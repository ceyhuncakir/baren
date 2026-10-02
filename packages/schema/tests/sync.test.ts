import { describe, expect, it } from 'vitest'
import type { LoroDoc } from 'loro-crdt'
import {
  createNode,
  deleteNode,
  getChildIds,
  getNode,
  loadDoc,
  moveNode,
  setStyle,
  setText,
  setTokens,
  toSnapshot,
} from '../src/index.ts'
import { docWithPage } from './helpers.ts'

/** Exchange updates both ways (as the sync server would) until both peers are equal. */
function sync(a: LoroDoc, b: LoroDoc): void {
  const toB = a.export({ mode: 'update', from: b.oplogVersion() })
  const toA = b.export({ mode: 'update', from: a.oplogVersion() })
  b.import(toB)
  a.import(toA)
}

function twoPeers() {
  const { doc: a, pageId } = docWithPage('Shared', 1)
  const b = loadDoc(a.export({ mode: 'snapshot' }))
  b.setPeerId(2)
  return { a, b, pageId }
}

describe('two peers', () => {
  it('converge after concurrent edits to different style keys of one node', () => {
    const { a, b, pageId } = twoPeers()
    const id = createNode(a, { type: 'frame', parentId: pageId, styles: { width: 100 } })
    sync(a, b)
    setStyle(a, id, 'width', 200)
    setStyle(b, id, 'height', 50)
    sync(a, b)
    expect(getNode(a, id)!.styles).toEqual({ width: 200, height: 50 })
    expect(toSnapshot(a)).toEqual(toSnapshot(b))
  })

  it('merge concurrent text edits character-wise', () => {
    const { a, b, pageId } = twoPeers()
    const id = createNode(a, { type: 'text', parentId: pageId, text: 'Hello world' })
    sync(a, b)
    setText(a, id, 'Hello brave world')
    setText(b, id, 'Hello world!')
    sync(a, b)
    expect(getNode(a, id)!.text).toBe('Hello brave world!')
    expect(toSnapshot(a)).toEqual(toSnapshot(b))
  })

  it('converge on sibling order after concurrent inserts and moves', () => {
    const { a, b, pageId } = twoPeers()
    const ids = ['x', 'y', 'z'].map((name) =>
      createNode(a, { type: 'rect', parentId: pageId, name }),
    )
    sync(a, b)
    createNode(a, { type: 'rect', parentId: pageId, name: 'from-a', index: 1 })
    createNode(b, { type: 'rect', parentId: pageId, name: 'from-b', index: 1 })
    moveNode(a, ids[2]!, pageId, 0)
    moveNode(b, ids[0]!, pageId, 3)
    sync(a, b)
    const order = getChildIds(a, pageId)
    expect(order).toEqual(getChildIds(b, pageId))
    expect(order).toHaveLength(5)
    expect(toSnapshot(a)).toEqual(toSnapshot(b))
  })

  it('converge when one peer edits inside a subtree the other deleted', () => {
    const { a, b, pageId } = twoPeers()
    const frame = createNode(a, { type: 'frame', parentId: pageId })
    const child = createNode(a, { type: 'rect', parentId: frame })
    sync(a, b)
    deleteNode(a, frame)
    setStyle(b, child, 'width', 10)
    createNode(b, { type: 'text', parentId: frame, text: 'late' })
    sync(a, b)
    expect(toSnapshot(a)).toEqual(toSnapshot(b))
    expect(getNode(a, frame)).toBeUndefined()
  })

  it('converge on concurrent cyclic moves without creating a cycle', () => {
    const { a, b, pageId } = twoPeers()
    const f1 = createNode(a, { type: 'frame', parentId: pageId })
    const f2 = createNode(a, { type: 'frame', parentId: pageId })
    sync(a, b)
    moveNode(a, f1, f2)
    moveNode(b, f2, f1)
    sync(a, b)
    expect(toSnapshot(a)).toEqual(toSnapshot(b))
    const p1 = getNode(a, f1)!.parentId
    const p2 = getNode(a, f2)!.parentId
    expect(p1 === f2 && p2 === f1).toBe(false)
  })

  it('converge on concurrent token edits', () => {
    const { a, b } = twoPeers()
    setTokens(a, { '--color-primary': { type: 'color', value: '#000' } })
    sync(a, b)
    setTokens(a, { '--color-primary': { type: 'color', value: '#111', description: 'ink' } })
    setTokens(b, { '--spacing-1': { type: 'spacing', value: '4px' } })
    sync(a, b)
    expect(toSnapshot(b).tokens).toEqual({
      '--color-primary': { type: 'color', value: '#111', description: 'ink' },
      '--spacing-1': { type: 'spacing', value: '4px' },
    })
    expect(toSnapshot(a)).toEqual(toSnapshot(b))
  })
})
