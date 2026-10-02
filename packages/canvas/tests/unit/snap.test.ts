import { describe, expect, it } from 'vitest'
import { snapEdges, snapMove } from '../../src/math/snap.ts'

describe('snapMove', () => {
  const other = { x: 200, y: 0, width: 100, height: 100 }

  it('snaps a nearby edge within the threshold and reports a guide', () => {
    // moving.right = 197 → other.left = 200
    const res = snapMove({ x: 97, y: 40, width: 100, height: 50 }, [other], 6)
    expect(res.dx).toBe(3)
    expect(res.dy).toBe(0)
    const g = res.guides.find((x) => x.axis === 'x')
    expect(g).toMatchObject({ axis: 'x', pos: 200 })
    expect(g?.start).toBe(0)
    expect(g?.end).toBe(100)
  })

  it('snaps centres', () => {
    const res = snapMove({ x: 0, y: 23, width: 50, height: 50 }, [other], 6)
    // moving centreY 48 → other centreY 50
    expect(res.dy).toBe(2)
  })

  it('does not snap beyond the threshold', () => {
    const res = snapMove({ x: 80, y: 300, width: 100, height: 50 }, [other], 6)
    expect(res).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('picks the closest candidate line', () => {
    const res = snapMove(
      { x: 0, y: 0, width: 10, height: 10 },
      [
        { x: 13, y: 500, width: 1, height: 1 },
        { x: 12, y: 600, width: 1, height: 1 },
      ],
      5,
    )
    expect(res.dx).toBe(2)
  })

  it('no candidates → no snapping', () => {
    expect(snapMove({ x: 0, y: 0, width: 1, height: 1 }, [], 5)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    })
  })
})

describe('snapEdges', () => {
  it('snaps only the moving edge of a resize', () => {
    const base = { x: 0, y: 0, width: 197, height: 50 }
    const res = snapEdges(
      { x: 197 },
      (sx) => ({ ...base, width: base.width + sx }),
      [{ x: 200, y: 0, width: 50, height: 50 }],
      6,
    )
    expect(res.dx).toBe(3)
    expect(res.dy).toBe(0)
    expect(res.guides[0]).toMatchObject({ axis: 'x', pos: 200 })
  })
})
