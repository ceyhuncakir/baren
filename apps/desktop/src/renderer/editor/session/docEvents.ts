/**
 * One `subscribeNodes` subscription per open document, fanned out to the editor's
 * watchers (layer tree, inspector, tokens, document name). Watchers decide cheaply
 * whether a batch concerns them, so a canvas drag commit re-renders only what changed.
 *
 * The session's component resolver (one per open file, contract §6) is told about every
 * batch first: `affectedBy` names the components whose rendered content changed and the
 * instances whose own data changed, then `apply` drops its stale caches, and only then do
 * the watchers run, so they can read resolved (instance and virtual) nodes right away.
 */
import {
  createComponentResolver,
  getChildIds,
  getDocName,
  getNode,
  getParentId,
  getTokens,
  hasNode,
  isTreeId,
  listComponents,
  nodesTree,
  parseVirtualId,
  subscribeNodes,
  type AffectedByBatch,
  type ComponentInfo,
  type ComponentResolver,
  type ResolvedNode,
  type NodeChangeBatch,
  type Token,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { registerResolver } from '../model/resolver'
import { tokenOrders } from '../model/tokenOps'

export type BatchListener = (batch: NodeChangeBatch, affected: AffectedByBatch) => void

const NOTHING: AffectedByBatch = { components: new Set(), instances: new Set() }

export class DocEvents {
  private readonly listeners = new Set<BatchListener>()
  private readonly unsubscribe: () => void
  readonly resolver: ComponentResolver

  constructor(
    readonly doc: LoroDoc,
    resolver?: ComponentResolver,
  ) {
    this.resolver = resolver ?? createComponentResolver(doc)
    registerResolver(doc, this.resolver)
    this.unsubscribe = subscribeNodes(doc, (batch) => {
      let affected = NOTHING
      try {
        affected = this.resolver.affectedBy(batch)
        this.resolver.apply(batch)
      } catch (error) {
        console.warn('[editor] component resolver', error)
      }
      for (const l of [...this.listeners]) l(batch, affected)
    })
  }

  subscribe(listener: BatchListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
    this.resolver.dispose()
  }
}

/** The instance a ref renders through (itself for instance roots, its owner for virtual ids). */
export function instanceOfRef(ref: string): string | null {
  const v = parseVirtualId(ref)
  return v ? v.instanceId : null
}

/**
 * True when an affected-by result can change how `ref` resolves: an instance root or a
 * virtual id whose instance changed, or any component change (cheap and conservative; the
 * caller only asks for instance and virtual refs).
 */
export function refAffected(ref: string, affected: AffectedByBatch): boolean {
  const instanceId = isTreeId(ref) ? ref : instanceOfRef(ref)
  if (instanceId === null) return false
  return affected.instances.has(instanceId) || affected.components.size > 0
}

/** Ids touched by a batch (structure or content). */
export function touchedIds(batch: NodeChangeBatch): Set<string> {
  const out = new Set<string>()
  for (const c of batch.changes) {
    out.add(c.id)
    if (c.kind === 'moved' || c.kind === 'created') {
      if (c.parentId) out.add(c.parentId)
    }
    if (c.kind === 'moved' || c.kind === 'deleted') {
      if (c.oldParentId) out.add(c.oldParentId)
    }
  }
  return out
}

export interface NodesSnapshot {
  /** Live nodes among the watched ids (instances and virtual ids resolved), in id order. */
  nodes: readonly ResolvedNode[]
  /** Parent of each node (same index), null for pages. */
  parents: readonly (ResolvedNode | null)[]
}

/**
 * External store for a fixed list of node ids (the selection): `getSnapshot` returns a
 * stable object that only changes when a batch touches one of the ids or their parents.
 */
export class NodesWatcher {
  private snapshot: NodesSnapshot
  private listeners = new Set<() => void>()
  private off: (() => void) | null = null

  constructor(
    private readonly events: DocEvents,
    readonly ids: readonly string[],
  ) {
    this.snapshot = this.read()
  }

  private read(): NodesSnapshot {
    const { resolver } = this.events
    const nodes: ResolvedNode[] = []
    for (const id of this.ids) {
      const n = resolver.resolveNode(id)
      if (n) nodes.push(n)
    }
    const parents = nodes.map((n) =>
      n.parentId ? (resolver.resolveNode(n.parentId) ?? null) : null,
    )
    return { nodes, parents }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.off) {
      this.off = this.events.subscribe((batch, affected) => {
        const touched = touchedIds(batch)
        const relevant =
          this.ids.some((id) => touched.has(id)) ||
          this.snapshot.nodes.some((n) => n.parentId !== null && touched.has(n.parentId)) ||
          this.ids.some((id) => !isTreeId(id) && refAffected(id, affected)) ||
          this.snapshot.nodes.some((n) => n.type === 'instance' && refAffected(n.id, affected))
        if (!relevant) return
        this.snapshot = this.read()
        for (const l of [...this.listeners]) l()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.off?.()
        this.off = null
      }
    }
  }

  getSnapshot = (): NodesSnapshot => this.snapshot
}

/** External store for the token map (re-read only when a batch reports token changes). */
export class TokensWatcher {
  private snapshot: Record<string, Token>
  private orders: Record<string, number>
  private listeners = new Set<() => void>()
  private off: (() => void) | null = null

  constructor(private readonly events: DocEvents) {
    this.snapshot = getTokens(events.doc)
    this.orders = tokenOrders(events.doc)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.off) {
      this.off = this.events.subscribe((batch) => {
        if (batch.tokens.length === 0 && batch.by !== 'checkout') return
        this.snapshot = getTokens(this.events.doc)
        this.orders = tokenOrders(this.events.doc)
        for (const l of [...this.listeners]) l()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.off?.()
        this.off = null
      }
    }
  }

  getSnapshot = (): Record<string, Token> => this.snapshot
  getOrders = (): Record<string, number> => this.orders
}

/** External store for the document name (meta.name). */
export class DocNameWatcher {
  private snapshot: string
  private listeners = new Set<() => void>()
  private off: (() => void) | null = null

  constructor(private readonly events: DocEvents) {
    this.snapshot = getDocName(events.doc)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.off) {
      this.off = this.events.subscribe((batch) => {
        if (!batch.meta) return
        const next = getDocName(this.events.doc)
        if (next === this.snapshot) return
        this.snapshot = next
        for (const l of [...this.listeners]) l()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.off?.()
        this.off = null
      }
    }
  }

  getSnapshot = (): string => this.snapshot
}

export interface ComponentsSnapshot {
  /** Live main components (sorted by name). */
  list: readonly ComponentInfo[]
  /** Instance count per component key (instance nodes in the whole document). */
  counts: Readonly<Record<string, number>>
}

const NO_COMPONENTS: ComponentsSnapshot = { list: [], counts: {} }

/**
 * External store for the Components panel and the component picker: the registry's live
 * mains and how many instances each has. Documents without components cost one registry
 * read per structural batch. Instance counts come from one scan of the document (on first
 * use, when components exist) kept current from the change batches: created nodes are added,
 * instances that are no longer live dropped, `componentKey`/`type` changes re-read.
 */
export class ComponentsWatcher {
  private snapshot: ComponentsSnapshot = NO_COMPONENTS
  private dirty = true
  private listeners = new Set<() => void>()
  private off: (() => void) | null = null
  /** Instance id → component key (null until the first scan). */
  private instances: Map<string, string> | null = null

  constructor(private readonly events: DocEvents) {}

  private scan(): Map<string, string> {
    const map = new Map<string, string>()
    for (const node of nodesTree(this.events.doc).getNodes({ withDeleted: false })) {
      if (node.data.get('type') !== 'instance') continue
      const key = node.data.get('componentKey')
      if (typeof key === 'string') map.set(node.id, key)
    }
    return map
  }

  private read(): ComponentsSnapshot {
    const doc = this.events.doc
    const list = sortByDocumentOrder(doc, listComponents(doc))
    if (list.length === 0) return NO_COMPONENTS
    this.instances ??= this.scan()
    const counts: Record<string, number> = {}
    for (const key of this.instances.values()) counts[key] = (counts[key] ?? 0) + 1
    return { list, counts }
  }

  /** Keep the instance map current; returns true when the panel may change. */
  private track(batch: NodeChangeBatch, affected: AffectedByBatch): boolean {
    if (batch.by === 'checkout') {
      this.instances = null
      return true
    }
    let changed = batch.components.length > 0 || affected.components.size > 0
    const map = this.instances
    const doc = this.events.doc
    let deleted = false
    for (const c of batch.changes) {
      if (c.kind === 'deleted') {
        deleted = true
        changed = true
      } else if (
        c.kind === 'created' ||
        (c.kind === 'props' && (c.keys.includes('componentKey') || c.keys.includes('type')))
      ) {
        changed = true
        if (!map) continue
        const node = getNode(doc, c.id)
        if (node?.type === 'instance' && node.componentKey) map.set(c.id, node.componentKey)
        else map.delete(c.id)
      } else if (c.kind === 'props' && c.keys.includes('name')) changed = true
    }
    // A deleted subtree reports its root only: drop every instance that is no longer live.
    if (deleted && map) for (const id of [...map.keys()]) if (!hasNode(doc, id)) map.delete(id)
    return changed
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.off) {
      this.off = this.events.subscribe((batch, affected) => {
        if (!this.track(batch, affected)) return
        // Cheap when there are no components: stay quiet.
        if (this.snapshot.list.length === 0 && listComponents(this.events.doc).length === 0) return
        this.dirty = true
        for (const l of [...this.listeners]) l()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.off?.()
        this.off = null
        // Unsubscribed: the map can no longer follow the document.
        this.instances = null
        this.dirty = true
      }
    }
  }

  getSnapshot = (): ComponentsSnapshot => {
    if (this.dirty) {
      this.dirty = false
      const next = this.read()
      if (!sameComponents(this.snapshot, next)) this.snapshot = next
    }
    return this.snapshot
  }
}

/** Position of a node in the document: child indexes from its page down (pages first). */
function orderPath(doc: LoroDoc, id: string): number[] {
  const path: number[] = []
  for (let cur: string | null = id; cur !== null;) {
    const parent: string | null = getParentId(doc, cur)
    path.unshift(getChildIds(doc, parent).indexOf(cur))
    cur = parent
  }
  return path
}

/** Components in document order (pages, then layer order), like the layers panel. */
function sortByDocumentOrder(doc: LoroDoc, list: ComponentInfo[]): ComponentInfo[] {
  if (list.length < 2) return list
  const keys = new Map(list.map((c) => [c.key, orderPath(doc, c.mainId)]))
  return [...list].sort((a, b) => {
    const p = keys.get(a.key) ?? []
    const q = keys.get(b.key) ?? []
    for (let i = 0; i < Math.min(p.length, q.length); i++) {
      const d = (p[i] ?? 0) - (q[i] ?? 0)
      if (d !== 0) return d
    }
    return p.length - q.length || a.name.localeCompare(b.name)
  })
}

function sameComponents(a: ComponentsSnapshot, b: ComponentsSnapshot): boolean {
  if (a.list.length !== b.list.length) return false
  for (let i = 0; i < a.list.length; i++) {
    const p = a.list[i] as ComponentInfo
    const q = b.list[i] as ComponentInfo
    if (p.key !== q.key || p.mainId !== q.mainId || p.name !== q.name || p.pageId !== q.pageId)
      return false
  }
  const ka = Object.keys(a.counts)
  if (ka.length !== Object.keys(b.counts).length) return false
  return ka.every((k) => a.counts[k] === b.counts[k])
}
