/**
 * Keeps asset bytes and asset references in step for shared files (ARCHITECTURE.md,
 * "Images" → Collaboration):
 *
 *  - local references (image inserts, image fills) are uploaded with `uploadAsset` as soon
 *    as they are made — the Loro update that references them streams at the same time;
 *  - references arriving from peers (imports) whose bytes this machine lacks are downloaded
 *    with `downloadAsset`, stored with `assets.put`, and the canvas re-renders them; a 404
 *    (the uploader is still sending) is retried with backoff;
 *  - attaching (opening a team file, or sharing a local one) reconciles every reference:
 *    upload what the server lacks, download what we lack.
 *
 * Pure orchestration over injected ports (local store, REST API, doc events), so it is unit
 * tested without a server or a bridge.
 */
import { docAssetRefs, getNode, nodeAssetRefs, type NodeChangeBatch } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

/** The REST endpoints from `@baren/sync-client/api` (contract signatures). */
export interface AssetApi {
  hasAsset(fileId: string, hash: string): Promise<boolean>
  uploadAsset(fileId: string, hash: string, bytes: Uint8Array, mime: string): Promise<unknown>
  downloadAsset(fileId: string, hash: string): Promise<{ bytes: Uint8Array; mime: string } | null>
}

/** The local asset store (the bridge). */
export interface LocalAssets {
  get(hash: string): Promise<Uint8Array | null>
  put(bytes: Uint8Array, mime: string): Promise<string>
  mimeOf(bytes: Uint8Array): string | null
}

export interface AssetSyncOptions {
  local: LocalAssets
  /** Bytes for these hashes were stored locally (re-render them). */
  onArrived(hashes: readonly string[]): void
  /** Download retry delays (ms) while the server does not have the bytes yet. */
  retryDelays?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  /** Parallel transfers. */
  concurrency?: number
  onError?: (error: unknown) => void
}

/** Above this many created nodes in one batch, rescan the whole doc instead. */
const BULK_CREATED = 300
const DEFAULT_RETRIES = [400, 1000, 2000, 4000, 8000, 15000, 30000]

/**
 * Adapter for the sync client: the asset endpoints are looked up at runtime so this works
 * whether they are exposed as `uploadAsset/downloadAsset/hasAsset` (contract) or grouped
 * under `assets.{upload,download,has}`. Null when the client has none.
 */
export function assetApiOf(client: unknown): AssetApi | null {
  if (typeof client !== 'object' || client === null) return null
  const c = client as Record<string, unknown>
  const fn = (o: Record<string, unknown> | undefined, name: string) =>
    o && typeof o[name] === 'function'
      ? (o[name] as (...args: unknown[]) => Promise<unknown>).bind(o)
      : null
  const group =
    typeof c['assets'] === 'object' ? (c['assets'] as Record<string, unknown>) : undefined
  const has = fn(c, 'hasAsset') ?? fn(group, 'has')
  const upload = fn(c, 'uploadAsset') ?? fn(group, 'upload')
  const download = fn(c, 'downloadAsset') ?? fn(group, 'download')
  if (!has || !upload || !download) return null
  return {
    hasAsset: async (f, h) => (await has(f, h)) === true,
    uploadAsset: (f, h, b, m) => upload(f, h, b, m),
    downloadAsset: async (f, h) => {
      const r = (await download(f, h)) as { bytes?: unknown; mime?: unknown } | null
      if (!r || !(r.bytes instanceof Uint8Array)) return null
      return { bytes: r.bytes, mime: typeof r.mime === 'string' ? r.mime : '' }
    },
  }
}

/** Hashes referenced by the nodes a batch created or whose image properties changed. */
export function batchAssetRefs(doc: LoroDoc, batch: NodeChangeBatch): Set<string> {
  const out = new Set<string>()
  const ids = new Set<string>()
  let created = 0
  for (const c of batch.changes) {
    if (c.kind === 'created') {
      created++
      ids.add(c.id)
    } else if (c.kind === 'styles') {
      if (c.keys.some((k) => k.startsWith('background') || k.startsWith('--hidden-background')))
        ids.add(c.id)
    } else if (c.kind === 'props') {
      if (c.keys.includes('assetId') || c.keys.includes('type')) ids.add(c.id)
    } else if (c.kind === 'overrides') {
      // Instance overrides can swap an image (assetId) or an image fill (contract §3.5).
      ids.add(c.id)
    }
  }
  if (created > BULK_CREATED) return docAssetRefs(doc)
  for (const id of ids) {
    const node = getNode(doc, id)
    if (node) for (const h of nodeAssetRefs(node)) out.add(h)
  }
  return out
}

export class AssetSync {
  private remote: { fileId: string; api: AssetApi } | null = null
  /** Hashes the server is known to have (for the attached file). */
  private readonly onServer = new Set<string>()
  /** Hashes known to be stored locally. */
  private readonly local = new Set<string>()
  private readonly uploads = new Map<string, Promise<void>>()
  private readonly downloads = new Map<string, Promise<boolean>>()
  private active = 0
  private readonly queue: (() => void)[] = []
  private generation = 0
  private disposed = false

  constructor(private readonly opts: AssetSyncOptions) {}

  get attached(): boolean {
    return this.remote !== null
  }

  /**
   * Start (or stop, with null) syncing assets for a server file. Resolves when the
   * initial reconciliation of `refs` (every reference in the doc) is done.
   */
  attach(
    remote: { fileId: string; api: AssetApi } | null,
    refs: Iterable<string> = [],
  ): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const same = remote !== null && this.remote?.fileId === remote.fileId
    if (!same) {
      this.generation++
      this.onServer.clear()
      this.uploads.clear()
      this.downloads.clear()
    }
    this.remote = remote
    if (!remote) return Promise.resolve()
    return this.reconcile(refs)
  }

  /** Upload what the server lacks and download what this machine lacks. */
  async reconcile(refs: Iterable<string>): Promise<void> {
    const list = [...new Set(refs)]
    await Promise.all(
      list.map(async (hash) => {
        if (await this.hasLocal(hash)) await this.upload(hash)
        else await this.download(hash)
      }),
    )
  }

  /** Local references (inserts/fills): upload them when the file is shared. */
  track(hashes: Iterable<string>): void {
    for (const h of hashes) {
      this.local.add(h)
      if (this.remote) void this.upload(h)
    }
  }

  /** Feed a doc change batch: local refs are uploaded, imported refs downloaded if missing. */
  onBatch(doc: LoroDoc, batch: NodeChangeBatch): void {
    if (this.disposed || batch.by === 'checkout') return
    const refs = batchAssetRefs(doc, batch)
    if (refs.size === 0) return
    if (batch.by === 'local') {
      if (this.remote) for (const h of refs) void this.upload(h)
      return
    }
    for (const h of refs) void this.ensureLocal(h)
  }

  /** Download `hash` unless it is stored locally. Resolves true when it is available. */
  async ensureLocal(hash: string): Promise<boolean> {
    if (await this.hasLocal(hash)) return true
    return this.download(hash)
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.remote = null
    this.queue.length = 0
  }

  // -------------------------------------------------------------------------

  private async hasLocal(hash: string): Promise<boolean> {
    if (this.local.has(hash)) return true
    const bytes = await this.opts.local.get(hash).catch(() => null)
    if (bytes) this.local.add(hash)
    return bytes !== null
  }

  private limit<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.opts.concurrency ?? 4
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active++
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--
            this.queue.shift()?.()
          })
      }
      if (this.active < max) run()
      else this.queue.push(run)
    })
  }

  private upload(hash: string): Promise<void> {
    const remote = this.remote
    if (!remote || this.onServer.has(hash)) return Promise.resolve()
    let pending = this.uploads.get(hash)
    if (pending) return pending
    const gen = this.generation
    pending = this.limit(async () => {
      if (gen !== this.generation) return
      if (await remote.api.hasAsset(remote.fileId, hash)) {
        this.onServer.add(hash)
        return
      }
      const bytes = await this.opts.local.get(hash)
      if (!bytes || gen !== this.generation) return
      await remote.api.uploadAsset(
        remote.fileId,
        hash,
        bytes,
        this.opts.local.mimeOf(bytes) ?? 'application/octet-stream',
      )
      this.onServer.add(hash)
    })
      .catch((error: unknown) => {
        // Forget the attempt: the next reference or reconnect retries it.
        if (this.uploads.get(hash) === pending) this.uploads.delete(hash)
        this.opts.onError?.(error)
      })
      .then(() => undefined)
    this.uploads.set(hash, pending)
    return pending
  }

  private download(hash: string): Promise<boolean> {
    const remote = this.remote
    if (!remote) return Promise.resolve(false)
    let pending = this.downloads.get(hash)
    if (pending) return pending
    const gen = this.generation
    const delays = this.opts.retryDelays ?? DEFAULT_RETRIES
    const sleep = this.opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
    pending = (async () => {
      for (let attempt = 0; ; attempt++) {
        if (gen !== this.generation) return false
        const got = await this.limit(() => remote.api.downloadAsset(remote.fileId, hash)).catch(
          (error: unknown) => {
            this.opts.onError?.(error)
            return null
          },
        )
        if (gen !== this.generation) return false
        if (got) {
          const stored = await this.opts.local.put(
            got.bytes,
            got.mime || this.opts.local.mimeOf(got.bytes) || 'application/octet-stream',
          )
          this.local.add(hash)
          this.onServer.add(hash)
          if (stored !== hash) {
            this.opts.onError?.(new Error(`Downloaded asset ${hash} hashed to ${stored}`))
          }
          this.opts.onArrived([hash])
          return true
        }
        const delay = delays[attempt]
        if (delay === undefined) return false
        await sleep(delay)
      }
    })().finally(() => {
      if (this.downloads.get(hash) === pending) this.downloads.delete(hash)
    })
    this.downloads.set(hash, pending)
    return pending
  }
}
