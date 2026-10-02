import { afterEach, describe, expect, test } from 'vitest'
import type { LoroDoc } from 'loro-crdt'
import {
  createComponent,
  createInstance,
  createNode,
  docGeometry,
  getChildIds,
  getNode,
  transact,
  virtualId,
  type DesignNode,
} from '@baren/schema'
import { HtmlApplyError, applyHtml, parseHtml } from '../src/index.ts'
import { HASH_A, HASH_B, checkInvariants, context, seeded, setup, tree, write } from './helpers.ts'

let current: LoroDoc | null = null
afterEach(() => {
  if (current) expect(checkInvariants(current)).toEqual([])
  current = null
})

function doc0(tokens = {}) {
  const s = setup(tokens)
  current = s.doc
  return s
}

function artboard(
  doc: LoroDoc,
  pageId: string,
  styles: Record<string, string | number> = {},
): string {
  return createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Board',
    styles: {
      left: 0,
      top: 0,
      width: '400px',
      height: '300px',
      display: 'flex',
      flexDirection: 'column',
      ...styles,
    },
  })
}

const node = (doc: LoroDoc, id: string): DesignNode => getNode(doc, id) as DesignNode

describe('insert-children', () => {
  test('appends roots in order under a frame; one transaction', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    createNode(doc, { type: 'text', parentId: board, text: 'existing' })
    const before = doc.oplogVersion()
    const r = write(doc, '<p>one</p><div style="display:flex"><p>two</p></div>', board)
    expect(r.parentId).toBe(board)
    expect(r.replacedId).toBeNull()
    expect(getChildIds(doc, board).slice(1)).toEqual(r.created)
    expect(r.created.map((id) => node(doc, id).type)).toEqual(['text', 'frame'])
    // One commit for the whole call (one change since `before`).
    const changes = doc.exportJsonUpdates(before, doc.oplogVersion()).changes
    expect(changes).toHaveLength(1)
  })
  test('into a group: roots absolute, group refitted', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId, { display: 'block' })
    const group = createNode(doc, {
      type: 'group',
      parentId: board,
      styles: { position: 'absolute', left: 10, top: 10, width: 20, height: 20 },
    })
    createNode(doc, {
      type: 'rect',
      parentId: group,
      styles: { position: 'absolute', left: 0, top: 0, width: 20, height: 20 },
    })
    const r = write(
      doc,
      '<div style="width: 30px; height: 30px; left: 40px; top: 5px"></div>',
      group,
    )
    expect(node(doc, r.created[0]!).styles).toMatchObject({ position: 'absolute' })
    expect(Number.parseFloat(String(node(doc, group).styles['width']))).toBeCloseTo(70)
  })
  test('absolute roots give an unpositioned target frame a containing block', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const card = createNode(doc, {
      type: 'frame',
      parentId: board,
      styles: { display: 'flex', width: '100px', height: '100px' },
    })
    write(
      doc,
      '<div style="position:absolute; left: 4px; top: 4px; width: 8px; height: 8px"></div>',
      card,
    )
    expect(node(doc, card).styles['position']).toBe('relative')
    // Top-level artboards are already positioned by the canvas.
    write(doc, '<div style="position:absolute; left: 4px; top: 4px"></div>', board)
    expect(node(doc, board).styles['position']).toBeUndefined()
  })
  test('invalid targets', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const text = createNode(doc, { type: 'text', parentId: board, text: 't' })
    const run = (target: string, mode: 'insert-children' | 'replace' = 'insert-children') => {
      try {
        write(doc, '<p>x</p>', target, mode)
      } catch (e) {
        return e instanceof HtmlApplyError ? e.code : String(e)
      }
      return 'ok'
    }
    expect(run(text)).toBe('invalid_target')
    expect(run('999@9')).toBe('node_not_found')
    expect(run('not-an-id')).toBe('node_not_found')
    expect(run(pageId, 'replace')).toBe('invalid_target')
    expect(run(`${board}/abcdefghij`)).toBe('instance_content')
  })
  test('too_large: more than 5,000 nodes are refused before anything is written', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const html = '<div style="display:flex">' + '<p>x</p>'.repeat(5001) + '</div>'
    const before = doc.oplogVersion()
    expect(() => write(doc, html, board)).toThrow(HtmlApplyError)
    try {
      write(doc, html, board)
    } catch (e) {
      expect((e as HtmlApplyError).code).toBe('too_large')
    }
    expect(doc.exportJsonUpdates(before, doc.oplogVersion()).changes).toHaveLength(0)
  })
})

describe('replace', () => {
  test('a layer is replaced in place (same index), in order', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const a = createNode(doc, { type: 'text', parentId: board, text: 'a' })
    const b = createNode(doc, { type: 'text', parentId: board, text: 'b' })
    const c = createNode(doc, { type: 'text', parentId: board, text: 'c' })
    const r = write(doc, '<p>b1</p><p>b2</p>', b, 'replace')
    expect(r.replacedId).toBe(b)
    expect(r.parentId).toBe(board)
    expect(getChildIds(doc, board)).toEqual([a, ...r.created, c])
    expect(getNode(doc, b)).toBeUndefined()
  })
  test('HTML that creates nothing never deletes the target', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const a = createNode(doc, { type: 'text', parentId: board, text: 'a' })
    for (const html of ['<script>x()</script>', '', '<x-baren-clone node-id="9@9" />']) {
      let code = ''
      try {
        write(doc, html, a, 'replace')
      } catch (e) {
        code = (e as HtmlApplyError).code
      }
      expect(code).toBe('invalid_target')
      expect(getNode(doc, a)).toBeDefined()
    }
  })
  test('an artboard keeps its position (first root) and size defaults', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId, { left: 120, top: 340, width: '390px', height: '844px' })
    const r = write(
      doc,
      '<div style="display:flex; background: #fff"><p>hi</p></div>',
      board,
      'replace',
    )
    const root = node(doc, r.created[0]!)
    expect(root.parentId).toBe(pageId)
    expect(root.styles).toMatchObject({ left: 120, top: 340, width: '390px', height: '844px' })
    expect(r.warnings.map((w) => w.code)).toContain('artboard-size-defaulted')
    const own = write(
      doc,
      '<div style="left: 5px; top: 6px; width: 10px; height: 10px"></div>',
      r.created[0]!,
      'replace',
    )
    expect(node(doc, own.created[0]!).styles).toMatchObject({ left: '5px', top: '6px' })
  })
})

describe('page target', () => {
  test('each root becomes an artboard placed after the previous one; sizes default', () => {
    const { doc, pageId } = doc0()
    artboard(doc, pageId, { left: 0, top: 0, width: '400px' })
    const r = write(
      doc,
      '<div style="width: 390px; height: 844px"></div><section style="display:flex"><p>x</p></section>',
      pageId,
    )
    const [a, b] = r.created.map((id) => node(doc, id))
    expect(a!.styles).toMatchObject({ left: 480, top: 0, width: '390px', height: '844px' })
    expect(b!.styles).toMatchObject({ left: 950, top: 0, width: '1440px', height: 'fit-content' })
    expect(
      r.warnings.filter((w) => w.code === 'artboard-size-defaulted').map((w) => w.path),
    ).toEqual(['section[2]'])
  })
  test('explicit left/top win; position keys are dropped on artboards', () => {
    const { doc, pageId } = doc0()
    const r = write(
      doc,
      '<div style="position: absolute; left: 10px; top: 20px; right: 0; width: 100px; height: 100px"></div>',
      pageId,
    )
    const s = node(doc, r.created[0]!).styles
    expect(s).toMatchObject({ left: '10px', top: '20px' })
    expect(s['position']).toBeUndefined()
    expect(s['right']).toBeUndefined()
  })
})

describe('images (§7.8)', () => {
  test('raster with size from styles, attributes, aspect ratio or natural size', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const r = write(
      doc,
      [
        '<img src="/Users/ana/brand/logo.png" style="width: 80px; height: 30px; object-fit: cover">',
        '<img src="/Users/ana/brand/logo.png" width="60">',
        '<img src="https://example.com/photo.jpg">',
        '<img src="file:///Users/ana/hero.png" alt="Hero" style="height: 120px">',
      ].join(''),
      board,
    )
    const imgs = r.created.map((id) => node(doc, id))
    expect(imgs.map((n) => [n.type, n.assetId, n.assetName, n.name])).toEqual([
      ['image', HASH_A, 'logo', 'logo'],
      ['image', HASH_A, 'logo', 'logo'],
      ['image', HASH_B, 'photo', 'photo'],
      ['image', HASH_A, 'hero', 'Hero'],
    ])
    expect(imgs.map((n) => [n.styles['width'], n.styles['height']])).toEqual([
      ['80px', '30px'],
      [60, 30],
      [1200, 800],
      [160, '120px'],
    ])
    expect(imgs[0]!.styles['objectFit']).toBe('cover')
    expect(imgs[1]!.styles['objectFit']).toBeUndefined()
    expect(r.warnings).toEqual([])
  })
  test('svg sources become sanitised svg layers sized from the file', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const r = write(
      doc,
      '<img src="/Users/ana/icon.svg"><img src="data:image/svg+xml,%3Csvg width=%2210%22 height=%2220%22%3E%3C/svg%3E" alt="Inline">',
      board,
    )
    const [a, b] = r.created.map((id) => node(doc, id))
    expect(a!.type).toBe('svg')
    expect(a!.svg).not.toContain('script')
    expect(a!.name).toBe('icon')
    expect([a!.styles['width'], a!.styles['height']]).toEqual([32, 16])
    expect(b!.type).toBe('svg')
    expect(b!.name).toBe('Inline')
    expect([b!.styles['width'], b!.styles['height']]).toEqual([10, 20])
  })
  test('data URIs resolved by the runtime; base64 svg data URIs decoded here', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const svg64 = Buffer.from('<svg viewBox="0 0 8 4"><rect width="8" height="4"/></svg>').toString(
      'base64',
    )
    const r = write(
      doc,
      `<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml;base64,${svg64}">`,
      board,
    )
    const [a, b] = r.created.map((id) => node(doc, id))
    expect(a!.assetId).toBe(HASH_B)
    expect(b!.type).toBe('svg')
    expect([b!.styles['width'], b!.styles['height']]).toEqual([8, 4])
  })
  test('unresolved sources leave a placeholder image and a warning', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const r = write(
      doc,
      '<img src="/missing.png" style="width: 40px"><img src="relative.png"><img src="ftp://example.com/cat.png">',
      board,
    )
    const imgs = r.created.map((id) => node(doc, id))
    expect(imgs.every((n) => n.type === 'image' && n.assetId === undefined)).toBe(true)
    expect(imgs.map((n) => [n.styles['width'], n.styles['height']])).toEqual([
      ['40px', 100],
      [100, 100],
      [100, 100],
    ])
    expect(r.warnings.map((w) => w.code)).toEqual([
      'image-unresolved',
      'image-unresolved',
      'image-unresolved',
    ])
  })
  test('image fills in styles are rewritten or dropped', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const r = write(
      doc,
      '<div style="width:10px;height:10px;background: #000 url(/Users/ana/brand/logo.png) center / cover no-repeat"></div><div style="background-image: url(/missing.png); color: red"></div>',
      board,
    )
    const [a, b] = r.created.map((id) => node(doc, id))
    expect(a!.styles).toMatchObject({
      backgroundColor: '#000',
      backgroundImage: `url("baren-asset://${HASH_A}")`,
      backgroundSize: 'cover',
    })
    expect(b!.styles).toEqual({ color: 'red' })
    expect(r.warnings.map((w) => [w.code, w.property])).toEqual([
      ['image-unresolved', 'backgroundImage'],
    ])
  })
})

describe('clones (§7.5)', () => {
  function sourceCard(doc: LoroDoc, board: string): { card: string; title: string } {
    const card = createNode(doc, {
      type: 'frame',
      parentId: board,
      name: 'Card',
      styles: {
        display: 'flex',
        gap: '8px',
        padding: '12px',
        backgroundColor: '#eee',
        width: '200px',
      },
    })
    const title = createNode(doc, { type: 'text', parentId: card, name: 'Title', text: 'Hello' })
    return { card, title }
  }
  test('deep copy with the element styles applied and layer-name; in flow in a flex parent', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const { card } = sourceCard(doc, board)
    const target = createNode(doc, {
      type: 'frame',
      parentId: board,
      styles: { display: 'flex', flexDirection: 'column' },
    })
    const r = write(
      doc,
      `<x-baren-clone node-id="${card}" style="background: #fff; padding: 4px 8px" layer-name="Copy" />`,
      target,
    )
    const copy = node(doc, r.created[0]!)
    expect(copy.name).toBe('Copy')
    expect(copy.styles).toEqual({
      display: 'flex',
      gap: '8px',
      paddingBlock: '4px',
      paddingInline: '8px',
      backgroundColor: '#fff',
      width: '200px',
    })
    expect(tree(doc, copy.children[0]!)).toEqual(tree(doc, getChildIds(doc, card)[0]!))
  })
  test('an absolutely positioned source becomes an in-flow copy unless the clone sets a position', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const dot = createNode(doc, {
      type: 'rect',
      parentId: board,
      styles: { position: 'absolute', left: 300, top: 200, width: 8, height: 8 },
    })
    const row = createNode(doc, { type: 'frame', parentId: board, styles: { display: 'flex' } })
    const r = write(
      doc,
      `<x-baren-clone node-id="${dot}"></x-baren-clone><x-baren-clone node-id="${dot}" style="position:absolute; left: 1px; top: 2px"></x-baren-clone>`,
      row,
    )
    const [a, b] = r.created.map((id) => node(doc, id))
    expect(a!.styles['position']).toBeUndefined()
    expect(a!.styles['left']).toBeUndefined()
    expect(b!.styles).toMatchObject({ position: 'absolute', left: '1px', top: '2px' })
  })
  test('clones on a page become artboards in a free spot', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const r = write(doc, `<x-baren-clone node-id="${board}" />`, pageId)
    expect(node(doc, r.created[0]!).styles).toMatchObject({ left: 480, top: 0 })
  })
  test('instances stay instances; instance styles go to own keys and overrides', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const { card } = sourceCard(doc, board)
    const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(3) }) as string
    const key = node(doc, main).componentKey as string
    const inst = createInstance(doc, { componentKey: key, parentId: board }, { random: seeded(4) })
    const r = write(
      doc,
      `<x-baren-clone node-id="${inst}" style="width: 120px; background-color: #f00" />`,
      board,
    )
    const copy = node(doc, r.created[0]!)
    expect(copy.type).toBe('instance')
    expect(copy.componentKey).toBe(key)
    expect(copy.styles['width']).toBe('120px')
    expect(copy.overrides?.['']?.styles?.['backgroundColor']).toBe('#f00')
  })
  test('virtual (instance content) sources become detached copies', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const { card, title } = sourceCard(doc, board)
    const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(5) }) as string
    const key = node(doc, main).componentKey as string
    const inst = createInstance(doc, { componentKey: key, parentId: board }, { random: seeded(6) })
    const nodeKey = node(doc, title).nodeKey as string
    const r = write(
      doc,
      `<x-baren-clone node-id="${virtualId(inst, nodeKey)}" style="color: blue" />`,
      board,
    )
    const copy = node(doc, r.created[0]!)
    expect(copy.type).toBe('text')
    expect(copy.text).toBe('Hello')
    expect(copy.styles['color']).toBe('blue')
  })
  test('cycle: cloning an instance into its own main is refused as a whole', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const { card } = sourceCard(doc, board)
    const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(8) }) as string
    const key = node(doc, main).componentKey as string
    const inst = createInstance(doc, { componentKey: key, parentId: board }, { random: seeded(9) })
    const before = doc.oplogVersion()
    let code = ''
    try {
      write(doc, `<p>first</p><x-baren-clone node-id="${inst}" />`, main)
    } catch (e) {
      code = (e as HtmlApplyError).code
    }
    expect(code).toBe('cycle')
    expect(doc.exportJsonUpdates(before, doc.oplogVersion()).changes).toHaveLength(0)
  })
  test('unknown ids and pages warn and create nothing', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const r = write(
      doc,
      `<x-baren-clone node-id="77@77" /><x-baren-clone node-id="${pageId}" /><p>x</p>`,
      board,
    )
    expect(r.created).toHaveLength(1)
    expect(r.warnings.map((w) => w.code)).toEqual(['clone-not-found', 'clone-not-found'])
  })
  test('replace mode can clone a descendant of the replaced node', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const { card, title } = sourceCard(doc, board)
    const r = write(
      doc,
      `<div style="display:flex"><x-baren-clone node-id="${title}" style="font-size: 20px" /></div>`,
      card,
      'replace',
    )
    const frame = node(doc, r.created[0]!)
    expect(node(doc, frame.children[0]!)).toMatchObject({
      type: 'text',
      text: 'Hello',
      styles: { fontSize: '20px' },
    })
  })
})

describe('determinism', () => {
  test('the same HTML gives the same tree', () => {
    const html =
      '<div layer-name="Row" style="display:flex; align-items:center; gap: 12px; padding: 8px 12px"><svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg><p style="font-size: 14px; color: var(--color-foreground)">Label</p><span style="margin-left:auto">⌘K</span></div>'
    const a = doc0()
    const ra = write(a.doc, html, artboard(a.doc, a.pageId))
    const b = setup()
    const rb = write(b.doc, html, artboard(b.doc, b.pageId))
    expect(tree(a.doc, ra.created[0]!)).toEqual(tree(b.doc, rb.created[0]!))
  })
  test('applyHtml outside transact still works (each helper commits)', () => {
    const { doc, pageId } = doc0()
    const board = artboard(doc, pageId)
    const ctx = context(doc)
    const r = applyHtml(
      doc,
      parseHtml('<p>x</p>'),
      { mode: 'insert-children', targetId: board },
      ctx,
    )
    expect(r.created).toHaveLength(1)
    transact(doc, () => undefined)
  })
})
