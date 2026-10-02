import { describe, expect, it } from 'vitest'
import { UndoManager, type LoroDoc } from 'loro-crdt'
import {
  CLIPBOARD_MIME,
  attachAssetBytes,
  base64ToBytes,
  clipAssetBytes,
  clipboardPayloadVersion,
  clipboardText,
  createComponent,
  createInstance,
  createNode,
  docGeometry,
  duplicateNodes,
  getChildIds,
  getNode,
  getResolvedNode,
  getTokens,
  listComponents,
  parseClipboardPayload,
  pasteClipboard,
  serializeClipboard,
  setStylesAt,
  setTextAt,
  setTokens,
  toSnapshot,
  tokensReferencedBy,
  type ClipboardPayload,
} from '../src/index.ts'
import { docWithPage, expectFrameClose, frame, seeded } from './helpers.ts'
import { checkInvariants } from './invariants.ts'

const HASH = 'c'.repeat(64)
const HASH2 = 'd'.repeat(64)

function source(doc: LoroDoc, pageId: string) {
  setTokens(doc, {
    '--brand': { type: 'color', value: 'var(--base)' },
    '--base': { type: 'color', value: '#F04E1E', description: 'Base' },
    '--unused': { type: 'color', value: '#000' },
  })
  const card = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Card',
    styles: { left: 0, top: 0, width: 200, height: 100, backgroundColor: 'var(--brand)' },
  })
  const title = createNode(doc, {
    type: 'text',
    parentId: card,
    name: 'Title',
    text: 'Hello',
    styles: { position: 'absolute', left: 4, top: 4 },
  })
  createNode(doc, {
    type: 'image',
    parentId: card,
    name: 'Photo',
    assetId: HASH,
    assetName: 'p.png',
    styles: { position: 'absolute', left: 50, top: 10, width: 10, height: 10 },
  })
  const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(5) })!
  const key = getNode(doc, main)!.componentKey!
  const board = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Board',
    styles: { left: 400, top: 0, width: 600, height: 400 },
  })
  const inst = createInstance(doc, {
    componentKey: key,
    parentId: board,
    styles: { position: 'absolute', left: 20, top: 30 },
  })
  const titleKey = getNode(doc, title)!.nodeKey!
  setTextAt(doc, `${inst}/${titleKey}`, 'Overridden')
  setStylesAt(doc, inst, { backgroundImage: `url("baren-asset://${HASH2}")` })
  const note = createNode(doc, {
    type: 'text',
    parentId: board,
    name: 'Note',
    text: 'A note',
    styles: { position: 'absolute', left: 300, top: 30, color: 'var(--brand)' },
  })
  return { main, key, board, inst, note, titleKey }
}

describe('serializeClipboard / parseClipboardPayload', () => {
  it('serialises nodes, the component closure, transitive tokens and assets; round-trips through JSON', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const payload = serializeClipboard(doc, [s.inst, s.note], {
      geo: docGeometry(doc),
      fileId: 'file-a',
      pageId,
      app: '0.1.0',
    })!
    expect(payload.kind).toBe('baren/clipboard')
    expect(payload.nodes.map((n) => n.type)).toEqual(['instance', 'text'])
    expect(payload.nodes[0]).toMatchObject({
      componentKey: s.key,
      mainId: s.main,
      context: 'absolute',
      overrides: {
        [s.titleKey]: { text: 'Overridden' },
        '': { styles: { backgroundImage: `url("baren-asset://${HASH2}")` } },
      },
    })
    expectFrameClose(payload.nodes[0]!.frame!, frame(420, 30, 200, 100))
    expect(Object.keys(payload.components)).toEqual([s.key])
    expect(payload.components[s.key]!.root.componentKey).toBe(s.key)
    expect(Object.keys(payload.tokens).sort()).toEqual(['--base', '--brand'])
    expect(Object.keys(payload.assets).sort()).toEqual([HASH, HASH2])
    expect(payload.assets[HASH]).toEqual({ name: 'p.png' })
    // The note has no declared width (auto text): declared geometry measures it as 0 wide at x 700.
    expect(payload.bounds).toEqual({ x: 420, y: 30, width: 280, height: 100 })
    const parsed = parseClipboardPayload(JSON.stringify(payload))
    expect(parsed).toEqual(payload)
    expect(clipboardPayloadVersion(JSON.stringify(payload))).toBe(2)
    expect(CLIPBOARD_MIME).toBe('web application/x-baren-clipboard+json')
  })

  it('upgrades the legacy v1 format', () => {
    const v1 = {
      kind: 'baren/nodes',
      version: 1,
      nodes: [
        {
          type: 'frame',
          name: 'F',
          styles: { left: 10, top: 20, width: 30, height: 40 },
          children: [{ type: 'text', name: 'T', styles: {}, text: 'x', children: [] }],
        },
        {
          type: 'rect',
          name: 'R',
          styles: { position: 'absolute', left: 1, top: 2, width: 3, height: 4 },
          children: [],
        },
      ],
    }
    const p = parseClipboardPayload(JSON.stringify(v1))!
    expect(p.version).toBe(2)
    expect(p.nodes[0]).toMatchObject({
      context: 'page',
      frame: { x: 10, y: 20, width: 30, height: 40, rotation: 0 },
    })
    expect(p.nodes[1]!.context).toBe('absolute')
    expect(p.nodes[0]!.children[0]).toEqual({
      type: 'text',
      name: 'T',
      styles: {},
      text: 'x',
      children: [],
    })
    expect(p.bounds).toEqual({ x: 1, y: 2, width: 39, height: 58 })
    expect(clipboardPayloadVersion(JSON.stringify(v1))).toBe(1)
  })

  it('validates untrusted input: drops invalid entries, rejects malformed payloads', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const good = serializeClipboard(doc, [s.inst], { geo: docGeometry(doc), fileId: null, pageId })!
    const tamper = (fn: (p: Record<string, unknown>) => void): ClipboardPayload | null => {
      const p = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
      fn(p)
      return parseClipboardPayload(JSON.stringify(p))
    }
    expect(parseClipboardPayload('not json')).toBeNull()
    expect(parseClipboardPayload('[]')).toBeNull()
    expect(tamper((p) => (p['version'] = 3))).toBeNull()
    expect(tamper((p) => (p['kind'] = 'other'))).toBeNull()
    expect(tamper((p) => (p['nodes'] = {}))).toBeNull()
    expect(tamper((p) => (p['source'] = 'x'))).toBeNull()
    expect(clipboardPayloadVersion(JSON.stringify({ ...good, version: 3 }))).toBe(3)
    const dropped = tamper((p) => {
      ;(p['tokens'] as Record<string, unknown>)['bad name'] = { type: 'color', value: 'red' }
      ;(p['tokens'] as Record<string, unknown>)['--nan'] = {
        type: 'number',
        value: 'x'.repeat(1024 * 1024 + 1),
      }
      ;(p['assets'] as Record<string, unknown>)['not-a-hash'] = {}
      ;(p['assets'] as Record<string, unknown>)[HASH] = { data: '%%%' }
      const node = (p['nodes'] as Record<string, unknown>[])[0]!
      node['type'] = 'instance'
      node['componentKey'] = 'BAD'
      node['styles'] = { width: 10, bad: { nested: true }, nan: 'x' }
      ;(p['nodes'] as unknown[]).push({
        type: 'hologram',
        name: 'H',
        styles: {},
        children: [],
        assetId: 'xyz',
        nodeKey: 'short',
      })
      ;(p['components'] as Record<string, unknown>)['zzzzzzzzzzzzzzzz'] = {
        key: 'mismatch',
        root: {},
      }
    })!
    expect(Object.keys(dropped.tokens).sort()).toEqual(['--base', '--brand'])
    expect(dropped.assets[HASH]).toEqual({})
    expect(dropped.assets['not-a-hash']).toBeUndefined()
    expect(dropped.nodes[0]).toMatchObject({ type: 'frame', styles: { width: 10, nan: 'x' } })
    expect(dropped.nodes[0]!.componentKey).toBeUndefined()
    expect(dropped.nodes[1]).toMatchObject({ type: 'frame', name: 'H' })
    expect(dropped.nodes[1]!.assetId).toBeUndefined()
    expect(dropped.nodes[1]!.nodeKey).toBeUndefined()
    expect(Object.keys(dropped.components)).toEqual([s.key])
    // Depth and size limits.
    let deep: Record<string, unknown> = { type: 'frame', name: 'leaf', styles: {}, children: [] }
    for (let i = 0; i < 300; i++)
      deep = { type: 'frame', name: `d${i}`, styles: {}, children: [deep] }
    expect(tamper((p) => (p['nodes'] = [deep]))).toBeNull()
    const many = Array.from({ length: 50_001 }, () => ({
      type: 'rect',
      name: '',
      styles: {},
      children: [],
    }))
    expect(tamper((p) => (p['nodes'] = many))).toBeNull()
  })
})

describe('pasteClipboard', () => {
  it('pastes into another file: tokens added, Components page and mains created once, overrides kept', () => {
    const { doc: a, pageId: pa } = docWithPage('A', 1)
    const s = source(a, pa)
    const payload = serializeClipboard(a, [s.inst, s.note], {
      geo: docGeometry(a),
      fileId: 'a',
      pageId: pa,
    })!
    const { doc: b, pageId: pb } = docWithPage('B', 2)
    setTokens(b, { '--brand': { type: 'color', value: '#123456' } })
    const undo = new UndoManager(b, { mergeInterval: 0 })
    const r1 = pasteClipboard(b, JSON.parse(JSON.stringify(payload)) as ClipboardPayload, {
      parentId: pb,
      geo: docGeometry(b),
      assetRemap: { [HASH2]: 'e'.repeat(64) },
    })
    expect(r1.refused).toBeNull()
    expect(r1.tokens).toEqual({ added: ['--base'], kept: ['--brand'] })
    expect(getTokens(b)['--brand']!.value).toBe('#123456')
    expect(r1.components).toEqual({ created: [s.key], reused: [] })
    const pages = getChildIds(b, null)
    expect(pages.map((p) => getNode(b, p)!.name)).toEqual(['Page 1', 'Components'])
    const [inst, note] = r1.ids
    const instNode = getNode(b, inst!)!
    expect(instNode).toMatchObject({
      type: 'instance',
      componentKey: s.key,
      styles: { left: 420, top: 30 },
    })
    expect(instNode.mainId).toBe(listComponents(b)[0]!.mainId)
    expect(instNode.overrides!['']!.styles!['backgroundImage']).toBe(
      `url("baren-asset://${'e'.repeat(64)}")`,
    )
    expect(getResolvedNode(b, `${inst}/${s.titleKey}`)!.text).toBe('Overridden')
    expect(getNode(b, note!)!.styles).toMatchObject({ left: 700, top: 30, color: 'var(--brand)' })
    expect(getNode(b, note!)!.styles['position']).toBeUndefined()
    expect(checkInvariants(b)).toEqual([])
    // Second paste reuses the main.
    const r2 = pasteClipboard(b, payload, {
      parentId: pb,
      geo: docGeometry(b),
      translate: { dx: 24, dy: 24 },
    })
    expect(r2.components).toEqual({ created: [], reused: [s.key] })
    expect(getChildIds(b, pages[1]!)).toHaveLength(1)
    expect(getNode(b, r2.ids[0]!)!.styles).toMatchObject({ left: 444, top: 54 })
    // One undo step per paste.
    undo.undo()
    expect(getNode(b, r2.ids[0]!)).toBeUndefined()
    expect(getNode(b, inst!)).toBeDefined()
  })

  it('places roots into absolute frames, flex frames (index) and groups', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const payload = serializeClipboard(doc, [s.note], {
      geo: docGeometry(doc),
      fileId: null,
      pageId,
    })!
    // Paste in place into the same board: same world frame.
    const inPlace = pasteClipboard(doc, payload, { parentId: s.board, geo: docGeometry(doc) })
    expect(getNode(doc, inPlace.ids[0]!)!.styles).toMatchObject({
      position: 'absolute',
      left: 300,
      top: 30,
    })
    const flex = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 900, width: 300, height: 100, display: 'flex' },
    })
    createNode(doc, { type: 'rect', parentId: flex })
    createNode(doc, { type: 'rect', parentId: flex })
    const intoFlex = pasteClipboard(doc, payload, {
      parentId: flex,
      index: 1,
      geo: docGeometry(doc),
    })
    expect(getChildIds(doc, flex)[1]).toBe(intoFlex.ids[0])
    expect(getNode(doc, intoFlex.ids[0]!)!.styles).toEqual({ color: 'var(--brand)' })
    const g = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 1000, top: 1000, width: 10, height: 10 },
    })
    createNode(doc, {
      type: 'rect',
      parentId: g,
      styles: { position: 'absolute', left: 0, top: 0, width: 10, height: 10 },
    })
    const intoGroup = pasteClipboard(doc, payload, {
      parentId: g,
      geo: docGeometry(doc),
      translate: { dx: 700, dy: 970 },
    })
    expect(getNode(doc, intoGroup.ids[0]!)!.styles['position']).toBe('absolute')
    expect(getNode(doc, g)!.styles['left']).toBe(1000)
    expect(pasteClipboard(doc, payload, { parentId: s.note, geo: docGeometry(doc) }).refused).toBe(
      'invalid-target',
    )
  })

  it('refuses pastes that would put a component inside itself', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const payload = serializeClipboard(doc, [s.inst], {
      geo: docGeometry(doc),
      fileId: null,
      pageId,
    })!
    const result = pasteClipboard(doc, payload, { parentId: s.main, geo: docGeometry(doc) })
    expect(result.refused).toBe('cycle')
    expect(result.ids).toEqual([])
  })

  it('copies mains: same key into a file without it, fresh key when the key is live', () => {
    const { doc: a, pageId: pa } = docWithPage('A', 1)
    const s = source(a, pa)
    const payload = serializeClipboard(a, [s.main], {
      geo: docGeometry(a),
      fileId: null,
      pageId: pa,
    })!
    expect(payload.components).toEqual({})
    const same = pasteClipboard(a, payload, {
      parentId: pa,
      geo: docGeometry(a),
      translate: { dx: 0, dy: 500 },
      random: seeded(77),
    })
    const copyKey = getNode(a, same.ids[0]!)!.componentKey!
    expect(copyKey).not.toBe(s.key)
    expect(toSnapshot(a).components![copyKey]).toEqual({ mainId: same.ids[0] })
    const { doc: b, pageId: pb } = docWithPage('B', 2)
    const other = pasteClipboard(b, payload, { parentId: pb, geo: docGeometry(b) })
    expect(getNode(b, other.ids[0]!)!.componentKey).toBe(s.key)
    const child = getNode(b, getNode(b, other.ids[0]!)!.children[0]!)!
    expect(child.nodeKey).toBe(s.titleKey)
    expect(checkInvariants(a)).toEqual([])
    expect(checkInvariants(b)).toEqual([])
  })

  it('copies virtual nodes as detached copies (effective styles, nested instances rebased)', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const payload = serializeClipboard(doc, [`${s.inst}/${s.titleKey}`], {
      geo: docGeometry(doc),
      fileId: null,
      pageId,
    })!
    expect(payload.nodes[0]).toMatchObject({
      type: 'text',
      text: 'Overridden',
      nodeKey: s.titleKey,
    })
    expect(payload.nodes[0]!.componentKey).toBeUndefined()
    const pasted = pasteClipboard(doc, payload, { parentId: pageId, geo: docGeometry(doc) })
    expect(getNode(doc, pasted.ids[0]!)).toMatchObject({ type: 'text', text: 'Overridden' })
  })
})

describe('duplicateNodes', () => {
  it('copies after each original with the same styles; mains get a fresh key; virtual copies are detached', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    const ids = duplicateNodes(doc, [s.note, s.main], docGeometry(doc), {
      placeRoot: (n) => (n.parentId === pageId ? { left: 999 } : null),
    })
    expect(ids).toHaveLength(2) // document order: the main, then the note
    const pageChildren = getChildIds(doc, pageId)
    expect(pageChildren.indexOf(ids[0]!)).toBe(pageChildren.indexOf(s.main) + 1)
    expect(getChildIds(doc, s.board)).toEqual([s.inst, s.note, ids[1]])
    expect(getNode(doc, ids[1]!)!.styles).toEqual(getNode(doc, s.note)!.styles)
    const mainCopy = getNode(doc, ids[0]!)!
    expect(mainCopy.styles['left']).toBe(999)
    expect(mainCopy.componentKey).not.toBe(s.key)
    expect(listComponents(doc)).toHaveLength(2)
    const instCopy = duplicateNodes(doc, [s.inst], docGeometry(doc))
    expect(getNode(doc, instCopy[0]!)).toMatchObject({
      type: 'instance',
      componentKey: s.key,
      overrides: getNode(doc, s.inst)!.overrides,
    })
    const virtualCopy = duplicateNodes(doc, [`${s.inst}/${s.titleKey}`], docGeometry(doc))
    expect(getNode(doc, virtualCopy[0]!)).toMatchObject({
      type: 'text',
      text: 'Overridden',
      parentId: s.board,
    })
    expect(getNode(doc, virtualCopy[0]!)!.styles).toMatchObject({
      position: 'absolute',
      left: 24,
      top: 34,
    })
    expect(checkInvariants(doc)).toEqual([])
    undo.undo()
    expect(getNode(doc, virtualCopy[0]!)).toBeUndefined()
  })
})

describe('tokens, text and assets', () => {
  it('finds referenced tokens transitively (styles and override styles)', () => {
    const tokens = {
      '--a': { type: 'color', value: 'var(--b)' },
      '--b': { type: 'color', value: 'var(--c, red)' },
      '--c': { type: 'color', value: '#000' },
      '--d': { type: 'color', value: '#111' },
    }
    expect(
      tokensReferencedBy(
        [
          { styles: { color: 'var(--a)' } },
          { styles: {}, overrides: { k: { styles: { fill: 'var(--d)', x: null } } } },
        ],
        tokens,
      ),
    ).toEqual(['--a', '--d', '--b', '--c'])
  })

  it('writes text/plain from text layers, else SVG markup, else names', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const p = serializeClipboard(doc, [s.inst, s.note], {
      geo: docGeometry(doc),
      fileId: null,
      pageId,
    })!
    expect(clipboardText(p)).toBe('Overridden\nA note')
    const vec = createNode(doc, {
      type: 'vector',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10, stroke: '#000' },
      vector: {
        fillRule: 'nonzero',
        subpaths: [
          {
            id: 'aaaaaaaa',
            closed: false,
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
            ],
          },
        ],
      },
    })
    expect(
      clipboardText(
        serializeClipboard(doc, [vec], { geo: docGeometry(doc), fileId: null, pageId })!,
      ),
    ).toMatch(/^<svg xmlns=.*<path d="M 0 0 L 10 10"/)
    const r = createNode(doc, { type: 'rect', parentId: pageId, name: 'Box', styles: {} })
    expect(
      clipboardText(serializeClipboard(doc, [r], { geo: docGeometry(doc), fileId: null, pageId })!),
    ).toBe('Box')
  })

  it('writes the main name for an unnamed instance without text', () => {
    const { doc, pageId } = docWithPage('A', 1)
    const pill = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Pill',
      styles: { left: 0, top: 0, width: 40, height: 20 },
    })
    createNode(doc, { type: 'rect', parentId: pill, name: 'Dot', styles: { width: 4, height: 4 } })
    const main = createComponent(doc, [pill], docGeometry(doc))!
    const inst = createInstance(doc, {
      componentKey: getNode(doc, main)!.componentKey!,
      parentId: pageId,
      styles: { left: 100, top: 0 },
    })
    expect(getNode(doc, inst)!.name).toBe('')
    const p = serializeClipboard(doc, [inst], { geo: docGeometry(doc), fileId: null, pageId })!
    expect(clipboardText(p)).toBe('Pill')
  })

  it('embeds asset bytes smallest first within the limit', async () => {
    const { doc, pageId } = docWithPage('A', 1)
    const s = source(doc, pageId)
    const p = serializeClipboard(doc, [s.inst], { geo: docGeometry(doc), fileId: null, pageId })!
    const files: Record<string, Uint8Array> = {
      [HASH]: new Uint8Array(10).fill(1),
      [HASH2]: new Uint8Array(30).fill(2),
    }
    const withBytes = await attachAssetBytes(
      p,
      async (h) => ({ bytes: files[h]!, mime: 'image/png' }),
      25,
    )
    expect(withBytes.assets[HASH]).toMatchObject({ mime: 'image/png', size: 10, name: 'p.png' })
    expect(clipAssetBytes(withBytes.assets[HASH]!)).toEqual(files[HASH])
    expect(withBytes.assets[HASH2]).toEqual({ mime: 'image/png', size: 30 })
    expect(p.assets[HASH]!.data).toBeUndefined() // input untouched
    expect(base64ToBytes('%%')).toBeNull()
    expect(parseClipboardPayload(JSON.stringify(withBytes))!.assets[HASH]!.data).toBe(
      withBytes.assets[HASH]!.data,
    )
  })
})
