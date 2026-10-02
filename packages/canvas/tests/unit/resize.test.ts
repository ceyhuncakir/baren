import { describe, expect, it } from 'vitest'
import {
  handleAt,
  handleCursor,
  mapRectBetween,
  resizeRect,
  roundRect,
} from '../../src/math/resize.ts'
import type { Rect } from '../../src/types.ts'

const r: Rect = { x: 100, y: 100, width: 200, height: 100 }

describe('resizeRect', () => {
  it('moves only the dragged edges', () => {
    expect(resizeRect(r, 'e', 50, 999)).toEqual({ x: 100, y: 100, width: 250, height: 100 })
    expect(resizeRect(r, 'w', 50, 0)).toEqual({ x: 150, y: 100, width: 150, height: 100 })
    expect(resizeRect(r, 'n', 0, -20)).toEqual({ x: 100, y: 80, width: 200, height: 120 })
    expect(resizeRect(r, 's', 0, 30)).toEqual({ x: 100, y: 100, width: 200, height: 130 })
    expect(resizeRect(r, 'se', 10, 20)).toEqual({ x: 100, y: 100, width: 210, height: 120 })
    expect(resizeRect(r, 'nw', -10, -20)).toEqual({ x: 90, y: 80, width: 210, height: 120 })
  })

  it('flips when dragged past the opposite edge', () => {
    expect(resizeRect(r, 'e', -250, 0)).toEqual({ x: 50, y: 100, width: 50, height: 100 })
    expect(resizeRect(r, 'n', 0, 150)).toEqual({ x: 100, y: 200, width: 200, height: 50 })
  })

  it('enforces a minimum size', () => {
    expect(resizeRect(r, 'e', -200, 0).width).toBe(1)
    expect(resizeRect(r, 'e', -200, 0, { minSize: 4 }).width).toBe(4)
  })

  it('keeps the aspect ratio with Shift (corner: dominant axis drives)', () => {
    const out = resizeRect(r, 'se', 100, 0, { keepAspect: true })
    expect(out).toEqual({ x: 100, y: 100, width: 300, height: 150 })
    const out2 = resizeRect(r, 'se', 0, 100, { keepAspect: true })
    expect(out2).toEqual({ x: 100, y: 100, width: 400, height: 200 })
    // Opposite corner stays fixed for nw.
    const nw = resizeRect(r, 'nw', -100, 0, { keepAspect: true })
    expect(nw.x + nw.width).toBe(300)
    expect(nw.y + nw.height).toBe(200)
    expect(nw.width / nw.height).toBeCloseTo(2)
  })

  it('keeps the aspect ratio on edge handles, centred on the other axis', () => {
    const out = resizeRect(r, 'e', 100, 0, { keepAspect: true })
    expect(out.width).toBe(300)
    expect(out.height).toBe(150)
    expect(out.y + out.height / 2).toBe(150)
  })

  it('resizes from the centre with Alt', () => {
    expect(resizeRect(r, 'e', 10, 0, { fromCenter: true })).toEqual({
      x: 90,
      y: 100,
      width: 220,
      height: 100,
    })
    expect(resizeRect(r, 'se', 10, 10, { fromCenter: true })).toEqual({
      x: 90,
      y: 90,
      width: 220,
      height: 120,
    })
  })

  it('combines Shift + Alt', () => {
    const out = resizeRect(r, 'se', 20, 0, { keepAspect: true, fromCenter: true })
    expect(out.width).toBe(240)
    expect(out.height).toBe(120)
    expect(out.x + out.width / 2).toBe(200)
    expect(out.y + out.height / 2).toBe(150)
  })
})

describe('resize helpers', () => {
  it('rounds edges to whole pixels', () => {
    expect(roundRect({ x: 0.4, y: 0.6, width: 10.2, height: 9.9 })).toEqual({
      x: 0,
      y: 1,
      width: 11,
      height: 10,
    })
  })

  it('maps rects between group bounds', () => {
    const from = { x: 0, y: 0, width: 100, height: 100 }
    const to = { x: 0, y: 0, width: 200, height: 50 }
    expect(mapRectBetween({ x: 50, y: 50, width: 50, height: 50 }, from, to)).toEqual({
      x: 100,
      y: 25,
      width: 100,
      height: 25,
    })
  })

  it('finds handles: corners first, then invisible edge zones', () => {
    const box = { x: 100, y: 100, width: 200, height: 100 }
    expect(handleAt(box, { x: 101, y: 99 })).toBe('nw')
    expect(handleAt(box, { x: 304, y: 204 })).toBe('se')
    expect(handleAt(box, { x: 200, y: 102 })).toBe('n')
    expect(handleAt(box, { x: 200, y: 199 })).toBe('s')
    expect(handleAt(box, { x: 98, y: 150 })).toBe('w')
    expect(handleAt(box, { x: 302, y: 150 })).toBe('e')
    expect(handleAt(box, { x: 200, y: 150 })).toBeNull()
    expect(handleAt(box, { x: 400, y: 400 })).toBeNull()
    expect(handleCursor('ne')).toBe('nesw-resize')
    expect(handleCursor('w')).toBe('ew-resize')
  })
})
