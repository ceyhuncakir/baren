/**
 * Instance resolution (contract §3.2): instances are tree leaves whose content is expanded
 * from their main component at render time, never copied into the document. Expanded nodes
 * get virtual ids `"<instanceId>/<path>"`.
 *
 * The resolver caches one resolved template per component key (the main's content with the
 * overrides stored on nested instances applied) and builds each instance from it by applying
 * that instance's own styles and overrides. Caches are invalidated through `apply(batch)`;
 * reads after a local commit that was not applied yet drop every cache (checked with the
 * document's op count), so a resolver never serves data older than the document.
 */
import type { LoroDoc } from 'loro-crdt'
import { nodesTree } from './doc.ts'
import type { NodeChangeBatch } from './events.ts'
import {
  anyNode,
  componentsMap,
  findMainComponent,
  mainKeyOf,
  rawSubtree,
  registryMainId,
} from './graph.ts'
import { isNodeKey, isTreeId, parseVirtualId, virtualId } from './ids.ts'
import { decodeNode, getNode } from './nodes.ts'
import { toSubtreeSnapshot } from './snapshot.ts'
import {
  MAX_INSTANCE_DEPTH,
  MISSING_FILL_COLOR,
  PLACEMENT_KEYS,
  SIZE_KEYS,
  type DesignNode,
  type NodeType,
  type OverrideEntry,
  type Styles,
  type VectorData,
} from './types.ts'

export type InstanceStatus = 'ok' | 'cycle' | 'depth' | 'unresolved'

export interface ResolvedNode extends DesignNode {
  /** Where an expanded node comes from (virtual nodes and resolved instance roots). */
  source?: { instanceId: string; path: string; mainNodeId: string; componentKey: string }
  /** What the outermost instance overrides on this node (omitted when nothing is). */
  overridden?: { styles: string[]; text: boolean; hidden: boolean; assetId: boolean }
  /** Instance roots (top-level and nested). */
  status?: InstanceStatus
  /** Instance roots whose main is deleted (rendered from its retained data). */
  mainDeleted?: boolean
}

export interface ExpandedInstance {
  rootId: string
  componentKey: string
  status: InstanceStatus
  mainDeleted: boolean
  /** Root (the instance's TreeID) and every virtual node, in document order. */
  nodes: Record<string, ResolvedNode>
  /** Component keys this expansion depends on (its own and every nested one). */
  dependsOn: ReadonlySet<string>
}

export interface AffectedByBatch {
  components: ReadonlySet<string>
  instances: ReadonlySet<string>
}

export interface ComponentResolver {
  expandInstance(instanceId: string): ExpandedInstance | null
  resolveNode(ref: string): ResolvedNode | undefined
  /** Children refs of a node (virtual for instance content). */
  childrenOf(ref: string): readonly string[]
  /** Components whose rendered content changed, instances whose own data changed. */
  affectedBy(batch: NodeChangeBatch): AffectedByBatch
  /** Call once per batch (after affectedBy) to drop stale caches. */
  apply(batch: NodeChangeBatch): void
  /**
   * Fast path for main edits that only restyle main content (contract §9 propagation): for
   * each affected component key, the template paths whose resolved styles `batch` changes, so
   * a renderer can patch `virtualId(instance, path)` with `resolveStyles` instead of
   * re-expanding every instance. `null` when the batch needs full re-expansion: any change
   * other than `styles`, registry or instance changes, an affected component without a cached
   * top-level template, or a restyled main root that other components nest. Call BEFORE
   * `apply(batch)` (paths come from the templates the batch invalidates).
   */
  stylePaths(batch: NodeChangeBatch): ReadonlyMap<string, ReadonlySet<string>> | null
  /**
   * Resolved styles of one node of a real (TreeID) instance — equal to
   * `expandInstance(instanceId).nodes[virtualId(instanceId, path)].styles` — computed from the
   * component's template and the instance's override, without expanding the instance.
   * `undefined` when the instance does not resolve or has no such path.
   */
  resolveStyles(instanceId: string, path: string): Styles | undefined
  dispose(): void
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

/** A node of an expansion, keyed by its path relative to the expanded instance. */
interface TNode {
  path: string
  parentPath: string | null
  childPaths: string[]
  type: NodeType
  name: string
  styles: Styles
  text?: string
  svg?: string
  assetId?: string
  assetName?: string
  locked?: boolean
  hidden?: boolean
  componentKey?: string
  nodeKey?: string
  mainId?: string
  vector?: VectorData
  status?: InstanceStatus
  mainDeleted?: boolean
  /** TreeID of the node in its (innermost) main; '' for placeholder roots. */
  mainNodeId: string
  /** Key of the component whose main contains the node (the expanded key for the root). */
  sourceKey: string
}

interface Template {
  key: string
  status: 'ok' | 'unresolved'
  mainId: string
  mainDeleted: boolean
  name: string
  /** Pre-order; `nodes[0]` is the root (path ''). */
  nodes: TNode[]
  byPath: Map<string, TNode>
  /** Keys of every nested instance, transitively (cycle/depth ones included). */
  deps: Set<string>
  /** Instance nesting levels below the main (0 = no nested instances). */
  maxDepth: number
  /** A nested expansion hit the depth limit. */
  truncated: boolean
  /** TreeIDs of every main node the template was built from. */
  nodeIds: string[]
}

/** Instance data the expansion needs (a decoded instance node). */
type InstanceData = Pick<
  DesignNode,
  | 'id'
  | 'name'
  | 'styles'
  | 'componentKey'
  | 'mainId'
  | 'overrides'
  | 'hidden'
  | 'locked'
  | 'nodeKey'
>

interface TExpansion {
  status: InstanceStatus
  mainDeleted: boolean
  mainName: string
  nodes: TNode[]
  deps: Set<string>
  maxDepth: number
  truncated: boolean
  nodeIds: string[]
}

/** Apply an override's styles: value → set, `null` → delete. */
function applyOverrideStyles(styles: Styles, entry: OverrideEntry | undefined): void {
  const o = entry?.styles
  if (!o) return
  for (const key in o) {
    const v = o[key]
    if (v === null) delete styles[key]
    else if (v !== undefined) styles[key] = v
  }
}

/** Apply a non-root override entry (styles, text, hidden, asset) to a node in place. */
function applyEntry(node: TNode, entry: OverrideEntry | undefined): void {
  if (!entry) return
  applyOverrideStyles(node.styles, entry)
  if (entry.text !== undefined && node.type === 'text') node.text = entry.text
  if (entry.hidden !== undefined) node.hidden = entry.hidden
  if (entry.assetId !== undefined) node.assetId = entry.assetId
  if (entry.assetName !== undefined) node.assetName = entry.assetName
}

function withoutPlacement(styles: Styles): Styles {
  const out: Styles = {}
  for (const key in styles) if (!PLACEMENT_KEYS.has(key)) out[key] = styles[key] as Styles[string]
  return out
}

/** Root styles of an instance: base, then `overrides['']`, then its own styles (all keys). */
function rootStyles(base: Styles, inst: InstanceData): Styles {
  const styles: Styles = { ...base }
  applyOverrideStyles(styles, inst.overrides?.[''])
  for (const key in inst.styles) styles[key] = inst.styles[key] as Styles[string]
  return styles
}

/** Root-only stand-in for `cycle | depth | unresolved` instances (§3.2 step 5). */
function placeholderStyles(inst: InstanceData): Styles {
  const styles = rootStyles({}, inst)
  if (styles['width'] === undefined) styles['width'] = 100
  if (styles['height'] === undefined) styles['height'] = 100
  if (styles['backgroundColor'] === undefined && styles['background'] === undefined) {
    styles['backgroundColor'] = MISSING_FILL_COLOR
  }
  return styles
}

/** Override markers; style keys sorted (Loro map order differs between builds). */
function overriddenOf(
  entry: OverrideEntry | undefined,
  extraStyles: readonly string[] = [],
): ResolvedNode['overridden'] {
  // Most expanded nodes carry no override: skip the allocations below (hot in propagation).
  if (entry === undefined && extraStyles.length === 0) return undefined
  const styles = [...new Set([...Object.keys(entry?.styles ?? {}), ...extraStyles])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const text = entry?.text !== undefined
  const hidden = entry?.hidden !== undefined
  const assetId = entry?.assetId !== undefined
  if (styles.length === 0 && !text && !hidden && !assetId) return undefined
  return { styles, text, hidden, assetId }
}

/** ResolvedNode in DesignNode field order (keeps JSON identical to the Rust mirror). */
function toResolved(
  n: TNode,
  id: string,
  parentId: string | null,
  children: string[],
  extra: Pick<ResolvedNode, 'source' | 'overridden'>,
): ResolvedNode {
  const out: ResolvedNode = { id, type: n.type, name: n.name, parentId, children, styles: n.styles }
  if (n.text !== undefined) out.text = n.text
  if (n.svg !== undefined) out.svg = n.svg
  if (n.assetId !== undefined) out.assetId = n.assetId
  if (n.assetName !== undefined) out.assetName = n.assetName
  if (n.locked !== undefined) out.locked = n.locked
  if (n.hidden !== undefined) out.hidden = n.hidden
  if (n.componentKey !== undefined) out.componentKey = n.componentKey
  if (n.nodeKey !== undefined) out.nodeKey = n.nodeKey
  if (n.mainId !== undefined) out.mainId = n.mainId
  if (n.vector !== undefined) out.vector = n.vector
  if (extra.source) out.source = extra.source
  if (extra.overridden) out.overridden = extra.overridden
  if (n.status !== undefined) out.status = n.status
  if (n.mainDeleted) out.mainDeleted = true
  return out
}

interface RawNode {
  id: string
  meta: unknown
  children: RawNode[]
}

function asRaw(v: unknown): RawNode | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (typeof r['id'] !== 'string') return null
  return {
    id: r['id'],
    meta: r['meta'],
    children: Array.isArray(r['children'])
      ? (r['children'] as unknown[]).map(asRaw).filter((c): c is RawNode => c !== null)
      : [],
  }
}

/** Deeper main subtrees are cut off (protects the stack; real designs are far shallower). */
const MAX_TREE_DEPTH = 256

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

class Resolver implements ComponentResolver {
  private templates = new Map<string, Template>()
  private expansions = new Map<string, ExpandedInstance & { key: string }>()
  /** Instances this resolver expanded at least once (reported by `affectedBy`). */
  private seen = new Set<string>()
  /** main node TreeID → keys of the templates that contain it. */
  private keysByNodeId = new Map<string, Set<string>>()
  /** key → keys whose templates contain an instance of it (transitively). */
  private dependents = new Map<string, Set<string>>()
  private affectedCache = new WeakMap<NodeChangeBatch, AffectedByBatch>()
  /**
   * Decoded instance nodes. A main edit re-expands every instance of the component, but the
   * instances' own data did not change: reading it again from Loro (wasm decode) was the
   * largest part of propagation. Dropped per instance when its own data changes (`apply`).
   */
  private instData = new Map<string, DesignNode>()
  private version: number
  private readonly doc: LoroDoc

  constructor(doc: LoroDoc) {
    this.doc = doc
    this.version = doc.opCount()
  }

  /** Drop caches when the document changed without `apply` (reads right after a commit). */
  private guard(): void {
    const v = this.doc.opCount()
    if (v !== this.version) {
      this.templates.clear()
      this.expansions.clear()
      this.instData.clear()
      this.version = v
    }
  }

  // -- templates ------------------------------------------------------------

  /** The template for `key` valid in the context of the instance-key `stack`. */
  template(key: string, stack: readonly string[], hint: string | undefined): Template {
    const byKey = this.templates.get(key)
    // A key-only "unresolved" may still resolve through this instance's own hint (§2.7.4).
    if (byKey && this.validIn(byKey, stack) && (byKey.status === 'ok' || hint === undefined)) {
      return byKey
    }
    if (hint !== undefined) {
      const byHint = this.templates.get(`${key}|${hint}`)
      if (byHint && this.validIn(byHint, stack)) return byHint
    }
    const t = this.buildTemplate(key, stack, hint)
    if (!t.truncated && !stack.some((k) => t.deps.has(k))) {
      // Same result as a top-level build: cacheable. A result that depends on the hint
      // (unresolved with a hint, or a deleted main found only through it) is cached per hint.
      const viaHint =
        hint !== undefined &&
        (t.status === 'unresolved' ||
          (t.mainDeleted && t.mainId === hint && registryMainId(this.doc, key) !== hint))
      this.templates.set(viaHint ? `${key}|${hint}` : key, t)
    }
    return t
  }

  /** A template built top-level is valid under `stack` when no nested key repeats it and
   *  the extra nesting stays within the depth limit. */
  private validIn(t: Template, stack: readonly string[]): boolean {
    if (stack.length === 0) return true
    if (stack.length + t.maxDepth >= MAX_INSTANCE_DEPTH) return false
    return !stack.some((k) => t.deps.has(k))
  }

  private buildTemplate(key: string, stack: readonly string[], hint: string | undefined): Template {
    const found = findMainComponent(this.doc, key, hint)
    const raw = found ? asRaw(rawSubtree(this.doc, found.mainId)) : null
    if (!found || !raw) {
      return {
        key,
        status: 'unresolved',
        mainId: '',
        mainDeleted: false,
        name: '',
        nodes: [],
        byPath: new Map(),
        deps: new Set(),
        maxDepth: 0,
        truncated: false,
        nodeIds: [],
      }
    }
    const main = decodeNode(raw.id, null, [], raw.meta)
    const root: TNode = {
      path: '',
      parentPath: null,
      childPaths: [],
      type: 'instance',
      name: main.name,
      styles: withoutPlacement(main.styles),
      mainNodeId: raw.id,
      sourceKey: key,
    }
    const t: Template = {
      key,
      status: 'ok',
      mainId: found.mainId,
      mainDeleted: found.deleted,
      name: main.name,
      nodes: [root],
      byPath: new Map([['', root]]),
      deps: new Set(),
      maxDepth: 0,
      truncated: false,
      nodeIds: [raw.id],
    }
    const used = new Set<string>()
    const inner = [...stack, key]
    const visit = (rawNode: RawNode, parent: TNode, depth: number): void => {
      const d = decodeNode(rawNode.id, null, [], rawNode.meta)
      const segment =
        d.nodeKey !== undefined && isNodeKey(d.nodeKey) && !used.has(d.nodeKey)
          ? d.nodeKey
          : `~${rawNode.id}`
      used.add(segment)
      parent.childPaths.push(segment)
      t.nodeIds.push(rawNode.id)
      if (d.type === 'instance') {
        const nested = this.expandNested(d, inner)
        if (d.componentKey !== undefined) t.deps.add(d.componentKey)
        for (const k of nested.deps) t.deps.add(k)
        t.maxDepth = Math.max(t.maxDepth, 1 + nested.maxDepth)
        if (nested.truncated) t.truncated = true
        for (const id of nested.nodeIds) t.nodeIds.push(id)
        const prefix = (p: string): string => (p === '' ? segment : `${segment}/${p}`)
        for (const nn of nested.nodes) {
          const node: TNode = {
            ...nn,
            path: prefix(nn.path),
            parentPath: nn.parentPath === null ? parent.path : prefix(nn.parentPath),
            childPaths: nn.childPaths.map(prefix),
          }
          if (nn.path === '') {
            node.mainNodeId = rawNode.id
            node.sourceKey = key
            if (d.nodeKey !== undefined) node.nodeKey = d.nodeKey
            node.name = d.name !== '' ? d.name : nested.mainName
          }
          t.nodes.push(node)
          t.byPath.set(node.path, node)
        }
        return
      }
      const node: TNode = {
        path: segment,
        parentPath: parent.path,
        childPaths: [],
        type: d.type,
        name: d.name,
        styles: d.styles,
        mainNodeId: rawNode.id,
        sourceKey: key,
      }
      if (d.text !== undefined) node.text = d.text
      if (d.svg !== undefined) node.svg = d.svg
      if (d.assetId !== undefined) node.assetId = d.assetId
      if (d.assetName !== undefined) node.assetName = d.assetName
      if (d.locked !== undefined) node.locked = d.locked
      if (d.hidden !== undefined) node.hidden = d.hidden
      if (d.nodeKey !== undefined) node.nodeKey = d.nodeKey
      if (d.vector !== undefined) node.vector = d.vector
      t.nodes.push(node)
      t.byPath.set(node.path, node)
      if (depth < MAX_TREE_DEPTH) for (const c of rawNode.children) visit(c, node, depth + 1)
    }
    for (const c of raw.children) visit(c, root, 1)
    for (const id of t.nodeIds) {
      let set = this.keysByNodeId.get(id)
      if (!set) this.keysByNodeId.set(id, (set = new Set()))
      set.add(key)
    }
    for (const dep of t.deps) {
      let set = this.dependents.get(dep)
      if (!set) this.dependents.set(dep, (set = new Set()))
      set.add(key)
    }
    return t
  }

  /** Expansion of an instance nested in a main (TNodes, paths relative to it). */
  private expandNested(inst: InstanceData, stack: readonly string[]): TExpansion {
    const key = inst.componentKey
    const status: InstanceStatus | null =
      key === undefined
        ? 'unresolved'
        : stack.includes(key)
          ? 'cycle'
          : stack.length >= MAX_INSTANCE_DEPTH
            ? 'depth'
            : null
    const t = status === null ? this.template(key as string, stack, inst.mainId) : null
    if (!t || t.status !== 'ok') {
      const s = status ?? 'unresolved'
      return {
        status: s,
        mainDeleted: false,
        mainName: '',
        nodes: [placeholderNode(inst, s)],
        deps: new Set(),
        maxDepth: 0,
        truncated: s === 'depth',
        nodeIds: [],
      }
    }
    const overrides = inst.overrides ?? {}
    const nodes = t.nodes.map((tn) => {
      const n: TNode = { ...tn, styles: { ...tn.styles } }
      if (tn.path === '') {
        n.styles = rootStyles(tn.styles, inst)
        n.type = 'instance'
        n.name = inst.name !== '' ? inst.name : t.name
        if (inst.hidden !== undefined) n.hidden = inst.hidden
        else delete n.hidden
        if (inst.locked !== undefined) n.locked = inst.locked
        else delete n.locked
        n.componentKey = key as string
        if (inst.mainId !== undefined) n.mainId = inst.mainId
        n.status = 'ok'
        if (t.mainDeleted) n.mainDeleted = true
      } else {
        applyEntry(n, overrides[tn.path])
      }
      return n
    })
    return {
      status: 'ok',
      mainDeleted: t.mainDeleted,
      mainName: t.name,
      nodes,
      deps: t.deps,
      maxDepth: t.maxDepth,
      truncated: t.truncated,
      nodeIds: t.nodeIds,
    }
  }

  // -- public API -------------------------------------------------------------

  expandInstance(instanceId: string): ExpandedInstance | null {
    this.guard()
    const cached = this.expansions.get(instanceId)
    if (cached) return cached
    let inst = this.instData.get(instanceId)
    if (!inst) {
      inst = isTreeId(instanceId) ? getNode(this.doc, instanceId) : undefined
      if (!inst || inst.type !== 'instance') return null
      this.instData.set(instanceId, inst)
    }
    const out = this.expandTop(inst)
    this.seen.add(instanceId)
    this.expansions.set(instanceId, out)
    return out
  }

  private expandTop(inst: DesignNode): ExpandedInstance & { key: string } {
    const id = inst.id
    const key = inst.componentKey ?? ''
    const status: InstanceStatus | null = inst.componentKey === undefined ? 'unresolved' : null
    const t = status === null ? this.template(key, [], inst.mainId) : null
    if (!t || t.status !== 'ok') {
      const s = status ?? 'unresolved'
      const n = placeholderNode(inst, s)
      const root = toResolved(n, id, inst.parentId, [], {
        overridden: overriddenOf(inst.overrides?.[''], ownSizeKeys(inst.styles)),
      })
      return {
        key,
        rootId: id,
        componentKey: key,
        status: s,
        mainDeleted: false,
        nodes: { [id]: root },
        dependsOn: new Set(key === '' ? [] : [key]),
      }
    }
    const overrides = inst.overrides ?? {}
    const nodes: Record<string, ResolvedNode> = {}
    const ref = (p: string): string => virtualId(id, p)
    for (const tn of t.nodes) {
      const vid = ref(tn.path)
      const children = tn.childPaths.map(ref)
      if (tn.path === '') {
        const n: TNode = {
          ...tn,
          styles: rootStyles(tn.styles, inst),
          name: inst.name !== '' ? inst.name : t.name,
          componentKey: key,
          status: 'ok',
        }
        delete n.hidden
        delete n.locked
        if (inst.locked !== undefined) n.locked = inst.locked
        if (inst.hidden !== undefined) n.hidden = inst.hidden
        if (inst.nodeKey !== undefined) n.nodeKey = inst.nodeKey
        if (inst.mainId !== undefined) n.mainId = inst.mainId
        if (t.mainDeleted) n.mainDeleted = true
        nodes[vid] = toResolved(n, vid, inst.parentId, children, {
          source: { instanceId: id, path: '', mainNodeId: tn.mainNodeId, componentKey: key },
          overridden: overriddenOf(overrides[''], ownSizeKeys(inst.styles)),
        })
        continue
      }
      const entry = overrides[tn.path]
      const n: TNode = { ...tn, styles: { ...tn.styles } }
      applyEntry(n, entry)
      nodes[vid] = toResolved(n, vid, ref(tn.parentPath ?? ''), children, {
        source: {
          instanceId: id,
          path: tn.path,
          mainNodeId: tn.mainNodeId,
          componentKey: tn.sourceKey,
        },
        overridden: overriddenOf(entry),
      })
    }
    return {
      key,
      rootId: id,
      componentKey: key,
      status: 'ok',
      mainDeleted: t.mainDeleted,
      nodes,
      dependsOn: new Set([key, ...t.deps]),
    }
  }

  resolveNode(ref: string): ResolvedNode | undefined {
    this.guard()
    if (isTreeId(ref)) {
      const node = getNode(this.doc, ref)
      if (!node) return undefined
      if (node.type !== 'instance') return node
      return this.expandInstance(ref)?.nodes[ref]
    }
    const parsed = parseVirtualId(ref)
    if (!parsed) return undefined
    return this.expandInstance(parsed.instanceId)?.nodes[ref]
  }

  childrenOf(ref: string): readonly string[] {
    return this.resolveNode(ref)?.children ?? []
  }

  /**
   * The base (pre-override) template node of `path` in `instanceId` — what the instance shows
   * without its own override at that path (main + overrides stored on nested instances).
   */
  baseOf(instanceId: string, path: string): TNode | undefined {
    this.guard()
    const inst = isTreeId(instanceId) ? getNode(this.doc, instanceId) : undefined
    if (!inst || inst.type !== 'instance' || inst.componentKey === undefined) return undefined
    const t = this.template(inst.componentKey, [], inst.mainId)
    return t.status === 'ok' ? t.byPath.get(path) : undefined
  }

  affectedBy(batch: NodeChangeBatch): AffectedByBatch {
    const cached = this.affectedCache.get(batch)
    if (cached) return cached
    const components = new Set<string>(batch.components)
    const instances = new Set<string>()
    const result = { components, instances }
    const quiet =
      componentsMap(this.doc).size === 0 &&
      this.templates.size === 0 &&
      this.seen.size === 0 &&
      this.keysByNodeId.size === 0
    if (quiet) {
      for (const c of batch.changes) if (c.kind === 'overrides') instances.add(c.id)
      this.affectedCache.set(batch, result)
      return result
    }
    const tree = nodesTree(this.doc)
    const walked = new Set<string>()
    const chain = (id: string | null): void => {
      for (let node = id === null ? undefined : anyNode(tree, id); node; node = node.parent()) {
        if (walked.has(node.id)) return
        walked.add(node.id)
        if (tree.isNodeDeleted(node.id)) return
        const key = mainKeyOf(node)
        if (key !== undefined) components.add(key)
      }
    }
    const selfKey = (id: string): void => {
      const node = anyNode(tree, id)
      const key = node ? mainKeyOf(node) : undefined
      if (key !== undefined) components.add(key)
    }
    for (const c of batch.changes) {
      const id = c.id
      if (this.seen.has(id)) instances.add(id)
      const inTemplates = this.keysByNodeId.get(id)
      if (inTemplates) for (const k of inTemplates) components.add(k)
      switch (c.kind) {
        case 'created':
          chain(c.parentId)
          selfKey(id)
          break
        case 'moved':
          chain(c.parentId)
          chain(c.oldParentId)
          break
        case 'deleted':
          chain(c.oldParentId)
          selfKey(id)
          this.seen.delete(id)
          break
        case 'overrides':
          instances.add(id)
          chain(id)
          break
        case 'props':
          chain(id)
          if (c.keys.includes('componentKey') || c.keys.includes('type')) {
            selfKey(id)
            for (const t of this.templates.values()) if (t.mainId === id) components.add(t.key)
          }
          break
        default:
          chain(id)
      }
    }
    const queue = [...components]
    for (let k = queue.pop(); k !== undefined; k = queue.pop()) {
      for (const d of this.dependents.get(k) ?? []) {
        if (!components.has(d)) {
          components.add(d)
          queue.push(d)
        }
      }
    }
    this.affectedCache.set(batch, result)
    return result
  }

  apply(batch: NodeChangeBatch): void {
    const { components, instances } = this.affectedBy(batch)
    if (components.size > 0) {
      for (const [cacheKey, t] of this.templates) {
        if (components.has(t.key)) this.templates.delete(cacheKey)
      }
    }
    for (const [id, e] of this.expansions) {
      if (instances.has(id) || components.has(e.key)) {
        this.expansions.delete(id)
        continue
      }
      for (const k of e.dependsOn) {
        if (components.has(k)) {
          this.expansions.delete(id)
          break
        }
      }
    }
    for (const id of instances) this.instData.delete(id)
    for (const c of batch.changes) {
      if (c.kind === 'deleted') {
        this.expansions.delete(c.id)
        this.instData.delete(c.id)
      } else if (this.instData.has(c.id)) {
        // Any change on the instance node itself (styles, props, overrides, move).
        this.instData.delete(c.id)
      }
    }
    this.version = this.doc.opCount()
  }

  stylePaths(batch: NodeChangeBatch): ReadonlyMap<string, ReadonlySet<string>> | null {
    // No `guard()`: the doc already holds the batch's ops, and the cached templates (built
    // before it) are exactly what maps the changed main nodes to paths. A style-only batch
    // changes no structure, so those paths are still the current ones.
    if (batch.components.length > 0 || batch.changes.length === 0) return null
    for (const c of batch.changes) if (c.kind !== 'styles') return null
    const { components, instances } = this.affectedBy(batch)
    if (instances.size > 0 || components.size === 0) return null
    const changed = new Set<string>()
    for (const c of batch.changes) changed.add(c.id)
    // Templates cached per instance hint (deleted or registry-less mains) are not scanned:
    // their instances take the full path.
    for (const cacheKey of this.templates.keys()) {
      const bar = cacheKey.indexOf('|')
      if (bar >= 0 && components.has(cacheKey.slice(0, bar))) return null
    }
    const out = new Map<string, Set<string>>()
    for (const key of components) {
      const t = this.templates.get(key)
      if (!t || t.status !== 'ok' || t.truncated) return null
      const paths = new Set<string>()
      for (const tn of t.nodes) {
        if (!changed.has(tn.mainNodeId)) continue
        // A main root's styles reach the roots of nested instances through `rootStyles`,
        // whose template nodes carry the nested instance's id, not the root's: full path.
        if (tn.path === '' && (this.dependents.get(key)?.size ?? 0) > 0) return null
        paths.add(tn.path)
      }
      out.set(key, paths)
    }
    return out
  }

  resolveStyles(instanceId: string, path: string): Styles | undefined {
    this.guard()
    let inst = this.instData.get(instanceId)
    if (!inst) {
      inst = isTreeId(instanceId) ? getNode(this.doc, instanceId) : undefined
      if (!inst || inst.type !== 'instance') return undefined
      this.instData.set(instanceId, inst)
    }
    if (inst.componentKey === undefined) return undefined
    // Same template and formulas as `expandTop`.
    const t = this.template(inst.componentKey, [], inst.mainId)
    if (t.status !== 'ok') return undefined
    const tn = t.byPath.get(path)
    if (!tn) return undefined
    if (path === '') return rootStyles(tn.styles, inst)
    const styles: Styles = { ...tn.styles }
    applyOverrideStyles(styles, inst.overrides?.[path])
    return styles
  }

  dispose(): void {
    this.templates.clear()
    this.expansions.clear()
    this.instData.clear()
    this.seen.clear()
    this.keysByNodeId.clear()
    this.dependents.clear()
  }
}

function ownSizeKeys(styles: Styles): string[] {
  return Object.keys(styles).filter((k) => SIZE_KEYS.has(k))
}

function placeholderNode(inst: InstanceData, status: InstanceStatus): TNode {
  const n: TNode = {
    path: '',
    parentPath: null,
    childPaths: [],
    type: 'instance',
    name: inst.name,
    styles: placeholderStyles(inst),
    status,
    mainNodeId: '',
    sourceKey: inst.componentKey ?? '',
  }
  if (inst.locked !== undefined) n.locked = inst.locked
  if (inst.hidden !== undefined) n.hidden = inst.hidden
  if (inst.componentKey !== undefined) n.componentKey = inst.componentKey
  if (inst.nodeKey !== undefined) n.nodeKey = inst.nodeKey
  if (inst.mainId !== undefined) n.mainId = inst.mainId
  return n
}

/** A resolver for `doc` (one per editor session / canvas). */
export function createComponentResolver(doc: LoroDoc): ComponentResolver {
  return new Resolver(doc)
}

/** @internal Base template node used by the override helpers. */
export function baseNodeOf(
  doc: LoroDoc,
  instanceId: string,
  path: string,
  resolver?: ComponentResolver,
): Pick<TNode, 'styles' | 'text' | 'hidden' | 'assetId' | 'assetName' | 'type'> | undefined {
  const r = resolver instanceof Resolver ? resolver : new Resolver(doc)
  return r.baseOf(instanceId, path)
}

/**
 * `toSubtreeSnapshot` with every instance expanded: real nodes as they are, instance roots
 * resolved, their content as virtual nodes (pre-order). `rootRef` may be virtual.
 */
export function toRenderSubtree(
  doc: LoroDoc,
  rootRef: string,
  resolver?: ComponentResolver,
): { rootId: string; nodes: Record<string, ResolvedNode> } | undefined {
  const r = resolver ?? createComponentResolver(doc)
  const nodes: Record<string, ResolvedNode> = {}
  const virtual = parseVirtualId(rootRef)
  if (virtual) {
    const exp = r.expandInstance(virtual.instanceId)
    if (!exp || !exp.nodes[rootRef]) return undefined
    const stack = [rootRef]
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      const n = exp.nodes[id]
      if (!n) continue
      nodes[id] = n
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as string)
    }
    return { rootId: rootRef, nodes }
  }
  const sub = toSubtreeSnapshot(doc, rootRef)
  if (!sub) return undefined
  const stack: string[] = [rootRef]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    const n = sub.nodes[id]
    if (!n) continue
    if (n.type === 'instance') {
      const exp = r.expandInstance(id)
      if (!exp) {
        nodes[id] = n
        continue
      }
      const inner = [id]
      for (let v = inner.pop(); v !== undefined; v = inner.pop()) {
        const vn = exp.nodes[v]
        if (!vn) continue
        nodes[v] = vn
        for (let i = vn.children.length - 1; i >= 0; i--) inner.push(vn.children[i] as string)
      }
      continue
    }
    nodes[id] = n
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as string)
  }
  return { rootId: rootRef, nodes }
}

/** One node, real or virtual, as it renders (instances resolved). */
export function getResolvedNode(
  doc: LoroDoc,
  ref: string,
  resolver?: ComponentResolver,
): ResolvedNode | undefined {
  return (resolver ?? createComponentResolver(doc)).resolveNode(ref)
}

/** True when `ref` names a live node or existing expanded content. */
export function refExists(doc: LoroDoc, ref: string, resolver?: ComponentResolver): boolean {
  if (isTreeId(ref)) return getNode(doc, ref) !== undefined
  if (!parseVirtualId(ref)) return false
  return getResolvedNode(doc, ref, resolver) !== undefined
}
