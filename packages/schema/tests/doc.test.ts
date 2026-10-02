import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_BACKGROUND,
  SCHEMA_VERSION,
  createEmptyDoc,
  createNode,
  exportSnapshot,
  getChildIds,
  getDocName,
  getSchemaVersion,
  loadDoc,
  nodesTree,
  setDocName,
  setStyle,
  subscribeNodes,
  toSnapshot,
  transact,
} from '../src/index.ts'
import { docWithPage, flushEvents } from './helpers.ts'

describe('createEmptyDoc', () => {
  it('writes meta and one default page', () => {
    const doc = createEmptyDoc('My file')
    expect(getDocName(doc)).toBe('My file')
    expect(getSchemaVersion(doc)).toBe(SCHEMA_VERSION)
    const snap = toSnapshot(doc)
    expect(snap.pageIds).toHaveLength(1)
    const page = snap.nodes[snap.pageIds[0]!]!
    expect(page).toMatchObject({
      type: 'page',
      name: 'Page 1',
      parentId: null,
      children: [],
      background: DEFAULT_PAGE_BACKGROUND,
    })
  })

  it('can skip the page and pin the peer id', () => {
    const doc = createEmptyDoc('Empty', { pageName: null, peerId: 42 })
    expect(getChildIds(doc, null)).toEqual([])
    expect(doc.peerIdStr).toBe('42')
  })

  it('enables fractional indexing on the nodes tree', () => {
    const doc = createEmptyDoc('x')
    expect(nodesTree(doc).isFractionalIndexEnabled()).toBe(true)
  })

  it('renames the doc', () => {
    const doc = createEmptyDoc('a')
    setDocName(doc, 'b')
    expect(toSnapshot(doc).name).toBe('b')
  })
})

describe('loadDoc / exportSnapshot', () => {
  it('round-trips a snapshot', () => {
    const { doc, pageId } = docWithPage()
    createNode(doc, { type: 'frame', parentId: pageId, styles: { left: 1, top: 2 } })
    const copy = loadDoc(exportSnapshot(doc))
    expect(toSnapshot(copy)).toEqual(toSnapshot(doc))
  })

  it('loads from a batch of updates', () => {
    const { doc, pageId } = docWithPage()
    const v0 = doc.oplogVersion()
    const first = doc.export({ mode: 'update' })
    createNode(doc, { type: 'rect', parentId: pageId })
    const second = doc.export({ mode: 'update', from: v0 })
    const copy = loadDoc([first, second])
    expect(toSnapshot(copy)).toEqual(toSnapshot(doc))
  })
})

describe('transact', () => {
  it('commits once for many mutations and tags the origin', async () => {
    const { doc, pageId } = docWithPage()
    const batches: { origin: string | undefined; count: number }[] = []
    subscribeNodes(doc, (b) => batches.push({ origin: b.origin, count: b.changes.length }))
    const id = transact(
      doc,
      () => {
        const frame = createNode(doc, { type: 'frame', parentId: pageId })
        createNode(doc, { type: 'text', parentId: frame, text: 'hi' })
        transact(doc, () => setStyle(doc, frame, 'gap', '4px'))
        return frame
      },
      { origin: 'ui' },
    )
    await flushEvents()
    expect(typeof id).toBe('string')
    expect(batches).toEqual([{ origin: 'ui', count: 2 }])
  })

  it('commits what was applied when the callback throws', async () => {
    const { doc, pageId } = docWithPage()
    let events = 0
    subscribeNodes(doc, () => events++)
    expect(() =>
      transact(doc, () => {
        createNode(doc, { type: 'frame', parentId: pageId })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    await flushEvents()
    expect(events).toBe(1)
    expect(getChildIds(doc, pageId)).toHaveLength(1)
  })
})
