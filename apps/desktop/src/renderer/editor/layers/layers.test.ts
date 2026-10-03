import { describe, expect, it } from 'vitest'
import { editorKeyAction } from '../commands/keymap'
import { formatShortcut } from '../commands/shortcutLabels'
import { dropTargetAt, type DndTree } from './dnd'
import { flattenLayers, indexOfRow, rowState } from './flatten'

/**
 * page
 *  ├ A (frame)
 *  │  ├ A1 (frame)
 *  │  │  └ A1a (text)
 *  │  └ A2 (rect)
 *  └ B (frame, empty)
 */
const CHILDREN: Record<string, string[]> = {
  page: ['A', 'B'],
  A: ['A1', 'A2'],
  A1: ['A1a'],
  A1a: [],
  A2: [],
  B: [],
}
const TYPES: Record<string, string> = {
  page: 'page',
  A: 'frame',
  A1: 'frame',
  A1a: 'text',
  A2: 'rect',
  B: 'frame',
}
const PARENT: Record<string, string> = { A: 'page', B: 'page', A1: 'A', A2: 'A', A1a: 'A1' }

const tree: DndTree = {
  children: (id) => CHILDREN[id] ?? [],
  meta: (id) => (TYPES[id] ? { type: TYPES[id] as string } : null),
  parent: (id) => PARENT[id] ?? null,
}

describe('flattenLayers', () => {
  it('lists artboards and descends only into expanded frames', () => {
    expect(
      flattenLayers(tree, 'page', new Set()).map((r) => [r.id, r.depth, r.expandable]),
    ).toEqual([
      ['A', 0, true],
      ['B', 0, false],
    ])
    const rows = flattenLayers(tree, 'page', new Set(['A', 'A1']))
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.id}`)).toEqual([
      'A',
      '  A1',
      '    A1a',
      '  A2',
      'B',
    ])
    expect(rows.map((r) => r.parentIndex)).toEqual([-1, 0, 1, 0, -1])
    expect(indexOfRow(rows, 'A2')).toBe(3)
  })

  it('marks the selection and rows inside the selection parent (artboard 14)', () => {
    const rows = flattenLayers(tree, 'page', new Set(['A', 'A1']))
    const selected = new Set(['A1a'])
    const scope = new Set(['A1'])
    expect(rows.map((_, i) => rowState(rows, i, selected, scope))).toEqual([
      'idle',
      'ancestor',
      'selected',
      'idle',
      'idle',
    ])
  })
})

describe('dropTargetAt', () => {
  const rows = flattenLayers(tree, 'page', new Set(['A', 'A1']))
  const H = 28

  it('drops before/after leaves and inside frames', () => {
    // Row 3 = A2 (rect): top half → before, bottom half → after.
    expect(dropTargetAt(rows, 3 * H + 5, H, tree, 'page', new Set(['B']))).toEqual({
      rowId: 'A2',
      position: 'before',
      parentId: 'A',
      index: 1,
    })
    expect(dropTargetAt(rows, 3 * H + 20, H, tree, 'page', new Set(['B']))).toMatchObject({
      position: 'after',
      parentId: 'A',
      index: 2,
    })
    // Row 4 = B (frame): middle → inside.
    expect(dropTargetAt(rows, 4 * H + 14, H, tree, 'page', new Set(['A2']))).toMatchObject({
      position: 'inside',
      parentId: 'B',
      index: 0,
    })
    // "After" an expanded frame inserts as its first child.
    expect(dropTargetAt(rows, 1 * H + 26, H, tree, 'page', new Set(['B']))).toMatchObject({
      parentId: 'A1',
      index: 0,
    })
    // Below the list: append to the page.
    expect(dropTargetAt(rows, 40 * H, H, tree, 'page', new Set(['A2']))).toMatchObject({
      parentId: 'page',
      index: 2,
    })
  })

  it('refuses drops into the dragged subtree', () => {
    expect(dropTargetAt(rows, 2 * H + 14, H, tree, 'page', new Set(['A']))).toBeNull()
    expect(dropTargetAt(rows, 1 * H + 14, H, tree, 'page', new Set(['A1']))).toBeNull()
  })
})

describe('keyboard map', () => {
  const key = (
    k: string,
    extra: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> & {
      code?: string
    } = {},
  ) => ({
    key: k,
    code: extra.code ?? '',
    ctrlKey: extra.ctrlKey ?? false,
    metaKey: extra.metaKey ?? false,
    shiftKey: extra.shiftKey ?? false,
    altKey: extra.altKey ?? false,
  })

  it('maps editor shortcuts on Linux/Windows', () => {
    expect(editorKeyAction(key('=', { ctrlKey: true, code: 'Equal' }), 'linux')).toEqual({
      kind: 'zoomIn',
    })
    expect(editorKeyAction(key('0', { ctrlKey: true }), 'linux')).toEqual({ kind: 'zoom100' })
    expect(editorKeyAction(key('!', { shiftKey: true, code: 'Digit1' }), 'linux')).toEqual({
      kind: 'zoomToFit',
    })
    expect(editorKeyAction(key('A', { shiftKey: true, code: 'KeyA' }), 'linux')).toEqual({
      kind: 'addFlex',
    })
    expect(
      editorKeyAction(key('g', { ctrlKey: true, altKey: true, code: 'KeyG' }), 'linux'),
    ).toEqual({
      kind: 'wrapInFrame',
    })
    expect(
      editorKeyAction(key('L', { ctrlKey: true, shiftKey: true, code: 'KeyL' }), 'linux'),
    ).toEqual({
      kind: 'toggleLock',
    })
    expect(editorKeyAction(key(']', { ctrlKey: true }), 'linux')).toEqual({ kind: 'bringToFront' })
    expect(editorKeyAction(key('c', { altKey: true, code: 'KeyC' }), 'linux')).toEqual({
      kind: 'toggleClip',
    })
    expect(
      editorKeyAction(key('C', { ctrlKey: true, shiftKey: true, code: 'KeyC' }), 'linux'),
    ).toEqual({ kind: 'copyAgentContext' })
    expect(editorKeyAction(key('F2'), 'linux')).toEqual({ kind: 'rename' })
    expect(editorKeyAction(key('r'), 'linux')).toEqual({ kind: 'tool', tool: 'rectangle' })
    expect(editorKeyAction(key('I', { shiftKey: true, code: 'KeyI' }), 'linux')).toEqual({
      kind: 'tool',
      tool: 'image',
    })
    // Undo and friends belong to the app's command registry.
    expect(editorKeyAction(key('z', { ctrlKey: true }), 'linux')).toBeNull()
  })

  it('uses Cmd on macOS', () => {
    expect(editorKeyAction(key('d', { metaKey: true }), 'darwin')).toEqual({ kind: 'duplicate' })
    expect(editorKeyAction(key('d', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(
      editorKeyAction(key('c', { metaKey: true, shiftKey: true, code: 'KeyC' }), 'darwin'),
    ).toEqual({ kind: 'copyAgentContext' })
  })

  it('formats shortcut labels per platform', () => {
    expect(formatShortcut('Mod+Shift+L', 'linux')).toBe('Ctrl+Shift+L')
    expect(formatShortcut('Mod+=', 'win32')).toBe('Ctrl+=')
    expect(formatShortcut('Mod+Shift+L', 'darwin')).toBe('⇧⌘L')
    expect(formatShortcut('Mod+Alt+C', 'darwin')).toBe('⌥⌘C')
  })
})
