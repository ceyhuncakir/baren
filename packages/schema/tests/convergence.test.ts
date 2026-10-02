/**
 * Two-peer convergence for every row of the merge table (contract §2.9): after exchanging
 * updates both peers have identical `toSnapshot`, identical `toRenderSubtree` for the
 * instances involved, and the stated outcome.
 */
import { describe, expect, it } from 'vitest'
import { UndoManager, type LoroDoc } from 'loro-crdt'
import {
  createComponent,
  createComponentResolver,
  createInstance,
  createNode,
  deleteNode,
  detachInstance,
  docGeometry,
  editVector,
  findMainComponent,
  fitGroups,
  getChildIds,
  getNode,
  getOverrides,
  getResolvedNode,
  getTokens,
  groupNodes,
  pasteClipboard,
  reparentNodes,
  scaleVector,
  serializeClipboard,
  setStyles,
  setStylesAt,
  setTextAt,
  setTokens,
  setVector,
  toRenderSubtree,
  toSnapshot,
  ungroupNodes,
  type VectorData,
} from '../src/index.ts'
import { docWithPage, frame, framesGeometry, seeded, sync, twoPeers } from './helpers.ts'
import { checkInvariants } from './invariants.ts'

function expectConverged(a: LoroDoc, b: LoroDoc, renderRoots: readonly string[] = []): void {
  expect(toSnapshot(a)).toEqual(toSnapshot(b))
  for (const root of renderRoots) {
    expect(toRenderSubtree(a, root)).toEqual(toRenderSubtree(b, root))
  }
}

function rect(doc: LoroDoc, parentId: string, styles: Record<string, string | number>): string {
  return createNode(doc, { type: 'rect', parentId, styles })
}

/** A main with a title text and an icon rect on peer `a`, synced to `b`. */
function sharedComponent(a: LoroDoc, b: LoroDoc, pageId: string) {
  const card = createNode(a, {
    type: 'frame',
    parentId: pageId,
    name: 'Card',
    styles: { left: 0, top: 0, width: 100, height: 60 },
  })
  const title = createNode(a, {
    type: 'text',
    parentId: card,
    text: 'Title',
    styles: { color: '#000' },
  })
  const icon = rect(a, card, { width: 10, height: 10, backgroundColor: 'red' })
  const main = createComponent(a, [card], docGeometry(a), { random: seeded(11) })!
  const key = getNode(a, main)!.componentKey!
  const inst = createInstance(a, {
    componentKey: key,
    parentId: pageId,
    styles: { left: 300, top: 0 },
  })
  sync(a, b)
  return {
    main,
    key,
    title,
    icon,
    inst,
    tk: getNode(a, title)!.nodeKey!,
    ik: getNode(a, icon)!.nodeKey!,
  }
}

describe('merge table (§2.9)', () => {
  it('A groups {x, y}; B moves x → x ends in the group', () => {
    const { a, b, pageId } = twoPeers()
    const x = rect(a, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const y = rect(a, pageId, { left: 50, top: 0, width: 10, height: 10 })
    sync(a, b)
    const g = groupNodes(a, [x, y], docGeometry(a))!
    setStyles(b, x, { left: 500 })
    sync(a, b)
    expectConverged(a, b)
    expect(getNode(a, x)!.parentId).toBe(g)
    expect(getNode(a, g)!.children).toEqual([x, y])
  })

  it('A and B group the same node into different groups → it is in one group, the other may be empty', () => {
    const { a, b, pageId } = twoPeers()
    const x = rect(a, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const y = rect(a, pageId, { left: 50, top: 0, width: 10, height: 10 })
    const z = rect(a, pageId, { left: 100, top: 0, width: 10, height: 10 })
    sync(a, b)
    const ga = groupNodes(a, [x, y], docGeometry(a))!
    const gb = groupNodes(b, [x, z], docGeometry(b))!
    sync(a, b)
    expectConverged(a, b)
    const parent = getNode(a, x)!.parentId
    expect([ga, gb]).toContain(parent)
    expect(getNode(a, ga)).toBeDefined()
    expect(getNode(a, gb)).toBeDefined()
  })

  it('A ungroups G; B adds z into G → z is deleted with G', () => {
    const { a, b, pageId } = twoPeers()
    const g = createNode(a, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
    })
    rect(a, g, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    sync(a, b)
    ungroupNodes(a, [g], docGeometry(a))
    const z = rect(b, g, { position: 'absolute', left: 20, top: 0, width: 10, height: 10 })
    sync(a, b)
    expectConverged(a, b)
    expect(getNode(a, g)).toBeUndefined()
    expect(getNode(a, z)).toBeUndefined()
  })

  it('A edits main node m; B overrides m in instance I → both kept', () => {
    const { a, b, pageId } = twoPeers()
    const c = sharedComponent(a, b, pageId)
    setStyles(a, c.icon, { backgroundColor: 'blue', borderRadius: 2 })
    setStylesAt(b, `${c.inst}/${c.ik}`, { backgroundColor: 'green' })
    sync(a, b)
    expectConverged(a, b, [c.inst])
    expect(getResolvedNode(a, `${c.inst}/${c.ik}`)!.styles).toEqual({
      width: 10,
      height: 10,
      backgroundColor: 'green',
      borderRadius: 2,
    })
  })

  it('A deletes main node m; B overrides m → orphaned, applies again after A undoes', () => {
    const { a, b, pageId } = twoPeers()
    const c = sharedComponent(a, b, pageId)
    const undo = new UndoManager(a, { mergeInterval: 0 })
    deleteNode(a, c.icon)
    setStylesAt(b, `${c.inst}/${c.ik}`, { backgroundColor: 'green' })
    sync(a, b)
    expectConverged(a, b, [c.inst])
    expect(getResolvedNode(a, `${c.inst}/${c.ik}`)).toBeUndefined()
    expect(getOverrides(a, c.inst)[c.ik]).toEqual({ styles: { backgroundColor: 'green' } })
    undo.undo()
    sync(a, b)
    expectConverged(a, b, [c.inst])
    expect(getResolvedNode(b, `${c.inst}/${c.ik}`)!.styles['backgroundColor']).toBe('green')
  })

  it('A deletes the main; B creates and edits instances → they render from the retained main', () => {
    const { a, b, pageId } = twoPeers()
    const c = sharedComponent(a, b, pageId)
    deleteNode(a, c.main)
    const i2 = createInstance(b, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 0, top: 300 },
    })
    setTextAt(b, `${i2}/${c.tk}`, 'From B')
    sync(a, b)
    expectConverged(a, b, [c.inst, i2])
    const exp = createComponentResolver(a).expandInstance(i2)!
    expect(exp.status).toBe('ok')
    expect(exp.mainDeleted).toBe(true)
    expect(exp.nodes[`${i2}/${c.tk}`]!.text).toBe('From B')
  })

  it('A detaches I; B overrides inside I → the override is lost', () => {
    const { a, b, pageId } = twoPeers()
    const c = sharedComponent(a, b, pageId)
    detachInstance(a, c.inst)
    setStylesAt(b, `${c.inst}/${c.ik}`, { backgroundColor: 'green' })
    sync(a, b)
    expectConverged(a, b)
    const node = getNode(a, c.inst)!
    expect(node.type).toBe('frame')
    expect(node.overrides).toBeUndefined()
    expect(node.children.map((id) => getNode(a, id)!.styles['backgroundColor'])).toEqual([
      undefined,
      'red',
    ])
  })

  it('A puts an instance of B in main A; B puts an instance of A in main B → cycle rendered, converged', () => {
    const { a, b, pageId } = twoPeers()
    const fa = createNode(a, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 50, height: 50 },
    })
    const fb = createNode(a, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 100, top: 0, width: 50, height: 50 },
    })
    const ma = createComponent(a, [fa], docGeometry(a), { random: seeded(1) })!
    const mb = createComponent(a, [fb], docGeometry(a), { random: seeded(2) })!
    const ka = getNode(a, ma)!.componentKey!
    const kb = getNode(a, mb)!.componentKey!
    const top = createInstance(a, {
      componentKey: ka,
      parentId: pageId,
      styles: { left: 0, top: 200 },
    })
    sync(a, b)
    createInstance(a, { componentKey: kb, parentId: ma })
    createInstance(b, { componentKey: ka, parentId: mb })
    sync(a, b)
    expectConverged(a, b, [top, ma, mb])
    const statuses = Object.values(createComponentResolver(a).expandInstance(top)!.nodes).map(
      (n) => n.status,
    )
    expect(statuses).toContain('cycle')
  })

  it('vector points: different points both kept, same point LWW, inserts and deletes merge', () => {
    const { a, b, pageId } = twoPeers()
    const data: VectorData = {
      fillRule: 'nonzero',
      subpaths: [
        {
          id: 'aaaaaaaa',
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 20, y: 0 },
            { x: 30, y: 0 },
          ],
        },
      ],
    }
    const v = createNode(a, {
      type: 'vector',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 30, height: 1 },
      vector: data,
    })
    sync(a, b)
    editVector(a, v, [{ kind: 'set', subpathId: 'aaaaaaaa', index: 1, point: { x: 10, y: 5 } }])
    editVector(b, v, [{ kind: 'set', subpathId: 'aaaaaaaa', index: 2, point: { x: 20, y: -5 } }])
    sync(a, b)
    expectConverged(a, b)
    expect(getNode(a, v)!.vector!.subpaths[0]!.points.slice(1, 3)).toEqual([
      { x: 10, y: 5 },
      { x: 20, y: -5 },
    ])
    editVector(a, v, [{ kind: 'set', subpathId: 'aaaaaaaa', index: 0, point: { x: 1, y: 1 } }])
    editVector(b, v, [{ kind: 'set', subpathId: 'aaaaaaaa', index: 0, point: { x: 2, y: 2 } }])
    editVector(a, v, [{ kind: 'insert', subpathId: 'aaaaaaaa', index: 4, point: { x: 40, y: 0 } }])
    editVector(b, v, [{ kind: 'delete', subpathId: 'aaaaaaaa', index: 3 }])
    sync(a, b)
    expectConverged(a, b)
    const pts = getNode(a, v)!.vector!.subpaths[0]!.points
    expect(pts).toHaveLength(4)
    expect([1, 2]).toContain(pts[0]!.x)
    expect(pts.at(-1)).toEqual({ x: 40, y: 0 })
  })

  it('A resizes a vector (points rescaled); B moves a point → per-point LWW, converged', () => {
    const { a, b, pageId } = twoPeers()
    const data: VectorData = {
      fillRule: 'nonzero',
      subpaths: [
        {
          id: 'aaaaaaaa',
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      ],
    }
    const v = createNode(a, {
      type: 'vector',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
      vector: data,
    })
    sync(a, b)
    setVector(a, v, scaleVector(data, 2, 2))
    setStyles(a, v, { width: 20, height: 20 })
    editVector(b, v, [{ kind: 'set', subpathId: 'aaaaaaaa', index: 1, point: { x: 12, y: 0 } }])
    sync(a, b)
    expectConverged(a, b)
    expect(getNode(a, v)!.vector!.subpaths[0]!.points).toHaveLength(3)
  })

  it('A and B paste the same component into a file lacking it → deterministic resolution', () => {
    const { doc: src, pageId: sp } = docWithPage('Source', 9)
    const card = createNode(src, {
      type: 'frame',
      parentId: sp,
      styles: { left: 0, top: 0, width: 40, height: 40 },
    })
    createNode(src, { type: 'text', parentId: card, text: 'T' })
    const main = createComponent(src, [card], docGeometry(src), { random: seeded(4) })!
    const key = getNode(src, main)!.componentKey!
    const inst = createInstance(src, {
      componentKey: key,
      parentId: sp,
      styles: { left: 100, top: 0 },
    })
    const payload = serializeClipboard(src, [inst], {
      geo: docGeometry(src),
      fileId: 'src',
      pageId: sp,
    })!
    const { a, b, pageId } = twoPeers()
    const ra = pasteClipboard(a, payload, { parentId: pageId, geo: docGeometry(a) })
    const rb = pasteClipboard(b, payload, { parentId: pageId, geo: docGeometry(b) })
    expect(ra.components.created).toEqual([key])
    expect(rb.components.created).toEqual([key])
    sync(a, b)
    expectConverged(a, b, [ra.ids[0]!, rb.ids[0]!])
    expect(findMainComponent(a, key)).toEqual(findMainComponent(b, key))
    expect(
      getChildIds(a, null).filter((p) => getNode(a, p)!.name === 'Components').length,
    ).toBeGreaterThanOrEqual(1)
  })

  it('A and B convert the same frame to a component → one key wins', () => {
    const { a, b, pageId } = twoPeers()
    const f = createNode(a, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 40, height: 40 },
    })
    createNode(a, { type: 'text', parentId: f, text: 'T' })
    sync(a, b)
    createComponent(a, [f], docGeometry(a), { random: seeded(1) })
    createComponent(b, [f], docGeometry(b), { random: seeded(2) })
    sync(a, b)
    expectConverged(a, b)
    const key = getNode(a, f)!.componentKey!
    expect(findMainComponent(a, key)).toEqual({ mainId: f, deleted: false })
  })

  it('A paste adds token --x; B edits --x → token fields merge', () => {
    const { doc: src, pageId: sp } = docWithPage('Source', 9)
    setTokens(src, { '--x': { type: 'color', value: '#111', description: 'from source' } })
    const r = createNode(src, {
      type: 'rect',
      parentId: sp,
      styles: { left: 0, top: 0, color: 'var(--x)' },
    })
    const payload = serializeClipboard(src, [r], {
      geo: docGeometry(src),
      fileId: null,
      pageId: sp,
    })!
    const { a, b, pageId } = twoPeers()
    pasteClipboard(a, payload, { parentId: pageId, geo: docGeometry(a) })
    setTokens(b, { '--x': { type: 'color', value: '#222' } })
    sync(a, b)
    expectConverged(a, b)
    expect(getTokens(a)['--x']!.type).toBe('color')
  })

  it('A and B move the same node by canvas reparent → converged', () => {
    const { a, b, pageId } = twoPeers()
    const f1 = createNode(a, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 100, height: 100 },
    })
    const f2 = createNode(a, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 200, top: 0, width: 100, height: 100, display: 'flex' },
    })
    const x = rect(a, pageId, { left: 10, top: 10, width: 10, height: 10 })
    sync(a, b)
    reparentNodes(a, [{ id: x }], { parentId: f1 }, docGeometry(a), { origin: 'canvas:reparent' })
    reparentNodes(b, [{ id: x }], { parentId: f2, index: 0 }, docGeometry(b), {
      origin: 'canvas:reparent',
    })
    sync(a, b)
    expectConverged(a, b)
    expect([f1, f2]).toContain(getNode(a, x)!.parentId)
  })

  it('group fits computed by A and B for different child edits → converged, refit on next local edit', () => {
    const { a, b, pageId } = twoPeers()
    const g = createNode(a, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 60, height: 10 },
    })
    const x = rect(a, g, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    const y = rect(a, g, { position: 'absolute', left: 50, top: 0, width: 10, height: 10 })
    sync(a, b)
    setStyles(a, x, { top: 40 })
    fitGroups(a, [x], docGeometry(a))
    setStyles(b, y, { left: 90 })
    fitGroups(b, [y], docGeometry(b))
    sync(a, b)
    expectConverged(a, b)
    fitGroups(a, [x], docGeometry(a))
    sync(a, b)
    expectConverged(a, b)
    expect(checkInvariants(a)).toEqual([])
  })

  it('paste into a file another peer is editing at the same time', () => {
    const { doc: src, pageId: sp } = docWithPage('Source', 9)
    const card = createNode(src, {
      type: 'frame',
      parentId: sp,
      styles: { left: 0, top: 0, width: 40, height: 40 },
    })
    const t = createNode(src, { type: 'text', parentId: card, text: 'T' })
    const main = createComponent(src, [card], docGeometry(src), { random: seeded(4) })!
    const key = getNode(src, main)!.componentKey!
    const inst = createInstance(src, {
      componentKey: key,
      parentId: sp,
      styles: { left: 100, top: 0 },
    })
    setTextAt(src, `${inst}/${getNode(src, t)!.nodeKey!}`, 'Pasted')
    const payload = serializeClipboard(src, [inst], {
      geo: docGeometry(src),
      fileId: 'src',
      pageId: sp,
    })!
    const { a, b, pageId } = twoPeers()
    const board = createNode(a, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 500, height: 500 },
    })
    sync(a, b)
    const pasted = pasteClipboard(a, payload, {
      parentId: board,
      geo: framesGeometry(a, { [board]: frame(0, 0, 500, 500) }),
      translate: { dx: -50, dy: 20 },
    })
    setStyles(b, board, { width: 600, backgroundColor: '#fff' })
    createNode(b, { type: 'text', parentId: board, text: 'B was here' })
    sync(a, b)
    expectConverged(a, b, [pasted.ids[0]!])
    expect(getResolvedNode(b, `${pasted.ids[0]}/${getNode(src, t)!.nodeKey!}`)!.text).toBe('Pasted')
    expect(getNode(b, pasted.ids[0]!)!.styles).toMatchObject({
      position: 'absolute',
      left: 50,
      top: 20,
    })
    expect(checkInvariants(a)).toEqual([])
  })
})
