import { describe, expect, it } from 'vitest'
import { flowDropIndex } from '../../src/interaction/gestures.ts'

const col = [
  { rect: { x: 0, y: 0, width: 100, height: 20 } },
  { rect: { x: 0, y: 30, width: 100, height: 20 } },
  { rect: { x: 0, y: 60, width: 100, height: 20 } },
]

describe('flow drop index', () => {
  it('counts siblings whose midpoint is before the pointer (column)', () => {
    expect(flowDropIndex(col, { x: 50, y: 5 }, 'column', null).index).toBe(0)
    expect(flowDropIndex(col, { x: 50, y: 15 }, 'column', null).index).toBe(1)
    expect(flowDropIndex(col, { x: 50, y: 45 }, 'column', null).index).toBe(2)
    expect(flowDropIndex(col, { x: 50, y: 99 }, 'column', null).index).toBe(3)
  })

  it('places the indicator in the gap between neighbours', () => {
    const d = flowDropIndex(col, { x: 50, y: 15 }, 'column', { x: 0, y: 0, width: 100, height: 80 })
    expect(d.a).toEqual({ x: 0, y: 25 })
    expect(d.b).toEqual({ x: 100, y: 25 })
  })

  it('works along rows', () => {
    const row = [
      { rect: { x: 0, y: 0, width: 10, height: 10 } },
      { rect: { x: 20, y: 0, width: 10, height: 10 } },
    ]
    expect(flowDropIndex(row, { x: 16, y: 5 }, 'row', null).index).toBe(1)
    expect(flowDropIndex(row, { x: 40, y: 5 }, 'row', null).a.x).toBe(30)
  })
})
