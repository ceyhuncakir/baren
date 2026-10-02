import type { BBox } from 'rbush'
import { pointInFrame, type NodeFrame } from '@baren/schema'
import type { Point, Rect } from '../types.ts'

/**
 * A node in the spatial index. The bbox is the node's *visible* world box
 * (clipped by ancestors with overflow clipping); `rect` is the unclipped box
 * used for selection outlines. `order` is the paint order across the page:
 * a later (higher) order paints on top.
 */
export interface IndexedNode extends BBox {
  id: string
  parentId: string | null
  depth: number
  order: number
  rect: Rect
  /** World frame when the node's accumulated rotation is not 0 (exact hit test). */
  frame?: NodeFrame
}

export function pointBox(p: Point): BBox {
  return { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
}

function containsP(b: BBox, p: Point): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
}

/** True when `p` is inside the node's visible box and, for rotated nodes, its rotated shape. */
export function nodeContains(n: IndexedNode, p: Point): boolean {
  if (!containsP(n, p)) return false
  return !n.frame || pointInFrame(n.frame, p)
}

/**
 * The top-most node under `p` among `candidates` (typically an rbush search
 * result). Ties in paint order resolve to the deeper node. Rotated nodes are
 * tested against their rotated shape (the index stores their axis-aligned bounds).
 */
export function topmostAt(
  candidates: readonly IndexedNode[],
  p: Point,
  accept?: (n: IndexedNode) => boolean,
): IndexedNode | null {
  let best: IndexedNode | null = null
  for (const c of candidates) {
    if (!nodeContains(c, p)) continue
    if (accept && !accept(c)) continue
    if (best === null || c.order > best.order || (c.order === best.order && c.depth > best.depth))
      best = c
  }
  return best
}

/**
 * Paint-order key for a node from its sibling-index path (root → node). Lexicographic
 * order of these paths equals DOM paint order for in-flow content.
 */
export function comparePaths(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d
  }
  return a.length - b.length
}

/**
 * Ancestor path from the top-level node (direct child of the page) down to `id`.
 * Returns an empty array when `id` is not under `pageId`.
 */
export function pathFromTop(
  id: string,
  parentOf: (id: string) => string | null,
  pageId: string,
): string[] {
  const out: string[] = []
  let cur: string | null = id
  let guard = 0
  while (cur !== null && cur !== pageId && guard++ < 10_000) {
    out.push(cur)
    cur = parentOf(cur)
  }
  if (cur !== pageId) return []
  return out.reverse()
}
