/**
 * JS fallback for the Rust core: design files, thumbnails and assets as plain
 * files under the data directory. Runs inside a worker thread (see worker.ts)
 * so Loro work and hashing never block the Electron main thread.
 *
 *   <dataDir>/files/<id>/meta.json      FileMeta (source of truth, written atomically)
 *   <dataDir>/files/<id>/doc.loro       compacted Loro snapshot (created on first open)
 *   <dataDir>/files/<id>/updates.bin    append-only update log (see updateLog.ts)
 *   <dataDir>/files/<id>/thumbnail.png
 *   <dataDir>/assets/<hh>/<blake3>      content-addressed bytes (+ .json sidecar with mime)
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KeyedMutex } from '../../util/keyedMutex'
import { isNotFound, readFileOrNull, readJsonOrNull, writeFileAtomic } from '../../util/fs'
import { sniffMime } from '../../protocol/assetRequest'
import { CoreError, type AssetEntry, type CoreOperations, type FileMeta } from '../types'
import type { DocEngine } from './docEngine'
import { decodeRecords, encodeRecord } from './updateLog'

export interface JsCoreOptions {
  dataDir: string
  /** Loro operations, loaded lazily (WASM init). */
  engine: () => Promise<DocEngine>
  /** Content hash for assets: blake3 hex, like the Rust core. */
  hash: (bytes: Uint8Array) => string
  now?: () => number
  newId?: () => string
  /** Fold the update log into the snapshot once it exceeds this size. */
  compactThresholdBytes?: number
  /** Delay for persisting `updatedAt` bumps caused by applyUpdate. */
  metaDebounceMs?: number
  warn?: (message: string, data?: unknown) => void
}

const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const HASH_RE = /^[0-9a-f]{64}$/
const MIME_RE = /^[\w.+-]{1,127}\/[\w.+-]{1,127}$/
/** Same limits as the Rust core (crates/core/src/store). */
export const MAX_FILE_NAME_BYTES = 1024
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= PNG_SIGNATURE.byteLength && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
  )
}

function copyMeta(meta: FileMeta): FileMeta {
  return { ...meta }
}

function parseMeta(value: unknown, expectedId: string): FileMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const nullableString = (x: unknown): x is string | null => x === null || typeof x === 'string'
  if (
    v['id'] !== expectedId ||
    typeof v['name'] !== 'string' ||
    typeof v['createdAt'] !== 'number' ||
    typeof v['updatedAt'] !== 'number' ||
    typeof v['archived'] !== 'boolean' ||
    !nullableString(v['teamId'] ?? null) ||
    !nullableString(v['remoteId'] ?? null)
  ) {
    return null
  }
  return {
    id: expectedId,
    name: v['name'],
    createdAt: v['createdAt'],
    updatedAt: v['updatedAt'],
    archived: v['archived'],
    teamId: (v['teamId'] as string | null | undefined) ?? null,
    remoteId: (v['remoteId'] as string | null | undefined) ?? null,
  }
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || Buffer.byteLength(name, 'utf8') > MAX_FILE_NAME_BYTES) {
    throw new CoreError('INVALID_ARGUMENT', `Invalid file name`)
  }
}

export class JsCore implements CoreOperations {
  private readonly files = new Map<string, FileMeta>()
  private loading: Promise<void> | null = null
  private readonly locks = new KeyedMutex()
  private readonly logSizes = new Map<string, number>()
  private readonly dirtyMeta = new Set<string>()
  private metaTimer: ReturnType<typeof setTimeout> | null = null

  private readonly now: () => number
  private readonly newId: () => string
  private readonly compactThreshold: number
  private readonly metaDebounceMs: number
  private readonly warn: (message: string, data?: unknown) => void

  constructor(private readonly options: JsCoreOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.compactThreshold = options.compactThresholdBytes ?? 8 * 1024 * 1024
    this.metaDebounceMs = options.metaDebounceMs ?? 1000
    this.warn = options.warn ?? (() => {})
  }

  // ---------------------------------------------------------------- paths

  private get filesDir(): string {
    return join(this.options.dataDir, 'files')
  }

  private fileDir(id: string): string {
    return join(this.filesDir, id)
  }

  private assetPath(hash: string): string {
    return join(this.options.dataDir, 'assets', hash.slice(0, 2), hash)
  }

  // ---------------------------------------------------------------- index

  private ready(): Promise<void> {
    this.loading ??= this.scan()
    return this.loading
  }

  private async scan(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true })
    const entries = await readdir(this.filesDir, { withFileTypes: true })
    const metas = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && FILE_ID_RE.test(e.name))
        .map(async (e) => {
          try {
            const meta = parseMeta(
              await readJsonOrNull(join(this.fileDir(e.name), 'meta.json')),
              e.name,
            )
            if (!meta) this.warn('skipping file with invalid meta.json', { id: e.name })
            return meta
          } catch (error) {
            this.warn('skipping unreadable file', { id: e.name, error: String(error) })
            return null
          }
        }),
    )
    for (const meta of metas) if (meta) this.files.set(meta.id, meta)
  }

  private async requireFile(id: string): Promise<FileMeta> {
    await this.ready()
    const meta = typeof id === 'string' && FILE_ID_RE.test(id) ? this.files.get(id) : undefined
    if (!meta) throw new CoreError('NOT_FOUND', `File not found: ${String(id)}`)
    return meta
  }

  /** Persist the in-memory meta. Must run inside the file's lock (latest state wins). */
  private async writeMeta(id: string): Promise<void> {
    this.dirtyMeta.delete(id)
    const meta = this.files.get(id)
    if (!meta) return
    await writeFileAtomic(join(this.fileDir(id), 'meta.json'), JSON.stringify(meta))
  }

  private scheduleMetaWrite(id: string): void {
    this.dirtyMeta.add(id)
    if (this.metaTimer !== null) return
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null
      void this.flushMeta()
    }, this.metaDebounceMs)
    this.metaTimer.unref?.()
  }

  private async flushMeta(): Promise<void> {
    const ids = [...this.dirtyMeta]
    await Promise.all(
      ids.map((id) =>
        this.locks
          .run(id, () => this.writeMeta(id))
          .catch((error: unknown) =>
            this.warn('failed to persist file meta', { id, error: String(error) }),
          ),
      ),
    )
  }

  // ---------------------------------------------------------------- docs

  /** Current state as Loro blobs (snapshot, then pending updates). Call inside the file's lock. */
  private async readBlobs(
    meta: FileMeta,
  ): Promise<{ blobs: Uint8Array[]; pending: number; torn: boolean; hasSnapshot: boolean }> {
    const dir = this.fileDir(meta.id)
    const [snapshot, log] = await Promise.all([
      readFileOrNull(join(dir, 'doc.loro')),
      readFileOrNull(join(dir, 'updates.bin')),
    ])
    const decoded = log ? decodeRecords(log) : { records: [], validBytes: 0 }
    const base = snapshot ?? (await this.options.engine()).createEmpty(meta.name)
    return {
      blobs: [base, ...decoded.records],
      pending: decoded.records.length,
      torn: log !== null && decoded.validBytes !== log.byteLength,
      hasSnapshot: snapshot !== null,
    }
  }

  /** Fold pending updates into doc.loro. Call inside the file's lock. */
  private async compactLocked(meta: FileMeta): Promise<Uint8Array> {
    const dir = this.fileDir(meta.id)
    const { blobs, pending, torn, hasSnapshot } = await this.readBlobs(meta)
    let snapshot = blobs[0] as Uint8Array
    if (pending > 0) {
      const result = (await this.options.engine()).compact(blobs)
      if (result.skipped > 0)
        this.warn('dropped corrupt updates', { id: meta.id, count: result.skipped })
      snapshot = result.snapshot
    }
    if (pending > 0 || !hasSnapshot) await writeFileAtomic(join(dir, 'doc.loro'), snapshot)
    // Only after the merged snapshot is durable: re-importing updates is idempotent anyway.
    if (pending > 0 || torn) await writeFile(join(dir, 'updates.bin'), new Uint8Array(0))
    this.logSizes.set(meta.id, 0)
    return snapshot
  }

  // ---------------------------------------------------------------- CoreOperations

  async listFiles(): Promise<FileMeta[]> {
    await this.ready()
    return [...this.files.values()].map(copyMeta).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async createFile(name: string): Promise<FileMeta> {
    assertName(name)
    await this.ready()
    const t = this.now()
    const meta: FileMeta = {
      id: this.newId(),
      name,
      createdAt: t,
      updatedAt: t,
      archived: false,
      teamId: null,
      remoteId: null,
    }
    if (!FILE_ID_RE.test(meta.id))
      throw new CoreError('INVALID_ARGUMENT', 'generated an invalid id')
    await mkdir(this.fileDir(meta.id), { recursive: true })
    this.files.set(meta.id, meta)
    await this.locks.run(meta.id, () => this.writeMeta(meta.id))
    return copyMeta(meta)
  }

  async importFile(snapshot: Uint8Array, name: string | null): Promise<FileMeta> {
    if (name !== null) assertName(name)
    if (!(snapshot instanceof Uint8Array) || snapshot.byteLength === 0) {
      throw new CoreError('INVALID_ARGUMENT', 'Snapshot must be non-empty bytes')
    }
    await this.ready()
    const imported = (await this.options.engine()).importSnapshot(snapshot, name)
    if (!imported) throw new CoreError('INVALID_ARGUMENT', 'Not a complete Loro snapshot')
    assertName(imported.name)
    const t = this.now()
    const meta: FileMeta = {
      id: this.newId(),
      name: imported.name,
      createdAt: t,
      updatedAt: t,
      archived: false,
      teamId: null,
      remoteId: null,
    }
    if (!FILE_ID_RE.test(meta.id))
      throw new CoreError('INVALID_ARGUMENT', 'generated an invalid id')
    await mkdir(this.fileDir(meta.id), { recursive: true })
    await this.locks.run(meta.id, async () => {
      // The snapshot first: a listed file must always open.
      await writeFileAtomic(join(this.fileDir(meta.id), 'doc.loro'), imported.snapshot)
      this.files.set(meta.id, meta)
      await this.writeMeta(meta.id)
    })
    return copyMeta(meta)
  }

  async setFileRemote(id: string, teamId: string | null, remoteId: string | null): Promise<void> {
    const nullableId = (v: unknown): v is string | null =>
      v === null || (typeof v === 'string' && v.length > 0 && v.length <= 256)
    if (!nullableId(teamId) || !nullableId(remoteId)) {
      throw new CoreError('INVALID_ARGUMENT', 'Invalid team or remote id')
    }
    const meta = await this.requireFile(id)
    await this.locks.run(id, async () => {
      meta.teamId = teamId
      meta.remoteId = remoteId
      await this.writeMeta(id)
    })
  }

  async renameFile(id: string, name: string): Promise<void> {
    assertName(name)
    const meta = await this.requireFile(id)
    await this.locks.run(id, async () => {
      meta.name = name
      meta.updatedAt = this.now()
      await this.writeMeta(id)
    })
  }

  async archiveFile(id: string, archived: boolean): Promise<void> {
    const meta = await this.requireFile(id)
    await this.locks.run(id, async () => {
      meta.archived = archived === true
      meta.updatedAt = this.now()
      await this.writeMeta(id)
    })
  }

  async removeFile(id: string): Promise<void> {
    await this.requireFile(id)
    await this.locks.run(id, async () => {
      this.files.delete(id)
      this.dirtyMeta.delete(id)
      this.logSizes.delete(id)
      await rm(this.fileDir(id), { recursive: true, force: true })
    })
  }

  async openFile(id: string): Promise<Uint8Array> {
    const meta = await this.requireFile(id)
    return this.locks.run(id, () => this.compactLocked(meta))
  }

  async applyUpdate(id: string, update: Uint8Array): Promise<void> {
    const meta = await this.requireFile(id)
    if (!(update instanceof Uint8Array) || update.byteLength === 0) {
      throw new CoreError('INVALID_ARGUMENT', 'Update must be non-empty bytes')
    }
    if (!(await this.options.engine()).isValidBlob(update)) {
      throw new CoreError('INVALID_ARGUMENT', 'Not a valid Loro update')
    }
    const size = await this.locks.run(id, async () => {
      if (!this.files.has(id)) throw new CoreError('NOT_FOUND', `File not found: ${id}`)
      const file = join(this.fileDir(id), 'updates.bin')
      const record = encodeRecord(update)
      const before =
        this.logSizes.get(id) ??
        (await stat(file).then(
          (s) => s.size,
          () => 0,
        ))
      await appendFile(file, record)
      const after = before + record.byteLength
      this.logSizes.set(id, after)
      meta.updatedAt = this.now()
      this.scheduleMetaWrite(id)
      return after
    })
    if (size > this.compactThreshold) {
      void this.locks
        .run(id, async () => {
          const current = this.files.get(id)
          if (current) await this.compactLocked(current)
        })
        .catch((error: unknown) =>
          this.warn('background compaction failed', { id, error: String(error) }),
        )
    }
  }

  async setThumbnail(id: string, png: Uint8Array): Promise<void> {
    await this.requireFile(id)
    if (!(png instanceof Uint8Array) || !isPng(png)) {
      throw new CoreError('INVALID_ARGUMENT', 'Thumbnail must be a PNG image')
    }
    await this.locks.run(id, () => writeFileAtomic(join(this.fileDir(id), 'thumbnail.png'), png))
  }

  async getThumbnail(id: string): Promise<Uint8Array | null> {
    await this.requireFile(id)
    return readFileOrNull(join(this.fileDir(id), 'thumbnail.png'))
  }

  async putAsset(bytes: Uint8Array, mime: string): Promise<string> {
    if (!(bytes instanceof Uint8Array))
      throw new CoreError('INVALID_ARGUMENT', 'Asset must be bytes')
    if (typeof mime !== 'string' || !MIME_RE.test(mime)) {
      throw new CoreError('INVALID_ARGUMENT', `Invalid mime type: ${String(mime)}`)
    }
    const hash = this.options.hash(bytes)
    const path = this.assetPath(hash)
    await this.locks.run(`asset:${hash}`, async () => {
      try {
        await stat(path)
        return
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      await mkdir(join(path, '..'), { recursive: true })
      await writeFileAtomic(`${path}.json`, JSON.stringify({ mime, size: bytes.byteLength }))
      await writeFileAtomic(path, bytes)
    })
    return hash
  }

  async getAsset(hash: string): Promise<Uint8Array | null> {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null
    return readFileOrNull(this.assetPath(hash))
  }

  /** Bytes plus the mime from the `.json` sidecar (sniffed when the sidecar is missing or bad). */
  async getAssetEntry(hash: string): Promise<AssetEntry | null> {
    const bytes = await this.getAsset(hash)
    if (bytes === null) return null
    let mime: unknown = null
    try {
      mime = ((await readJsonOrNull(`${this.assetPath(hash)}.json`)) as { mime?: unknown } | null)
        ?.mime
    } catch {
      // Unreadable sidecar: sniff below.
    }
    return {
      bytes,
      mime: typeof mime === 'string' && MIME_RE.test(mime) ? mime : sniffMime(bytes),
    }
  }

  async exportJson(fileId: string): Promise<string> {
    const meta = await this.requireFile(fileId)
    return this.locks.run(fileId, async () => {
      const { blobs } = await this.readBlobs(meta)
      return (await this.options.engine()).exportJson(blobs)
    })
  }

  async exportHtml(fileId: string, nodeId: string): Promise<string> {
    const meta = await this.requireFile(fileId)
    const html = await this.locks.run(fileId, async () => {
      const { blobs } = await this.readBlobs(meta)
      return (await this.options.engine()).exportHtml(blobs, nodeId)
    })
    if (html === null) throw new CoreError('NOT_FOUND', `Node not found: ${String(nodeId)}`)
    return html
  }

  /** Persist debounced metadata and wait for in-flight work (quit, tests). */
  async flush(): Promise<void> {
    if (this.metaTimer !== null) {
      clearTimeout(this.metaTimer)
      this.metaTimer = null
    }
    await this.flushMeta()
    await this.locks.idle()
  }
}
