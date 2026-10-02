import { describe, expect, it } from 'vitest'
import {
  createNode,
  generateBenchDoc,
  getNode,
  setTokens,
  toSnapshot,
  toSubtreeSnapshot,
} from '../src/index.ts'
import { docWithPage } from './helpers.ts'

describe('toSnapshot', () => {
  it('materialises pages, nodes in order, and tokens', () => {
    const { doc, pageId } = docWithPage('Snap')
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Board',
      styles: { left: 0, top: 0, width: 1440, height: 900 },
    })
    const title = createNode(doc, { type: 'text', parentId: board, text: 'Title' })
    const box = createNode(doc, { type: 'rect', parentId: board, index: 0 })
    setTokens(doc, { '--color-primary': { type: 'color', value: '#141414' } })

    const snap = toSnapshot(doc)
    expect(snap.name).toBe('Snap')
    expect(snap.pageIds).toEqual([pageId])
    expect(snap.nodes[pageId]!.children).toEqual([board])
    expect(snap.nodes[board]).toMatchObject({ parentId: pageId, children: [box, title] })
    expect(snap.nodes[title]).toMatchObject({ type: 'text', text: 'Title', parentId: board })
    expect(snap.tokens).toEqual({ '--color-primary': { type: 'color', value: '#141414' } })
    expect(Object.keys(snap.nodes).sort()).toEqual([pageId, board, title, box].sort())
  })

  it('agrees with getNode for every node', () => {
    const { doc, pageId } = docWithPage()
    const f = createNode(doc, { type: 'frame', parentId: pageId, styles: { gap: '8px' } })
    createNode(doc, { type: 'svg', parentId: f, svg: '<svg/>', hidden: true })
    createNode(doc, { type: 'text', parentId: f, text: 'x', locked: false })
    const snap = toSnapshot(doc)
    for (const node of Object.values(snap.nodes)) expect(getNode(doc, node.id)).toEqual(node)
  })

  it('returns a plain, detached object', () => {
    const { doc, pageId } = docWithPage()
    const snap = toSnapshot(doc)
    createNode(doc, { type: 'rect', parentId: pageId })
    expect(snap.nodes[pageId]!.children).toEqual([])
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
  })
})

describe('toSubtreeSnapshot', () => {
  it('materialises exactly one subtree, matching the full snapshot', () => {
    const doc = generateBenchDoc({ artboards: 3, nodesPerArtboard: 20 })
    const full = toSnapshot(doc)
    const boardId = full.nodes[full.pageIds[0]!]!.children[1]!
    const sub = toSubtreeSnapshot(doc, boardId)!
    expect(Object.keys(sub.nodes)).toHaveLength(21)
    for (const node of Object.values(sub.nodes)) expect(node).toEqual(full.nodes[node.id])
    expect(sub.nodes[boardId]!.parentId).toBe(full.pageIds[0])
    expect(toSubtreeSnapshot(doc, '999@1')).toBeUndefined()
  })
})
