import { describe, expect, it } from 'vitest'
import { splitSegment, vectorToPathD, type VectorSubpath } from '@baren/schema'
import { draftToVector } from '../../src/interaction/pen.ts'
import { constrain45, moveHandle } from '../../src/interaction/vectorEdit.ts'
import { rectFrame } from '../../src/math/frame.ts'

function close(a: number, b: number): void {
  expect(a).toBeCloseTo(b, 6)
}

describe('pen drafts', () => {
  it('converts world points to node-local px with a tight box', () => {
    const made = draftToVector(
      [
        { x: 520, y: 30 },
        { x: 600, y: 110 },
        { x: 680, y: 30 },
      ],
      false,
      rectFrame({ x: 500, y: 0, width: 400, height: 300 }),
      'sp000001',
    )
    expect(made?.box).toEqual({ x: 20, y: 30, width: 160, height: 80 })
    expect(vectorToPathD(made!.vector)).toBe('M 0 0 L 80 80 L 160 0')
  })

  it('keeps handles relative and the box tight around curve extrema', () => {
    const made = draftToVector(
      [
        { x: 0, y: 0, out: [0, -40], in: [0, 40], mode: 'smooth' },
        { x: 100, y: 0 },
      ],
      false,
      rectFrame({ x: 0, y: 0, width: 0, height: 0 }),
      'sp000002',
    )
    const sp = made?.vector.subpaths[0]
    expect(sp?.points[0]).toMatchObject({ out: [0, -40], in: [0, 40], mode: 'smooth' })
    // The curve bulges up by 3/4 · 40 · (4/9)… less than the handle: the box is not the hull.
    expect(made!.box.height).toBeGreaterThan(5)
    expect(made!.box.height).toBeLessThan(40)
  })

  it('needs at least two points', () => {
    expect(
      draftToVector([{ x: 0, y: 0 }], false, rectFrame({ x: 0, y: 0, width: 0, height: 0 }), 'x'),
    ).toBeNull()
  })

  it('converts into a rotated container’s axes', () => {
    const made = draftToVector(
      [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
      false,
      { x: -50, y: -50, width: 100, height: 100, rotation: 90 },
      'sp000003',
    )
    // A horizontal world segment is vertical in a container turned 90°.
    expect(made?.box.width).toBe(1)
    close(made!.box.height, 10)
  })
})

describe('bezier editing', () => {
  it('smooth handles stay collinear and keep the opposite length', () => {
    const p = moveHandle({ x: 0, y: 0, in: [-10, 0], out: [20, 0], mode: 'smooth' }, 'out', [0, 30])
    expect(p.out).toEqual([0, 30])
    close(p.in?.[0] ?? NaN, 0)
    close(p.in?.[1] ?? NaN, -10)
  })

  it('mirrored handles mirror, corner handles are independent', () => {
    expect(
      moveHandle({ x: 0, y: 0, in: [-10, 0], out: [10, 0], mode: 'mirrored' }, 'in', [3, 4]).out,
    ).toEqual([-3, -4])
    expect(moveHandle({ x: 0, y: 0, in: [-10, 0], out: [10, 0] }, 'in', [3, 4]).out).toEqual([
      10, 0,
    ])
  })

  it('Shift constrains to 45° steps', () => {
    const c = constrain45(10, 1)
    close(c.x, Math.hypot(10, 1))
    close(c.y, 0)
    const d = constrain45(10, 9)
    close(d.x, d.y)
  })

  it('inserting a point on a curve keeps the shape (de Casteljau)', () => {
    const sp: VectorSubpath = {
      id: 'a',
      closed: false,
      points: [
        { x: 0, y: 0, out: [0, -40] },
        { x: 100, y: 0, in: [0, -40] },
      ],
    }
    const split = splitSegment(sp, 0, 0.5)
    expect(split.points).toHaveLength(3)
    // The midpoint of the symmetric curve: x 50, y = -30 (cubic at t = 0.5).
    close(split.points[1]?.x ?? NaN, 50)
    close(split.points[1]?.y ?? NaN, -30)
  })
})
