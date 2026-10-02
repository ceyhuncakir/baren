import type { Rect } from '../types.ts'
import { containsRect, intersects } from './rect.ts'

/**
 * Selection rules for nested layers. A hit "path" lists node ids from the
 * top-level node (artboard, a direct child of the page) down to the deepest
 * node under the pointer.
 */
export interface SelectionContext {
  selection: readonly string[]
  parentOf(id: string): string | null
  isLocked(id: string): boolean
  /**
   * Groups and instances (contract 5.2): a click inside one that is not "entered" selects the
   * outermost such node. Also tells top-level frames (artboards) apart: `kind(id)`.
   */
  kind?(id: string): 'group' | 'instance' | 'frame' | 'other'
}

/**
 * Ids that are "entered": selected nodes and all their ancestors. A group or instance is
 * entered when the selection is that node or inside it.
 */
function enteredSet(ctx: SelectionContext): Set<string> {
  const out = new Set<string>()
  for (const id of ctx.selection) {
    let cur: string | null = id
    let guard = 0
    while (cur !== null && !out.has(cur) && guard++ < 10_000) {
      out.add(cur)
      cur = ctx.parentOf(cur)
    }
  }
  return out
}

/** Apply the outermost-group/instance rule to a candidate at index `i` of `path`. */
function outermostContainer(path: readonly string[], i: number, ctx: SelectionContext): string {
  const kind = ctx.kind
  if (!kind) return path[i] as string
  let entered: Set<string> | null = null
  for (let j = 0; j < i; j++) {
    const id = path[j] as string
    const k = kind(id)
    if (k !== 'group' && k !== 'instance') continue
    entered ??= enteredSet(ctx)
    if (!entered.has(id)) return id
  }
  return path[i] as string
}

export interface ClickModifiers {
  /** Ctrl/Meta-click: select the deepest node. */
  deep?: boolean
  /** Level-of-detail rendering (tiny artboards): clicks select whole artboards. */
  lod?: boolean
}

/** Locked nodes (and everything inside them) can't be picked on the canvas. */
export function truncateLocked(
  path: readonly string[],
  isLocked: (id: string) => boolean,
): string[] {
  const i = path.findIndex(isLocked)
  return i < 0 ? [...path] : path.slice(0, i)
}

/**
 * Which node a single click on `path` selects.
 *
 * 1. Locked nodes are skipped (empty result = click on empty canvas).
 * 2. LOD: the artboard. Deep (Ctrl/Meta): the deepest node.
 * 3. A click inside an already selected (non-artboard) node keeps that node,
 *    so pressing on a selected group's content drags the group.
 * 4. A click on a sibling-level node of the current selection selects at that
 *    same depth (stay "inside" the current context).
 * 5. Otherwise the artboard's direct child under the pointer, or the artboard
 *    itself when its background was hit.
 */
export function resolveClickTarget(
  path: readonly string[],
  ctx: SelectionContext,
  mods: ClickModifiers = {},
): string | null {
  const p = truncateLocked(path, ctx.isLocked)
  if (p.length === 0) return null
  if (mods.lod) return p[0] as string
  if (mods.deep) return p[p.length - 1] as string
  if (p.length === 1) return p[0] as string
  // A top-level non-frame (group, instance, shape) is selected as itself, unless entered.
  const topKind = ctx.kind?.(p[0] as string)
  const selected = new Set(ctx.selection)
  for (let i = p.length - 1; i >= 1; i--) {
    const id = p[i] as string
    if (selected.has(id)) return id
  }
  for (const s of ctx.selection) {
    const parent = ctx.parentOf(s)
    if (parent === null) continue
    const i = p.indexOf(parent)
    if (i >= 0 && i + 1 < p.length) return outermostContainer(p, i + 1, ctx)
  }
  if (topKind !== undefined && topKind !== 'frame') {
    if (topKind !== 'group' && topKind !== 'instance') return p[0] as string
    return outermostContainer(p, 1, ctx)
  }
  return outermostContainer(p, 1, ctx)
}

/**
 * Double-click: drill one level deeper from the selected node along the path,
 * or start text editing when the selected node is the deepest (a text node).
 */
export function resolveDoubleClickTarget(
  path: readonly string[],
  ctx: SelectionContext,
  isText: (id: string) => boolean,
): { id: string; editText: boolean } | null {
  const p = truncateLocked(path, ctx.isLocked)
  if (p.length === 0) return null
  if (ctx.selection.length === 1) {
    const sel = ctx.selection[0] as string
    const i = p.indexOf(sel)
    if (i >= 0) {
      if (i === p.length - 1) return { id: sel, editText: isText(sel) }
      const next = p[i + 1] as string
      return { id: next, editText: false }
    }
  }
  const target = resolveClickTarget(p, ctx)
  return target === null ? null : { id: target, editText: false }
}

/** Shift-click toggle. */
export function toggleInSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]
}

/** Escape: select the parents of the selection (not the page), or clear. */
export function escapeSelection(
  selection: readonly string[],
  parentOf: (id: string) => string | null,
  pageId: string,
): string[] {
  const out: string[] = []
  for (const id of selection) {
    const parent = parentOf(id)
    if (parent !== null && parent !== pageId && !out.includes(parent)) out.push(parent)
  }
  return out
}

/** Drop ids whose ancestor is also selected (moving both would double-apply). */
export function normalizeSelection(
  ids: readonly string[],
  parentOf: (id: string) => string | null,
): string[] {
  const set = new Set(ids)
  const out: string[] = []
  for (const id of ids) {
    let p = parentOf(id)
    let covered = false
    let guard = 0
    while (p !== null && guard++ < 10_000) {
      if (set.has(p)) {
        covered = true
        break
      }
      p = parentOf(p)
    }
    if (!covered && !out.includes(id)) out.push(id)
  }
  return out
}

export interface MarqueeTop {
  id: string
  bounds: Rect
  isFrame: boolean
  locked?: boolean
  hidden?: boolean
}

export interface MarqueeChild {
  id: string
  bounds: Rect
  locked?: boolean
  hidden?: boolean
}

/**
 * Marquee selection.
 * - With a `scope` (the drag started on an artboard's background): the
 *   scope's children that the marquee touches.
 * - Otherwise for each top-level node the marquee touches: a fully enclosed
 *   artboard (or any non-frame) is selected as a whole; a partially covered
 *   artboard contributes its touched children (when known).
 */
export function marqueeSelection(
  marquee: Rect,
  tops: readonly MarqueeTop[],
  childrenOf: (id: string) => readonly MarqueeChild[] | null,
  scope: string | null = null,
): string[] {
  const usable = (n: { locked?: boolean; hidden?: boolean }): boolean => !n.locked && !n.hidden
  if (scope !== null) {
    return (childrenOf(scope) ?? [])
      .filter((c) => usable(c) && intersects(c.bounds, marquee))
      .map((c) => c.id)
  }
  const out: string[] = []
  for (const top of tops) {
    if (!usable(top) || !intersects(top.bounds, marquee)) continue
    if (!top.isFrame || containsRect(marquee, top.bounds)) {
      out.push(top.id)
      continue
    }
    const kids = childrenOf(top.id)
    if (!kids) continue
    for (const c of kids) if (usable(c) && intersects(c.bounds, marquee)) out.push(c.id)
  }
  return out
}

export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
