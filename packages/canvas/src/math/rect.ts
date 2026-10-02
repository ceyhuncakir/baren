import type { BBox } from 'rbush'
import type { Point, Rect } from '../types.ts'

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export function right(r: Rect): number {
  return r.x + r.width
}

export function bottom(r: Rect): number {
  return r.y + r.height
}

export function centerX(r: Rect): number {
  return r.x + r.width / 2
}

export function centerY(r: Rect): number {
  return r.y + r.height / 2
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/** True when `inner` lies completely inside `outer` (edges may touch). */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/** True when the rectangles overlap or touch. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  )
}

export function inflate(r: Rect, dx: number, dy: number = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: r.width + dx * 2, height: r.height + dy * 2 }
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }
}

export function unionRects(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.width > maxX) maxX = r.x + r.width
    if (r.y + r.height > maxY) maxY = r.y + r.height
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function toBBox(r: Rect): BBox {
  return { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height }
}

export function fromBBox(b: BBox): Rect {
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY }
}

export function rectsEqual(a: Rect | null, b: Rect | null, epsilon = 1e-6): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon
  )
}
