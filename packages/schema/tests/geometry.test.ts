import { describe, expect, it } from 'vitest'
import {
  createNode,
  docGeometry,
  frameAabb,
  frameCorners,
  getNode,
  localToWorld,
  normalizeDeg,
  placementStyles,
  pointInFrame,
  readRotation,
  rotateNodes,
  rotatePoint,
  rotationValue,
  setRotation,
  worldToLocal,
} from '../src/index.ts'
import { docWithPage, expectFrameClose, frame, framesGeometry } from './helpers.ts'

describe('rotation values', () => {
  it('normalises degrees to (-180, 180]', () => {
    expect(normalizeDeg(0)).toBe(0)
    expect(normalizeDeg(180)).toBe(180)
    expect(normalizeDeg(-180)).toBe(180)
    expect(normalizeDeg(190)).toBe(-170)
    expect(normalizeDeg(-190)).toBe(170)
    expect(normalizeDeg(720 + 15)).toBe(15)
    expect(Object.is(normalizeDeg(-360), 0)).toBe(true)
  })

  it('writes the canonical "<n>deg" form, rounded to 2 decimals; 0 removes the key', () => {
    expect(rotationValue(15)).toBe('15deg')
    expect(rotationValue(-22.456)).toBe('-22.46deg')
    expect(rotationValue(370)).toBe('10deg')
    expect(rotationValue(-179.999)).toBe('180deg')
    expect(rotationValue(0)).toBeNull()
    expect(rotationValue(360)).toBeNull()
    expect(rotationValue(0.001)).toBeNull()
  })

  it('reads deg, turn, rad, grad, bare numbers and legacy rotate-only transforms', () => {
    expect(readRotation({})).toBe(0)
    expect(readRotation({ rotate: '15deg' })).toBe(15)
    expect(readRotation({ rotate: '0.25turn' })).toBe(90)
    expect(readRotation({ rotate: `${Math.PI}rad` })).toBeCloseTo(180)
    expect(readRotation({ rotate: '100grad' })).toBeCloseTo(90)
    expect(readRotation({ rotate: 30 })).toBe(30)
    expect(readRotation({ rotate: '-45' })).toBe(-45)
    expect(readRotation({ rotate: 'none' })).toBe(0)
    expect(readRotation({ rotate: 'z 45deg' })).toBe(0)
    expect(readRotation({ transform: 'rotate(30deg)' })).toBe(30)
    expect(readRotation({ transform: 'rotate(10deg) rotateZ(5deg)' })).toBe(15)
    expect(readRotation({ transform: 'translateX(4px) rotate(30deg)' })).toBe(0)
    expect(readRotation({ rotate: '10deg', transform: 'rotate(20deg)' })).toBe(30)
    expect(readRotation({ rotate: '270deg' })).toBe(-90)
  })
})

describe('frame math', () => {
  it('rotates points clockwise like CSS and maps local <-> world', () => {
    const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(10)
    const parent = frame(100, 100, 200, 100, 90)
    const local = { x: 20, y: 30 }
    const world = localToWorld(parent, local)
    const back = worldToLocal(parent, world)
    expect(back.x).toBeCloseTo(20)
    expect(back.y).toBeCloseTo(30)
  })

  it('computes corners, AABB and point containment of rotated frames', () => {
    const f = frame(0, 0, 100, 20, 90)
    const [tl] = frameCorners(f)
    expect(tl.x).toBeCloseTo(60)
    expect(tl.y).toBeCloseTo(-40)
    const box = frameAabb(f)
    expect(box.x).toBeCloseTo(40)
    expect(box.y).toBeCloseTo(-40)
    expect(box.width).toBeCloseTo(20)
    expect(box.height).toBeCloseTo(100)
    expect(pointInFrame(f, { x: 50, y: 50 })).toBe(true)
    expect(pointInFrame(f, { x: 5, y: 10 })).toBe(false) // inside the unrotated box only
    const diamond = frame(0, 0, 100, 100, 45)
    expect(pointInFrame(diamond, { x: 3, y: 3 })).toBe(false) // AABB corner area
    expect(pointInFrame(diamond, { x: 50, y: -15 })).toBe(true)
  })
})

describe('placementStyles (§2.4)', () => {
  it('places on a page with world left/top and relative rotation', () => {
    const { doc, pageId } = docWithPage()
    expect(placementStyles(doc, pageId, frame(10.123, -5, 50, 20, 30), null)).toEqual({
      position: null,
      left: 10.12,
      top: -5,
      right: null,
      bottom: null,
      inset: null,
      rotate: '30deg',
    })
  })

  it('makes flex children flow items', () => {
    const { doc, pageId } = docWithPage()
    const flex = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 300, height: 200, display: 'flex', rotate: '10deg' },
    })
    const patch = placementStyles(doc, flex, frame(5, 5, 10, 10, 25), frame(0, 0, 300, 200, 10))
    expect(patch).toEqual({
      position: null,
      left: null,
      top: null,
      right: null,
      bottom: null,
      inset: null,
      rotate: '15deg',
    })
  })

  it('positions absolutely from the padding box (border offsets) in other frames', () => {
    const { doc, pageId } = docWithPage()
    const box = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: {
        left: 100,
        top: 50,
        width: 300,
        height: 200,
        border: '2px solid #000',
        borderTopWidth: '4px',
      },
    })
    const patch = placementStyles(doc, box, frame(130, 80, 40, 20), frame(100, 50, 300, 200))
    expect(patch['position']).toBe('absolute')
    expect(patch['left']).toBe(28)
    expect(patch['top']).toBe(26)
    expect(patch['rotate']).toBeNull()
  })

  it('positions relative to a rotated parent', () => {
    const { doc, pageId } = docWithPage()
    const g = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 100, height: 100, rotate: '90deg' },
    })
    // Child world: the unrotated parent-local box (10, 0, 20, 10) rotated 90° about (50, 50).
    const parentFrame = frame(0, 0, 100, 100, 90)
    const c = localToWorld(parentFrame, { x: 20, y: 5 })
    const world = frame(c.x - 10, c.y - 5, 20, 10, 90)
    const patch = placementStyles(doc, g, world, parentFrame)
    expect(patch['left']).toBeCloseTo(10)
    expect(patch['top']).toBeCloseTo(0)
    expect(patch['rotate']).toBeNull()
  })
})

describe('docGeometry', () => {
  it('reads declared frames through absolute, group and rotated parents', () => {
    const { doc, pageId } = docWithPage()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 100, top: 100, width: 400, height: 300, borderWidth: '1px' },
    })
    const rect = createNode(doc, {
      type: 'rect',
      parentId: board,
      styles: { position: 'absolute', left: 10, top: 20, width: 30, height: 40 },
    })
    const geo = docGeometry(doc)
    expectFrameClose(geo.frameOf(board), frame(100, 100, 400, 300))
    expectFrameClose(geo.frameOf(rect), frame(111, 121, 30, 40))
    const g = createNode(doc, {
      type: 'group',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 100, height: 100, rotate: '180deg' },
    })
    const inner = createNode(doc, {
      type: 'rect',
      parentId: g,
      styles: { position: 'absolute', left: 0, top: 0, width: 10, height: 10, rotate: '10deg' },
    })
    expectFrameClose(geo.frameOf(inner), frame(90, 90, 10, 10, -170))
  })
})

describe('setRotation / rotateNodes', () => {
  it('sets own rotation and migrates a legacy rotate-only transform', () => {
    const { doc, pageId } = docWithPage()
    const a = createNode(doc, {
      type: 'rect',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10, transform: 'rotate(20deg)' },
    })
    const b = createNode(doc, {
      type: 'rect',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10, transform: 'scale(2)' },
    })
    setRotation(doc, [a, b], 45, docGeometry(doc))
    expect(getNode(doc, a)!.styles).toEqual({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
      rotate: '45deg',
    })
    expect(getNode(doc, b)!.styles['transform']).toBe('scale(2)')
    expect(getNode(doc, b)!.styles['rotate']).toBe('45deg')
    setRotation(doc, [a], 0, docGeometry(doc))
    expect(getNode(doc, a)!.styles['rotate']).toBeUndefined()
  })

  it('rotates several nodes around the centre of their union: centres move, flow nodes only turn', () => {
    const { doc, pageId } = docWithPage()
    const a = createNode(doc, {
      type: 'rect',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 20, height: 20 },
    })
    const b = createNode(doc, {
      type: 'rect',
      parentId: pageId,
      styles: { left: 80, top: 0, width: 20, height: 20 },
    })
    const flex = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 500, top: 0, width: 100, height: 100, display: 'flex' },
    })
    const item = createNode(doc, {
      type: 'rect',
      parentId: flex,
      styles: { width: 10, height: 10 },
    })
    rotateNodes(doc, [a, b], 90, docGeometry(doc))
    // Pivot (50, 10): a's centre (10, 10) → (50, -30); b's (90, 10) → (50, 50).
    expect(getNode(doc, a)!.styles).toMatchObject({ left: 40, top: -40, rotate: '90deg' })
    expect(getNode(doc, b)!.styles).toMatchObject({ left: 40, top: 40, rotate: '90deg' })
    rotateNodes(doc, [item], 30, docGeometry(doc))
    expect(getNode(doc, item)!.styles).toEqual({ width: 10, height: 10, rotate: '30deg' })
  })

  it('keeps a single node in place when it rotates about its own centre', () => {
    const { doc, pageId } = docWithPage()
    const a = createNode(doc, {
      type: 'rect',
      parentId: pageId,
      styles: { left: '12px', top: 7, width: 20, height: 10 },
    })
    rotateNodes(doc, [a], -15, framesGeometry(doc, { [a]: frame(12, 7, 20, 10) }))
    expect(getNode(doc, a)!.styles).toEqual({
      left: '12px',
      top: 7,
      width: 20,
      height: 10,
      rotate: '-15deg',
    })
  })
})
