/**
 * `checkInvariants(doc)` — the document invariants of contract §2.8, checked by tests only.
 * Returns human-readable violations (empty = valid).
 */
import type { LoroDoc } from 'loro-crdt'
import {
  CONTAINER_NODE_TYPES,
  PLACEMENT_KEYS,
  SIZE_KEYS,
  componentDependencies,
  frameAabb,
  readRotation,
  toSnapshot,
  unionRects,
  type DesignNode,
} from '../src/index.ts'

function px(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^-?[\d.]+(px)?$/.test(v.trim())) return Number.parseFloat(v)
  return null
}

export function checkInvariants(doc: LoroDoc, opts: { groupTolerance?: number } = {}): string[] {
  const snap = toSnapshot(doc)
  const out: string[] = []
  const nodes = snap.nodes
  const tol = opts.groupTolerance ?? 0.5
  for (const pageId of snap.pageIds) {
    if (nodes[pageId]?.type !== 'page') out.push(`root ${pageId} is not a page`)
  }
  for (const n of Object.values(nodes)) {
    // 1. containment
    if (n.children.length > 0 && !CONTAINER_NODE_TYPES.has(n.type)) {
      out.push(`${n.type} ${n.id} has children`)
    }
    if (n.type === 'page' && n.parentId !== null) out.push(`page ${n.id} is not a root`)
    // 4. keys only where allowed
    if (n.componentKey !== undefined && n.type !== 'frame' && n.type !== 'instance') {
      out.push(`componentKey on ${n.type} ${n.id}`)
    }
    if (n.overrides !== undefined && n.type !== 'instance')
      out.push(`overrides on ${n.type} ${n.id}`)
    if (n.vector !== undefined && n.type !== 'vector') out.push(`vector on ${n.type} ${n.id}`)
    // 3. instances
    if (n.type === 'instance') {
      if (n.children.length > 0) out.push(`instance ${n.id} has children`)
      if (n.componentKey === undefined) out.push(`instance ${n.id} has no componentKey`)
      for (const k of Object.keys(n.styles)) {
        if (!PLACEMENT_KEYS.has(k) && !SIZE_KEYS.has(k))
          out.push(`instance ${n.id} owns style ${k}`)
      }
    }
    // 2. groups
    if (n.type === 'group' && n.children.length > 0) {
      const rects = []
      for (const c of n.children) {
        const child = nodes[c] as DesignNode
        if (child.styles['position'] !== 'absolute') out.push(`group child ${c} is not absolute`)
        const w = px(child.styles['width'])
        const h = px(child.styles['height'])
        if (w === null || h === null) continue
        rects.push(
          frameAabb({
            x: px(child.styles['left']) ?? 0,
            y: px(child.styles['top']) ?? 0,
            width: w,
            height: h,
            rotation: readRotation(child.styles),
          }),
        )
      }
      const u = unionRects(rects)
      if (u && rects.length === n.children.length) {
        const gw = px(n.styles['width']) ?? -1
        const gh = px(n.styles['height']) ?? -1
        if (
          Math.abs(u.x) > tol ||
          Math.abs(u.y) > tol ||
          Math.abs(u.width - gw) > tol ||
          Math.abs(u.height - gh) > tol
        ) {
          out.push(`group ${n.id} box ${gw}x${gh} != children union ${JSON.stringify(u)}`)
        }
      }
    }
  }
  // 4b. nodeKeys unique per main subtree; 5. registry entries; 6. no self-containing mains
  const registry = snap.components ?? {}
  for (const main of Object.values(nodes)) {
    if (main.type !== 'frame' || main.componentKey === undefined) continue
    if (!registry[main.componentKey])
      out.push(`main ${main.id} (${main.componentKey}) not registered`)
    const seen = new Map<string, string>()
    const stack = [...main.children]
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      const d = nodes[id] as DesignNode
      if (d.nodeKey === undefined) out.push(`node ${id} inside main ${main.id} has no nodeKey`)
      else if (seen.has(d.nodeKey)) out.push(`nodeKey ${d.nodeKey} repeats in main ${main.id}`)
      else seen.set(d.nodeKey, id)
      stack.push(...d.children)
    }
    if (componentDependencies(doc, main.componentKey).has(main.componentKey)) {
      out.push(`main ${main.id} contains an instance of itself`)
    }
  }
  return out
}
