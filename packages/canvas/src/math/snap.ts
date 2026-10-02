import type { Rect } from '../types.ts'

/** A snapping guide line in world coordinates. `axis: 'x'` is a vertical line at x = pos. */
export interface Guide {
  axis: 'x' | 'y'
  pos: number
  start: number
  end: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
}

const EPS = 0.5

function xs(r: Rect): [number, number, number] {
  return [r.x, r.x + r.width / 2, r.x + r.width]
}
function ys(r: Rect): [number, number, number] {
  return [r.y, r.y + r.height / 2, r.y + r.height]
}

/** Smallest correction (≤ threshold) that aligns one of `values` with one of the candidates' lines. */
function bestDelta(
  values: readonly number[],
  lines: readonly number[],
  threshold: number,
): number | null {
  let best: number | null = null
  for (const v of values) {
    for (const l of lines) {
      const d = l - v
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d
    }
  }
  return best
}

function guidesFor(
  axis: 'x' | 'y',
  moved: Rect,
  values: readonly number[],
  candidates: readonly Rect[],
): Guide[] {
  const out: Guide[] = []
  const seen = new Set<number>()
  for (const v of values) {
    let start = axis === 'x' ? moved.y : moved.x
    let end = axis === 'x' ? moved.y + moved.height : moved.x + moved.width
    let matched = false
    for (const c of candidates) {
      const lines = axis === 'x' ? xs(c) : ys(c)
      if (lines.some((l) => Math.abs(l - v) <= EPS)) {
        matched = true
        start = Math.min(start, axis === 'x' ? c.y : c.x)
        end = Math.max(end, axis === 'x' ? c.y + c.height : c.x + c.width)
      }
    }
    const key = Math.round(v * 2) / 2
    if (matched && !seen.has(key)) {
      seen.add(key)
      out.push({ axis, pos: v, start, end })
    }
  }
  return out
}

/**
 * Snap a moving rectangle's edges and centre to the edges and centres of
 * `candidates` (siblings, parent, nearby artboards). `threshold` is in world
 * units (callers pass screen threshold / zoom).
 */
export function snapMove(moving: Rect, candidates: readonly Rect[], threshold: number): SnapResult {
  if (candidates.length === 0 || threshold <= 0) return { dx: 0, dy: 0, guides: [] }
  const allX: number[] = []
  const allY: number[] = []
  for (const c of candidates) {
    allX.push(...xs(c))
    allY.push(...ys(c))
  }
  const dx = bestDelta(xs(moving), allX, threshold) ?? 0
  const dy = bestDelta(ys(moving), allY, threshold) ?? 0
  const moved: Rect = {
    x: moving.x + dx,
    y: moving.y + dy,
    width: moving.width,
    height: moving.height,
  }
  const guides = [
    ...guidesFor('x', moved, xs(moved), candidates),
    ...guidesFor('y', moved, ys(moved), candidates),
  ]
  return { dx, dy, guides }
}

export interface EdgeSnapInput {
  /** The moving vertical edge's x (resize from e/w), if any. */
  x?: number
  /** The moving horizontal edge's y (resize from n/s), if any. */
  y?: number
}

/**
 * Snap only the edges that a resize moves. Returns corrections for those
 * edges plus guides computed against the resulting rectangle.
 */
export function snapEdges(
  edges: EdgeSnapInput,
  rectAfter: (dx: number, dy: number) => Rect,
  candidates: readonly Rect[],
  threshold: number,
): SnapResult {
  if (candidates.length === 0 || threshold <= 0) return { dx: 0, dy: 0, guides: [] }
  const allX: number[] = []
  const allY: number[] = []
  for (const c of candidates) {
    allX.push(...xs(c))
    allY.push(...ys(c))
  }
  const dx = edges.x === undefined ? 0 : (bestDelta([edges.x], allX, threshold) ?? 0)
  const dy = edges.y === undefined ? 0 : (bestDelta([edges.y], allY, threshold) ?? 0)
  const moved = rectAfter(dx, dy)
  const guides: Guide[] = []
  if (edges.x !== undefined) guides.push(...guidesFor('x', moved, [edges.x + dx], candidates))
  if (edges.y !== undefined) guides.push(...guidesFor('y', moved, [edges.y + dy], candidates))
  return { dx, dy, guides }
}
