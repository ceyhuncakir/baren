import type { Handle, Rect } from '../types.ts'

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export interface ResizeOptions {
  /** Shift: keep the start rectangle's aspect ratio. */
  keepAspect?: boolean
  /** Alt: resize symmetrically around the start rectangle's centre. */
  fromCenter?: boolean
  /** Minimum width/height in world px. Default 1. */
  minSize?: number
}

function hasW(h: Handle): boolean {
  return h === 'w' || h === 'nw' || h === 'sw'
}
function hasE(h: Handle): boolean {
  return h === 'e' || h === 'ne' || h === 'se'
}
function hasN(h: Handle): boolean {
  return h === 'n' || h === 'nw' || h === 'ne'
}
function hasS(h: Handle): boolean {
  return h === 's' || h === 'sw' || h === 'se'
}

export function isCornerHandle(h: Handle): boolean {
  return h.length === 2
}

/**
 * Resize `start` by dragging `handle` by (dx, dy) world pixels.
 *
 * - The opposite edge/corner stays fixed (or the centre with `fromCenter`).
 * - Dragging past the opposite edge flips the rectangle (the result is always
 *   normalised to a positive size) — like every design tool.
 * - `keepAspect` locks the ratio; for corner handles the axis that changed
 *   more (relative to its start size) drives, for edge handles the other axis
 *   follows, centred on the start rectangle.
 */
export function resizeRect(
  start: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): Rect {
  const min = Math.max(0, options.minSize ?? 1)
  const k = options.fromCenter ? 2 : 1
  const w0 = start.width
  const h0 = start.height

  // Signed sizes along the drag direction (negative = flipped).
  let w = w0 + (hasE(handle) ? dx * k : hasW(handle) ? -dx * k : 0)
  let h = h0 + (hasS(handle) ? dy * k : hasN(handle) ? -dy * k : 0)
  const horizontal = hasE(handle) || hasW(handle)
  const vertical = hasN(handle) || hasS(handle)

  if (options.keepAspect && w0 > 0 && h0 > 0) {
    const ratio = w0 / h0
    if (horizontal && vertical) {
      const sx = Math.abs(w) / w0
      const sy = Math.abs(h) / h0
      if (sx >= sy) h = Math.sign(h || 1) * (Math.abs(w) / ratio)
      else w = Math.sign(w || 1) * (Math.abs(h) * ratio)
    } else if (horizontal) {
      h = Math.abs(w) / ratio
    } else if (vertical) {
      w = Math.abs(h) * ratio
    }
  }

  // Enforce the minimum magnitude, keeping the sign (direction of the drag).
  if (Math.abs(w) < min) w = (w < 0 ? -1 : 1) * min
  if (Math.abs(h) < min) h = (h < 0 ? -1 : 1) * min

  let x: number
  let y: number
  if (options.fromCenter) {
    const cx = start.x + w0 / 2
    const cy = start.y + h0 / 2
    x = cx - Math.abs(w) / 2
    y = cy - Math.abs(h) / 2
  } else {
    // Horizontal anchor.
    if (hasW(handle)) {
      const anchor = start.x + w0 // right edge fixed
      x = w >= 0 ? anchor - w : anchor
    } else if (hasE(handle)) {
      const anchor = start.x // left edge fixed
      x = w >= 0 ? anchor : anchor + w
    } else {
      // n/s edge with aspect lock: keep the horizontal centre.
      x = start.x + w0 / 2 - Math.abs(w) / 2
    }
    if (hasN(handle)) {
      const anchor = start.y + h0
      y = h >= 0 ? anchor - h : anchor
    } else if (hasS(handle)) {
      const anchor = start.y
      y = h >= 0 ? anchor : anchor + h
    } else {
      y = start.y + h0 / 2 - Math.abs(h) / 2
    }
  }

  return { x, y, width: Math.abs(w), height: Math.abs(h) }
}

/** Round a rectangle's edges to whole pixels (positions and sizes stay consistent). */
export function roundRect(r: Rect): Rect {
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  return {
    x,
    y,
    width: Math.max(0, Math.round(r.x + r.width) - x),
    height: Math.max(0, Math.round(r.y + r.height) - y),
  }
}

/**
 * Map each selected rectangle from the old group bounds to the new group
 * bounds (multi-selection resize scales positions and sizes proportionally).
 */
export function mapRectBetween(r: Rect, from: Rect, to: Rect): Rect {
  const sx = from.width === 0 ? 1 : to.width / from.width
  const sy = from.height === 0 ? 1 : to.height / from.height
  return {
    x: to.x + (r.x - from.x) * sx,
    y: to.y + (r.y - from.y) * sy,
    width: r.width * sx,
    height: r.height * sy,
  }
}

export interface HandleHitOptions {
  /** Hit radius around a corner, screen px. Default 6. */
  corner?: number
  /** Hit distance from an edge, screen px. Default 4. */
  edge?: number
}

/**
 * Which handle (if any) of the screen-space selection box `box` is under the
 * screen point `p`. Corners win over edges; edges are invisible hit zones
 * along the outline (only the four corner squares are drawn).
 */
export function handleAt(
  box: Rect,
  p: { x: number; y: number },
  options: HandleHitOptions = {},
): Handle | null {
  const c = options.corner ?? 6
  const e = options.edge ?? 4
  const l = box.x
  const r = box.x + box.width
  const t = box.y
  const b = box.y + box.height
  const near = (ax: number, ay: number): boolean =>
    Math.abs(p.x - ax) <= c && Math.abs(p.y - ay) <= c
  if (near(l, t)) return 'nw'
  if (near(r, t)) return 'ne'
  if (near(r, b)) return 'se'
  if (near(l, b)) return 'sw'
  const withinX = p.x > l + c && p.x < r - c
  const withinY = p.y > t + c && p.y < b - c
  if (withinX && Math.abs(p.y - t) <= e) return 'n'
  if (withinX && Math.abs(p.y - b) <= e) return 's'
  if (withinY && Math.abs(p.x - l) <= e) return 'w'
  if (withinY && Math.abs(p.x - r) <= e) return 'e'
  return null
}

/** CSS cursor for a handle. */
export function handleCursor(h: Handle): string {
  switch (h) {
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'nw':
    case 'se':
      return 'nwse-resize'
  }
}
