import { describe, expect, it } from 'vitest'
import {
  escapeSelection,
  marqueeSelection,
  normalizeSelection,
  resolveClickTarget,
  resolveDoubleClickTarget,
  sameSelection,
  toggleInSelection,
  truncateLocked,
  type SelectionContext,
} from '../../src/math/selection.ts'

// page > artboard > section > text ; artboard > rect
const parents: Record<string, string> = {
  artboard: 'page',
  section: 'artboard',
  text: 'section',
  rect: 'artboard',
  other: 'page',
}
const parentOf = (id: string): string | null => parents[id] ?? null

function ctx(selection: string[], locked: string[] = []): SelectionContext {
  return { selection, parentOf, isLocked: (id) => locked.includes(id) }
}

const deepPath = ['artboard', 'section', 'text']

describe('click selection rules', () => {
  it('selects the artboard child under the pointer by default', () => {
    expect(resolveClickTarget(deepPath, ctx([]))).toBe('section')
  })

  it('selects the artboard when its background is hit', () => {
    expect(resolveClickTarget(['artboard'], ctx([]))).toBe('artboard')
  })

  it('Ctrl/Meta-click selects the deepest node', () => {
    expect(resolveClickTarget(deepPath, ctx([]), { deep: true })).toBe('text')
  })

  it('selects whole artboards at LOD', () => {
    expect(resolveClickTarget(deepPath, ctx([]), { lod: true })).toBe('artboard')
  })

  it('keeps an already selected node when clicking inside it', () => {
    expect(resolveClickTarget(deepPath, ctx(['section']))).toBe('section')
  })

  it('stays at the depth of the current selection (siblings)', () => {
    // text is selected; clicking another node inside the same section keeps depth 2.
    expect(resolveClickTarget(['artboard', 'section', 'text2'], ctx(['text']))).toBe('text2')
  })

  it('a selected artboard does not swallow clicks on its children', () => {
    expect(resolveClickTarget(deepPath, ctx(['artboard']))).toBe('section')
  })

  it('skips locked nodes and their descendants', () => {
    expect(resolveClickTarget(deepPath, ctx([], ['section']))).toBe('artboard')
    expect(resolveClickTarget(deepPath, ctx([], ['artboard']))).toBeNull()
    expect(truncateLocked(deepPath, (id) => id === 'text')).toEqual(['artboard', 'section'])
  })
})

describe('double click', () => {
  const isText = (id: string): boolean => id === 'text'
  it('drills one level deeper from the selection', () => {
    expect(resolveDoubleClickTarget(deepPath, ctx(['section']), isText)).toEqual({
      id: 'text',
      editText: false,
    })
  })
  it('starts text editing on a selected text node', () => {
    expect(resolveDoubleClickTarget(deepPath, ctx(['text']), isText)).toEqual({
      id: 'text',
      editText: true,
    })
  })
  it('falls back to the click target without a selection on the path', () => {
    expect(resolveDoubleClickTarget(deepPath, ctx(['other']), isText)).toEqual({
      id: 'section',
      editText: false,
    })
  })
})

describe('selection helpers', () => {
  it('toggles with Shift', () => {
    expect(toggleInSelection(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleInSelection(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('Escape selects parents, never the page', () => {
    expect(escapeSelection(['text'], parentOf, 'page')).toEqual(['section'])
    expect(escapeSelection(['text', 'section'], parentOf, 'page')).toEqual(['section', 'artboard'])
    expect(escapeSelection(['artboard'], parentOf, 'page')).toEqual([])
  })

  it('drops descendants of selected nodes', () => {
    expect(normalizeSelection(['text', 'artboard', 'other'], parentOf)).toEqual([
      'artboard',
      'other',
    ])
  })

  it('compares selections by order', () => {
    expect(sameSelection(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameSelection(['a', 'b'], ['b', 'a'])).toBe(false)
  })
})

describe('marquee', () => {
  const tops = [
    { id: 'A', bounds: { x: 0, y: 0, width: 100, height: 100 }, isFrame: true },
    { id: 'B', bounds: { x: 200, y: 0, width: 100, height: 100 }, isFrame: true },
    { id: 'R', bounds: { x: 400, y: 0, width: 10, height: 10 }, isFrame: false },
    { id: 'L', bounds: { x: 0, y: 200, width: 10, height: 10 }, isFrame: true, locked: true },
  ]
  const kids: Record<
    string,
    {
      id: string
      bounds: { x: number; y: number; width: number; height: number }
      hidden?: boolean
    }[]
  > = {
    A: [
      { id: 'a1', bounds: { x: 10, y: 10, width: 20, height: 20 } },
      { id: 'a2', bounds: { x: 60, y: 60, width: 20, height: 20 } },
      { id: 'a3', bounds: { x: 80, y: 10, width: 5, height: 5 }, hidden: true },
    ],
  }
  const childrenOf = (id: string) => kids[id] ?? null

  it('selects fully enclosed artboards', () => {
    expect(marqueeSelection({ x: -10, y: -10, width: 320, height: 120 }, tops, childrenOf)).toEqual(
      ['A', 'B'],
    )
  })

  it('selects children of partially covered artboards', () => {
    expect(marqueeSelection({ x: 50, y: 50, width: 40, height: 40 }, tops, childrenOf)).toEqual([
      'a2',
    ])
  })

  it('selects touched non-frame top-level nodes and ignores locked ones', () => {
    expect(marqueeSelection({ x: 395, y: -5, width: 10, height: 10 }, tops, childrenOf)).toEqual([
      'R',
    ])
    expect(marqueeSelection({ x: -5, y: 195, width: 30, height: 30 }, tops, childrenOf)).toEqual([])
  })

  it('scoped marquee selects the scope children only (hidden skipped)', () => {
    expect(marqueeSelection({ x: 0, y: 0, width: 100, height: 40 }, tops, childrenOf, 'A')).toEqual(
      ['a1'],
    )
  })
})
