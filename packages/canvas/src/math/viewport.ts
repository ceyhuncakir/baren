import type { Point, Rect, Viewport } from '../types.ts'

/** 2 % … 6400 %. */
export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 64

/** Steps used by zoom in / zoom out (and the zoom menu's presets 50 %, 100 %, 200 %). */
export const ZOOM_STEPS: readonly number[] = [
  0.02, 0.03, 0.05, 0.0625, 0.1, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64,
]

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: v.x + p.x / v.zoom, y: v.y + p.y / v.zoom }
}

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) * v.zoom, y: (p.y - v.y) * v.zoom }
}

export function worldRectToScreen(v: Viewport, r: Rect): Rect {
  return {
    x: (r.x - v.x) * v.zoom,
    y: (r.y - v.y) * v.zoom,
    width: r.width * v.zoom,
    height: r.height * v.zoom,
  }
}

export function screenRectToWorld(v: Viewport, r: Rect): Rect {
  return {
    x: v.x + r.x / v.zoom,
    y: v.y + r.y / v.zoom,
    width: r.width / v.zoom,
    height: r.height / v.zoom,
  }
}

/** The world-space rectangle currently visible. */
export function visibleWorldRect(v: Viewport): Rect {
  return { x: v.x, y: v.y, width: v.width / v.zoom, height: v.height / v.zoom }
}

/** Zoom to `zoom` (clamped) keeping the world point under the screen `anchor` fixed. */
export function zoomAt(v: Viewport, zoom: number, anchor: Point): Viewport {
  const z = clampZoom(zoom)
  const world = screenToWorld(v, anchor)
  return { ...v, zoom: z, x: world.x - anchor.x / z, y: world.y - anchor.y / z }
}

/** Pan by a screen-space delta (content moves opposite to the delta, like scrolling). */
export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, x: v.x + dx / v.zoom, y: v.y + dy / v.zoom }
}

/** Next zoom step above (`dir` = 1) or below (`dir` = -1) the current zoom. */
export function nextZoomStep(zoom: number, dir: 1 | -1): number {
  const eps = 1e-3
  if (dir > 0) {
    for (const s of ZOOM_STEPS) if (s > zoom * (1 + eps)) return s
    return MAX_ZOOM
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STEPS[i] as number
    if (s < zoom * (1 - eps)) return s
  }
  return MIN_ZOOM
}

/**
 * Viewport that shows `target` centred inside a `width`×`height` screen with
 * `padding` screen pixels on every side, zoom clamped to `maxZoom`.
 */
export function fitRect(
  target: Rect,
  width: number,
  height: number,
  padding: number,
  maxZoom: number = MAX_ZOOM,
): Viewport {
  const availW = Math.max(1, width - padding * 2)
  const availH = Math.max(1, height - padding * 2)
  const tw = Math.max(target.width, 1e-6)
  const th = Math.max(target.height, 1e-6)
  const zoom = clampZoom(Math.min(availW / tw, availH / th, maxZoom))
  const cx = target.x + target.width / 2
  const cy = target.y + target.height / 2
  return { x: cx - width / 2 / zoom, y: cy - height / 2 / zoom, zoom, width, height }
}

export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  shiftKey?: boolean
}

const LINE_HEIGHT_PX = 16

/** Wheel deltas in screen pixels (lines/pages normalised; Shift turns vertical into horizontal). */
export function normalizeWheel(e: WheelLike, pageHeight: number): Point {
  const unit = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? pageHeight : 1
  let dx = e.deltaX * unit
  let dy = e.deltaY * unit
  if (e.shiftKey && dx === 0) {
    dx = dy
    dy = 0
  }
  return { x: dx, y: dy }
}

/**
 * Multiplicative zoom factor for a Ctrl/Meta+wheel or trackpad pinch event.
 * Pinch emits small deltas (≈ ±1…10); a mouse wheel notch is ≈ ±100, which is
 * clamped so one notch zooms by ~20 %.
 */
export function wheelZoomFactor(deltaYPx: number): number {
  const d = Math.max(-32, Math.min(32, deltaYPx))
  return Math.pow(2, -d * 0.01)
}

/** Ease-out cubic. */
export function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t))
  return 1 - u * u * u
}

/**
 * Interpolate between two viewports for a smooth zoom animation: zoom is
 * interpolated geometrically and the screen centre's world point linearly,
 * so the motion looks uniform at every scale.
 */
export function interpolateViewport(a: Viewport, b: Viewport, t: number): Viewport {
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t)
  const acx = a.x + a.width / 2 / a.zoom
  const acy = a.y + a.height / 2 / a.zoom
  const bcx = b.x + b.width / 2 / b.zoom
  const bcy = b.y + b.height / 2 / b.zoom
  const cx = acx + (bcx - acx) * t
  const cy = acy + (bcy - acy) * t
  return {
    x: cx - b.width / 2 / zoom,
    y: cy - b.height / 2 / zoom,
    zoom,
    width: b.width,
    height: b.height,
  }
}

export function viewportsEqual(a: Viewport, b: Viewport): boolean {
  return (
    a.x === b.x && a.y === b.y && a.zoom === b.zoom && a.width === b.width && a.height === b.height
  )
}

/** CSS transform that maps world coordinates to screen coordinates for the world layer. */
export function worldTransform(v: Viewport): string {
  return `translate3d(${-v.x * v.zoom}px, ${-v.y * v.zoom}px, 0) scale(${v.zoom})`
}

/** "12%", "100%", "6400%" — rounded for the zoom indicator. */
export function formatZoom(zoom: number): string {
  const pct = zoom * 100
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`
}
