/**
 * Internal helpers shared by the Phase 3 modules (not exported from the package root, except
 * where `index.ts` says so).
 */
import type { LoroDoc } from 'loro-crdt'
import { autoCommit, nodesTree, transact } from './doc.ts'
import { isTreeId, parseVirtualId } from './ids.ts'
import { applyStyle, requireNode, stylesMapOf } from './nodes.ts'
import type { StylePatch, StyleValue, Styles } from './types.ts'

const PX_RE = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px)?$/i

/** A length in px from a number or a `"12px"` / `"12"` string; null otherwise. */
export function toPx(v: StyleValue | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const m = PX_RE.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** Round to 2 decimals (geometry values), never `-0`. */
export function round2(n: number): number {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

export function isFlexDisplay(styles: Styles | undefined): boolean {
  const d = styles?.['display']
  return d === 'flex' || d === 'inline-flex'
}

export function isAbsolutePosition(styles: Styles | undefined): boolean {
  const p = styles?.['position']
  return p === 'absolute' || p === 'fixed'
}

const GEOMETRY_KEYS: ReadonlySet<string> = new Set(['left', 'top', 'width', 'height'])

/**
 * Write a style patch to a real node, skipping geometry values (`left/top/width/height`) that
 * already hold the same px value within 0.01 (so `"12px"` strings survive and re-measured
 * layouts do not write noise).
 */
export function writeStyles(doc: LoroDoc, id: string, patch: StylePatch): void {
  const node = requireNode(nodesTree(doc), id)
  const styles = stylesMapOf(node)
  for (const key in patch) {
    const v = patch[key]
    if (v === undefined) continue
    if (v !== null && GEOMETRY_KEYS.has(key) && typeof v === 'number') {
      const current = styles.get(key)
      const px = toPx(current as StyleValue | undefined)
      if (px !== null && Math.abs(px - v) < 0.01) continue
    }
    applyStyle(styles, key, v)
  }
}

/**
 * Run `fn` as one commit with `origin` (joining an open transaction), or — without an origin —
 * like a primitive helper (commit unless inside `transact`).
 */
export function run<T>(doc: LoroDoc, origin: string | undefined, fn: () => T): T {
  if (origin === undefined) {
    const out = fn()
    autoCommit(doc)
    return out
  }
  return transact(doc, fn, { origin })
}

/** Position of a live node in document order: its index path from the root. */
export function docOrderPath(doc: LoroDoc, id: string): number[] {
  const tree = nodesTree(doc)
  const path: number[] = []
  if (!isTreeId(id)) return path
  // `index()` is the position among siblings (among the roots for pages).
  for (let node = tree.getNodeByID(id); node; node = node.parent()) {
    path.push(node.index() ?? 0)
  }
  return path.reverse()
}

export function compareOrderPaths(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d
  }
  return a.length - b.length
}

/** Sort live real ids by document (paint) order. */
export function sortByDocOrder(doc: LoroDoc, ids: readonly string[]): string[] {
  const keyed = ids.map((id) => ({ id, path: docOrderPath(doc, id) }))
  keyed.sort((a, b) => compareOrderPaths(a.path, b.path))
  return keyed.map((k) => k.id)
}

/** The instance id of a virtual ref, or the ref itself. */
export function realIdOf(ref: string): string {
  return parseVirtualId(ref)?.instanceId ?? ref
}
