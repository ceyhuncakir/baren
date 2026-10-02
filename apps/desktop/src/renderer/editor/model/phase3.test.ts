import type { ResolvedNode } from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { dropTargetAt, type DndTree } from '../layers/dnd'
import { flattenLayers } from '../layers/flatten'
import { overriddenSections, sectionOfStyle, summarizeOverrides } from './overrides'
import { PASTE_OFFSET, indexAfterSelection, pasteTranslate } from './pastePlacement'
import {
  addVectorPaintPatch,
  dashPatch,
  readDash,
  readVectorPaint,
  removeVectorPaintPatch,
  toggleVectorPaintPatch,
  vectorPaintColorPatch,
} from './vectorPaint'

describe('paste placement (contract §7.4)', () => {
  const bounds = { x: 100, y: 100, width: 50, height: 40 }
  const viewport = { x: 0, y: 0, width: 1000, height: 800 }

  it('paste in place keeps the copied position', () => {
    expect(
      pasteTranslate({ mode: 'inPlace', bounds, sameFile: false, viewport, target: null }),
    ).toEqual({ dx: 0, dy: 0 })
  })

  it('offsets by 24 in the same file while the copy is visible', () => {
    expect(
      pasteTranslate({ mode: 'paste', bounds, sameFile: true, viewport, target: null }),
    ).toEqual({ dx: PASTE_OFFSET, dy: PASTE_OFFSET })
  })

  it('centres on the viewport for another file (page target)', () => {
    expect(
      pasteTranslate({ mode: 'paste', bounds, sameFile: false, viewport, target: null }),
    ).toEqual({ dx: 500 - 125, dy: 400 - 120 })
  })

  it('centres in a frame target, clamped to its top-left', () => {
    const target = { x: 1000, y: 1000, width: 200, height: 20 }
    expect(pasteTranslate({ mode: 'paste', bounds, sameFile: true, viewport, target })).toEqual({
      dx: 1000 + 75 - 100,
      dy: 1000 - 100,
    })
  })

  it('puts the copy at the clicked point for "Paste here"', () => {
    expect(
      pasteTranslate({
        mode: 'here',
        bounds,
        sameFile: true,
        viewport,
        target: null,
        point: { x: 300, y: 20 },
      }),
    ).toEqual({ dx: 200, dy: -80 })
  })

  it('inserts after the last selected sibling', () => {
    expect(indexAfterSelection(['a', 'b', 'c'], ['b', 'a'])).toBe(2)
    expect(indexAfterSelection(['a', 'b'], ['x'])).toBeUndefined()
  })
})

describe('override summaries (artboard 31)', () => {
  const base = (id: string, overridden?: ResolvedNode['overridden']): ResolvedNode => ({
    id,
    type: 'frame',
    name: id,
    parentId: null,
    children: [],
    styles: {},
    ...(overridden ? { overridden } : {}),
  })
  const nodes: Record<string, ResolvedNode> = {
    I: base('I', { styles: ['width'], text: false, hidden: false, assetId: false }),
    'I/btn': base('I/btn', {
      styles: ['backgroundColor'],
      text: false,
      hidden: false,
      assetId: false,
    }),
    'I/btn/label': base('I/btn/label', { styles: [], text: true, hidden: false, assetId: false }),
    'I/other': base('I/other', { styles: [], text: false, hidden: true, assetId: false }),
  }

  it('counts a virtual node with what is below it, kinds in display order', () => {
    expect(summarizeOverrides(nodes, 'I/btn')).toEqual({ count: 2, kinds: ['Text', 'Fill'] })
  })

  it('counts everything for an instance root', () => {
    expect(summarizeOverrides(nodes, 'I')).toEqual({
      count: 4,
      kinds: ['Text', 'Visibility', 'Layout', 'Fill'],
    })
  })

  it('maps style keys to inspector sections', () => {
    expect(sectionOfStyle('backgroundColor')).toBe('Fill')
    expect(sectionOfStyle('--hidden-backgroundColor')).toBe('Fill')
    expect(sectionOfStyle('strokeWidth')).toBe('Stroke')
    expect(sectionOfStyle('borderTopLeftRadius')).toBe('Radius')
    expect(sectionOfStyle('borderTopWidth')).toBe('Border')
    expect(sectionOfStyle('fontSize')).toBe('Typography')
    expect(sectionOfStyle('rotate')).toBe('Layout')
    expect([...overriddenSections([nodes['I/btn'] as ResolvedNode])]).toEqual(['Fill'])
  })
})

describe('vector paint (contract §2.6)', () => {
  it('reads fill and stroke, treating "none" as absent and keeping hidden paints', () => {
    expect(readVectorPaint({ fill: '#FF0000' }, 'fill')).toMatchObject({ hidden: false })
    expect(readVectorPaint({ fill: 'none' }, 'fill')).toBeNull()
    expect(readVectorPaint({ fill: 'none', '--hidden-fill': '#00FF00' }, 'fill')).toMatchObject({
      value: '#00FF00',
      hidden: true,
    })
  })

  it('never leaves an SVG fill absent (that would paint black)', () => {
    expect(removeVectorPaintPatch('fill')).toEqual({ fill: 'none', '--hidden-fill': null })
    const paint = readVectorPaint({ fill: '#123456' }, 'fill')
    expect(paint && toggleVectorPaintPatch(paint)).toEqual({
      fill: 'none',
      '--hidden-fill': '#123456',
    })
    expect(addVectorPaintPatch('stroke')).toMatchObject({ stroke: '#000000', strokeWidth: 1 })
    expect(vectorPaintColorPatch(null, 'stroke', '#FF0000')).toEqual({ stroke: '#FF0000' })
  })

  it('dash patterns follow the stroke width', () => {
    expect(dashPatch({ strokeWidth: 2 }, 'dashed')).toEqual({ strokeDasharray: '6 4' })
    expect(readDash({ strokeWidth: 2, strokeDasharray: '6 4' })).toBe('dashed')
    expect(readDash({ strokeWidth: 2, strokeDasharray: '0 4' })).toBe('dotted')
    expect(dashPatch({}, 'solid')).toEqual({ strokeDasharray: null })
  })
})

describe('layer rows for groups and instances', () => {
  /**
   * page
   *  ├ G (group) ─ R (rect)
   *  └ I (instance) ─ I/a (virtual frame) ─ I/a/b (virtual text)
   */
  const CHILDREN: Record<string, string[]> = {
    page: ['G', 'I'],
    G: ['R'],
    R: [],
    I: ['I/a'],
    'I/a': ['I/a/b'],
    'I/a/b': [],
  }
  const META: Record<string, { type: string; virtual?: boolean }> = {
    page: { type: 'page' },
    G: { type: 'group' },
    R: { type: 'rect' },
    I: { type: 'instance' },
    'I/a': { type: 'frame', virtual: true },
    'I/a/b': { type: 'text', virtual: true },
  }
  const PARENT: Record<string, string> = {
    G: 'page',
    I: 'page',
    R: 'G',
    'I/a': 'I',
    'I/a/b': 'I/a',
  }
  const tree: DndTree = {
    children: (id) => CHILDREN[id] ?? [],
    meta: (id) => META[id] ?? null,
    parent: (id) => PARENT[id] ?? null,
  }

  it('expands groups and instances (resolved content)', () => {
    const rows = flattenLayers(tree, 'page', new Set(['G', 'I', 'I/a']))
    expect(rows.map((r) => `${r.depth}:${r.id}`)).toEqual(['0:G', '1:R', '0:I', '1:I/a', '2:I/a/b'])
  })

  it('accepts drops into groups but never into instances or their content', () => {
    const rows = flattenLayers(tree, 'page', new Set(['G', 'I', 'I/a']))
    const dragged = new Set(['X'])
    // Middle of the group row → inside the group.
    expect(dropTargetAt(rows, 14, 28, tree, 'page', dragged)).toMatchObject({
      parentId: 'G',
      position: 'inside',
    })
    // Middle of the instance row → before/after it on the page, never inside.
    expect(dropTargetAt(rows, 2 * 28 + 10, 28, tree, 'page', dragged)).toMatchObject({
      parentId: 'page',
    })
    // Rows of instance content refuse every drop.
    expect(dropTargetAt(rows, 3 * 28 + 14, 28, tree, 'page', dragged)).toBeNull()
    expect(dropTargetAt(rows, 4 * 28 + 4, 28, tree, 'page', dragged)).toBeNull()
    // A refused parent (component cycle) shows no indicator.
    expect(dropTargetAt(rows, 14, 28, tree, 'page', dragged, () => false)).toBeNull()
  })
})
