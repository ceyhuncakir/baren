/**
 * Low-level component graph reads shared by the node primitives and the component helpers
 * (contract §2.7): the registry, main lookup (§2.7.4), dependencies and cycle checks (§2.7.5)
 * and node-key assignment (§2.7.2). Reads Loro directly (no `nodes.ts` import) so the
 * primitives can use it without an import cycle.
 */
import { LoroMap, type LoroDoc, type LoroTree, type LoroTreeNode, type TreeID } from 'loro-crdt'
import { nodesTree } from './doc.ts'
import { compareTreeIds, isTreeId, newNodeKey } from './ids.ts'
import { CONTAINER, NODE_KEY } from './types.ts'

export function componentsMap(doc: LoroDoc): LoroMap {
  return doc.getMap(CONTAINER.components)
}

function liveNode(tree: LoroTree, id: string): LoroTreeNode | undefined {
  if (!isTreeId(id)) return undefined
  if (!tree.has(id) || tree.isNodeDeleted(id)) return undefined
  return tree.getNodeByID(id)
}

/** Any node, live or deleted (deleted nodes keep their data and children in Loro). */
export function anyNode(tree: LoroTree, id: string): LoroTreeNode | undefined {
  if (!isTreeId(id) || !tree.has(id)) return undefined
  return tree.getNodeByID(id)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** `componentKey` of a node when it is a main (a frame carrying a key). */
export function mainKeyOf(node: LoroTreeNode): string | undefined {
  const key = str(node.data.get(NODE_KEY.componentKey))
  if (key === undefined) return undefined
  // Unknown types decode as frames (and may be mains); instances carry keys but are not mains.
  return decodesAsFrame(node.data.get(NODE_KEY.type)) ? key : undefined
}

const KNOWN_NON_FRAME: ReadonlySet<string> = new Set([
  'page',
  'text',
  'rect',
  'svg',
  'image',
  'group',
  'vector',
  'instance',
])

/** The decoding rule of `decodeNode`: `frame` and every unknown type read as `frame`. */
function decodesAsFrame(type: unknown): boolean {
  return typeof type !== 'string' || !KNOWN_NON_FRAME.has(type)
}

const LEAF_TYPES: ReadonlySet<string> = new Set(['text', 'rect', 'svg', 'image', 'vector'])

/** Registry entry's `mainId` for `key`, if any. */
export function registryMainId(doc: LoroDoc, key: string): string | undefined {
  const entry = componentsMap(doc).get(key)
  return entry instanceof LoroMap ? str(entry.get('mainId')) : undefined
}

/** Write `components[key] = { mainId }` (mergeable entry; no op when unchanged). */
export function writeRegistry(doc: LoroDoc, key: string, mainId: string): void {
  const map = componentsMap(doc)
  const existing = map.get(key)
  const entry = existing instanceof LoroMap ? existing : map.ensureMergeableMap(key)
  if (entry.get('mainId') !== mainId) entry.set('mainId', mainId)
}

// ---------------------------------------------------------------------------
// Main lookup (§2.7.4)
// ---------------------------------------------------------------------------

interface MainIndex {
  version: number
  byKey: Map<string, string[]>
}

const mainIndexes = new WeakMap<LoroDoc, MainIndex>()

/** Live mains by key, rebuilt by one scan whenever the document changed since the last build. */
function mainIndex(doc: LoroDoc): MainIndex {
  const version = doc.opCount()
  const cached = mainIndexes.get(doc)
  if (cached && cached.version === version) return cached
  const byKey = new Map<string, string[]>()
  for (const node of nodesTree(doc).getNodes({ withDeleted: false })) {
    const key = mainKeyOf(node)
    if (key === undefined) continue
    const list = byKey.get(key)
    if (list) list.push(node.id)
    else byKey.set(key, [node.id])
  }
  const index = { version, byKey }
  mainIndexes.set(doc, index)
  return index
}

export interface FoundMain {
  mainId: string
  deleted: boolean
}

/**
 * Deterministic main lookup: (1) the registry's `mainId` when live with the same key;
 * (2) else the live main with that key and the smallest TreeID; (3) else a deleted node
 * (registry `mainId`, then `hint`) whose retained data still has the key → `deleted: true`;
 * (4) else null.
 */
export function findMainComponent(doc: LoroDoc, key: string, hint?: string): FoundMain | null {
  const tree = nodesTree(doc)
  const registered = registryMainId(doc, key)
  if (registered !== undefined) {
    const node = liveNode(tree, registered)
    if (node && mainKeyOf(node) === key) return { mainId: registered, deleted: false }
  }
  const live = mainIndex(doc).byKey.get(key)
  if (live && live.length > 0) {
    let best: string | undefined
    for (const id of live) {
      const node = liveNode(tree, id)
      if (!node || mainKeyOf(node) !== key) continue
      if (best === undefined || compareTreeIds(id, best) < 0) best = id
    }
    if (best !== undefined) return { mainId: best, deleted: false }
  }
  for (const candidate of [registered, hint]) {
    if (candidate === undefined) continue
    const node = anyNode(tree, candidate)
    if (node && tree.isNodeDeleted(candidate as TreeID) && mainKeyOf(node) === key) {
      return { mainId: candidate, deleted: true }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Ancestry, dependencies, cycles (§2.7.5)
// ---------------------------------------------------------------------------

/** Keys of the mains that are `id` or one of its live ancestors, innermost first. */
export function mainKeysAbove(doc: LoroDoc, id: string | null): string[] {
  if (id === null) return []
  const tree = nodesTree(doc)
  const out: string[] = []
  for (let node = liveNode(tree, id); node; node = node.parent()) {
    const key = mainKeyOf(node)
    if (key !== undefined) out.push(key)
  }
  return out
}

/** True when `id` is a main or lies inside a main's subtree. */
export function isInsideMain(doc: LoroDoc, id: string | null): boolean {
  if (id === null) return false
  const tree = nodesTree(doc)
  for (let node = liveNode(tree, id); node; node = node.parent()) {
    if (mainKeyOf(node) !== undefined) return true
  }
  return false
}

interface RawTreeNode {
  id: string
  meta?: unknown
  children?: unknown
}

function asRaw(v: unknown): RawTreeNode | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as RawTreeNode
  return typeof r.id === 'string' ? r : null
}

/** Instance keys inside the given raw subtrees (roots included). */
export function instanceKeysInRaw(roots: readonly unknown[], out = new Set<string>()): Set<string> {
  const stack: unknown[] = [...roots]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const raw = asRaw(item)
    if (!raw) continue
    const meta = raw.meta as Record<string, unknown> | undefined
    if (meta && meta[NODE_KEY.type] === 'instance') {
      const key = str(meta[NODE_KEY.componentKey])
      if (key !== undefined) out.add(key)
    }
    if (Array.isArray(raw.children)) for (const c of raw.children) stack.push(c)
  }
  return out
}

/** Raw JSON (`{ id, meta, children }`) of a node's subtree; works for deleted nodes too. */
export function rawSubtree(doc: LoroDoc, id: string): unknown {
  const node = anyNode(nodesTree(doc), id)
  return node ? (node.toJSON() as unknown) : undefined
}

/** Instance keys inside the subtrees of live nodes `ids` (roots included). */
export function instanceKeysIn(doc: LoroDoc, ids: readonly string[]): Set<string> {
  const out = new Set<string>()
  const tree = nodesTree(doc)
  for (const id of ids) {
    const node = liveNode(tree, id)
    if (!node) continue
    // Fast path for leaves: no JSON round trip.
    const type = node.data.get(NODE_KEY.type)
    if (type === 'instance') {
      const key = str(node.data.get(NODE_KEY.componentKey))
      if (key !== undefined) out.add(key)
      continue
    }
    if (typeof type === 'string' && LEAF_TYPES.has(type)) continue
    instanceKeysInRaw([node.toJSON() as unknown], out)
  }
  return out
}

/**
 * Keys of every instance inside the main of `key`, transitively (through the mains of those
 * instances). Deleted mains count through their retained data.
 */
export function componentDependencies(doc: LoroDoc, key: string): Set<string> {
  const out = new Set<string>()
  const queue = [key]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const k = queue.pop() as string
    if (visited.has(k)) continue
    visited.add(k)
    const main = findMainComponent(doc, k)
    if (!main) continue
    const raw = rawSubtree(doc, main.mainId)
    if (raw === undefined) continue
    for (const dep of instanceKeysInRaw([raw])) {
      out.add(dep)
      if (!visited.has(dep)) queue.push(dep)
    }
  }
  return out
}

/**
 * True when placing content whose instances use `keys` under `parentId` would make a main
 * contain (transitively) an instance of itself.
 */
export function wouldCreateCycleForKeys(
  doc: LoroDoc,
  keys: Iterable<string>,
  parentId: string,
): boolean {
  return cycleAgainst(doc, keys, mainKeysAbove(doc, parentId))
}

/** True when some key in `above` (mains around the target) is in the closure of `keys`. */
export function cycleAgainst(
  doc: LoroDoc,
  keys: Iterable<string>,
  above: readonly string[],
): boolean {
  if (above.length === 0) return false
  const closure = new Set<string>()
  for (const k of keys) {
    closure.add(k)
    for (const d of componentDependencies(doc, k)) closure.add(d)
  }
  return above.some((k) => closure.has(k))
}

/** True when moving the subtrees `subtreeIds` under `parentId` would create a component cycle. */
export function wouldCreateCycle(
  doc: LoroDoc,
  subtreeIds: readonly string[],
  parentId: string,
): boolean {
  if (mainKeysAbove(doc, parentId).length === 0) return false
  return wouldCreateCycleForKeys(doc, instanceKeysIn(doc, subtreeIds), parentId)
}

// ---------------------------------------------------------------------------
// Node keys (§2.7.2)
// ---------------------------------------------------------------------------

/**
 * Give every node in the subtrees of `ids` that has no `nodeKey` a fresh one (instances are
 * leaves, so the walk never crosses into instance content). With `includeRoots: false` the
 * roots themselves are skipped (a main root only has a key when it is inside another main).
 */
export function fillNodeKeys(
  doc: LoroDoc,
  ids: readonly string[],
  options: { includeRoots?: boolean; random?: () => number } = {},
): void {
  const tree = nodesTree(doc)
  const includeRoots = options.includeRoots ?? true
  const stack: { node: LoroTreeNode; root: boolean }[] = []
  for (const id of ids) {
    const node = liveNode(tree, id)
    if (node) stack.push({ node, root: true })
  }
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, root } = item
    if ((includeRoots || !root) && typeof node.data.get(NODE_KEY.nodeKey) !== 'string') {
      node.data.set(NODE_KEY.nodeKey, newNodeKey(options.random))
    }
    for (const child of node.children() ?? []) stack.push({ node: child, root: false })
  }
}

/**
 * After `movedId` (with its subtree) was moved inside a main: nodes of the moved subtree whose
 * `nodeKey` already exists elsewhere in the outermost enclosing main (or repeats inside the
 * moved subtree) get a fresh key, so every key stays unique per main subtree (§2.7.2). Keys
 * only collide when nodes move between copies of one main (a duplicated main keeps its keys);
 * keeping such a key would bind the instances' overrides of the original node to the moved
 * one. Keys inside mains of the moved subtree (the moved node itself when it is a main) are
 * kept: they address the overrides of those mains' own instances, as in `createComponent`'s
 * de-duplication.
 */
export function rekeyCollisions(doc: LoroDoc, movedId: string, random?: () => number): void {
  const tree = nodesTree(doc)
  const moved = liveNode(tree, movedId)
  if (!moved) return
  let outer: LoroTreeNode | undefined
  for (let n = moved.parent(); n; n = n.parent()) if (mainKeyOf(n) !== undefined) outer = n
  if (!outer) return
  const used = new Set<string>()
  const scan: LoroTreeNode[] = [outer]
  for (let n = scan.pop(); n !== undefined; n = scan.pop()) {
    if (n.id === moved.id) continue
    const key = str(n.data.get(NODE_KEY.nodeKey))
    if (key !== undefined) used.add(key)
    for (const c of n.children() ?? []) scan.push(c)
  }
  // Document order inside the moved subtree, so the first of two repeated keys is kept.
  const walk: { node: LoroTreeNode; nested: boolean }[] = [{ node: moved, nested: false }]
  for (let item = walk.pop(); item !== undefined; item = walk.pop()) {
    const { node } = item
    // A moved main (it becomes a nested main) keeps its keys like any nested main.
    const nested = item.nested || mainKeyOf(node) !== undefined
    const key = str(node.data.get(NODE_KEY.nodeKey))
    if (key !== undefined) {
      if (used.has(key) && !nested) {
        let fresh = newNodeKey(random)
        while (used.has(fresh)) fresh = newNodeKey(random)
        node.data.set(NODE_KEY.nodeKey, fresh)
        used.add(fresh)
      } else used.add(key)
    }
    const children = node.children() ?? []
    for (let i = children.length - 1; i >= 0; i--) {
      walk.push({ node: children[i] as LoroTreeNode, nested })
    }
  }
}
