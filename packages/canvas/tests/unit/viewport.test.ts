import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  fitRect,
  formatZoom,
  interpolateViewport,
  nextZoomStep,
  normalizeWheel,
  panBy,
  screenToWorld,
  visibleWorldRect,
  wheelZoomFactor,
  worldRectToScreen,
  worldToScreen,
  worldTransform,
  zoomAt,
} from '../../src/math/viewport.ts'
import type { Viewport } from '../../src/types.ts'

const v0: Viewport = { x: 100, y: -50, zoom: 2, width: 800, height: 600 }

describe('viewport math', () => {
  it('round-trips screen ↔ world', () => {
    const p = { x: 123.5, y: 77 }
    const w = screenToWorld(v0, p)
    expect(w).toEqual({ x: 100 + 123.5 / 2, y: -50 + 77 / 2 })
    expect(worldToScreen(v0, w)).toEqual(p)
  })

  it('maps rects and the visible region', () => {
    expect(worldRectToScreen(v0, { x: 100, y: -50, width: 10, height: 5 })).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 10,
    })
    expect(visibleWorldRect(v0)).toEqual({ x: 100, y: -50, width: 400, height: 300 })
  })

  it('zooms at an anchor keeping the world point under it fixed', () => {
    const anchor = { x: 300, y: 200 }
    const before = screenToWorld(v0, anchor)
    const v1 = zoomAt(v0, 5, anchor)
    expect(v1.zoom).toBe(5)
    const after = screenToWorld(v1, anchor)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('clamps zoom to 2%…6400%', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(zoomAt(v0, 0.0001, { x: 0, y: 0 }).zoom).toBe(0.02)
    expect(zoomAt(v0, 999, { x: 0, y: 0 }).zoom).toBe(64)
  })

  it('pans in screen pixels', () => {
    expect(panBy(v0, 20, -10)).toMatchObject({ x: 110, y: -55, zoom: 2 })
  })

  it('steps through zoom presets', () => {
    expect(nextZoomStep(1, 1)).toBe(2)
    expect(nextZoomStep(1, -1)).toBe(0.5)
    expect(nextZoomStep(0.7, 1)).toBe(1)
    expect(nextZoomStep(0.7, -1)).toBe(0.5)
    expect(nextZoomStep(64, 1)).toBe(64)
    expect(nextZoomStep(0.02, -1)).toBe(0.02)
  })

  it('fits a rect with padding, centred, capped by maxZoom', () => {
    const v = fitRect({ x: 0, y: 0, width: 1000, height: 500 }, 600, 400, 50, 1)
    expect(v.zoom).toBeCloseTo(0.5)
    const c = screenToWorld(v, { x: 300, y: 200 })
    expect(c.x).toBeCloseTo(500)
    expect(c.y).toBeCloseTo(250)
    expect(fitRect({ x: 0, y: 0, width: 10, height: 10 }, 600, 400, 50, 1).zoom).toBe(1)
  })

  it('normalises wheel deltas', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ x: 0, y: 48 })
    expect(normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ x: 0, y: 600 })
    expect(normalizeWheel({ deltaX: 0, deltaY: 10, deltaMode: 0, shiftKey: true }, 600)).toEqual({
      x: 10,
      y: 0,
    })
  })

  it('maps pinch/ctrl-wheel deltas to a bounded zoom factor', () => {
    expect(wheelZoomFactor(0)).toBe(1)
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1)
    expect(wheelZoomFactor(10)).toBeLessThan(1)
    // A mouse wheel notch (±100) is clamped.
    expect(wheelZoomFactor(-100)).toBeCloseTo(wheelZoomFactor(-32))
  })

  it('interpolates viewports geometrically in zoom', () => {
    const a: Viewport = { x: 0, y: 0, zoom: 0.25, width: 800, height: 600 }
    const b: Viewport = { x: 1000, y: 1000, zoom: 4, width: 800, height: 600 }
    expect(interpolateViewport(a, b, 0)).toMatchObject({ zoom: 0.25 })
    const end = interpolateViewport(a, b, 1)
    expect(end.zoom).toBeCloseTo(4)
    expect(end.x).toBeCloseTo(1000)
    expect(interpolateViewport(a, b, 0.5).zoom).toBeCloseTo(1)
  })

  it('formats zoom and builds the world transform', () => {
    expect(formatZoom(0.12173)).toBe('12%')
    expect(formatZoom(0.02)).toBe('2%')
    expect(formatZoom(0.055)).toBe('5.5%')
    expect(worldTransform({ x: 10, y: 20, zoom: 2, width: 1, height: 1 })).toBe(
      'translate3d(-20px, -40px, 0) scale(2)',
    )
  })
})
