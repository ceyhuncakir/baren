import { describe, expect, it } from 'vitest'
import {
  createEmptyDoc,
  createNode,
  getChildIds,
  getNode,
  subscribeNodes,
  type NodeChangeBatch,
} from '@baren/schema'
import { History } from '../../src/doc/history.ts'
import {
  ORIGIN,
  commitGeometry,
  commitReorder,
  deleteNodes,
  duplicateNodes,
  geometryValue,
} from '../../src/doc/ops.ts'
import { readProps, readStyleValues, readText, topLevelOf } from '../../src/doc/read.ts'

function fixture() {
  const doc = createEmptyDoc('t', { peerId: 7 })
  const page = getChildIds(doc, null)[0] as string
  const board = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Board',
    styles: { left: 0, top: 0, width: 400, height: '300px' },
  })
  const a = createNode(doc, {
    type: 'rect',
    parentId: board,
    name: 'A',
    styles: { position: 'absolute', left: '10px', top: 10, width: 20, height: 20 },
  })
  const b = createNode(doc, { type: 'text', parentId: board, name: 'B', text: 'hello' })
  const c = createNode(doc, { type: 'rect', parentId: board, name: 'C' })
  return { doc, page, board, a, b, c }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('document ops', () => {
  it('preserves the existing value format for geometry', () => {
    expect(geometryValue('10px', 12)).toBe('12px')
    expect(geometryValue(10, 12.345)).toBe(12.35)
    expect(geometryValue(undefined, 3)).toBe(3)
  })

  it('commits geometry for many nodes in one transaction', async () => {
    const { doc, board, a } = fixture()
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (b) => batches.push(b))
    commitGeometry(
      doc,
      [
        { id: a, left: 15, top: 25 },
        { id: board, width: 500, height: 320 },
      ],
      ORIGIN.move,
    )
    await flush()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.origin).toBe(ORIGIN.move)
    expect(readStyleValues(doc, a, ['left', 'top'])).toEqual({ left: '15px', top: 25 })
    expect(readStyleValues(doc, board, ['width', 'height'])).toEqual({
      width: 500,
      height: '320px',
    })
  })

  it('reorders siblings to a final index', () => {
    const { doc, board, a, b, c } = fixture()
    commitReorder(doc, [a], board, 2, ORIGIN.reorder)
    expect(getChildIds(doc, board)).toEqual([b, c, a])
    commitReorder(doc, [c, a], board, 0, ORIGIN.reorder)
    expect(getChildIds(doc, board)).toEqual([c, a, b])
  })

  it('duplicates subtrees right after the original with overrides', () => {
    const { doc, page, board } = fixture()
    const [copy] = duplicateNodes(doc, [board], (n) => (n.parentId === page ? { left: 480 } : null))
    expect(copy).toBeDefined()
    expect(getChildIds(doc, page)).toEqual([board, copy])
    const node = getNode(doc, copy as string)
    expect(node?.styles['left']).toBe(480)
    expect(node?.children).toHaveLength(3)
    const kids = (node?.children ?? []).map((id) => getNode(doc, id))
    expect(kids.map((k) => k?.name)).toEqual(['A', 'B', 'C'])
    expect(readText(doc, kids[1]?.id as string)).toBe('hello')
  })

  it('deletes nodes in one step and reads props/top-level', () => {
    const { doc, page, board, a, b } = fixture()
    expect(topLevelOf(doc, a, page)).toBe(board)
    expect(topLevelOf(doc, board, page)).toBe(board)
    expect(readProps(doc, b, ['name', 'type'])).toEqual({ name: 'B', type: 'text' })
    deleteNodes(doc, [a, b])
    expect(getChildIds(doc, board)).toHaveLength(1)
    expect(topLevelOf(doc, a, page)).toBeNull()
  })
})

describe('history (Loro UndoManager)', () => {
  it('undoes a whole gesture commit and restores the selection of that time', async () => {
    const { doc, a } = fixture()
    let selection: string[] = [a]
    const history = new History(doc, {
      excludeOriginPrefixes: ['remote'],
      getSelection: () => selection,
      restoreSelection: (ids) => {
        selection = ids
      },
    })
    commitGeometry(doc, [{ id: a, left: 100, top: 100 }], ORIGIN.move)
    selection = []
    expect(history.canUndo()).toBe(true)
    history.undo()
    expect(readStyleValues(doc, a, ['left', 'top'])).toEqual({ left: '10px', top: 10 })
    expect(selection).toEqual([a])
    history.redo()
    expect(readStyleValues(doc, a, ['left'])).toEqual({ left: '100px' })
    history.dispose()
  })

  it('groups commits into one undo step', () => {
    const { doc, a } = fixture()
    const history = new History(doc, {
      excludeOriginPrefixes: [],
      getSelection: () => [],
      restoreSelection: () => {},
    })
    history.groupStart()
    commitGeometry(doc, [{ id: a, left: 1 }], ORIGIN.nudge)
    commitGeometry(doc, [{ id: a, left: 2 }], ORIGIN.nudge)
    history.groupEnd()
    history.undo()
    expect(readStyleValues(doc, a, ['left'])).toEqual({ left: '10px' })
    history.dispose()
  })
})
