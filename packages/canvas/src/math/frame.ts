import {
  frameAabb,
  frameCenter,
  frameCorners,
  localToWorld,
  rotatePoint,
  worldToLocal,
  type NodeFrame,
} from '@baren/schema'
import type { Handle, Point, Rect, Viewport } from '../types.ts'
import { handleAt, resizeRect, type HandleHitOptions, type ResizeOptions } from './resize.ts'

/**
 * Geometry of rotated boxes (contract 2.3, 3.4, 5.2): frames are the unrotated box plus a
 * rotation about its centre, in world or screen coordinates.
 */

export type Corner = 'nw' | 'ne' | 'se' | 'sw'

/** A frame without rotation. */
export function rectFrame(r: Rect, rotation = 0): NodeFrame {
  return { x: r.x, y: r.y, width: r.width, height: r.height, rotation }
}

/** World frame → screen frame (zoom and pan; rotation unchanged). */
export function frameToScreen(v: Viewport, f: NodeFrame): NodeFrame {
  return {
    x: (f.x - v.x) * v.zoom,
    y: (f.y - v.y) * v.zoom,
    width: f.width * v.zoom,
    height: f.height * v.zoom,
    rotation: f.rotation,
  }
}

/** Translate a frame. */
export function translateFrame(f: NodeFrame, dx: number, dy: number): NodeFrame {
  return { ...f, x: f.x + dx, y: f.y + dy }
}

/** Axis-aligned union of rotated frames. */
export function framesAabb(frames: Iterable<NodeFrame>): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const f of frames) {
    const r = frameAabb(f)
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  if (x0 === Infinity) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** The handle of a (screen-space, possibly rotated) selection frame under screen point `p`. */
export function frameHandleAt(
  box: NodeFrame,
  p: Point,
  options: HandleHitOptions = {},
): Handle | null {
  const q = box.rotation === 0 ? p : rotatePoint(p, frameCenter(box), -box.rotation)
  return handleAt(box, q, options)
}

/** Screen px beyond each corner of the selection box where dragging rotates. */
export const ROTATE_ZONE_PX = 16

/**
 * The corner whose rotation zone contains screen point `p`: outside the (rotated) selection
 * box, within `zone` px of a corner along both local axes. Resize handles take precedence (the
 * caller tests them first).
 */
export function rotationZoneAt(box: NodeFrame, p: Point, zone = ROTATE_ZONE_PX): Corner | null {
  const c = frameCenter(box)
  const q = box.rotation === 0 ? p : rotatePoint(p, c, -box.rotation)
  const l = box.x
  const r = box.x + box.width
  const t = box.y
  const b = box.y + box.height
  const inside = q.x >= l && q.x <= r && q.y >= t && q.y <= b
  if (inside) return null
  const corners: [Corner, number, number][] = [
    ['nw', l, t],
    ['ne', r, t],
    ['se', r, b],
    ['sw', l, b],
  ]
  let best: Corner | null = null
  let bestD = Infinity
  for (const [name, x, y] of corners) {
    const dx = q.x - x
    const dy = q.y - y
    // Only the quadrant that points away from the box.
    const outX = name === 'nw' || name === 'sw' ? dx <= 0 : dx >= 0
    const outY = name === 'nw' || name === 'ne' ? dy <= 0 : dy >= 0
    if (!(outX || outY)) continue
    if (Math.abs(dx) > zone || Math.abs(dy) > zone) continue
    const d = Math.hypot(dx, dy)
    if (d < bestD) {
      bestD = d
      best = name
    }
  }
  return best
}

/** Angle of `p` around `pivot` in degrees (0 = +x, clockwise on screen). */
export function angleAround(pivot: Point, p: Point): number {
  return (Math.atan2(p.y - pivot.y, p.x - pivot.x) * 180) / Math.PI
}

/** Snap an angle to multiples of `step` degrees. */
export function snapAngle(deg: number, step = 15): number {
  const s = Math.round(deg / step) * step
  return s === 0 ? 0 : s
}

/** Normalise to (−180, 180]. */
export function normalizeAngle(deg: number): number {
  let r = deg % 360
  if (r <= -180) r += 360
  else if (r > 180) r -= 360
  return r === 0 ? 0 : r
}

/**
 * Resize a (possibly rotated) world frame by dragging `handle` by a world-space delta: the
 * resize happens in the frame's local axes and the opposite handle stays fixed in world space.
 */
export function resizeFrame(
  start: NodeFrame,
  handle: Handle,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): NodeFrame {
  const d =
    start.rotation === 0
      ? { x: dx, y: dy }
      : rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -start.rotation)
  const local = resizeRect(
    { x: 0, y: 0, width: start.width, height: start.height },
    handle,
    d.x,
    d.y,
    options,
  )
  const c = localToWorld(start, { x: local.x + local.width / 2, y: local.y + local.height / 2 })
  return {
    x: c.x - local.width / 2,
    y: c.y - local.height / 2,
    width: local.width,
    height: local.height,
    rotation: start.rotation,
  }
}

/** Whether a rotation swaps the box's axes for scaling (closer to 90° than to 0°/180°). */
export function swapsAxes(rotation: number): boolean {
  const a = Math.abs(rotation) % 180
  return Math.min(a, 180 - a) >= 45
}

/**
 * Multi-selection resize (contract 5.2): the centre maps through the box transform; width and
 * height scale by (sx, sy), or (sy, sx) when the node is rotated closer to 90°.
 */
export function mapFrameBetween(f: NodeFrame, from: Rect, to: Rect): NodeFrame {
  const sx = from.width === 0 ? 1 : to.width / from.width
  const sy = from.height === 0 ? 1 : to.height / from.height
  const c = frameCenter(f)
  const cx = to.x + (c.x - from.x) * sx
  const cy = to.y + (c.y - from.y) * sy
  const [fx, fy] = swapsAxes(f.rotation) ? [sy, sx] : [sx, sy]
  const w = f.width * fx
  const h = f.height * fy
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rotation: f.rotation }
}

/** Rotate a frame's centre about `pivot` by `delta` degrees and add `delta` to its rotation. */
export function rotateFrameAbout(f: NodeFrame, pivot: Point, delta: number): NodeFrame {
  const c = rotatePoint(frameCenter(f), pivot, delta)
  return {
    x: c.x - f.width / 2,
    y: c.y - f.height / 2,
    width: f.width,
    height: f.height,
    rotation: normalizeAngle(f.rotation + delta),
  }
}

/** A world-space delta expressed in a parent's local (unrotated) axes. */
export function deltaInParent(dx: number, dy: number, parentRotation: number): Point {
  if (parentRotation === 0) return { x: dx, y: dy }
  return rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -parentRotation)
}

/**
 * New `left/top` for a node whose world frame changes from `from` to `to`, given its declared
 * `left/top` and its parent's world rotation (positions are the unrotated box in parent-local
 * coordinates, so the centre's movement is converted and the size change re-centred).
 */
export function movedPosition(
  left: number,
  top: number,
  from: NodeFrame,
  to: NodeFrame,
  parentRotation: number,
): { left: number; top: number } {
  const c0 = frameCenter(from)
  const c1 = frameCenter(to)
  const d = deltaInParent(c1.x - c0.x, c1.y - c0.y, parentRotation)
  return {
    left: left + d.x - (to.width - from.width) / 2,
    top: top + d.y - (to.height - from.height) / 2,
  }
}

export { frameAabb, frameCenter, frameCorners, localToWorld, worldToLocal }

/** CSS cursor for the rotation zone of `corner` on a box rotated by `rotation` degrees. */
export function rotateCursor(corner: Corner, rotation: number): string {
  const base = corner === 'ne' ? 0 : corner === 'se' ? 90 : corner === 'sw' ? 180 : 270
  const angle = Math.round((base + rotation) / 15) * 15
  const cached = cursorCache.get(angle)
  if (cached) return cached
  // A curved double arrow (white halo, dark stroke), rotated to face away from the corner.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
    `<g transform='rotate(${angle} 12 12)' fill='none' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M6 9a8 8 0 0 1 9 -3' stroke='white' stroke-width='4'/>` +
    `<path d='M13 3l3 3-3 3M6 9a8 8 0 0 1 9 -3' stroke='white' stroke-width='4'/>` +
    `<path d='M6 9a8 8 0 0 1 9 -3' stroke='black' stroke-width='1.5'/>` +
    `<path d='M13 3l3 3-3 3' stroke='black' stroke-width='1.5'/>` +
    `<path d='M9 18a8 8 0 0 0 3 -9' stroke='white' stroke-width='4'/>` +
    `<path d='M9 18a8 8 0 0 0 3 -9' stroke='black' stroke-width='1.5'/>` +
    `<path d='M6 15l3 3 3-3' stroke='white' stroke-width='4'/>` +
    `<path d='M6 15l3 3 3-3' stroke='black' stroke-width='1.5'/>` +
    `</g></svg>`
  const css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
  cursorCache.set(angle, css)
  return css
}

const cursorCache = new Map<number, string>()
