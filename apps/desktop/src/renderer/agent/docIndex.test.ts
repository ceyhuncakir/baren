import {
  createEmptyDoc,
  createNode,
  deleteNode,
  getChildIds,
  loadDoc,
  moveNode,
  setStyles,
  setText,
  subscribeNodes,
  toSnapshot,
} from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { DocIndex } from './docIndex'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('DocIndex', () => {
  it('mirrors the document and follows local and remote changes', async () => {
    const doc = createEmptyDoc('d', { peerId: 1 })
    const page = getChildIds(doc, null)[0] as string
    const board = createNode(doc, {
      type: 'frame',
      parentId: page,
      name: 'B',
      styles: { width: 10 },
    })
    const index = new DocIndex(doc, (l) => subscribeNodes(doc, l))
    expect(index.get(board)?.name).toBe('B')

    const text = createNode(doc, { type: 'text', parentId: board, text: 'a' })
    const frame = createNode(doc, { type: 'frame', parentId: board })
    const inner = createNode(doc, { type: 'rect', parentId: frame })
    setStyles(doc, board, { width: 20, color: 'red' })
    setText(doc, text, 'b')
    moveNode(doc, frame, page)
    await flush()
    const expectMirror = () => {
      const snap = toSnapshot(doc)
      expect(Object.fromEntries(index.map())).toEqual(snap.nodes)
      expect(index.pages()).toEqual(snap.pageIds)
    }
    expectMirror()
    deleteNode(doc, frame)
    await flush()
    expect(index.get(inner)).toBeUndefined()
    expectMirror()

    // Remote import (another peer adds a page and edits a node).
    const peer = loadDoc(doc.export({ mode: 'snapshot' }))
    peer.setPeerId(2)
    createNode(peer, { type: 'page', parentId: null, name: 'P2' })
    setStyles(peer, board, { height: 5 })
    doc.import(peer.export({ mode: 'update', from: doc.oplogVersion() }))
    await flush()
    expectMirror()
    expect(index.pages()).toHaveLength(2)
    index.dispose()
  })

  it('rebuilds when a change has not been delivered yet', () => {
    const doc = createEmptyDoc('d', { peerId: 1 })
    const page = getChildIds(doc, null)[0] as string
    const index = new DocIndex(doc, (l) => subscribeNodes(doc, l))
    expect(index.map().size).toBe(1)
    // No await: the change batch is still pending, the op count tells the mirror it is stale.
    const id = createNode(doc, { type: 'frame', parentId: page })
    expect(index.get(id)?.type).toBe('frame')
  })

  it('warms in slices and stays correct when the document changes meanwhile', async () => {
    const doc = createEmptyDoc('d', { peerId: 1 })
    const page = getChildIds(doc, null)[0] as string
    const boards = Array.from({ length: 30 }, (_, i) =>
      createNode(doc, { type: 'frame', parentId: page, name: `B${i}`, styles: { left: i * 100 } }),
    )
    const deep: string[] = []
    for (const b of boards) {
      const f = createNode(doc, { type: 'frame', parentId: b })
      for (let k = 0; k < 20; k++) deep.push(createNode(doc, { type: 'rect', parentId: f }))
    }
    const index = new DocIndex(doc, (l) => subscribeNodes(doc, l))
    index.warm()
    expect(index.isReady()).toBe(false)
    // Move a subtree out of the last board (loaded last) into the first one, delete another.
    const moving = getChildIds(doc, boards[29] as string)[0] as string
    moveNode(doc, moving, boards[0] as string)
    deleteNode(doc, boards[15] as string)
    createNode(doc, { type: 'text', parentId: boards[3] as string, text: 'new' })
    for (let i = 0; i < 50 && !index.isReady(); i++) await flush()
    expect(index.isReady()).toBe(true)
    const snap = toSnapshot(doc)
    expect(Object.fromEntries(index.map())).toEqual(snap.nodes)
    index.dispose()
  })
})
