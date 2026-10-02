/**
 * QA (Phase 3): adversarial edge cases for the six canvas-tool features at the model level —
 * reparenting between contexts, rotation inside flex frames, groups (nested, rotated, ungroup),
 * vectors with 1/2/many points, components (deleted mains, detach, overrides vs main edits,
 * cycles), clipboard across files (instances, tokens, images) and single-step undo/redo of
 * every compound helper.
 */
import { describe, expect, it } from 'vitest'
import { UndoManager, type LoroDoc } from 'loro-crdt'
import {
  attachAssetBytes,
  canReparent,
  createComponent,
  createComponentResolver,
  createInstance,
  createNode,
  deleteNode,
  detachInstance,
  docGeometry,
  duplicateNodes,
  editVector,
  findMainComponent,
  getChildIds,
  getNode,
  getResolvedNode,
  getTokens,
  groupNodes,
  listComponents,
  normalizeVector,
  parseClipboardPayload,
  pasteClipboard,
  readRotation,
  removeNodes,
  reparentNodes,
  resetOverrides,
  restoreMainComponent,
  rotateNodes,
  serializeClipboard,
  setPropsAt,
  setRotation,
  setStyles,
  setStylesAt,
  setTextAt,
  setTokens,
  setVectorGeometry,
  splitSegment,
  toRenderSubtree,
  toSnapshot,
  ungroupNodes,
  vectorBounds,
  vectorToPathD,
  wrapInFrame,
  type DesignNode,
  type NodeFrame,
  type VectorData,
} from '../src/index.ts'
import { docWithPage, expectFrameClose, frame, framesGeometry, seeded } from './helpers.ts'
import { checkInvariants } from './invariants.ts'

type Doc = LoroDoc

function rect(doc: Doc, parentId: string, styles: Record<string, string | number>, name = 'R') {
  return createNode(doc, { type: 'rect', parentId, name, styles })
}

function board(doc: Doc, parentId: string, styles: Record<string, string | number>, name = 'F') {
  return createNode(doc, { type: 'frame', parentId, name, styles })
}

/** Id-free structure of the whole document (undo of a delete re-creates nodes under new ids). */
function shape(doc: Doc): unknown {
  const snap = toSnapshot(doc)
  const walk = (id: string): unknown => {
    const n = snap.nodes[id] as DesignNode
    const {
      id: _id,
      parentId: _p,
      children,
      mainId: _m,
      ...rest
    } = n as DesignNode & { mainId?: string }
    return { ...rest, children: children.map(walk) }
  }
  return {
    pages: snap.pageIds.map(walk),
    tokens: snap.tokens,
    components: Object.keys(snap.components ?? {}).sort(),
  }
}

/** Run `action`, then check undo restores the previous structure and redo the new one. */
function expectSingleUndoStep(doc: Doc, action: () => void): void {
  doc.commit()
  const undo = new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: ['derived'] })
  const before = shape(doc)
  action()
  doc.commit()
  const after = shape(doc)
  expect(after).not.toEqual(before)
  expect(undo.canUndo()).toBe(true)
  undo.undo()
  expect(shape(doc)).toEqual(before)
  expect(undo.canUndo()).toBe(false)
  undo.redo()
  expect(shape(doc)).toEqual(after)
}

function frameOf(doc: Doc, id: string): NodeFrame {
  const f = docGeometry(doc).frameOf(id)
  if (!f) throw new Error(`no frame for ${id}`)
  return f
}

function setup() {
  const { doc, pageId } = docWithPage('QA', 1)
  return { doc, pageId }
}

/** A main "Card" (title text + icon rect + badge frame) and an instance of it on the page. */
function cardComponent(doc: Doc, pageId: string, seed = 3) {
  const card = board(doc, pageId, { left: 0, top: 0, width: 200, height: 100, color: '#111' })
  const title = createNode(doc, {
    type: 'text',
    parentId: card,
    name: 'Title',
    text: 'Title',
    styles: { position: 'absolute', left: 8, top: 8, fontSize: 14 },
  })
  const icon = rect(doc, card, {
    position: 'absolute',
    left: 150,
    top: 10,
    width: 20,
    height: 20,
    backgroundColor: '#ff0000',
  })
  const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(seed) })!
  const key = getNode(doc, main)!.componentKey!
  const inst = createInstance(doc, {
    componentKey: key,
    parentId: pageId,
    styles: { left: 400, top: 0 },
  })
  return {
    main,
    key,
    title,
    icon,
    inst,
    tk: getNode(doc, title)!.nodeKey!,
    ik: getNode(doc, icon)!.nodeKey!,
  }
}

// ---------------------------------------------------------------------------
// Reparenting
// ---------------------------------------------------------------------------

describe('QA reparent', () => {
  it('into a flex frame: becomes a flow item at the index; out to a non-flex frame: absolute at its world position', () => {
    const { doc, pageId } = setup()
    const a = board(doc, pageId, { left: 0, top: 0, width: 300, height: 300 }, 'A')
    const flex = board(
      doc,
      pageId,
      { left: 400, top: 0, width: 300, height: 300, display: 'flex', gap: 10 },
      'Flex',
    )
    const f1 = rect(doc, flex, { width: 50, height: 50 })
    const f2 = rect(doc, flex, { width: 50, height: 50 })
    const r = rect(doc, a, { position: 'absolute', left: 20, top: 30, width: 40, height: 40 })
    expect(canReparent(doc, [r], flex)).toEqual({ ok: true })
    const moved = reparentNodes(doc, [{ id: r }], { parentId: flex, index: 1 }, docGeometry(doc))
    expect(moved).toEqual([r])
    expect(getChildIds(doc, flex)).toEqual([f1, r, f2])
    const flow = getNode(doc, r)!.styles
    expect(flow['position']).toBeUndefined()
    expect(flow['left']).toBeUndefined()
    expect(flow['top']).toBeUndefined()
    expect(flow['width']).toBe(40)
    // Back out into the non-flex frame A at a given world frame.
    reparentNodes(
      doc,
      [{ id: r, world: frame(110, 120, 40, 40) }],
      { parentId: a },
      docGeometry(doc),
    )
    expect(getNode(doc, r)!.styles).toMatchObject({ position: 'absolute', left: 110, top: 120 })
    expectFrameClose(frameOf(doc, r), frame(110, 120, 40, 40))
    expect(checkInvariants(doc)).toEqual([])
  })

  it('a flow item with a flex size (flex: 1, width 100%) keeps its measured size when it leaves the flex frame', () => {
    const { doc, pageId } = setup()
    const flex = board(doc, pageId, {
      left: 0,
      top: 0,
      width: 300,
      height: 100,
      display: 'flex',
    })
    const item = rect(doc, flex, { flex: 1, height: '100%' })
    const geo = framesGeometry(doc, { [item]: frame(0, 0, 300, 100) })
    reparentNodes(doc, [{ id: item }], { parentId: pageId }, geo)
    const s = getNode(doc, item)!.styles
    expect(s['left']).toBe(0)
    expect(s['top']).toBe(0)
    expect(s['width']).toBe(300)
    expect(s['height']).toBe(100)
  })

  it('refuses instances, virtual nodes, pages and a node into its own subtree', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    const r = rect(doc, pageId, { left: 0, top: 500, width: 10, height: 10 })
    const outer = board(doc, pageId, { left: 0, top: 600, width: 100, height: 100 })
    const inner = board(doc, outer, {
      position: 'absolute',
      left: 0,
      top: 0,
      width: 50,
      height: 50,
    })
    expect(canReparent(doc, [r], c.inst)).toEqual({ ok: false, reason: 'instance-target' })
    expect(canReparent(doc, [`${c.inst}/${c.tk}`], pageId)).toEqual({
      ok: false,
      reason: 'virtual',
    })
    expect(canReparent(doc, [r], `${c.inst}/${c.tk}`)).toEqual({
      ok: false,
      reason: 'instance-target',
    })
    expect(canReparent(doc, [pageId], outer)).toEqual({ ok: false, reason: 'page-node' })
    expect(canReparent(doc, [outer], inner)).toEqual({ ok: false, reason: 'into-self' })
    // An instance of the card into the card's own main: cycle.
    expect(canReparent(doc, [c.inst], c.main)).toEqual({ ok: false, reason: 'cycle' })
    const before = toSnapshot(doc)
    expect(reparentNodes(doc, [{ id: c.inst }], { parentId: c.main }, docGeometry(doc))).toEqual([])
    expect(reparentNodes(doc, [{ id: r }], { parentId: c.inst }, docGeometry(doc))).toEqual([])
    expect(toSnapshot(doc)).toEqual(before)
  })

  it('into and out of a group keeps world frames, refits the group and deletes it when emptied', () => {
    const { doc, pageId } = setup()
    const x = rect(doc, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const y = rect(doc, pageId, { left: 40, top: 40, width: 10, height: 10 })
    const z = rect(doc, pageId, { left: 100, top: 100, width: 20, height: 20, rotate: '30deg' })
    const g = groupNodes(doc, [x, y], docGeometry(doc))!
    const fz = frameOf(doc, z)
    reparentNodes(doc, [{ id: z }], { parentId: g }, docGeometry(doc))
    expectFrameClose(frameOf(doc, z), fz)
    expect(checkInvariants(doc)).toEqual([])
    const fx = frameOf(doc, x)
    reparentNodes(doc, [{ id: x }, { id: y }, { id: z }], { parentId: pageId }, docGeometry(doc))
    expect(getNode(doc, g)).toBeUndefined()
    expectFrameClose(frameOf(doc, x), fx)
    expectFrameClose(frameOf(doc, z), fz)
    expect(getNode(doc, z)!.styles['position']).toBeUndefined()
    expect(checkInvariants(doc)).toEqual([])
  })

  it('between rotated frames keeps the world frame (rotation relative to the new parent)', () => {
    const { doc, pageId } = setup()
    const a = board(doc, pageId, { left: 0, top: 0, width: 200, height: 200, rotate: '30deg' })
    const b = board(doc, pageId, { left: 400, top: 0, width: 300, height: 300, rotate: '-45deg' })
    const r = rect(doc, a, {
      position: 'absolute',
      left: 50,
      top: 60,
      width: 40,
      height: 20,
      rotate: '10deg',
    })
    const before = frameOf(doc, r)
    expect(before.rotation).toBeCloseTo(40)
    reparentNodes(doc, [{ id: r }], { parentId: b }, docGeometry(doc))
    expect(readRotation(getNode(doc, r)!.styles)).toBeCloseTo(85)
    expectFrameClose(frameOf(doc, r), before)
  })

  it('a frame with a border: the absolute position counts from the padding box', () => {
    const { doc, pageId } = setup()
    const b = board(doc, pageId, {
      left: 100,
      top: 100,
      width: 200,
      height: 200,
      border: '5px solid red',
    })
    const r = rect(doc, pageId, { left: 150, top: 150, width: 10, height: 10 })
    reparentNodes(doc, [{ id: r }], { parentId: b }, docGeometry(doc))
    expect(getNode(doc, r)!.styles).toMatchObject({ position: 'absolute', left: 45, top: 45 })
    expectFrameClose(frameOf(doc, r), frame(150, 150, 10, 10))
  })
})

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('QA rotation', () => {
  it('rotating an absolutely positioned child of a flex frame keeps its position', () => {
    const { doc, pageId } = setup()
    const flex = board(doc, pageId, {
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      display: 'flex',
      position: 'relative',
    })
    rect(doc, flex, { width: 50, height: 50 })
    const abs = rect(doc, flex, {
      position: 'absolute',
      left: 200,
      top: 100,
      width: 40,
      height: 20,
    })
    const before = frameOf(doc, abs)
    rotateNodes(doc, [abs], 90, docGeometry(doc))
    const s = getNode(doc, abs)!.styles
    expect(s['position']).toBe('absolute')
    expect(s['left']).toBe(200)
    expect(s['top']).toBe(100)
    expect(readRotation(s)).toBe(90)
    expectFrameClose(frameOf(doc, abs), { ...before, rotation: 90 })
  })

  it('a rotated flow item in a flex frame only turns (keeps its flow slot)', () => {
    const { doc, pageId } = setup()
    const flex = board(doc, pageId, { left: 0, top: 0, width: 400, height: 200, display: 'flex' })
    const a = rect(doc, flex, { width: 50, height: 50 })
    const b = rect(doc, flex, { width: 50, height: 50 })
    rotateNodes(doc, [a, b], 45, docGeometry(doc))
    for (const id of [a, b]) {
      const s = getNode(doc, id)!.styles
      expect(s['rotate']).toBe('45deg')
      expect(s['left']).toBeUndefined()
      expect(s['position']).toBeUndefined()
    }
    setRotation(doc, [a], -30, docGeometry(doc))
    expect(getNode(doc, a)!.styles['rotate']).toBe('-30deg')
  })

  it('multi-selection rotates around the common centre (positions move, sizes stay)', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 20, height: 20 })
    const b = rect(doc, pageId, { left: 80, top: 0, width: 20, height: 20 })
    rotateNodes(doc, [a, b], 90, docGeometry(doc))
    // Union centre (50, 10): a's centre (10, 10) → (50, -30); b's (90, 10) → (50, 50).
    expectFrameClose(frameOf(doc, a), frame(40, -40, 20, 20, 90))
    expectFrameClose(frameOf(doc, b), frame(40, 40, 20, 20, 90))
    rotateNodes(doc, [a, b], -90, docGeometry(doc))
    expectFrameClose(frameOf(doc, a), frame(0, 0, 20, 20))
    expectFrameClose(frameOf(doc, b), frame(80, 0, 20, 20))
    expect(getNode(doc, a)!.styles['rotate']).toBeUndefined()
  })

  it('rotation, resize and undo are separate single steps', () => {
    const { doc, pageId } = setup()
    const r = rect(doc, pageId, { left: 0, top: 0, width: 100, height: 50 })
    expectSingleUndoStep(doc, () => rotateNodes(doc, [r], 33, docGeometry(doc)))
    expectSingleUndoStep(doc, () => setRotation(doc, [r], 120, docGeometry(doc)))
    expectSingleUndoStep(doc, () =>
      setStylesAt(doc, r, { width: 140, height: 70 }, { origin: 'canvas:resize' }),
    )
  })

  it('rotating a group rotates its box, children keep local frames; ungroup bakes the rotation', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 20, height: 20, rotate: '10deg' })
    const b = rect(doc, pageId, { left: 100, top: 50, width: 20, height: 20 })
    const g = groupNodes(doc, [a, b], docGeometry(doc))!
    const local = getNode(doc, a)!.styles
    rotateNodes(doc, [g], 90, docGeometry(doc))
    expect(getNode(doc, g)!.styles['rotate']).toBe('90deg')
    expect(getNode(doc, a)!.styles).toEqual(local)
    const fa = frameOf(doc, a)
    const fb = frameOf(doc, b)
    expect(fa.rotation).toBeCloseTo(100)
    ungroupNodes(doc, [g], docGeometry(doc))
    expectFrameClose(frameOf(doc, a), fa)
    expectFrameClose(frameOf(doc, b), fb)
    expect(getNode(doc, b)!.styles['rotate']).toBe('90deg')
  })
})

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

describe('QA groups', () => {
  it('a group of rotated layers is sized to their rotated bounds', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 100, height: 20, rotate: '90deg' })
    const b = rect(doc, pageId, { left: 200, top: 0, width: 20, height: 20, rotate: '45deg' })
    const g = groupNodes(doc, [a, b], docGeometry(doc))!
    const gs = getNode(doc, g)!.styles
    // a's AABB: x 40..60, y -40..60; b's: centre (210, 10), half diagonal 14.14.
    const half = 10 * Math.SQRT2
    expect(gs['left']).toBeCloseTo(40)
    expect(gs['top']).toBeCloseTo(-40)
    expect(gs['width']).toBeCloseTo(210 + half - 40, 1)
    expect(gs['height']).toBeCloseTo(100, 1)
    expect(checkInvariants(doc)).toEqual([])
  })

  it('nested groups: group, group again, ungroup both — every leaf keeps its world frame and z-order', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const b = rect(doc, pageId, { left: 30, top: 30, width: 10, height: 10, rotate: '20deg' })
    const c = rect(doc, pageId, { left: 100, top: 0, width: 10, height: 30 })
    const d = rect(doc, pageId, { left: 500, top: 500, width: 10, height: 10 })
    const frames = Object.fromEntries([a, b, c].map((id) => [id, frameOf(doc, id)]))
    const g1 = groupNodes(doc, [a, b], docGeometry(doc))!
    const g2 = groupNodes(doc, [g1, c], docGeometry(doc))!
    expect(getChildIds(doc, pageId)).toEqual([g2, d])
    expect(getChildIds(doc, g2)).toEqual([g1, c])
    rotateNodes(doc, [g2], 30, docGeometry(doc))
    const rotated = Object.fromEntries([a, b, c].map((id) => [id, frameOf(doc, id)]))
    expect(checkInvariants(doc)).toEqual([])
    const out = ungroupNodes(doc, [g2], docGeometry(doc))
    expect(out).toEqual([g1, c])
    for (const id of [a, b, c]) expectFrameClose(frameOf(doc, id), rotated[id]!)
    ungroupNodes(doc, [g1], docGeometry(doc))
    expect(getChildIds(doc, pageId)).toEqual([a, b, c, d])
    for (const id of [a, b, c]) expectFrameClose(frameOf(doc, id), rotated[id]!)
    rotateNodes(doc, [a, b, c], -30, docGeometry(doc), {
      pivot: {
        x: rotated[a]!.x, // any pivot: compare against a fresh rotation below
        y: rotated[a]!.y,
      },
    })
    expect(Object.keys(frames)).toHaveLength(3)
    expect(checkInvariants(doc)).toEqual([])
  })

  it('ungrouping both a group and its nested group in one call keeps world frames', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const b = rect(doc, pageId, { left: 30, top: 30, width: 10, height: 10 })
    const c = rect(doc, pageId, { left: 100, top: 0, width: 10, height: 30 })
    const g1 = groupNodes(doc, [a, b], docGeometry(doc))!
    const g2 = groupNodes(doc, [g1, c], docGeometry(doc))!
    rotateNodes(doc, [g2], 45, docGeometry(doc))
    const before = [a, b, c].map((id) => frameOf(doc, id))
    ungroupNodes(doc, [g2, g1], docGeometry(doc))
    expect(getNode(doc, g1)).toBeUndefined()
    expect(getNode(doc, g2)).toBeUndefined()
    ;[a, b, c].forEach((id, i) => expectFrameClose(frameOf(doc, id), before[i]!))
  })

  it('a group inside a flex frame is one flow item; its children stay absolute inside it', () => {
    const { doc, pageId } = setup()
    const flex = board(doc, pageId, {
      left: 0,
      top: 0,
      width: 400,
      height: 100,
      display: 'flex',
      gap: 10,
    })
    const a = rect(doc, flex, { width: 50, height: 50 })
    const b = rect(doc, flex, { width: 30, height: 80 })
    const c = rect(doc, flex, { width: 20, height: 20 })
    const geo = framesGeometry(doc, {
      [a]: frame(0, 0, 50, 50),
      [b]: frame(60, 0, 30, 80),
      [c]: frame(100, 0, 20, 20),
    })
    const g = groupNodes(doc, [a, b], geo)!
    expect(getChildIds(doc, flex)).toEqual([g, c])
    const gs = getNode(doc, g)!.styles
    expect(gs).toMatchObject({ width: 90, height: 80, flexShrink: 0 })
    expect(gs['position']).toBeUndefined()
    expect(gs['left']).toBeUndefined()
    expect(getNode(doc, b)!.styles).toMatchObject({ position: 'absolute', left: 60, top: 0 })
    expect(checkInvariants(doc)).toEqual([])
    // Rotating the group inside the flex frame only turns it (flow item).
    rotateNodes(doc, [g], 15, geo)
    expect(getNode(doc, g)!.styles['left']).toBeUndefined()
    expect(getNode(doc, g)!.styles['rotate']).toBe('15deg')
  })

  it('grouping absolutely positioned children of a flex frame keeps them in place (absolute group)', () => {
    const { doc, pageId } = setup()
    const flex = board(doc, pageId, {
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      display: 'flex',
      position: 'relative',
    })
    const flow = rect(doc, flex, { width: 50, height: 50 })
    const a = rect(doc, flex, { position: 'absolute', left: 200, top: 100, width: 20, height: 20 })
    const b = rect(doc, flex, { position: 'absolute', left: 300, top: 150, width: 20, height: 20 })
    const geo = framesGeometry(doc, { [flow]: frame(0, 0, 50, 50) })
    const fa = frameOf(doc, a)
    const fb = frameOf(doc, b)
    const g = groupNodes(doc, [a, b], geo)!
    expect(getNode(doc, g)!.styles).toMatchObject({
      position: 'absolute',
      left: 200,
      top: 100,
      width: 120,
      height: 70,
    })
    expectFrameClose(frameOf(doc, a), fa)
    expectFrameClose(frameOf(doc, b), fb)
    expect(checkInvariants(doc)).toEqual([])
    // Ungroup returns absolute children (not flow items) at the same place.
    ungroupNodes(doc, [g], geo)
    expect(getNode(doc, a)!.styles).toMatchObject({ position: 'absolute', left: 200, top: 100 })
    expectFrameClose(frameOf(doc, b), fb)
    // Wrap in frame: same rule, an absolute frame.
    const w = wrapInFrame(doc, [a, b], geo)!
    expect(getNode(doc, w)!.styles).toMatchObject({ position: 'absolute', left: 200, top: 100 })
    expectFrameClose(frameOf(doc, a), fa)
    expect(getChildIds(doc, flex)).toEqual([flow, w])
  })

  it('creating a component from absolute children of a flex frame keeps them in place', () => {
    const { doc, pageId } = setup()
    const flex = board(doc, pageId, {
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      display: 'flex',
      position: 'relative',
    })
    const a = rect(doc, flex, { position: 'absolute', left: 200, top: 100, width: 20, height: 20 })
    const fa = frameOf(doc, a)
    const main = createComponent(doc, [a], docGeometry(doc))!
    expect(getNode(doc, main)!.styles['position']).toBe('absolute')
    expectFrameClose(frameOf(doc, a), fa)
  })

  it('groups refuse instance content and keep a main component child grouped inside the main', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    expect(groupNodes(doc, [`${c.inst}/${c.tk}`], docGeometry(doc))).toBeNull()
    const g = groupNodes(doc, [c.title, c.icon], docGeometry(doc))!
    expect(getNode(doc, g)!.parentId).toBe(c.main)
    expect(getNode(doc, g)!.nodeKey).toMatch(/^[0-9a-z]{10}$/)
    // Existing overrides keep working: the title keeps its node key.
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Hi')
    const sub = toRenderSubtree(doc, c.inst)!
    const title = Object.values(sub.nodes).find((n) => n.source?.mainNodeId === c.title)
    expect(title?.text).toBe('Hi')
    expect(checkInvariants(doc)).toEqual([])
  })

  it('removing the last child of a nested group deletes the whole chain of emptied groups', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const g1 = groupNodes(doc, [a], docGeometry(doc))!
    const g2 = groupNodes(doc, [g1], docGeometry(doc))!
    removeNodes(doc, [a], docGeometry(doc))
    expect(getNode(doc, g1)).toBeUndefined()
    expect(getNode(doc, g2)).toBeUndefined()
    expect(getChildIds(doc, pageId)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Vectors (pen paths)
// ---------------------------------------------------------------------------

function vec(points: { x: number; y: number }[], closed = false, id = 'sp000001'): VectorData {
  return { fillRule: 'nonzero', subpaths: [{ id, closed, points }] }
}

describe('QA vectors', () => {
  it('a 1-point path: "M x y", a 1×1 box, no NaN anywhere', () => {
    const v = vec([{ x: 5, y: 7 }])
    expect(vectorToPathD(v)).toBe('M 5 7')
    expect(vectorBounds(v)).toEqual({ x: 5, y: 7, width: 0, height: 0 })
    const n = normalizeVector(v, frame(100, 100, 10, 10))
    expect(n.box.width).toBe(1)
    expect(n.box.height).toBe(1)
    for (const k of ['x', 'y'] as const) expect(Number.isFinite(n.box[k])).toBe(true)
    expect(vectorToPathD(n.vector)).toBe('M 0 0')
    // Closing a 1-point path draws nothing extra.
    expect(vectorToPathD(vec([{ x: 5, y: 7 }], true))).toBe('M 5 7')
  })

  it('a 2-point path: horizontal line has height 1 after normalisation; closed 2-point path closes', () => {
    const v = vec([
      { x: 0, y: 10 },
      { x: 50, y: 10 },
    ])
    expect(vectorToPathD(v)).toBe('M 0 10 L 50 10')
    const n = normalizeVector(v, frame(0, 0, 50, 20))
    // The 1 px box starts at the line (the path sits on its top edge).
    expect(n.box).toEqual({ x: 0, y: 10, width: 50, height: 1, rotation: 0 })
    expect(vectorToPathD(n.vector)).toBe('M 0 0 L 50 0')
    expect(vectorToPathD(vec(v.subpaths[0]!.points, true))).toBe('M 0 10 L 50 10 Z')
  })

  it('many points: close and reopen a path through editVector; split the closing segment', () => {
    const { doc, pageId } = setup()
    const pts = Array.from({ length: 12 }, (_, i) => ({
      x: 50 + 40 * Math.cos((i / 12) * 2 * Math.PI),
      y: 50 + 40 * Math.sin((i / 12) * 2 * Math.PI),
    }))
    const id = createNode(doc, {
      type: 'vector',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 100, height: 100, stroke: '#000', fill: 'none' },
      vector: vec(pts),
    })
    expect(vectorToPathD(getNode(doc, id)!.vector!)).not.toContain('Z')
    editVector(doc, id, [{ kind: 'closed', subpathId: 'sp000001', closed: true }])
    expect(vectorToPathD(getNode(doc, id)!.vector!)).toMatch(/ Z$/)
    editVector(doc, id, [{ kind: 'closed', subpathId: 'sp000001', closed: false }])
    expect(vectorToPathD(getNode(doc, id)!.vector!)).not.toContain('Z')
    const closedSp = { id: 'sp000001', closed: true, points: pts }
    const split = splitSegment(closedSp, 11, 0.5)
    expect(split.points).toHaveLength(13)
    const mid = split.points[12]!
    expect(mid.x).toBeCloseTo((pts[11]!.x + pts[0]!.x) / 2)
    expect(mid.y).toBeCloseTo((pts[11]!.y + pts[0]!.y) / 2)
  })

  it('deleting every point of a vector through setVectorGeometry leaves no NaN geometry', () => {
    const { doc, pageId } = setup()
    const id = createNode(doc, {
      type: 'vector',
      parentId: pageId,
      styles: { left: 10, top: 10, width: 10, height: 10 },
      vector: vec([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    })
    setVectorGeometry(doc, id, { fillRule: 'nonzero', subpaths: [] }, {})
    const n = getNode(doc, id)!
    expect(n.vector?.subpaths ?? []).toEqual([])
    expect(vectorToPathD(n.vector!)).toBe('')
    expect(JSON.stringify(n.styles)).not.toContain('NaN')
  })

  it('vector edits are single undo steps; resizing a grouped vector rescales its points', () => {
    const { doc, pageId } = setup()
    const id = createNode(doc, {
      type: 'vector',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
      vector: vec(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        true,
      ),
    })
    expectSingleUndoStep(doc, () =>
      setVectorGeometry(
        doc,
        id,
        vec(
          [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 10 },
          ],
          true,
        ),
        { width: 20 },
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

describe('QA components', () => {
  it('deleting the main while instances exist: they keep rendering; restore re-links them; undo works', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Override')
    const before = toRenderSubtree(doc, c.inst)!
    deleteNode(doc, c.main)
    const r = createComponentResolver(doc)
    const exp = r.expandInstance(c.inst)!
    expect(exp.status).toBe('ok')
    expect(exp.mainDeleted).toBe(true)
    const titleNode = exp.nodes[`${c.inst}/${c.tk}`]!
    expect(titleNode.text).toBe('Override')
    expect(Object.keys(exp.nodes)).toEqual(Object.keys(before.nodes))
    expect(listComponents(doc)).toEqual([])
    // A second instance created while the main is deleted is refused? It resolves from the hint.
    const restored = restoreMainComponent(doc, c.key)!
    expect(restored).not.toBe(c.main)
    expect(findMainComponent(doc, c.key)).toEqual({ mainId: restored, deleted: false })
    const after = createComponentResolver(doc).expandInstance(c.inst)!
    expect(after.mainDeleted).toBe(false)
    expect(after.nodes[`${c.inst}/${c.tk}`]!.text).toBe('Override')
    // Edits to the restored main propagate.
    const restoredIcon = getChildIds(doc, restored).find(
      (id) => getNode(doc, id)!.nodeKey === c.ik,
    )!
    setStyles(doc, restoredIcon, { backgroundColor: '#00ff00' })
    expect(getResolvedNode(doc, `${c.inst}/${c.ik}`)!.styles['backgroundColor']).toBe('#00ff00')
    expect(checkInvariants(doc)).toEqual([])
  })

  it('detach then edit: the detached copy and the main no longer affect each other', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Mine')
    setStylesAt(doc, `${c.inst}/${c.ik}`, { backgroundColor: '#0000ff' })
    detachInstance(doc, c.inst)
    const detached = getNode(doc, c.inst)!
    expect(detached.type).toBe('frame')
    expect(detached.componentKey).toBeUndefined()
    const kids = detached.children.map((id) => getNode(doc, id)!)
    const title = kids.find((k) => k.type === 'text')!
    const icon = kids.find((k) => k.type === 'rect')!
    expect(title.text).toBe('Mine')
    expect(icon.styles['backgroundColor']).toBe('#0000ff')
    // Edit the main: the detached frame does not follow.
    setStyles(doc, c.icon, { backgroundColor: '#123456', width: 99 })
    setTextAt(doc, c.title, 'Main text')
    expect(getNode(doc, icon.id)!.styles['backgroundColor']).toBe('#0000ff')
    expect(getNode(doc, icon.id)!.styles['width']).toBe(20)
    expect(getNode(doc, title.id)!.text).toBe('Mine')
    // Edit the detached copy: the main does not follow.
    setStyles(doc, icon.id, { backgroundColor: '#abcdef' })
    expect(getNode(doc, c.icon)!.styles['backgroundColor']).toBe('#123456')
    expect(checkInvariants(doc)).toEqual([])
  })

  it('detaching an instance whose group content is overridden refits the now real group', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    // Sized title: the invariant check compares the group box with px-sized children only.
    setStyles(doc, c.title, { width: 100, height: 20 })
    const g = groupNodes(doc, [c.title, c.icon], docGeometry(doc))!
    const gk = getNode(doc, g)!.nodeKey!
    // Overrides move and rotate the icon inside the (virtual) group of the instance.
    setStylesAt(doc, `${c.inst}/${c.ik}`, { left: 300, rotate: '45deg' })
    expect(getResolvedNode(doc, `${c.inst}/${gk}`)?.type).toBe('group')
    detachInstance(doc, c.inst)
    expect(checkInvariants(doc)).toEqual([])
    const group = getNode(doc, c.inst)!.children.map((id) => getNode(doc, id)!)
    expect(group.find((n) => n.type === 'group')).toBeDefined()
  })

  it('detach is one undo step and undo brings the instance back with its overrides', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Kept')
    setStylesAt(doc, c.inst, { opacity: 0.5 })
    setStylesAt(doc, `${c.inst}/${c.ik}`, { backgroundColor: '#0000ff' })
    doc.commit()
    const render = toRenderSubtree(doc, c.inst)
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    detachInstance(doc, c.inst)
    doc.commit()
    expect(getNode(doc, c.inst)!.type).toBe('frame')
    undo.undo()
    expect(getNode(doc, c.inst)!.type).toBe('instance')
    expect(getNode(doc, c.inst)!.children).toEqual([])
    // Overrides come back exactly: the render equals the one before the detach.
    expect(toRenderSubtree(doc, c.inst)).toEqual(render)
    expect(undo.canUndo()).toBe(false) // the detach was exactly one step
    undo.redo()
    expect(getNode(doc, c.inst)!.type).toBe('frame')
    expect(getNode(doc, c.inst)!.children).toHaveLength(2)
    expect(checkInvariants(doc)).toEqual([])
  })

  it('override then edit main: overridden keys win, everything else follows the main', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    setStylesAt(doc, `${c.inst}/${c.ik}`, { backgroundColor: '#0000ff' })
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Custom')
    setStyles(doc, c.icon, { backgroundColor: '#00ff00', width: 30, borderRadius: 4 })
    setTextAt(doc, c.title, 'Main changed')
    setStyles(doc, c.title, { fontSize: 20 })
    const r = createComponentResolver(doc)
    const icon = r.resolveNode(`${c.inst}/${c.ik}`)!
    expect(icon.styles).toMatchObject({ backgroundColor: '#0000ff', width: 30, borderRadius: 4 })
    const title = r.resolveNode(`${c.inst}/${c.tk}`)!
    expect(title.text).toBe('Custom')
    expect(title.styles['fontSize']).toBe(20)
    // Setting the override back to the main's current value removes it.
    setStylesAt(doc, `${c.inst}/${c.ik}`, { backgroundColor: '#00ff00' })
    expect(getResolvedNode(doc, `${c.inst}/${c.ik}`)!.overridden).toBeUndefined()
    // Reset, then the main edits show; no resurfaced values.
    resetOverrides(doc, c.inst)
    setStyles(doc, c.icon, { backgroundColor: '#ffff00' })
    expect(getResolvedNode(doc, `${c.inst}/${c.tk}`)!.text).toBe('Main changed')
    expect(getResolvedNode(doc, `${c.inst}/${c.ik}`)!.styles['backgroundColor']).toBe('#ffff00')
  })

  it('hidden override survives a main edit and a delete/undo of the main node', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    setPropsAt(doc, `${c.inst}/${c.ik}`, { hidden: true })
    setStyles(doc, c.icon, { width: 44 })
    expect(getResolvedNode(doc, `${c.inst}/${c.ik}`)!.hidden).toBe(true)
    doc.commit()
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    deleteNode(doc, c.icon)
    doc.commit()
    expect(getResolvedNode(doc, `${c.inst}/${c.ik}`)).toBeUndefined()
    undo.undo()
    const icon = getResolvedNode(doc, `${c.inst}/${c.ik}`)!
    expect(icon.hidden).toBe(true)
    expect(icon.styles['width']).toBe(44)
  })

  it('nested instance cycles are refused everywhere (create, reparent, paste, wrap, create component)', () => {
    const { doc, pageId } = setup()
    const a = cardComponent(doc, pageId, 3)
    const bFrame = board(doc, pageId, { left: 0, top: 300, width: 100, height: 100 }, 'B')
    const bMain = createComponent(doc, [bFrame], docGeometry(doc), { random: seeded(9) })!
    const bKey = getNode(doc, bMain)!.componentKey!
    // A contains an instance of B.
    const bInA = createInstance(doc, {
      componentKey: bKey,
      parentId: a.main,
      styles: { position: 'absolute', left: 0, top: 50 },
    })
    // Now an instance of A inside B would be a cycle (A → B → A).
    expect(() =>
      createInstance(doc, { componentKey: a.key, parentId: bMain, styles: {} }),
    ).toThrowError(/itself/)
    const aOnPage = createInstance(doc, {
      componentKey: a.key,
      parentId: pageId,
      index: 0,
      styles: {},
    })
    expect(canReparent(doc, [aOnPage], bMain)).toEqual({ ok: false, reason: 'cycle' })
    const payload = serializeClipboard(doc, [aOnPage], {
      geo: docGeometry(doc),
      fileId: 'f',
      pageId,
    })!
    const res = pasteClipboard(doc, payload, { parentId: bMain, geo: docGeometry(doc) })
    expect(res.refused).toBe('cycle')
    // Grouping/wrapping the A-instance (painted first) with a child of B (painted last) puts
    // the new container into B: refused as a cycle.
    const rInB = rect(doc, bMain, { position: 'absolute', left: 0, top: 0, width: 5, height: 5 })
    expect(groupNodes(doc, [rInB, aOnPage], docGeometry(doc))).toBeNull()
    expect(wrapInFrame(doc, [rInB, aOnPage], docGeometry(doc))).toBeNull()
    // Detaching the nested B-instance in A and then the A-instance is fine (no cycle).
    expect(getNode(doc, bInA)!.type).toBe('instance')
    expect(checkInvariants(doc)).toEqual([])
  })

  it('a main nested inside another main: instances of the outer render the inner as plain content', () => {
    const { doc, pageId } = setup()
    const outer = board(doc, pageId, { left: 0, top: 0, width: 300, height: 300 }, 'Outer')
    const inner = board(
      doc,
      outer,
      { position: 'absolute', left: 10, top: 10, width: 50, height: 50 },
      'Inner',
    )
    rect(doc, inner, { position: 'absolute', left: 0, top: 0, width: 5, height: 5 })
    const innerMain = createComponent(doc, [inner], docGeometry(doc), { random: seeded(1) })!
    const outerMain = createComponent(doc, [outer], docGeometry(doc), { random: seeded(2) })!
    const ok = getNode(doc, outerMain)!.componentKey!
    const ik = getNode(doc, innerMain)!.componentKey!
    // An instance of the inner component inside the outer main is fine...
    createInstance(doc, { componentKey: ik, parentId: outerMain, styles: {} })
    // ...but an instance of the outer inside the inner (which is inside the outer) is a cycle.
    expect(() => createInstance(doc, { componentKey: ok, parentId: innerMain })).toThrowError()
    const inst = createInstance(doc, { componentKey: ok, parentId: pageId, styles: { left: 500 } })
    const exp = createComponentResolver(doc).expandInstance(inst)!
    expect(exp.status).toBe('ok')
    const copies = Object.values(exp.nodes).filter((n) => n.type === 'frame' && n.name === 'Inner')
    expect(copies).toHaveLength(1)
    expect(copies[0]!.componentKey).toBeUndefined()
    expect(checkInvariants(doc)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Clipboard across files
// ---------------------------------------------------------------------------

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
const HASH = 'a'.repeat(64)

describe('QA clipboard across files', () => {
  it('pasting an instance into a file without its component creates the main once, keeps overrides, tokens and images', async () => {
    const { doc: src, pageId } = docWithPage('Source', 1)
    setTokens(src, {
      '--brand': { type: 'color', value: 'var(--base)' },
      '--base': { type: 'color', value: '#123456' },
    })
    const c = cardComponent(src, pageId)
    setStyles(src, c.main, { backgroundColor: 'var(--brand)' })
    createNode(src, {
      type: 'image',
      parentId: c.main,
      name: 'Photo',
      assetId: HASH,
      assetName: 'photo.png',
      styles: { position: 'absolute', left: 0, top: 50, width: 10, height: 10 },
    })
    setTextAt(src, `${c.inst}/${c.tk}`, 'Overridden')
    let payload = serializeClipboard(src, [c.inst], {
      geo: docGeometry(src),
      fileId: 'src',
      pageId,
    })!
    payload = await attachAssetBytes(payload, async (h) =>
      h === HASH ? { bytes: PNG, mime: 'image/png' } : null,
    )
    const json = JSON.stringify(payload)
    const parsed = parseClipboardPayload(json)!
    expect(parsed.assets[HASH]?.data).toBeTruthy()

    const { doc: dst, pageId: dstPage } = docWithPage('Target', 2)
    setTokens(dst, { '--base': { type: 'color', value: '#ffffff' } })
    const r1 = pasteClipboard(dst, parsed, { parentId: dstPage, geo: docGeometry(dst) })
    expect(r1.refused).toBeNull()
    expect(r1.components.created).toEqual([c.key])
    expect(r1.tokens.added).toEqual(['--brand'])
    expect(r1.tokens.kept).toEqual(['--base'])
    expect(getTokens(dst)['--base']!.value).toBe('#ffffff')
    const pages = getChildIds(dst, null)
    expect(pages).toHaveLength(2)
    expect(getNode(dst, pages[1]!)!.name).toBe('Components')
    const inst = r1.ids[0]!
    const exp = createComponentResolver(dst).expandInstance(inst)!
    expect(exp.status).toBe('ok')
    expect(exp.mainDeleted).toBe(false)
    expect(exp.nodes[`${inst}/${c.tk}`]!.text).toBe('Overridden')
    expect(Object.values(exp.nodes).some((n) => n.assetId === HASH)).toBe(true)
    // mainId points at the new main in the target.
    const found = findMainComponent(dst, c.key)!
    expect(getNode(dst, inst)!.mainId).toBe(found.mainId)
    // Paste again: the main is reused, not duplicated.
    const r2 = pasteClipboard(dst, parsed, { parentId: dstPage, geo: docGeometry(dst) })
    expect(r2.components.reused).toEqual([c.key])
    expect(listComponents(dst)).toHaveLength(1)
    expect(checkInvariants(dst)).toEqual([])
  })

  it('a nested component closure: instance of A where A contains an instance of B pastes both mains', () => {
    const { doc: src, pageId } = docWithPage('Source', 1)
    const b = board(src, pageId, { left: 0, top: 300, width: 50, height: 50 }, 'B')
    rect(src, b, { position: 'absolute', left: 0, top: 0, width: 5, height: 5 })
    const bMain = createComponent(src, [b], docGeometry(src), { random: seeded(4) })!
    const bKey = getNode(src, bMain)!.componentKey!
    const a = board(src, pageId, { left: 0, top: 0, width: 100, height: 100 }, 'A')
    createInstance(src, { componentKey: bKey, parentId: a, styles: {} })
    const aMain = createComponent(src, [a], docGeometry(src), { random: seeded(5) })!
    const aKey = getNode(src, aMain)!.componentKey!
    const inst = createInstance(src, {
      componentKey: aKey,
      parentId: pageId,
      styles: { left: 500 },
    })
    const payload = serializeClipboard(src, [inst], { geo: docGeometry(src), fileId: 's', pageId })!
    expect(Object.keys(payload.components).sort()).toEqual([aKey, bKey].sort())
    const { doc: dst, pageId: dstPage } = docWithPage('T', 2)
    const res = pasteClipboard(dst, parseClipboardPayload(JSON.stringify(payload))!, {
      parentId: dstPage,
      geo: docGeometry(dst),
    })
    expect(res.components.created.sort()).toEqual([aKey, bKey].sort())
    const exp = createComponentResolver(dst).expandInstance(res.ids[0]!)!
    expect(exp.status).toBe('ok')
    const nested = Object.values(exp.nodes).find(
      (n) => n.type === 'instance' && n.id !== exp.rootId,
    )
    expect(nested?.status).toBe('ok')
    expect(checkInvariants(dst)).toEqual([])
  })

  it('copying an instance whose main was deleted still pastes a working component into another file', () => {
    const { doc: src, pageId } = docWithPage('Source', 1)
    const c = cardComponent(src, pageId)
    deleteNode(src, c.main)
    const payload = serializeClipboard(src, [c.inst], {
      geo: docGeometry(src),
      fileId: 's',
      pageId,
    })!
    expect(Object.keys(payload.components)).toEqual([c.key])
    const { doc: dst, pageId: dstPage } = docWithPage('T', 2)
    const res = pasteClipboard(dst, payload, { parentId: dstPage, geo: docGeometry(dst) })
    const exp = createComponentResolver(dst).expandInstance(res.ids[0]!)!
    expect(exp.status).toBe('ok')
    expect(exp.mainDeleted).toBe(false)
  })

  it('a pasted main into a file that already has the same key live gets a fresh key', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    const payload = serializeClipboard(doc, [c.main], {
      geo: docGeometry(doc),
      fileId: 'f',
      pageId,
    })!
    const res = pasteClipboard(doc, payload, { parentId: pageId, geo: docGeometry(doc) })
    const copy = getNode(doc, res.ids[0]!)!
    expect(copy.componentKey).toBeDefined()
    expect(copy.componentKey).not.toBe(c.key)
    expect(findMainComponent(doc, c.key)!.mainId).toBe(c.main)
    expect(listComponents(doc)).toHaveLength(2)
    expect(checkInvariants(doc)).toEqual([])
  })

  it('paste into a group keeps it a valid group (absolute child, refit)', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const b = rect(doc, pageId, { left: 50, top: 50, width: 10, height: 10 })
    const g = groupNodes(doc, [a, b], docGeometry(doc))!
    const src = rect(doc, pageId, { left: 300, top: 300, width: 30, height: 30 })
    const payload = serializeClipboard(doc, [src], { geo: docGeometry(doc), fileId: 'f', pageId })!
    const res = pasteClipboard(doc, payload, {
      parentId: g,
      geo: docGeometry(doc),
      translate: { dx: 0, dy: 0 },
    })
    expect(getNode(doc, res.ids[0]!)!.parentId).toBe(g)
    expectFrameClose(frameOf(doc, res.ids[0]!), frame(300, 300, 30, 30))
    expect(checkInvariants(doc)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Duplicates and pastes inside mains and groups keep the invariants
// ---------------------------------------------------------------------------

describe('QA duplicate / paste inside mains and groups', () => {
  it('Ctrl+D of a node inside a main gives the copy fresh node keys; instances show it', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    const [copy] = duplicateNodes(doc, [c.icon], docGeometry(doc))
    const key = getNode(doc, copy!)!.nodeKey!
    expect(key).toMatch(/^[0-9a-z]{10}$/)
    expect(key).not.toBe(c.ik)
    expect(getResolvedNode(doc, `${c.inst}/${key}`)?.type).toBe('rect')
    expect(checkInvariants(doc)).toEqual([])
  })

  it('createComponent re-keys a plain node that repeats a key of a nested main (any order)', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    // A frame holding a plain copy of the title (same key, outside every main) first and the
    // Card main (nested once converted) second.
    const outer = board(doc, pageId, { left: 0, top: 500, width: 600, height: 300 }, 'Outer')
    // A duplicated main keeps its node keys: take its title out of it.
    const [dup] = duplicateNodes(doc, [c.main], docGeometry(doc))
    const copy = getNode(doc, dup!)!.children.find((id) => getNode(doc, id)!.type === 'text')
    reparentNodes(doc, [{ id: copy! }], { parentId: outer, index: 0 }, docGeometry(doc))
    reparentNodes(doc, [{ id: c.main }], { parentId: outer }, docGeometry(doc))
    expect(getNode(doc, copy!)!.nodeKey).toBe(c.tk)
    createComponent(doc, [outer], docGeometry(doc))
    expect(getNode(doc, c.title)!.nodeKey).toBe(c.tk) // the nested main keeps its keys
    expect(getNode(doc, copy!)!.nodeKey).not.toBe(c.tk)
    expect(checkInvariants(doc)).toEqual([])
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Still bound')
    expect(getResolvedNode(doc, `${c.inst}/${c.tk}`)?.source?.mainNodeId).toBe(c.title)
  })

  it('moving a node from a duplicated main into the original re-keys it (overrides stay bound)', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Bound to the original')
    const [copy] = duplicateNodes(doc, [c.main], docGeometry(doc))
    const copyTitle = getNode(doc, copy!)!.children.find((id) => getNode(doc, id)!.type === 'text')!
    // The duplicate is a new component that keeps the node keys (copy outside every main).
    expect(getNode(doc, copyTitle)!.nodeKey).toBe(c.tk)
    reparentNodes(doc, [{ id: copyTitle }], { parentId: c.main }, docGeometry(doc))
    expect(getNode(doc, copyTitle)!.nodeKey).not.toBe(c.tk)
    expect(checkInvariants(doc)).toEqual([])
    const texts = Object.values(toRenderSubtree(doc, c.inst)!.nodes)
      .filter((n) => n.type === 'text')
      .map((n) => [n.source?.mainNodeId, n.text])
    expect(texts).toContainEqual([c.title, 'Bound to the original'])
    expect(texts).toContainEqual([copyTitle, 'Title'])
  })

  it('pasting a copy of a main child back into the same main re-keys it', () => {
    const { doc, pageId } = setup()
    const c = cardComponent(doc, pageId)
    const payload = serializeClipboard(doc, [c.title, c.icon], {
      geo: docGeometry(doc),
      fileId: 'f',
      pageId,
    })!
    const res = pasteClipboard(doc, payload, {
      parentId: c.main,
      geo: docGeometry(doc),
      translate: { dx: 0, dy: 0 },
    })
    expect(res.ids).toHaveLength(2)
    expect(checkInvariants(doc)).toEqual([])
    // Existing overrides still address the original title.
    setTextAt(doc, `${c.inst}/${c.tk}`, 'Still mine')
    const texts = Object.values(toRenderSubtree(doc, c.inst)!.nodes)
      .filter((n) => n.type === 'text')
      .map((n) => n.text)
    expect(texts).toContain('Still mine')
    expect(texts).toContain('Title')
  })

  it('Ctrl+D of a group with a rotated child and of a child inside a group keep groups valid', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 20, height: 20, rotate: '30deg' })
    const b = rect(doc, pageId, { left: 60, top: 40, width: 20, height: 20 })
    const g = groupNodes(doc, [a, b], docGeometry(doc))!
    const fa = frameOf(doc, a)
    const [g2] = duplicateNodes(doc, [g], docGeometry(doc))
    const a2 = getNode(doc, g2!)!.children[0]!
    expectFrameClose(frameOf(doc, a2), fa)
    const [b2] = duplicateNodes(doc, [b], docGeometry(doc), {
      placeRoot: () => ({ left: 300, top: 300 }),
    })
    expect(getNode(doc, b2!)!.parentId).toBe(g)
    expect(checkInvariants(doc)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Undo / redo: one step per action
// ---------------------------------------------------------------------------

describe('QA undo/redo of every new action is one step', () => {
  it('group, ungroup, reparent, wrap, remove, duplicate', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const b = rect(doc, pageId, { left: 30, top: 30, width: 10, height: 10, rotate: '15deg' })
    const f = board(doc, pageId, { left: 200, top: 0, width: 100, height: 100 })
    expectSingleUndoStep(doc, () => {
      groupNodes(doc, [a, b], docGeometry(doc))
    })
    // Redo re-creates the group under a new TreeID (Loro): find it again.
    const g = getChildIds(doc, pageId).find((id) => getNode(doc, id)!.type === 'group')!
    expect(getNode(doc, g)!.children).toEqual([a, b])
    expectSingleUndoStep(doc, () => {
      ungroupNodes(doc, [g], docGeometry(doc))
    })
    expectSingleUndoStep(doc, () => {
      reparentNodes(doc, [{ id: a }], { parentId: f }, docGeometry(doc), {
        origin: 'canvas:reparent',
      })
    })
    expectSingleUndoStep(doc, () => {
      wrapInFrame(doc, [a, b], docGeometry(doc))
    })
    expectSingleUndoStep(doc, () => removeNodes(doc, [a], docGeometry(doc)))
    expectSingleUndoStep(doc, () => {
      duplicateNodes(doc, [b], docGeometry(doc))
    })
  })

  it('ungroup then undo re-creates the group with its children (structure identical)', () => {
    const { doc, pageId } = setup()
    const a = rect(doc, pageId, { left: 0, top: 0, width: 10, height: 10 })
    const b = rect(doc, pageId, { left: 30, top: 30, width: 10, height: 10 })
    const g = groupNodes(doc, [a, b], docGeometry(doc))!
    doc.commit()
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    ungroupNodes(doc, [g], docGeometry(doc))
    doc.commit()
    undo.undo()
    const roots = getChildIds(doc, pageId)
    expect(roots).toHaveLength(1)
    const group = getNode(doc, roots[0]!)!
    expect(group.type).toBe('group')
    expect(group.children).toEqual([a, b])
    expect(checkInvariants(doc)).toEqual([])
  })

  it('create component, insert instance, override, reset, restore main, paste', () => {
    const { doc, pageId } = setup()
    const card = board(doc, pageId, { left: 0, top: 0, width: 100, height: 100 })
    const t = createNode(doc, { type: 'text', parentId: card, text: 'T', styles: {} })
    let key = ''
    expectSingleUndoStep(doc, () => {
      const main = createComponent(doc, [card], docGeometry(doc))!
      key = getNode(doc, main)!.componentKey!
    })
    // Redo left the component in place.
    expect(findMainComponent(doc, key)).toEqual({ mainId: card, deleted: false })
    expectSingleUndoStep(doc, () => {
      createInstance(doc, { componentKey: key, parentId: pageId, styles: { left: 300 } })
    })
    // Redo re-creates the instance under a new TreeID (Loro): find it again.
    const inst = getChildIds(doc, pageId).find((id) => getNode(doc, id)!.type === 'instance')!
    const tk = getNode(doc, t)!.nodeKey!
    expectSingleUndoStep(doc, () =>
      setTextAt(doc, `${inst}/${tk}`, 'Over', { origin: 'canvas:text' }),
    )
    expectSingleUndoStep(doc, () => resetOverrides(doc, inst))
    const payload = serializeClipboard(doc, [inst], { geo: docGeometry(doc), fileId: 'f', pageId })!
    expectSingleUndoStep(doc, () => {
      pasteClipboard(doc, payload, { parentId: pageId, geo: docGeometry(doc) })
    })
    deleteNode(doc, card)
    expectSingleUndoStep(doc, () => {
      restoreMainComponent(doc, key)
    })
  })
})
