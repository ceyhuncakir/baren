import {
  createEmptyDoc,
  createNode,
  getChildIds,
  getNode,
  getParentId,
  subscribeNodes,
  type NodeChangeBatch,
} from '@baren/schema'
import { UndoManager } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  addFlexLayout,
  deleteNodes,
  moveLayers,
  pasteNodes,
  reorder,
  serializeNodes,
  setFlag,
  topmostIds,
  wrapInFrame,
} from './docOps'
import { LayerTree } from './layerTree'
import { cancelPreview, commitStyles, previewStyles } from './previewEdits'

function setup() {
  const doc = createEmptyDoc('test', { peerId: 1 })
  const page = getChildIds(doc, null)[0] as string
  const board = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Board',
    styles: {
      left: 100,
      top: 50,
      width: 400,
      height: 300,
      display: 'flex',
      flexDirection: 'column',
    },
  })
  const a = createNode(doc, { type: 'rect', parentId: board, name: 'A', styles: { width: 10 } })
  const b = createNode(doc, { type: 'text', parentId: board, name: 'B', text: 'hello' })
  const c = createNode(doc, { type: 'frame', parentId: board, name: 'C' })
  return { doc, page, board, a, b, c }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('structure ops', () => {
  it('drops descendants of selected ancestors', () => {
    const { doc, board, a, b } = setup()
    expect(topmostIds(doc, [a, board, b])).toEqual([board])
  })

  it('reorders to front/back in one commit', () => {
    const { doc, board, a, b, c } = setup()
    reorder(doc, [a], 'front')
    expect(getChildIds(doc, board)).toEqual([b, c, a])
    reorder(doc, [c], 'back')
    expect(getChildIds(doc, board)).toEqual([c, b, a])
  })

  it('moves layers into frames and out to the page with position fix-ups', () => {
    const { doc, page, board, a, b, c } = setup()
    const bounds = (id: string) => (id === a ? { x: 100, y: 50, width: 10, height: 10 } : null)
    expect(moveLayers(doc, [a], c, 0, bounds)).toBe(true)
    expect(getParentId(doc, a)).toBe(c)
    // Out to the page: becomes absolutely placed at its world position.
    expect(moveLayers(doc, [a], page, 1, bounds)).toBe(true)
    expect(getChildIds(doc, page)).toEqual([board, a])
    expect(getNode(doc, a)?.styles).toMatchObject({ left: 100, top: 50 })
    // Back into a frame: left/top removed.
    moveLayers(doc, [a], board, 0, bounds)
    expect(getNode(doc, a)?.styles['left']).toBeUndefined()
    expect(getChildIds(doc, board)).toEqual([a, b, c])
    // Never into its own subtree.
    expect(moveLayers(doc, [board], c, 0, bounds)).toBe(false)
  })

  it('moves within the same parent using insertion slots', () => {
    const { doc, board, a, b, c } = setup()
    // Slot 3 = after the last child.
    moveLayers(doc, [a], board, 3, () => null)
    expect(getChildIds(doc, board)).toEqual([b, c, a])
    moveLayers(doc, [a, b], board, 0, () => null)
    expect(getChildIds(doc, board)).toEqual([a, b, c])
  })

  it('wraps siblings in a frame (flex parent → in-flow frame)', () => {
    const { doc, board, a, b, c } = setup()
    const frame = wrapInFrame(doc, [b, a], () => null) as string
    expect(getChildIds(doc, board)).toEqual([frame, c])
    expect(getChildIds(doc, frame)).toEqual([a, b])
    expect(getNode(doc, frame)?.styles).toMatchObject({ display: 'flex', flexDirection: 'column' })
  })

  it('wraps artboards on the page at their union bounds', () => {
    const { doc, page, board } = setup()
    const other = createNode(doc, {
      type: 'frame',
      parentId: page,
      name: 'Other',
      styles: { left: 600, top: 50, width: 100, height: 100 },
    })
    const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
      [board]: { x: 100, y: 50, width: 400, height: 300 },
      [other]: { x: 600, y: 50, width: 100, height: 100 },
    }
    const frame = wrapInFrame(doc, [board, other], (id) => rects[id] ?? null) as string
    expect(getNode(doc, frame)?.styles).toMatchObject({
      left: 100,
      top: 50,
      width: 600,
      height: 300,
    })
    expect(getNode(doc, other)?.styles).toMatchObject({ position: 'absolute', left: 500, top: 0 })
  })

  it('adds flex only to frames and toggles flags', () => {
    const { doc, a, c } = setup()
    addFlexLayout(doc, [a, c])
    expect(getNode(doc, c)?.styles['display']).toBe('flex')
    expect(getNode(doc, a)?.styles['display']).toBeUndefined()
    setFlag(doc, [a, c], 'locked', true)
    expect(getNode(doc, a)?.locked).toBe(true)
    setFlag(doc, [a], 'locked', false)
    expect(getNode(doc, a)?.locked).toBeUndefined()
  })

  it('copies and pastes subtrees with offsets', () => {
    const { doc, page, board, b } = setup()
    const payload = serializeNodes(doc, [board, b])
    expect(payload?.nodes).toHaveLength(1)
    const ids = pasteNodes(doc, payload as NonNullable<typeof payload>, {
      parentId: page,
      offset: 24,
    })
    expect(ids).toHaveLength(1)
    const copy = getNode(doc, ids[0] as string)
    expect(copy?.styles).toMatchObject({ left: 124, top: 74 })
    expect(getChildIds(doc, ids[0] as string)).toHaveLength(3)
    const text = getNode(doc, getChildIds(doc, ids[0] as string)[1] as string)
    expect(text?.text).toBe('hello')
    // Into a frame: page coordinates are dropped.
    const nested = pasteNodes(doc, payload as NonNullable<typeof payload>, { parentId: board })
    expect(getNode(doc, nested[0] as string)?.styles['left']).toBeUndefined()
  })

  it('deletes the topmost nodes only, never pages', () => {
    const { doc, page, board, a } = setup()
    deleteNodes(doc, [page])
    expect(getChildIds(doc, null)).toEqual([page])
    expect(getChildIds(doc, page)).toEqual([board])
    deleteNodes(doc, [a, board])
    expect(getChildIds(doc, page)).toEqual([])
  })
})

describe('previews', () => {
  it('collapses a scrub into one undo step that restores the original', () => {
    const { doc, a } = setup()
    const undo = new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: ['preview'] })
    for (const w of [11, 12, 13]) previewStyles(doc, [a], () => ({ width: w }))
    expect(getNode(doc, a)?.styles['width']).toBe(13)
    commitStyles(doc, [a], () => ({ width: 20 }))
    expect(getNode(doc, a)?.styles['width']).toBe(20)
    undo.undo()
    expect(getNode(doc, a)?.styles['width']).toBe(10)
  })

  it('cancel restores originals, including absent keys', () => {
    const { doc, a } = setup()
    previewStyles(doc, [a], () => ({ height: 5 }))
    cancelPreview(doc)
    expect(getNode(doc, a)?.styles['height']).toBeUndefined()
  })
})

describe('LayerTree cache', () => {
  it('reads lazily and invalidates exactly what changed', async () => {
    const { doc, page, board, a, c } = setup()
    const tree = new LayerTree(doc)
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (batch) => {
      batches.push(batch)
      tree.apply(batch)
    })
    expect(tree.pages()).toEqual([page])
    expect(tree.children(board)).toHaveLength(3)
    expect(tree.meta(board)).toMatchObject({ name: 'Board', kind: 'frame-column' })
    expect(tree.meta(a)).toMatchObject({ kind: 'rect' })
    expect(tree.meta(c)).toMatchObject({ kind: 'frame' })
    const before = tree.version
    setFlag(doc, [a], 'hidden', true)
    await flush()
    expect(tree.version).toBe(before + 1)
    expect(tree.meta(a)?.hidden).toBe(true)
    // Unrelated style changes do not bump the version.
    commitStyles(doc, [a], () => ({ width: 99 }))
    await flush()
    expect(tree.version).toBe(before + 1)
    moveLayers(doc, [a], c, 0, () => null)
    await flush()
    expect(tree.children(c)).toEqual([a])
    expect(tree.parent(a)).toBe(c)
    expect(tree.ancestors(a)).toEqual([c, board, page])
    expect(tree.topLevelOf(a)).toBe(board)
    expect(batches.length).toBeGreaterThan(0)
  })
})

describe('containerForInsert (QA)', () => {
  it('never targets a locked or hidden frame, nor one inside a locked or hidden ancestor', async () => {
    const { containerForInsert } = await import('./docOps')
    const { setNodeProps } = await import('@baren/schema')
    const doc = createEmptyDoc('qa', { peerId: 1 })
    const page = getChildIds(doc, null)[0] as string
    const outer = createNode(doc, { type: 'frame', parentId: page, name: 'Outer', styles: {} })
    const inner = createNode(doc, { type: 'frame', parentId: outer, name: 'Inner', styles: {} })
    const leaf = createNode(doc, { type: 'rect', parentId: inner, name: 'Leaf', styles: {} })
    expect(containerForInsert(doc, [inner], page)).toBe(inner)
    expect(containerForInsert(doc, [leaf], page)).toBe(inner)
    setNodeProps(doc, inner, { locked: true })
    expect(containerForInsert(doc, [inner], page)).toBe(outer)
    expect(containerForInsert(doc, [leaf], page)).toBe(outer)
    setNodeProps(doc, inner, { locked: false })
    setNodeProps(doc, outer, { hidden: true })
    expect(containerForInsert(doc, [inner], page)).toBe(page)
    expect(containerForInsert(doc, [leaf], page)).toBe(page)
    expect(containerForInsert(doc, [], page)).toBe(page)
  })
})
