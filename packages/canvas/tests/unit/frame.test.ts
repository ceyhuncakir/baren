import { describe, expect, it } from 'vitest'
import { frameAabb, frameCorners, pointInFrame, type NodeFrame } from '@baren/schema'
import {
  angleAround,
  deltaInParent,
  frameHandleAt,
  framesAabb,
  mapFrameBetween,
  movedPosition,
  normalizeAngle,
  resizeFrame,
  rotateFrameAbout,
  rotationZoneAt,
  snapAngle,
  swapsAxes,
} from '../../src/math/frame.ts'
import { nodeContains, topmostAt, type IndexedNode } from '../../src/math/hit.ts'
import { unrotatedSize } from '../../src/render/measure.ts'

const f = (x: number, y: number, width: number, height: number, rotation = 0): NodeFrame => ({
  x,
  y,
  width,
  height,
  rotation,
})

function close(a: number, b: number, digits = 6): void {
  expect(a).toBeCloseTo(b, digits)
}

describe('rotated bounds', () => {
  it('a 100×50 box rotated 30° has a 111.6 × 93.3 bounding box around the same centre', () => {
    const r = frameAabb(f(250, 150, 100, 50, 30))
    close(r.width, 100 * Math.cos(Math.PI / 6) + 50 * Math.sin(Math.PI / 6))
    close(r.height, 100 * Math.sin(Math.PI / 6) + 50 * Math.cos(Math.PI / 6))
    close(r.x + r.width / 2, 300)
    close(r.y + r.height / 2, 175)
  })

  it('the union of rotated frames covers every corner', () => {
    const frames = [f(0, 0, 10, 10, 45), f(20, 0, 10, 10)]
    const u = framesAabb(frames)
    if (!u) throw new Error('no union')
    for (const fr of frames)
      for (const c of frameCorners(fr)) {
        expect(c.x).toBeGreaterThanOrEqual(u.x - 1e-9)
        expect(c.x).toBeLessThanOrEqual(u.x + u.width + 1e-9)
      }
    close(u.x, 5 - Math.SQRT2 * 5)
    close(u.x + u.width, 30)
  })

  it('recovers the unrotated size of an element from its bounding box', () => {
    const r = frameAabb(f(0, 0, 120, 40, 20))
    const s = unrotatedSize(r.width, r.height, 20)
    close(s.width, 120, 4)
    close(s.height, 40, 4)
  })
})

describe('point in rotated rect', () => {
  // A 100×100 square rotated 45° around (50, 50): a diamond.
  const diamond = f(0, 0, 100, 100, 45)

  it('is inside near the tips of the diamond and outside in the bounding-box corners', () => {
    expect(pointInFrame(diamond, { x: 50, y: -15 })).toBe(true)
    expect(pointInFrame(diamond, { x: 50, y: 50 })).toBe(true)
    expect(pointInFrame(diamond, { x: -10, y: -10 })).toBe(false)
    expect(pointInFrame(diamond, { x: 100, y: 100 })).toBe(false)
  })

  it('index hits use the exact shape for rotated entries', () => {
    const aabb = frameAabb(diamond)
    const rotated: IndexedNode = {
      id: 'diamond',
      parentId: null,
      minX: aabb.x,
      minY: aabb.y,
      maxX: aabb.x + aabb.width,
      maxY: aabb.y + aabb.height,
      order: 2,
      depth: 1,
      rect: aabb,
      frame: diamond,
    }
    const below: IndexedNode = {
      id: 'below',
      parentId: null,
      minX: -50,
      minY: -50,
      maxX: 150,
      maxY: 150,
      order: 1,
      depth: 1,
      rect: { x: -50, y: -50, width: 200, height: 200 },
    }
    expect(nodeContains(rotated, { x: -15, y: -15 })).toBe(false)
    expect(topmostAt([rotated, below], { x: -15, y: -15 })?.id).toBe('below')
    expect(topmostAt([rotated, below], { x: 50, y: 0 })?.id).toBe('diamond')
  })
})

describe('handles and rotation zones', () => {
  const box = f(100, 100, 200, 100, 90)

  it('finds handles of a rotated box in its own axes', () => {
    // Rotated 90° about (200, 150): the local top-left corner sits at screen (250, 50).
    expect(frameHandleAt(box, { x: 250, y: 50 })).toBe('nw')
    expect(frameHandleAt(box, { x: 150, y: 250 })).toBe('se')
    expect(frameHandleAt(box, { x: 200, y: 150 })).toBeNull()
  })

  it('rotation zones sit just outside the corners, never inside the box', () => {
    const flat = f(100, 100, 200, 100)
    expect(rotationZoneAt(flat, { x: 90, y: 90 })).toBe('nw')
    expect(rotationZoneAt(flat, { x: 310, y: 205 })).toBe('se')
    expect(rotationZoneAt(flat, { x: 110, y: 110 })).toBeNull()
    expect(rotationZoneAt(flat, { x: 70, y: 70 })).toBeNull()
    expect(rotationZoneAt(box, { x: 255, y: 40 })).toBe('nw')
  })

  it('angles: atan2 in degrees, 15° snapping, normalisation to (−180, 180]', () => {
    close(angleAround({ x: 0, y: 0 }, { x: 0, y: 10 }), 90)
    expect(snapAngle(37)).toBe(30)
    expect(snapAngle(38)).toBe(45)
    expect(snapAngle(-7)).toBe(0)
    expect(normalizeAngle(190)).toBe(-170)
    expect(normalizeAngle(-180)).toBe(180)
  })
})

describe('rotated resize and multi-selection resize', () => {
  it('a rotated node resizes in its local axes; the opposite corner stays fixed in the world', () => {
    const start = f(250, 150, 100, 50, 30)
    const nwBefore = frameCorners(start)[0]
    // Drag the se handle 40 px along the box's local x axis.
    const a = (30 * Math.PI) / 180
    const out = resizeFrame(start, 'se', 40 * Math.cos(a), 40 * Math.sin(a))
    close(out.width, 140)
    close(out.height, 50)
    expect(out.rotation).toBe(30)
    const nwAfter = frameCorners(out)[0]
    close(nwAfter.x, nwBefore.x)
    close(nwAfter.y, nwBefore.y)
  })

  it('without rotation it is the plain rectangle resize', () => {
    expect(resizeFrame(f(10, 10, 100, 50), 'nw', -10, -5)).toEqual(f(0, 5, 110, 55))
  })

  it('maps centres through the box and swaps the scale axes beyond 45°', () => {
    const from = { x: 0, y: 0, width: 100, height: 100 }
    const to = { x: 0, y: 0, width: 200, height: 100 }
    const flat = mapFrameBetween(f(10, 10, 20, 10), from, to)
    expect(flat).toEqual(f(20, 10, 40, 10))
    const turned = mapFrameBetween(f(10, 10, 20, 10, 90), from, to)
    // Centre (20, 15) → (40, 15); a 90° node stretches along its own height.
    close(turned.x + turned.width / 2, 40)
    close(turned.width, 20)
    close(turned.height, 20)
    expect(swapsAxes(30)).toBe(false)
    expect(swapsAxes(-120)).toBe(true)
  })

  it('positions follow centre movement in the parent’s axes', () => {
    // Parent rotated 90°: a world move to +x is a local move to −y.
    const d = deltaInParent(10, 0, 90)
    close(d.x, 0)
    close(d.y, -10)
    const p = movedPosition(5, 5, f(0, 0, 10, 10), f(10, 0, 20, 10), 0)
    // The box moved +10 and grew by 10: left follows its edge.
    expect(p).toEqual({ left: 15, top: 5 })
    const r = rotateFrameAbout(f(0, 0, 10, 10), { x: 0, y: 0 }, 90)
    close(r.x, -10)
    close(r.y, 0)
    expect(r.rotation).toBe(90)
  })
})
