import { describe, expect, it } from 'vitest'
import { UndoManager } from 'loro-crdt'
import {
  canReparent,
  createComponent,
  createInstance,
  createNode,
  docGeometry,
  fitGroups,
  getChildIds,
  getNode,
  groupNodes,
  removeNodes,
  reparentNodes,
  resizeGroup,
  setStyles,
  ungroupNodes,
  wrapInFrame,
} from '../src/index.ts'
import { docWithPage, expectFrameClose, frame, framesGeometry, seeded } from './helpers.ts'
import { checkInvariants } from './invariants.ts'

function rect(
  doc: Parameters<typeof createNode>[0],
  parentId: string,
  styles: Record<string, string | number>,
  name = 'R',
): string {
  return createNode(doc, { type: 'rect', parentId, name, styles })
}

describe('groupNodes / ungroupNodes', () => {
  it('groups page-level nodes into a box that is the union of their bounds, keeping world frames', () => {
    const { doc, pageId } = docWithPage()
    const a = rect(doc, pageId, { left: 10, top: 20, width: 30, height: 40 })
    const b = rect(doc, pageId, { left: 100, top: 50, width: 20, height: 20, rotate: '45deg' })
    const c = rect(doc, pageId, { left: 500, top: 500, width: 5, height: 5 })
    const before = docGeometry(doc)
    const fa = before.frameOf(a)!
    const fb = before.frameOf(b)!
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    const g = groupNodes(doc, [b, a], docGeometry(doc))!
    expect(g).toBeTruthy()
    // The group sits where the top-most node (b) was; c stays above it.
    expect(getChildIds(doc, pageId)).toEqual([g, c])
    const group = getNode(doc, g)!
    expect(group.type).toBe('group')
    expect(group.name).toBe('Group')
    expect(group.children).toEqual([a, b])
    const half = 10 * Math.SQRT2
    expect(group.styles['left']).toBe(10)
    expect(group.styles['top']).toBe(20)
    expect(group.styles['width']).toBeCloseTo(110 + half - 10, 1)
    expect(getNode(doc, a)!.styles).toMatchObject({ position: 'absolute', left: 0, top: 0 })
    const after = docGeometry(doc)
    expectFrameClose(after.frameOf(a), fa)
    expectFrameClose(after.frameOf(b), fb)
    expect(checkInvariants(doc)).toEqual([])
    undo.undo()
    expect(getChildIds(doc, pageId)).toEqual([a, b, c])
    expect(getNode(doc, a)!.styles).toEqual({ left: 10, top: 20, width: 30, height: 40 })
  })

  it('ungroups a rotated group: rotation baked into the children, world frames kept', () => {
    const { doc, pageId } = docWithPage()
    const g = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 100, top: 100, width: 100, height: 50, rotate: '30deg' },
    })
    const a = rect(doc, g, { position: 'absolute', left: 0, top: 0, width: 40, height: 50 })
    const b = rect(doc, g, {
      position: 'absolute',
      left: 60,
      top: 10,
      width: 40,
      height: 20,
      rotate: '10deg',
    })
    const geo = docGeometry(doc)
    const fa = geo.frameOf(a)!
    const fb = geo.frameOf(b)!
    const out = ungroupNodes(doc, [g], docGeometry(doc))
    expect(out).toEqual([a, b])
    expect(getNode(doc, g)).toBeUndefined()
    expect(getChildIds(doc, pageId)).toEqual([a, b])
    expect(getNode(doc, a)!.styles['rotate']).toBe('30deg')
    expect(getNode(doc, b)!.styles['rotate']).toBe('40deg')
    expect(getNode(doc, a)!.styles['position']).toBeUndefined()
    const after = docGeometry(doc)
    expectFrameClose(after.frameOf(a), fa)
    expectFrameClose(after.frameOf(b), fb)
  })

  it('round-trips through a rotated group with rotated children', () => {
    const { doc, pageId } = docWithPage()
    const a = rect(doc, pageId, { left: 10, top: 10, width: 30, height: 10, rotate: '20deg' })
    const b = rect(doc, pageId, { left: 60, top: 40, width: 10, height: 30 })
    const geo0 = docGeometry(doc)
    const fa = geo0.frameOf(a)!
    const fb = geo0.frameOf(b)!
    const g = groupNodes(doc, [a, b], docGeometry(doc))!
    setStyles(doc, g, { rotate: '0deg' })
    ungroupNodes(doc, [g], docGeometry(doc))
    const geo1 = docGeometry(doc)
    expectFrameClose(geo1.frameOf(a), fa)
    expectFrameClose(geo1.frameOf(b), fb)
  })

  it('makes a group inside a flex frame one flow item; ungroup returns flow items', () => {
    const { doc, pageId } = docWithPage()
    const flex = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 400, height: 100, display: 'flex', gap: 8 },
    })
    const x = rect(doc, flex, { width: 50, height: 20 })
    const y = rect(doc, flex, { width: 60, height: 30 })
    const z = rect(doc, flex, { width: 10, height: 10 })
    const geo = framesGeometry(doc, {
      [flex]: frame(0, 0, 400, 100),
      [x]: frame(0, 0, 50, 20),
      [y]: frame(58, 0, 60, 30),
      [z]: frame(126, 0, 10, 10),
    })
    const g = groupNodes(doc, [x, y], geo)!
    expect(getChildIds(doc, flex)).toEqual([g, z])
    expect(getNode(doc, g)!.styles).toEqual({ width: 118, height: 30, flexShrink: 0 })
    expect(getNode(doc, y)!.styles).toMatchObject({ position: 'absolute', left: 58, top: 0 })
    expect(checkInvariants(doc)).toEqual([])
    const back = ungroupNodes(
      doc,
      [g],
      framesGeometry(doc, {
        [x]: frame(0, 0, 50, 20),
        [y]: frame(58, 0, 60, 30),
        [flex]: frame(0, 0, 400, 100),
      }),
    )
    expect(back).toEqual([x, y])
    expect(getChildIds(doc, flex)).toEqual([x, y, z])
    expect(getNode(doc, x)!.styles).toEqual({ width: 50, height: 20 })
  })

  it('groups nodes from different parents into the parent of the top-most one and deletes emptied groups', () => {
    const { doc, pageId } = docWithPage()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 500, height: 500 },
    })
    const inner = createNode(doc, {
      type: 'group',
      parentId: board,
      styles: { position: 'absolute', left: 0, top: 0, width: 10, height: 10 },
    })
    const a = rect(doc, inner, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    const b = rect(doc, board, { position: 'absolute', left: 100, top: 100, width: 10, height: 10 })
    const g = groupNodes(doc, [a, b], docGeometry(doc))!
    expect(getNode(doc, inner)).toBeUndefined()
    expect(getNode(doc, g)!.parentId).toBe(board)
    expect(getNode(doc, g)!.styles).toMatchObject({
      position: 'absolute',
      left: 0,
      top: 0,
      width: 110,
      height: 110,
    })
    expect(getNode(doc, board)!.styles['position']).toBeUndefined() // top-level artboard
    expect(checkInvariants(doc)).toEqual([])
  })
})

describe('fitGroups / resizeGroup', () => {
  it('refits nested and rotated groups, deepest first, keeping children in place', () => {
    const { doc, pageId } = docWithPage()
    const outer = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 100, height: 100, rotate: '90deg' },
    })
    const inner = createNode(doc, {
      type: 'group',
      parentId: outer,
      styles: { position: 'absolute', left: 0, top: 0, width: 100, height: 100 },
    })
    const a = rect(doc, inner, { position: 'absolute', left: 0, top: 0, width: 100, height: 100 })
    const b = rect(doc, outer, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    const geo0 = docGeometry(doc)
    // Move a to the right inside inner; fit must keep every node where it is in the world.
    setStyles(doc, a, { left: 50, width: 100 })
    const fa = docGeometry(doc).frameOf(a)!
    const fb = geo0.frameOf(b)!
    fitGroups(doc, [a], docGeometry(doc))
    expect(getNode(doc, a)!.styles).toMatchObject({ left: 0, top: 0 })
    expect(getNode(doc, inner)!.styles).toMatchObject({ left: 50, width: 100, height: 100 })
    expect(getNode(doc, outer)!.styles['width']).toBe(150)
    const geo1 = docGeometry(doc)
    expectFrameClose(geo1.frameOf(a), fa)
    expectFrameClose(geo1.frameOf(b), fb)
    expect(checkInvariants(doc)).toEqual([])
  })

  it('resizeGroup scales descendants (through nested groups)', () => {
    const { doc, pageId } = docWithPage()
    const g = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 100, height: 50 },
    })
    const a = rect(doc, g, { position: 'absolute', left: 0, top: 0, width: 50, height: 50 })
    const inner = createNode(doc, {
      type: 'group',
      parentId: g,
      styles: { position: 'absolute', left: 50, top: 0, width: 50, height: 50 },
    })
    const b = rect(doc, inner, { position: 'absolute', left: 0, top: 25, width: 50, height: 25 })
    const c = rect(doc, inner, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    expect(checkInvariants(doc)).toEqual([])
    resizeGroup(doc, g, { left: 10, top: 10, width: 200, height: 100 })
    expect(getNode(doc, c)!.styles).toMatchObject({ left: 0, top: 0, width: 20, height: 20 })
    expect(getNode(doc, g)!.styles).toMatchObject({ left: 10, top: 10, width: 200, height: 100 })
    expect(getNode(doc, a)!.styles).toMatchObject({ left: 0, top: 0, width: 100, height: 100 })
    expect(getNode(doc, inner)!.styles).toMatchObject({
      left: 100,
      top: 0,
      width: 100,
      height: 100,
    })
    expect(getNode(doc, b)!.styles).toMatchObject({ left: 0, top: 50, width: 100, height: 50 })
    expect(checkInvariants(doc)).toEqual([])
  })
})

describe('reparentNodes', () => {
  it('moves page → absolute frame → flex frame → page keeping world frames', () => {
    const { doc, pageId } = docWithPage()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 200, top: 100, width: 400, height: 300 },
    })
    const nested = createNode(doc, {
      type: 'frame',
      parentId: board,
      styles: {
        position: 'absolute',
        left: 20,
        top: 20,
        width: 200,
        height: 200,
        borderWidth: '2px',
      },
    })
    const flex = createNode(doc, {
      type: 'frame',
      parentId: board,
      styles: { position: 'absolute', left: 250, top: 0, width: 100, height: 100, display: 'flex' },
    })
    const r = rect(doc, pageId, { left: 260, top: 150, width: 20, height: 10, rotate: '30deg' })
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    expect(
      reparentNodes(doc, [{ id: r }], { parentId: nested }, docGeometry(doc), {
        origin: 'canvas:reparent',
      }),
    ).toEqual([r])
    expect(getNode(doc, r)!.styles).toMatchObject({
      position: 'absolute',
      left: 38,
      top: 28,
      rotate: '30deg',
    })
    expect(getNode(doc, nested)!.styles['position']).toBe('absolute') // already a containing block
    expectFrameClose(docGeometry(doc).frameOf(r), frame(260, 150, 20, 10, 30))
    reparentNodes(doc, [{ id: r }], { parentId: flex, index: 0 }, docGeometry(doc))
    expect(getNode(doc, r)!.styles).toEqual({ width: 20, height: 10, rotate: '30deg' })
    reparentNodes(
      doc,
      [{ id: r, world: frame(5, 6, 20, 10, 0) }],
      { parentId: pageId },
      docGeometry(doc),
    )
    expect(getNode(doc, r)!.styles).toEqual({ left: 5, top: 6, width: 20, height: 10 })
    undo.undo()
    expect(getNode(doc, r)!.parentId).toBe(flex)
  })

  it('gives an unpositioned nested frame a containing block and freezes flow sizes leaving flex', () => {
    const { doc, pageId } = docWithPage()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 400, height: 300, display: 'flex' },
    })
    const target = createNode(doc, {
      type: 'frame',
      parentId: board,
      styles: { width: 200, height: 200 },
    })
    const item = rect(doc, board, { width: '100%', height: 20, flexGrow: 1 })
    const geo = framesGeometry(doc, {
      [target]: frame(0, 0, 200, 200),
      [item]: frame(200, 0, 200, 20),
    })
    reparentNodes(doc, [{ id: item }], { parentId: target }, geo)
    expect(getNode(doc, target)!.styles['position']).toBe('relative')
    expect(getNode(doc, item)!.styles).toMatchObject({
      position: 'absolute',
      left: 200,
      top: 0,
      width: 200,
      height: 20,
    })
  })

  it('moves into a group (absolute + refit) and deletes the emptied source group', () => {
    const { doc, pageId } = docWithPage()
    const g1 = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
    })
    const a = rect(doc, g1, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    const g2 = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 100, top: 100, width: 10, height: 10 },
    })
    rect(doc, g2, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    reparentNodes(doc, [{ id: a }], { parentId: g2 }, docGeometry(doc))
    expect(getNode(doc, g1)).toBeUndefined()
    expect(getNode(doc, g2)!.styles).toMatchObject({ left: 0, top: 0, width: 110, height: 110 })
    expectFrameClose(docGeometry(doc).frameOf(a), frame(0, 0, 10, 10))
    expect(checkInvariants(doc)).toEqual([])
  })

  it('assigns node keys inside mains and refuses cycles', () => {
    const { doc, pageId } = docWithPage()
    const main = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 100, height: 100 },
    })
    createComponent(doc, [main], docGeometry(doc), { random: seeded(3) })
    const key = getNode(doc, main)!.componentKey!
    const loose = rect(doc, pageId, { left: 300, top: 0, width: 10, height: 10 })
    reparentNodes(doc, [{ id: loose }], { parentId: main }, docGeometry(doc))
    expect(getNode(doc, loose)!.nodeKey).toMatch(/^[0-9a-z]{10}$/)
    const inst = createInstance(doc, {
      componentKey: key,
      parentId: pageId,
      styles: { left: 500, top: 0 },
    })
    expect(canReparent(doc, [inst], main)).toEqual({ ok: false, reason: 'cycle' })
    expect(reparentNodes(doc, [{ id: inst }], { parentId: main }, docGeometry(doc))).toEqual([])
    expect(canReparent(doc, [main], loose)).toEqual({ ok: false, reason: 'instance-target' })
    expect(canReparent(doc, [main], inst)).toEqual({ ok: false, reason: 'instance-target' })
    expect(canReparent(doc, [`${inst}/abcdefghij`], pageId)).toEqual({
      ok: false,
      reason: 'virtual',
    })
    expect(canReparent(doc, [pageId], main)).toEqual({ ok: false, reason: 'page-node' })
    expect(canReparent(doc, [main], loose)).toEqual({ ok: false, reason: 'instance-target' })
    const frameInMain = createNode(doc, { type: 'frame', parentId: main, styles: {} })
    expect(canReparent(doc, [main], frameInMain)).toEqual({ ok: false, reason: 'into-self' })
    expect(checkInvariants(doc)).toEqual([])
  })
})

describe('removeNodes / wrapInFrame', () => {
  it('deletes topmost nodes, hides virtual ones and deletes emptied groups', () => {
    const { doc, pageId } = docWithPage()
    const g = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
    })
    const a = rect(doc, g, { position: 'absolute', left: 0, top: 0, width: 10, height: 10 })
    const b = rect(doc, pageId, { left: 50, top: 0, width: 10, height: 10 })
    removeNodes(doc, [a, b], docGeometry(doc))
    expect(getNode(doc, g)).toBeUndefined()
    expect(getNode(doc, b)).toBeUndefined()
  })

  it('wraps flow items in a flex frame and other nodes in an absolute frame', () => {
    const { doc, pageId } = docWithPage()
    const flex = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 300, height: 100, display: 'flex', flexDirection: 'row' },
    })
    const x = rect(doc, flex, { width: 10, height: 10 })
    const y = rect(doc, flex, { width: 10, height: 10 })
    const f = wrapInFrame(doc, [y, x], docGeometry(doc))!
    expect(getChildIds(doc, flex)).toEqual([f])
    expect(getNode(doc, f)!.styles).toEqual({ display: 'flex', flexDirection: 'row' })
    expect(getChildIds(doc, f)).toEqual([x, y])
    const a = rect(doc, pageId, { left: 100, top: 100, width: 10, height: 10 })
    const b = rect(doc, pageId, { left: 150, top: 120, width: 10, height: 10 })
    const w = wrapInFrame(doc, [a, b], docGeometry(doc), { name: 'Wrap' })!
    expect(getNode(doc, w)!.styles).toEqual({ left: 100, top: 100, width: 60, height: 30 })
    expect(getNode(doc, b)!.styles).toMatchObject({ position: 'absolute', left: 50, top: 20 })
  })
})
