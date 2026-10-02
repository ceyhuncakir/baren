import { describe, expect, it } from 'vitest'
import {
  SchemaError,
  createNode,
  deleteNode,
  getChildIds,
  getNode,
  getParentId,
  hasNode,
  moveNode,
  setNodeProps,
  setStyle,
  setStyles,
  setText,
  toSnapshot,
} from '../src/index.ts'
import { docWithPage } from './helpers.ts'

function names(doc: Parameters<typeof getChildIds>[0], parentId: string): string[] {
  return getChildIds(doc, parentId).map((id) => getNode(doc, id)!.name)
}

describe('createNode', () => {
  it('creates nodes with defaults and initial data', () => {
    const { doc, pageId } = docWithPage()
    const frame = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 40, top: 80, width: 1440, height: 900, display: 'flex' },
    })
    const text = createNode(doc, { type: 'text', parentId: frame, text: 'Hello', name: 'Title' })
    const svg = createNode(doc, { type: 'svg', parentId: frame, svg: '<svg/>', locked: true })
    const image = createNode(doc, { type: 'image', parentId: frame, assetId: 'abc', hidden: true })

    expect(getNode(doc, frame)).toEqual({
      id: frame,
      type: 'frame',
      name: 'Frame',
      parentId: pageId,
      children: [text, svg, image],
      styles: { left: 40, top: 80, width: 1440, height: 900, display: 'flex' },
    })
    expect(getNode(doc, text)).toMatchObject({ type: 'text', name: 'Title', text: 'Hello' })
    expect(getNode(doc, svg)).toMatchObject({
      type: 'svg',
      name: 'Vector',
      svg: '<svg/>',
      locked: true,
    })
    expect(getNode(doc, image)).toMatchObject({ assetId: 'abc', hidden: true })
    expect(createNode(doc, { type: 'text', parentId: frame })).toSatisfy(
      (id: string) => getNode(doc, id)!.text === '',
    )
  })

  it('inserts at an index and clamps out-of-range indices', () => {
    const { doc, pageId } = docWithPage()
    createNode(doc, { type: 'rect', parentId: pageId, name: 'b' })
    createNode(doc, { type: 'rect', parentId: pageId, name: 'd' })
    createNode(doc, { type: 'rect', parentId: pageId, name: 'a', index: 0 })
    createNode(doc, { type: 'rect', parentId: pageId, name: 'c', index: 2 })
    createNode(doc, { type: 'rect', parentId: pageId, name: 'e', index: 99 })
    createNode(doc, { type: 'rect', parentId: pageId, name: '_', index: -5 })
    expect(names(doc, pageId)).toEqual(['_', 'a', 'b', 'c', 'd', 'e'])
  })

  it('enforces the tree rules', () => {
    const { doc, pageId } = docWithPage()
    const text = createNode(doc, { type: 'text', parentId: pageId })
    const err = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return e instanceof SchemaError ? e.code : 'other'
      }
      return 'none'
    }
    expect(err(() => createNode(doc, { type: 'page', parentId: pageId }))).toBe('invalid-parent')
    expect(err(() => createNode(doc, { type: 'frame', parentId: null }))).toBe('invalid-parent')
    expect(err(() => createNode(doc, { type: 'rect', parentId: text }))).toBe('invalid-parent')
    expect(err(() => createNode(doc, { type: 'rect', parentId: '1@1' }))).toBe('node-not-found')
    expect(err(() => createNode(doc, { type: 'rect', parentId: 'nope' }))).toBe('invalid-id')
    expect(err(() => createNode(doc, { type: 'rect', parentId: pageId, text: 'x' }))).toBe(
      'invalid-type',
    )
    expect(err(() => createNode(doc, { type: 'blob' as 'rect', parentId: pageId }))).toBe(
      'invalid-type',
    )
    expect(
      err(() => createNode(doc, { type: 'rect', parentId: pageId, styles: { width: Infinity } })),
    ).toBe('invalid-type')
    // A second page is fine.
    expect(err(() => createNode(doc, { type: 'page', parentId: null, name: 'Page 2' }))).toBe(
      'none',
    )
    expect(getChildIds(doc, null)).toHaveLength(2)
  })
})

describe('moveNode', () => {
  it('reorders siblings; index is the final position', () => {
    const { doc, pageId } = docWithPage()
    const [a, , , d] = ['a', 'b', 'c', 'd'].map((name) =>
      createNode(doc, { type: 'rect', parentId: pageId, name }),
    )
    moveNode(doc, a!, pageId, 2)
    expect(names(doc, pageId)).toEqual(['b', 'c', 'a', 'd'])
    moveNode(doc, d!, pageId, 0)
    expect(names(doc, pageId)).toEqual(['d', 'b', 'c', 'a'])
    moveNode(doc, d!, pageId, 99)
    expect(names(doc, pageId)).toEqual(['b', 'c', 'a', 'd'])
    moveNode(doc, a!, pageId) // append
    expect(names(doc, pageId)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('does not write an op when nothing moves', () => {
    const { doc, pageId } = docWithPage()
    const a = createNode(doc, { type: 'rect', parentId: pageId })
    createNode(doc, { type: 'rect', parentId: pageId })
    const before = doc.oplogVersion().toJSON()
    moveNode(doc, a, pageId, 0)
    expect(doc.oplogVersion().toJSON()).toEqual(before)
  })

  it('reparents across frames and pages', () => {
    const { doc, pageId } = docWithPage()
    const page2 = createNode(doc, { type: 'page', parentId: null, name: 'Page 2' })
    const f1 = createNode(doc, { type: 'frame', parentId: pageId, name: 'f1' })
    const f2 = createNode(doc, { type: 'frame', parentId: pageId, name: 'f2' })
    const child = createNode(doc, { type: 'text', parentId: f1, text: 'x' })
    const sibling = createNode(doc, { type: 'rect', parentId: f2, name: 's' })

    moveNode(doc, child, f2, 0)
    expect(getParentId(doc, child)).toBe(f2)
    expect(getChildIds(doc, f2)).toEqual([child, sibling])
    expect(getChildIds(doc, f1)).toEqual([])

    moveNode(doc, f2, page2)
    expect(getParentId(doc, f2)).toBe(page2)
    expect(getParentId(doc, child)).toBe(f2) // subtree moves along
    expect(getChildIds(doc, pageId)).toEqual([f1])
  })

  it('rejects cycles and invalid parents', () => {
    const { doc, pageId } = docWithPage()
    const outer = createNode(doc, { type: 'frame', parentId: pageId })
    const inner = createNode(doc, { type: 'frame', parentId: outer })
    const text = createNode(doc, { type: 'text', parentId: pageId })
    expect(() => moveNode(doc, outer, inner)).toThrow(SchemaError)
    expect(() => moveNode(doc, inner, text)).toThrow(/cannot contain children/)
    expect(() => moveNode(doc, inner, null)).toThrow(/parent page or frame/)
    expect(() => moveNode(doc, pageId, outer)).toThrow(/Pages must be root/)
    expect(getParentId(doc, inner)).toBe(outer)
  })

  it('reorders pages', () => {
    const { doc, pageId } = docWithPage()
    const page2 = createNode(doc, { type: 'page', parentId: null })
    moveNode(doc, page2, null, 0)
    expect(getChildIds(doc, null)).toEqual([page2, pageId])
  })
})

describe('deleteNode', () => {
  it('removes the whole subtree', () => {
    const { doc, pageId } = docWithPage()
    const frame = createNode(doc, { type: 'frame', parentId: pageId })
    const child = createNode(doc, { type: 'rect', parentId: frame })
    deleteNode(doc, frame)
    expect(hasNode(doc, frame)).toBe(false)
    expect(hasNode(doc, child)).toBe(false)
    expect(getNode(doc, child)).toBeUndefined()
    expect(getChildIds(doc, pageId)).toEqual([])
    expect(Object.keys(toSnapshot(doc).nodes)).toEqual([pageId])
    expect(() => deleteNode(doc, frame)).toThrow(SchemaError)
    expect(hasNode(doc, 'garbage')).toBe(false)
  })
})

describe('styles, text and props', () => {
  it('sets and removes styles', () => {
    const { doc, pageId } = docWithPage()
    const id = createNode(doc, { type: 'rect', parentId: pageId, styles: { width: 10 } })
    setStyle(doc, id, 'height', '20px')
    setStyles(doc, id, { width: null, backgroundColor: 'var(--color-surface)', opacity: 0.5 })
    expect(getNode(doc, id)!.styles).toEqual({
      height: '20px',
      backgroundColor: 'var(--color-surface)',
      opacity: 0.5,
    })
    setStyle(doc, id, 'height', null)
    expect(getNode(doc, id)!.styles).not.toHaveProperty('height')
    expect(() => setStyle(doc, id, 'width', Number.NaN)).toThrow(SchemaError)
  })

  it('skips unchanged style writes', () => {
    const { doc, pageId } = docWithPage()
    const id = createNode(doc, { type: 'rect', parentId: pageId, styles: { width: 10 } })
    const before = doc.oplogVersion().toJSON()
    setStyles(doc, id, { width: 10, missing: null })
    expect(doc.oplogVersion().toJSON()).toEqual(before)
  })

  it('updates text by diff and rejects non-text nodes', () => {
    const { doc, pageId } = docWithPage()
    const id = createNode(doc, { type: 'text', parentId: pageId, text: 'Hello world' })
    setText(doc, id, 'Hello brave world')
    expect(getNode(doc, id)!.text).toBe('Hello brave world')
    const rect = createNode(doc, { type: 'rect', parentId: pageId })
    expect(() => setText(doc, rect, 'x')).toThrow(/not text/)
  })

  it('patches props', () => {
    const { doc, pageId } = docWithPage()
    const id = createNode(doc, { type: 'frame', parentId: pageId, name: 'Card' })
    setNodeProps(doc, id, { name: 'Hero', locked: true, hidden: true })
    expect(getNode(doc, id)).toMatchObject({ name: 'Hero', locked: true, hidden: true })
    setNodeProps(doc, id, { locked: null, hidden: false, name: null })
    const node = getNode(doc, id)!
    expect(node.locked).toBeUndefined()
    expect(node.hidden).toBe(false)
    expect(node.name).toBe('')
    expect(() => setNodeProps(doc, id, { locked: 'yes' as unknown as boolean })).toThrow(
      SchemaError,
    )
    setNodeProps(doc, pageId, { background: '#FFFFFF' })
    expect(getNode(doc, pageId)!.background).toBe('#FFFFFF')
  })
})
