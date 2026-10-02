import { appendFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNode,
  getDocName,
  loadDoc,
  setTokens,
  toSnapshot,
  type DocSnapshot,
} from '@baren/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLoroDocEngine } from './docEngine'
import { blake3Hex } from './hash'
import { JsCore, type JsCoreOptions } from './jsCore'

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
const engine = createLoroDocEngine()

/** A renderer-side edit: open the snapshot, add an artboard, export the update. */
function editAddingArtboard(
  snapshot: Uint8Array,
  name: string,
): { update: Uint8Array; id: string } {
  const doc = loadDoc(snapshot)
  const before = doc.oplogVersion()
  const pageId = toSnapshot(doc).pageIds[0] as string
  const id = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name,
    styles: {
      position: 'absolute',
      left: 40,
      top: 80,
      width: 320,
      height: 200,
      backgroundColor: 'var(--color-surface)',
    },
  })
  return { update: doc.export({ mode: 'update', from: before }), id }
}

describe('JsCore', () => {
  let dir: string
  let clock: number
  let core: JsCore
  const warnings: string[] = []

  const makeCore = (overrides: Partial<JsCoreOptions> = {}): JsCore =>
    new JsCore({
      dataDir: dir,
      engine: async () => engine,
      hash: blake3Hex,
      now: () => ++clock,
      metaDebounceMs: 5,
      warn: (m) => warnings.push(m),
      ...overrides,
    })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baren-jscore-'))
    clock = 1000
    warnings.length = 0
    core = makeCore()
  })
  afterEach(async () => {
    await core.flush()
    await rm(dir, { recursive: true, force: true })
  })

  it('creates, lists (most recent first), renames, archives and removes files', async () => {
    const a = await core.createFile('Alpha')
    const b = await core.createFile('Beta')
    expect(a).toMatchObject({ name: 'Alpha', archived: false, teamId: null, remoteId: null })
    expect((await core.listFiles()).map((f) => f.name)).toEqual(['Beta', 'Alpha'])

    await core.renameFile(a.id, 'Alpha 2')
    await core.archiveFile(a.id, true)
    const listed = await core.listFiles()
    expect(listed[0]).toMatchObject({ id: a.id, name: 'Alpha 2', archived: true })
    expect(listed[0]!.updatedAt).toBeGreaterThan(b.updatedAt)

    await core.removeFile(b.id)
    expect((await core.listFiles()).map((f) => f.id)).toEqual([a.id])
    await expect(core.openFile(b.id)).rejects.toThrow(`File not found: ${b.id}`)
  })

  it('persists metadata across restarts', async () => {
    const a = await core.createFile('Kept')
    await core.renameFile(a.id, 'Kept (renamed)')
    const reopened = makeCore()
    expect(await reopened.listFiles()).toEqual([
      expect.objectContaining({ id: a.id, name: 'Kept (renamed)' }),
    ])
  })

  it('imports a snapshot from elsewhere (shared history) and links it to a team file', async () => {
    const source = await core.createFile('Shared')
    const { update, id: artboardId } = editAddingArtboard(await core.openFile(source.id), 'Board')
    await core.applyUpdate(source.id, update)
    const snapshot = await core.openFile(source.id)

    const kept = await core.importFile(snapshot, null)
    expect(kept).toMatchObject({ name: 'Shared', teamId: null, remoteId: null })
    const doc = loadDoc(await core.openFile(kept.id))
    expect(toSnapshot(doc).nodes[artboardId]?.name).toBe('Board')
    // Same history: the source's version is contained, so later updates apply cleanly.
    expect(doc.oplogVersion().compare(loadDoc(snapshot).oplogVersion())).toBe(0)

    const renamed = await core.importFile(snapshot, 'Renamed copy')
    expect(getDocName(loadDoc(await core.openFile(renamed.id)))).toBe('Renamed copy')

    const updatedAt = (await core.listFiles()).find((f) => f.id === kept.id)!.updatedAt
    await core.setFileRemote(kept.id, 'team-1', 'remote-1')
    const linked = (await makeCore().listFiles()).find((f) => f.id === kept.id)
    expect(linked).toMatchObject({ teamId: 'team-1', remoteId: 'remote-1', updatedAt })
    await core.setFileRemote(kept.id, null, null)
    expect((await core.listFiles()).find((f) => f.id === kept.id)?.remoteId).toBeNull()

    await expect(core.importFile(Uint8Array.of(1, 2, 3), null)).rejects.toThrow(/snapshot/i)
    await expect(core.setFileRemote('missing', null, null)).rejects.toThrow(/not found/i)
  })

  it('opens a new file as an empty doc named after the file', async () => {
    const f = await core.createFile('Empty')
    const doc = loadDoc(await core.openFile(f.id))
    const snap = toSnapshot(doc)
    expect(getDocName(doc)).toBe('Empty')
    expect(snap.pageIds).toHaveLength(1)
    expect(snap.nodes[snap.pageIds[0]!]).toMatchObject({
      type: 'page',
      name: 'Page 1',
      background: '#EEEEEE',
    })
  })

  it('appends updates and folds them into the snapshot on open', async () => {
    const f = await core.createFile('Doc')
    const first = editAddingArtboard(await core.openFile(f.id), 'Board A')
    await core.applyUpdate(f.id, first.update)
    const second = editAddingArtboard(await core.openFile(f.id), 'Board B')
    await core.applyUpdate(f.id, second.update)

    const doc = loadDoc(await core.openFile(f.id))
    const names = Object.values(toSnapshot(doc).nodes).map((n) => n.name)
    expect(names).toEqual(expect.arrayContaining(['Board A', 'Board B']))
    // Compacted: the log is empty again.
    expect((await stat(join(dir, 'files', f.id, 'updates.bin'))).size).toBe(0)
  })

  it('compacts in the background once the log exceeds the threshold', async () => {
    core = makeCore({ compactThresholdBytes: 1 })
    const f = await core.createFile('Doc')
    const { update } = editAddingArtboard(await core.openFile(f.id), 'Board')
    await core.applyUpdate(f.id, update)
    await core.flush()
    expect((await stat(join(dir, 'files', f.id, 'updates.bin'))).size).toBe(0)
    const names = Object.values(
      toSnapshot(loadDoc(await readFile(join(dir, 'files', f.id, 'doc.loro')))).nodes,
    ).map((n) => n.name)
    expect(names).toContain('Board')
  })

  it('rejects bytes that are not a Loro update', async () => {
    const f = await core.createFile('Doc')
    await expect(core.applyUpdate(f.id, Uint8Array.of(1, 2, 3, 4))).rejects.toThrow(
      /valid Loro update/,
    )
    await expect(core.applyUpdate(f.id, new Uint8Array(0))).rejects.toThrow(/non-empty/)
  })

  it('survives a torn update log (crash mid-append)', async () => {
    const f = await core.createFile('Doc')
    const { update } = editAddingArtboard(await core.openFile(f.id), 'Board')
    await core.applyUpdate(f.id, update)
    await appendFile(join(dir, 'files', f.id, 'updates.bin'), Uint8Array.of(200, 0, 0, 0, 1, 2))
    const names = Object.values(toSnapshot(loadDoc(await core.openFile(f.id))).nodes).map(
      (n) => n.name,
    )
    expect(names).toContain('Board')
  })

  it('stores PNG thumbnails and returns null when there is none', async () => {
    const f = await core.createFile('Doc')
    expect(await core.getThumbnail(f.id)).toBeNull()
    await core.setThumbnail(f.id, PNG)
    expect(await core.getThumbnail(f.id)).toEqual(Buffer.from(PNG))
    await expect(core.setThumbnail(f.id, Uint8Array.of(1, 2, 3))).rejects.toThrow(/PNG/)
  })

  it('stores assets content-addressed by blake3', async () => {
    const bytes = new TextEncoder().encode('hello asset')
    const hash = await core.putAsset(bytes, 'image/png')
    expect(hash).toBe(blake3Hex(bytes))
    expect(await core.putAsset(bytes, 'image/png')).toBe(hash) // idempotent
    expect(await core.getAsset(hash)).toEqual(Buffer.from(bytes))
    expect(await core.getAsset('0'.repeat(64))).toBeNull()
    expect(await core.getAsset('../../etc/passwd')).toBeNull()
    await expect(core.putAsset(bytes, 'not a mime')).rejects.toThrow(/mime/)
    expect(await readdir(join(dir, 'assets', hash.slice(0, 2)))).toEqual([hash, `${hash}.json`])
  })

  it('returns assets with their stored mime type (baren-asset://)', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const hash = await core.putAsset(svg, 'image/svg+xml')
    expect(await core.getAssetEntry(hash)).toEqual({
      bytes: Buffer.from(svg),
      mime: 'image/svg+xml',
    })
    expect(await core.getAssetEntry('0'.repeat(64))).toBeNull()
    expect(await core.getAssetEntry('nope')).toBeNull()
    // A lost sidecar falls back to sniffing the bytes.
    await rm(join(dir, 'assets', hash.slice(0, 2), `${hash}.json`))
    expect((await core.getAssetEntry(hash))?.mime).toBe('image/svg+xml')
  })

  it('exports JSON (DocSnapshot) and HTML including pending updates', async () => {
    const f = await core.createFile('Export me')
    const snapshot = await core.openFile(f.id)
    const doc = loadDoc(snapshot)
    const before = doc.oplogVersion()
    setTokens(doc, { '--color-surface': { type: 'color', value: '#F7F7F7' } })
    const pageId = toSnapshot(doc).pageIds[0] as string
    const boardId = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Card',
      styles: { position: 'absolute', left: 10, top: 20, width: 200, height: 100, display: 'flex' },
    })
    createNode(doc, { type: 'text', parentId: boardId, name: 'Title', text: 'Hi <there>' })
    await core.applyUpdate(f.id, doc.export({ mode: 'update', from: before }))

    const json = JSON.parse(await core.exportJson(f.id)) as DocSnapshot
    expect(json.name).toBe('Export me')
    expect(json.tokens['--color-surface']).toMatchObject({ value: '#F7F7F7' })

    const html = await core.exportHtml(f.id, boardId)
    expect(html).toContain('--color-surface: #F7F7F7;')
    // Same as the Rust core: an artboard keeps its declared `position`, drops its canvas offset.
    expect(html).toContain(
      '<section style="position: absolute; display: flex; width: 200px; height: 100px">',
    )
    expect(html).not.toContain('left: 10px')
    expect(html).toContain('Hi &lt;there&gt;')
    await expect(core.exportHtml(f.id, '999@999')).rejects.toThrow(/Node not found/)
    await expect(core.exportHtml(f.id, 'not-an-id')).rejects.toThrow(/Node not found/)
  })

  it('rejects ids that could escape the data directory', async () => {
    await expect(core.openFile('../../etc')).rejects.toThrow(/File not found/)
    await expect(core.removeFile('')).rejects.toThrow(/File not found/)
  })

  it('serialises concurrent updates to the same file', async () => {
    const f = await core.createFile('Doc')
    const base = await core.openFile(f.id)
    const edits = Array.from({ length: 10 }, (_, i) => editAddingArtboard(base, `Board ${i}`))
    await Promise.all(edits.map((e) => core.applyUpdate(f.id, e.update)))
    const names = Object.values(toSnapshot(loadDoc(await core.openFile(f.id))).nodes).map(
      (n) => n.name,
    )
    for (let i = 0; i < 10; i++) expect(names).toContain(`Board ${i}`)
  })
})
