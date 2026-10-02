/**
 * Moving layers between parents (canvas drag-reparent and layers-panel moves) and removing
 * them (contract §4.5). Every move converts the node's position to the new parent's context
 * (§2.4) so it keeps its world frame.
 */
import type { LoroDoc } from 'loro-crdt'
import { docGeometry, frameOrDeclared, positionContextOf, placementStyles } from './geometry.ts'
import { wouldCreateCycle } from './graph.ts'
import { deleteEmptiedGroups, ensureContainingBlock, fitGroups, freezeSize } from './groups.ts'
import { isTreeId, parseVirtualId } from './ids.ts'
import { deleteNode, getNode, getParentId, moveNode } from './nodes.ts'
import { setPropsAt } from './overrides.ts'
import { topmostRefs } from './refs.ts'
import { createComponentResolver } from './resolve.ts'
import { CONTAINER_NODE_TYPES, type GeometrySource, type NodeFrame } from './types.ts'
import { run, writeStyles } from './util.ts'

export interface ReparentMove {
  id: string
  /** Desired world frame; default `geo.frameOf(id)`. */
  world?: NodeFrame
}

export interface ReparentTarget {
  parentId: string
  /** Final index of the first moved node (others follow it); default append. */
  index?: number
}

/**
 * Why a move is refused: `instance-target` also covers targets that cannot hold children
 * (leaves, virtual or missing nodes).
 */
export type ReparentRefusal = 'cycle' | 'instance-target' | 'virtual' | 'page-node' | 'into-self'

function isAncestorOrSelf(doc: LoroDoc, ancestor: string, id: string): boolean {
  for (let cur: string | null = id; cur !== null; cur = getNode(doc, cur)?.parentId ?? null) {
    if (cur === ancestor) return true
  }
  return false
}

export function canReparent(
  doc: LoroDoc,
  ids: readonly string[],
  parentId: string,
): { ok: true } | { ok: false; reason: ReparentRefusal } {
  const parent = isTreeId(parentId) ? getNode(doc, parentId) : undefined
  if (!parent || !CONTAINER_NODE_TYPES.has(parent.type)) {
    return { ok: false, reason: 'instance-target' }
  }
  for (const id of ids) {
    if (!isTreeId(id) || parseVirtualId(id)) return { ok: false, reason: 'virtual' }
    const node = getNode(doc, id)
    if (!node) return { ok: false, reason: 'virtual' }
    if (node.type === 'page') return { ok: false, reason: 'page-node' }
    if (isAncestorOrSelf(doc, id, parentId)) return { ok: false, reason: 'into-self' }
  }
  if (wouldCreateCycle(doc, ids, parentId)) return { ok: false, reason: 'cycle' }
  return { ok: true }
}

/**
 * Tree move + context conversion (§2.4) + containing-block fix + nodeKey assignment + group
 * fits + deletion of emptied groups, as one commit. Moves inside the same parent only reorder
 * (styles untouched). Returns the ids actually moved ([] when refused).
 */
export function reparentNodes(
  doc: LoroDoc,
  moves: readonly ReparentMove[],
  target: ReparentTarget,
  geo: GeometrySource,
  opts: { origin?: string } = {},
): string[] {
  const ids = moves.map((m) => m.id)
  if (!canReparent(doc, ids, target.parentId).ok) return []
  return run(doc, opts.origin ?? 'editor:layers', () => {
    const resolver = createComponentResolver(doc)
    const keep = new Set(topmostRefs(doc, ids, resolver, { virtual: false }))
    const list = moves.filter((m) => keep.has(m.id))
    const declared = docGeometry(doc, resolver)
    const worlds = list.map((m) => m.world ?? frameOrDeclared(doc, geo, m.id, declared))
    const parent = getNode(doc, target.parentId)
    const context = positionContextOf(parent)
    const parentFrame =
      context === 'page' ? null : frameOrDeclared(doc, geo, target.parentId, declared)
    const oldParents: (string | null)[] = []
    const moved: string[] = []
    list.forEach((m, i) => {
      const oldParentId = getParentId(doc, m.id)
      const oldContext = positionContextOf(
        oldParentId === null ? undefined : getNode(doc, oldParentId),
      )
      moveNode(
        doc,
        m.id,
        target.parentId,
        target.index === undefined ? undefined : target.index + i,
      )
      moved.push(m.id)
      oldParents.push(oldParentId)
      if (oldParentId === target.parentId) return
      const world = worlds[i] ?? null
      if (world) writeStyles(doc, m.id, placementStyles(doc, target.parentId, world, parentFrame))
      if (context !== 'flow' && (context === 'group' || oldContext === 'flow')) {
        freezeSize(doc, m.id, world)
      }
    })
    if (context === 'absolute') ensureContainingBlock(doc, target.parentId)
    const remaining = deleteEmptiedGroups(doc, oldParents)
    fitGroups(doc, [...moved, ...remaining], geo)
    return moved
  })
}

/**
 * Delete real nodes (topmost only; pages are skipped), hide virtual ones (override), delete
 * groups emptied by it and refit the remaining groups.
 */
export function removeNodes(
  doc: LoroDoc,
  refs: readonly string[],
  geo: GeometrySource,
  opts: { origin?: string } = {},
): void {
  run(doc, opts.origin ?? 'editor:menu', () => {
    const resolver = createComponentResolver(doc)
    const parents: (string | null)[] = []
    for (const ref of topmostRefs(doc, refs, resolver)) {
      if (!isTreeId(ref)) {
        setPropsAt(doc, ref, { hidden: true }, { resolver })
        continue
      }
      parents.push(getParentId(doc, ref))
      deleteNode(doc, ref)
    }
    fitGroups(doc, deleteEmptiedGroups(doc, parents), geo)
  })
}
