/**
 * Selection normalisation shared by the structure helpers: refs (real or virtual ids) reduced
 * to the topmost ones, in document order.
 */
import type { LoroDoc } from 'loro-crdt'
import { isTreeId, parseVirtualId } from './ids.ts'
import { getNode } from './nodes.ts'
import type { ComponentResolver } from './resolve.ts'
import { sortByDocOrder } from './util.ts'

/** Ancestor refs of `ref` (nearest first): virtual parents, the instance, then real ancestors. */
export function ancestorRefs(doc: LoroDoc, ref: string, resolver: ComponentResolver): string[] {
  const out: string[] = []
  let parent: string | null
  if (isTreeId(ref)) parent = getNode(doc, ref)?.parentId ?? null
  else parent = resolver.resolveNode(ref)?.parentId ?? null
  while (parent !== null) {
    out.push(parent)
    if (isTreeId(parent)) parent = getNode(doc, parent)?.parentId ?? null
    else parent = resolver.resolveNode(parent)?.parentId ?? null
  }
  return out
}

/**
 * Existing refs without pages, minus every ref that has an ancestor in the set; real ids in
 * document order first, then virtual ids (grouped per instance in document order).
 */
export function topmostRefs(
  doc: LoroDoc,
  refs: readonly string[],
  resolver: ComponentResolver,
  options: { virtual?: boolean } = {},
): string[] {
  const set = new Set<string>()
  for (const ref of refs) {
    if (isTreeId(ref)) {
      const node = getNode(doc, ref)
      if (node && node.type !== 'page') set.add(ref)
    } else if (options.virtual !== false && parseVirtualId(ref) && resolver.resolveNode(ref)) {
      set.add(ref)
    }
  }
  const top = [...set].filter((ref) => !ancestorRefs(doc, ref, resolver).some((a) => set.has(a)))
  const real = sortByDocOrder(
    doc,
    top.filter((r) => isTreeId(r)),
  )
  const virtual = top.filter((r) => !isTreeId(r))
  if (virtual.length === 0) return real
  // Virtual refs: order of their instances, then expansion order.
  const order = new Map<string, number>()
  const instances = sortByDocOrder(doc, [
    ...new Set(virtual.map((v) => parseVirtualId(v)?.instanceId ?? v)),
  ])
  for (const inst of instances) {
    const exp = resolver.expandInstance(inst)
    if (!exp) continue
    Object.keys(exp.nodes).forEach((id, i) => order.set(id, instances.indexOf(inst) * 1e6 + i))
  }
  virtual.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return [...real, ...virtual]
}
