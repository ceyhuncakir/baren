/**
 * Document lookups shared by the executors (contract §5): resolving node ids (real TreeIDs and
 * instance virtual ids), component names, pages and artboards, lock checks. Pure functions of
 * a Loro doc and the session's component resolver: no DOM, unit-tested in Node.
 */
import {
  findMainComponent,
  getChildIds,
  getNode,
  isMainComponent,
  isTreeId,
  parseVirtualId,
  type ComponentResolver,
  type ResolvedNode,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { AgentToolError } from './errors'

/** What every lookup needs: the document and the session's resolver. */
export interface DocContext {
  doc: LoroDoc
  resolver: ComponentResolver
}

/**
 * Resolved nodes per document while its op count stays the same (Loro counts pending ops too,
 * so any change — committed or inside a transaction — starts a new memo). Without it, walking
 * up from each of N children re-reads their parent, and every read of a node lists all its
 * children: O(N²) for a wide frame (a 1,800-layer write_html spent seconds in its summary).
 * Resolved nodes are read-only for callers.
 */
const memo = new WeakMap<
  DocContext,
  { doc: LoroDoc; ops: number; nodes: Map<string, ResolvedNode | undefined> }
>()

/** A real or virtual node as it renders (instances resolved), or undefined. */
export function resolveRef(ctx: DocContext, ref: string): ResolvedNode | undefined {
  if (typeof ref !== 'string' || ref === '') return undefined
  const ops = ctx.doc.opCount()
  let m = memo.get(ctx)
  if (!m || m.doc !== ctx.doc || m.ops !== ops) {
    m = { doc: ctx.doc, ops, nodes: new Map() }
    memo.set(ctx, m)
  }
  if (m.nodes.has(ref)) return m.nodes.get(ref)
  const node = resolveUncached(ctx, ref)
  m.nodes.set(ref, node)
  return node
}

function resolveUncached(ctx: DocContext, ref: string): ResolvedNode | undefined {
  if (isTreeId(ref)) {
    const node = getNode(ctx.doc, ref)
    if (!node) return undefined
    return node.type === 'instance' ? (ctx.resolver.resolveNode(ref) ?? node) : node
  }
  if (!parseVirtualId(ref)) return undefined
  return ctx.resolver.resolveNode(ref)
}

export function notFound(ref: string): AgentToolError {
  return new AgentToolError(
    'node_not_found',
    `Node ${JSON.stringify(ref)} not found. Ids change when the user undoes a creation or deletion; look the layer up again with get_tree_summary or get_children.`,
  )
}

export function requireRef(ctx: DocContext, ref: string): ResolvedNode {
  const node = resolveRef(ctx, ref)
  if (!node) throw notFound(ref)
  return node
}

export function isVirtual(ref: string): boolean {
  return !isTreeId(ref) && parseVirtualId(ref) !== null
}

/** Contract §5: the component name agents see for each node type. */
export function componentName(ctx: DocContext, node: Pick<ResolvedNode, 'id' | 'type'>): string {
  switch (node.type) {
    case 'page':
      return 'Page'
    case 'frame':
      return isTreeId(node.id) && isMainComponent(ctx.doc, node.id) ? 'Component' : 'Frame'
    case 'text':
      return 'Text'
    case 'rect':
      return 'Rectangle'
    case 'svg':
      return 'SVG'
    case 'image':
      return 'Image'
    case 'group':
      return 'Group'
    case 'vector':
      return 'Vector'
    case 'instance':
      return 'Instance'
  }
}

/** Children as they render: virtual refs for instance content, artboards for a page. */
export function childRefs(ctx: DocContext, ref: string): readonly string[] {
  const node = resolveRef(ctx, ref)
  if (!node) return []
  if (node.type === 'page') return getChildIds(ctx.doc, ref)
  return node.children
}

/** Parent ref (virtual for instance content; the page for artboards; null for pages). */
export function parentRef(ctx: DocContext, ref: string): string | null {
  return resolveRef(ctx, ref)?.parentId ?? null
}

/** The page a node is on (itself for a page), or null. */
export function pageOfRef(ctx: DocContext, ref: string): string | null {
  let cur: string | null = ref
  for (let guard = 0; cur !== null && guard < 10_000; guard++) {
    const node = resolveRef(ctx, cur)
    if (!node) return null
    if (node.type === 'page') return cur
    cur = node.parentId
  }
  return null
}

/** Contract §5: the top-level ancestor (child of a page) of a node; itself for an artboard. */
export function artboardOfRef(ctx: DocContext, ref: string): string | null {
  let cur: string | null = ref
  let prev: string | null = null
  for (let guard = 0; cur !== null && guard < 10_000; guard++) {
    const node = resolveRef(ctx, cur)
    if (!node) return null
    if (node.type === 'page') return prev
    prev = cur
    cur = node.parentId
  }
  return null
}

export function isTopLevel(ctx: DocContext, ref: string): boolean {
  const node = resolveRef(ctx, ref)
  if (!node || node.parentId === null) return false
  return resolveRef(ctx, node.parentId)?.type === 'page'
}

/** Contract §5: an artboard is a top-level frame, group or instance. */
export function isArtboardNode(node: Pick<ResolvedNode, 'type'>): boolean {
  return node.type === 'frame' || node.type === 'group' || node.type === 'instance'
}

/** The node itself or the nearest ancestor that is locked, or null. */
export function lockedAncestor(ctx: DocContext, ref: string): ResolvedNode | null {
  let cur: string | null = ref
  for (let guard = 0; cur !== null && guard < 10_000; guard++) {
    const node = resolveRef(ctx, cur)
    if (!node || node.type === 'page') return null
    if (node.locked === true) return node
    cur = node.parentId
  }
  return null
}

/** Throws `invalid_target` when the node (or an ancestor) is locked. */
export function assertUnlocked(ctx: DocContext, ref: string): void {
  const locked = lockedAncestor(ctx, ref)
  if (!locked) return
  const which =
    locked.id === ref
      ? `Layer "${locked.name}" is locked`
      : `Layer ${JSON.stringify(ref)} is inside the locked layer "${locked.name}"`
  throw new AgentToolError(
    'invalid_target',
    `${which}. Ask the user to unlock it before changing it.`,
  )
}

/** Main component of an instance (or of instance content): key, main id and name. */
export function mainComponentOf(
  ctx: DocContext,
  node: ResolvedNode,
): { key: string; mainId: string | null; name: string } | null {
  let key: string | undefined
  let hint: string | undefined
  if (node.type === 'instance' && node.componentKey !== undefined) {
    key = node.componentKey
    hint = node.mainId
  } else if (node.source) {
    const inst = getNode(ctx.doc, node.source.instanceId)
    key = inst?.componentKey ?? node.source.componentKey
    hint = inst?.mainId
  }
  if (key === undefined) return null
  const found = findMainComponent(ctx.doc, key, hint)
  const mainId = found && !found.deleted ? found.mainId : null
  const main = found ? getNode(ctx.doc, found.mainId) : undefined
  return { key, mainId, name: main?.name ?? '' }
}

/** Display name of a node (instances without a name show their main's name). */
export function displayName(ctx: DocContext, node: ResolvedNode): string {
  if (node.name !== '') return node.name
  if (node.type === 'instance') return mainComponentOf(ctx, node)?.name ?? ''
  return node.name
}

/**
 * Pre-order walk of the rendered tree under `ref` (instance content included), `visit`
 * returning false skips the node's children. Bounded by `limit` visited nodes.
 */
export function walkRefs(
  ctx: DocContext,
  ref: string,
  visit: (node: ResolvedNode, depth: number) => boolean | void,
  limit = Number.POSITIVE_INFINITY,
): number {
  let visited = 0
  const stack: { ref: string; depth: number }[] = [{ ref, depth: 0 }]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const node = resolveRef(ctx, item.ref)
    if (!node) continue
    visited++
    if (visited > limit) return visited
    if (visit(node, item.depth) === false) continue
    const kids = node.type === 'page' ? getChildIds(ctx.doc, node.id) : node.children
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ ref: kids[i] as string, depth: item.depth + 1 })
    }
  }
  return visited
}
