/**
 * Pure window-geometry logic: validating persisted state, restoring it onto
 * the current display layout, and cascading new windows.
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface WindowState {
  /** Normal (un-maximized) bounds. */
  bounds: Rect
  maximized: boolean
}

export const DEFAULT_WINDOW_SIZE: Size = { width: 1440, height: 900 }
export const MIN_WINDOW_SIZE: Size = { width: 1024, height: 700 }
/** A restored window must show at least this much of itself on some display. */
const MIN_VISIBLE: Size = { width: 120, height: 48 }
export const CASCADE_OFFSET = 28

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isRect(v: unknown): v is Rect {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    isFiniteNumber(r['x']) &&
    isFiniteNumber(r['y']) &&
    isFiniteNumber(r['width']) &&
    isFiniteNumber(r['height']) &&
    (r['width'] as number) > 0 &&
    (r['height'] as number) > 0
  )
}

/** Validate persisted JSON; anything malformed is treated as "no saved state". */
export function parseWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isRect(v['bounds'])) return null
  const { x, y, width, height } = v['bounds']
  return {
    bounds: {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    },
    maximized: v['maximized'] === true,
  }
}

function overlap(a: Rect, b: Rect): Size {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Fit a size into a work area, never below the window minimum. */
export function fitSize(size: Size, workArea: Rect, min: Size = MIN_WINDOW_SIZE): Size {
  return {
    width: clamp(size.width, min.width, workArea.width),
    height: clamp(size.height, min.height, workArea.height),
  }
}

/** Move (and if needed shrink) bounds so they lie inside the work area. */
export function constrainToWorkArea(
  bounds: Rect,
  workArea: Rect,
  min: Size = MIN_WINDOW_SIZE,
): Rect {
  const { width, height } = fitSize(bounds, workArea, min)
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  }
}

export function centeredBounds(size: Size, workArea: Rect, min: Size = MIN_WINDOW_SIZE): Rect {
  const fitted = fitSize(size, workArea, min)
  return {
    x: Math.round(workArea.x + (workArea.width - fitted.width) / 2),
    y: Math.round(workArea.y + (workArea.height - fitted.height) / 2),
    ...fitted,
  }
}

/**
 * Initial geometry for the first window. Saved bounds are reused when enough
 * of the window would be visible on a current display (monitors get
 * unplugged); otherwise the default size is centred on the primary display.
 */
export function restoreWindowState(
  saved: WindowState | null,
  workAreas: readonly Rect[],
  primaryWorkArea: Rect,
  defaultSize: Size = DEFAULT_WINDOW_SIZE,
): WindowState {
  if (saved) {
    let best: { area: Rect; visible: number } | null = null
    for (const area of workAreas) {
      const o = overlap(saved.bounds, area)
      if (o.width < MIN_VISIBLE.width || o.height < MIN_VISIBLE.height) continue
      const visible = o.width * o.height
      if (!best || visible > best.visible) best = { area, visible }
    }
    if (best) {
      return { bounds: constrainToWorkArea(saved.bounds, best.area), maximized: saved.maximized }
    }
  }
  return {
    bounds: centeredBounds(defaultSize, primaryWorkArea),
    maximized: saved?.maximized ?? false,
  }
}

/**
 * Bounds for an additional window opened from `from`: offset down-right,
 * wrapping back to the work area's top-left corner when it would overflow.
 */
export function cascadeBounds(from: Rect, workArea: Rect, offset: number = CASCADE_OFFSET): Rect {
  const { width, height } = fitSize(from, workArea)
  let x = from.x + offset
  let y = from.y + offset
  if (x + width > workArea.x + workArea.width) x = workArea.x + offset
  if (y + height > workArea.y + workArea.height) y = workArea.y + offset
  return constrainToWorkArea({ x, y, width, height }, workArea)
}
