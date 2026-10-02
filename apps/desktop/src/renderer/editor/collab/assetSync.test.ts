import {
  assetCssUrl,
  createEmptyDoc,
  createNode,
  getChildIds,
  loadDoc,
  subscribeNodes,
  type NodeChangeBatch,
} from '@baren/schema'
import { describe, expect, it, vi } from 'vitest'
import { AssetSync, assetApiOf, batchAssetRefs, type AssetApi } from './assetSync'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const bytesOf = (h: string) => new TextEncoder().encode(`bytes-${h}`)

function fakeLocal(initial: string[]) {
  const store = new Map<string, Uint8Array>(initial.map((h) => [h, bytesOf(h)]))
  return {
    store,
    local: {
      get: vi.fn(async (h: string) => store.get(h) ?? null),
      put: vi.fn(async (bytes: Uint8Array) => {
        const h = new TextDecoder().decode(bytes).slice('bytes-'.length)
        store.set(h, bytes)
        return h
      }),
      mimeOf: () => 'image/png',
    },
  }
}

function fakeServer(initial: string[]) {
  const store = new Map<string, Uint8Array>(initial.map((h) => [h, bytesOf(h)]))
  const api: AssetApi = {
    hasAsset: vi.fn(async (_f: string, h: string) => store.has(h)),
    uploadAsset: vi.fn(async (_f: string, h: string, bytes: Uint8Array) => {
      store.set(h, bytes)
    }),
    downloadAsset: vi.fn(async (_f: string, h: string) => {
      const bytes = store.get(h)
      return bytes ? { bytes, mime: 'image/png' } : null
    }),
  }
  return { store, api }
}

describe('asset reconciliation', () => {
  it('uploads what the server lacks and downloads what this machine lacks', async () => {
    const { local, store: mine } = fakeLocal([A, B])
    const { api, store: server } = fakeServer([B, C])
    const arrived: string[] = []
    const sync = new AssetSync({ local, onArrived: (h) => arrived.push(...h), retryDelays: [] })
    await sync.attach({ fileId: 'f1', api }, [A, B, C])
    expect(api.uploadAsset).toHaveBeenCalledTimes(1)
    expect(api.uploadAsset).toHaveBeenCalledWith('f1', A, bytesOf(A), 'image/png')
    expect(server.has(A)).toBe(true)
    expect(mine.has(C)).toBe(true)
    expect(arrived).toEqual([C])
    // Known state is cached: re-reconciling does not upload or download again.
    await sync.reconcile([A, B, C])
    expect(api.uploadAsset).toHaveBeenCalledTimes(1)
    expect(api.downloadAsset).toHaveBeenCalledTimes(1)
  })

  it('retries downloads until the uploader has sent the bytes', async () => {
    const { local } = fakeLocal([])
    const { api, store: server } = fakeServer([])
    const sleeps: number[] = []
    const onArrived = vi.fn()
    const sync = new AssetSync({
      local,
      onArrived,
      retryDelays: [10, 20, 40],
      sleep: async (ms) => {
        sleeps.push(ms)
        // The peer's upload lands during the second wait.
        if (sleeps.length === 2) server.set(A, bytesOf(A))
      },
    })
    await sync.attach({ fileId: 'f1', api })
    expect(await sync.ensureLocal(A)).toBe(true)
    expect(sleeps).toEqual([10, 20])
    expect(onArrived).toHaveBeenCalledWith([A])
    // Gives up after the last delay.
    expect(await sync.ensureLocal(B)).toBe(false)
  })

  it('does nothing while the file is local, then uploads tracked assets on share', async () => {
    const { local } = fakeLocal([A])
    const { api } = fakeServer([])
    const sync = new AssetSync({ local, onArrived: () => undefined })
    sync.track([A])
    expect(api.hasAsset).not.toHaveBeenCalled()
    await sync.attach({ fileId: 'f1', api }, [A])
    expect(api.uploadAsset).toHaveBeenCalledWith('f1', A, bytesOf(A), 'image/png')
  })

  it('follows doc batches: local references upload, imported ones download', async () => {
    const doc = createEmptyDoc('Doc', { peerId: 1 })
    const page = getChildIds(doc, null)[0] as string
    const { local } = fakeLocal([A])
    const { api, store: server } = fakeServer([B])
    const onArrived = vi.fn()
    const sync = new AssetSync({ local, onArrived, retryDelays: [] })
    await sync.attach({ fileId: 'f1', api })
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (b) => {
      batches.push(b)
      sync.onBatch(doc, b)
    })
    createNode(doc, { type: 'image', parentId: page, assetId: A })
    await vi.waitFor(() => expect(server.has(A)).toBe(true))

    // A peer adds an image fill referencing B (on the server, not here).
    const peer = loadDoc(doc.export({ mode: 'snapshot' }))
    peer.setPeerId(2)
    const before = doc.oplogVersion()
    createNode(peer, {
      type: 'rect',
      parentId: page,
      styles: { backgroundImage: assetCssUrl(B) },
    })
    doc.import(peer.export({ mode: 'update', from: before }))
    await vi.waitFor(() => expect(onArrived).toHaveBeenCalledWith([B]))
    expect(batches.map((b) => b.by)).toEqual(['local', 'import'])
  })

  it('finds references in created nodes and changed fills only', () => {
    const doc = createEmptyDoc('Doc', { peerId: 1 })
    const page = getChildIds(doc, null)[0] as string
    let batch: NodeChangeBatch | null = null
    subscribeNodes(doc, (b) => (batch = b))
    createNode(doc, { type: 'image', parentId: page, assetId: A })
    return vi.waitFor(() => {
      expect(batch).not.toBeNull()
      expect([...batchAssetRefs(doc, batch as unknown as NodeChangeBatch)]).toEqual([A])
    })
  })

  it('adapts sync clients with top-level or grouped asset endpoints', async () => {
    const has = vi.fn(async () => true)
    const flat = assetApiOf({ hasAsset: has, uploadAsset: vi.fn(), downloadAsset: vi.fn() })
    expect(await flat?.hasAsset('f', A)).toBe(true)
    const grouped = assetApiOf({
      assets: {
        has,
        upload: vi.fn(),
        download: vi.fn(async () => ({ bytes: new Uint8Array(1), mime: 'image/png' })),
      },
    })
    expect(await grouped?.downloadAsset('f', A)).toEqual({
      bytes: new Uint8Array(1),
      mime: 'image/png',
    })
    expect(assetApiOf({ me: () => null })).toBeNull()
  })
})
