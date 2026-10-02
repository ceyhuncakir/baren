/**
 * A lazily-filled, change-invalidated cache of the layer tree for the Pages and Layers
 * panels. Only rows that are actually shown are ever read from Loro: opening a 20k-node
 * document reads the pages and the artboards of the current page, nothing else.
 *
 * `apply(batch)` (from `subscribeNodes`) drops exactly the entries a batch touched and
 * bumps `version`, so React can re-render the list once per batch.
 *
 * Phase 3: instances are tree leaves whose rows expand into their resolved content (virtual
 * ids `"<instanceId>/<path>"`, read through the session's component resolver). Virtual rows
 * are cached separately and dropped whenever the resolver reports a component or instance
 * change, so edits to a main show up in every instance row immediately.
 */
import {
  getChildIds,
  hasNode,
  isTreeId,
  nodesTree,
  parseVirtualId,
  type AffectedByBatch,
  type ComponentResolver,
  type NodeChangeBatch,
  type NodeType,
} from '@baren/schema'
import type { LoroDoc, LoroMap, TreeID } from 'loro-crdt'

export type LayerKind =
  | 'artboard'
  | 'frame-column'
  | 'frame-row'
  | 'frame'
  | 'text'
  | 'rect'
  | 'svg'
  | 'image'
  | 'component'
  | 'group'
  | 'vector'
  | 'instance'

export interface LayerMeta {
  id: string
  type: NodeType
  name: string
  locked: boolean
  hidden: boolean
  kind: LayerKind
  /** Page background (pages only). */
  background: string | null
  /** Expanded instance content (a virtual id): no rename, drag, lock or children. */
  virtual: boolean
  /** Main component key (mains) or the shown component (instances). */
  componentKey: string | null
}

const META_PROPS = new Set(['name', 'locked', 'hidden', 'type', 'background', 'componentKey'])
const META_STYLES = new Set(['display', 'flexDirection', 'backgroundImage'])

const NODE_TYPES: ReadonlySet<string> = new Set([
  'page',
  'frame',
  'text',
  'rect',
  'svg',
  'image',
  'group',
  'vector',
  'instance',
])

function isNodeType(v: unknown): v is NodeType {
  return typeof v === 'string' && NODE_TYPES.has(v)
}

/** Node types whose rows can hold children (instances: their resolved content). */
export function isContainerType(type: string): boolean {
  return type === 'page' || type === 'frame' || type === 'group' || type === 'instance'
}

export class LayerTree {
  private readonly childCache = new Map<string, readonly string[]>()
  private readonly metaCache = new Map<string, LayerMeta>()
  private readonly parentCache = new Map<string, string | null>()
  private readonly virtualChildren = new Map<string, readonly string[]>()
  private readonly virtualMeta = new Map<string, LayerMeta>()
  private rootsCache: readonly string[] | null = null
  private listeners = new Set<() => void>()
  private _version = 0

  constructor(
    private readonly doc: LoroDoc,
    private readonly resolver: ComponentResolver | null = null,
  ) {}

  get version(): number {
    return this._version
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Page ids in order. */
  pages(): readonly string[] {
    if (!this.rootsCache) this.rootsCache = getChildIds(this.doc, null)
    return this.rootsCache
  }

  has(id: string): boolean {
    if (isTreeId(id)) return hasNode(this.doc, id)
    return this.virtualNode(id) !== undefined
  }

  private virtualNode(id: string) {
    if (!this.resolver || !parseVirtualId(id)) return undefined
    return this.resolver.resolveNode(id)
  }

  children(id: string): readonly string[] {
    if (!isTreeId(id)) {
      let list = this.virtualChildren.get(id)
      if (!list) {
        list = this.virtualNode(id)?.children ?? []
        this.virtualChildren.set(id, list)
      }
      return list
    }
    let list = this.childCache.get(id)
    if (!list) {
      if (!hasNode(this.doc, id)) list = []
      else if (this.meta(id)?.type === 'instance') {
        list = this.resolver?.childrenOf(id) ?? []
        this.virtualChildren.set(id, list)
      } else {
        list = getChildIds(this.doc, id)
        for (const c of list) this.parentCache.set(c, id)
      }
      this.childCache.set(id, list)
    }
    return list
  }

  parent(id: string): string | null {
    if (!isTreeId(id)) return this.virtualNode(id)?.parentId ?? null
    const cached = this.parentCache.get(id)
    if (cached !== undefined) return cached
    if (!hasNode(this.doc, id)) return null
    const node = nodesTree(this.doc).getNodeByID(id as TreeID)
    const parent = node?.parent()?.id ?? null
    this.parentCache.set(id, parent)
    return parent
  }

  /** Ancestors from the parent up to the page. */
  ancestors(id: string): string[] {
    const out: string[] = []
    for (let p = this.parent(id); p !== null; p = this.parent(p)) out.push(p)
    return out
  }

  /** The direct child of a page containing `id` (its artboard), or null for pages. */
  topLevelOf(id: string): string | null {
    let cur: string | null = id
    let prev: string | null = null
    while (cur !== null) {
      const parent = this.parent(cur)
      if (parent === null) return prev
      prev = cur
      cur = parent
    }
    return null
  }

  meta(id: string): LayerMeta | null {
    if (!isTreeId(id)) return this.virtualMetaOf(id)
    const cached = this.metaCache.get(id)
    if (cached) return cached
    if (!hasNode(this.doc, id)) return null
    const node = nodesTree(this.doc).getNodeByID(id as TreeID)
    if (!node) return null
    const data = node.data
    const rawType = data.get('type')
    const type: NodeType = isNodeType(rawType) ? rawType : 'frame'
    const rawName = data.get('name')
    const styles = data.get('styles') as LoroMap | undefined
    const background = data.get('background')
    const rawKey = data.get('componentKey')
    const componentKey = typeof rawKey === 'string' ? rawKey : null
    const parentIsPage = (() => {
      const p = node.parent()
      return p !== undefined && p.data.get('type') === 'page'
    })()
    let name = typeof rawName === 'string' ? rawName : ''
    // An instance with an empty name shows its main's current name (contract §2.1).
    if (type === 'instance' && name === '' && this.resolver) {
      name = this.resolver.resolveNode(id)?.name ?? ''
    }
    const meta: LayerMeta = {
      id,
      type,
      name,
      locked: data.get('locked') === true,
      hidden: data.get('hidden') === true,
      kind: kindOf(type, styles, parentIsPage, componentKey !== null),
      background: typeof background === 'string' ? background : null,
      virtual: false,
      componentKey,
    }
    this.metaCache.set(id, meta)
    return meta
  }

  private virtualMetaOf(id: string): LayerMeta | null {
    const cached = this.virtualMeta.get(id)
    if (cached) return cached
    const node = this.virtualNode(id)
    if (!node) return null
    const meta: LayerMeta = {
      id,
      type: node.type,
      name: node.name,
      locked: false,
      hidden: node.hidden === true,
      kind: kindOfStyles(node.type, node.styles, false, false),
      background: null,
      virtual: true,
      componentKey: node.componentKey ?? null,
    }
    this.virtualMeta.set(id, meta)
    return meta
  }

  /** Invalidate what a change batch touched. Returns true when layer rows may change. */
  apply(batch: NodeChangeBatch, affected?: AffectedByBatch): boolean {
    let changed = false
    const dropChildren = (parent: string | null) => {
      if (parent === null) this.rootsCache = null
      else this.childCache.delete(parent)
    }
    for (const c of batch.changes) {
      switch (c.kind) {
        case 'created':
          dropChildren(c.parentId)
          this.parentCache.set(c.id, c.parentId)
          changed = true
          break
        case 'moved':
          dropChildren(c.parentId)
          dropChildren(c.oldParentId)
          this.parentCache.set(c.id, c.parentId)
          // Artboard ↔ nested changes the icon kind.
          this.metaCache.delete(c.id)
          changed = true
          break
        case 'deleted':
          dropChildren(c.oldParentId)
          this.metaCache.delete(c.id)
          this.childCache.delete(c.id)
          this.parentCache.delete(c.id)
          changed = true
          break
        case 'props':
          if (c.keys.some((k) => META_PROPS.has(k))) {
            this.metaCache.delete(c.id)
            changed = true
          }
          break
        case 'styles':
          if (c.keys.some((k) => META_STYLES.has(k))) {
            this.metaCache.delete(c.id)
            changed = true
          }
          break
        default:
          break
      }
    }
    if (
      affected &&
      (affected.components.size > 0 || affected.instances.size > 0) &&
      this.dropResolved()
    ) {
      changed = true
    }
    if (batch.by === 'checkout') {
      this.clear()
      changed = true
    }
    if (changed) {
      this._version++
      for (const l of [...this.listeners]) l()
    }
    return changed
  }

  /** Drop every cached virtual row and instance row (their content comes from mains). */
  private dropResolved(): boolean {
    let dropped = this.virtualChildren.size > 0 || this.virtualMeta.size > 0
    this.virtualChildren.clear()
    this.virtualMeta.clear()
    for (const [id, meta] of this.metaCache) {
      if (meta.type !== 'instance') continue
      this.metaCache.delete(id)
      this.childCache.delete(id)
      dropped = true
    }
    return dropped
  }

  clear(): void {
    this.childCache.clear()
    this.metaCache.clear()
    this.parentCache.clear()
    this.virtualChildren.clear()
    this.virtualMeta.clear()
    this.rootsCache = null
  }
}

function kindOf(
  type: NodeType,
  styles: LoroMap | undefined,
  top: boolean,
  isMain: boolean,
): LayerKind {
  return kindFrom(type, (key) => styles?.get(key), top, isMain)
}

function kindOfStyles(
  type: NodeType,
  styles: Record<string, unknown>,
  top: boolean,
  isMain: boolean,
): LayerKind {
  return kindFrom(type, (key) => styles[key], top, isMain)
}

function kindFrom(
  type: NodeType,
  get: (key: string) => unknown,
  top: boolean,
  isMain: boolean,
): LayerKind {
  switch (type) {
    case 'text':
      return 'text'
    case 'rect': {
      // A rectangle filled with an image reads as an image in the layers panel (24).
      const bg = get('backgroundImage')
      return typeof bg === 'string' && bg.includes('baren-asset://') ? 'image' : 'rect'
    }
    case 'svg':
      return 'svg'
    case 'image':
      return 'image'
    case 'group':
      return 'group'
    case 'vector':
      return 'vector'
    case 'instance':
      return 'instance'
    default: {
      if (isMain && type === 'frame') return 'component'
      const display = get('display')
      if (display === 'flex' || display === 'inline-flex') {
        const dir = get('flexDirection')
        return dir === 'column' || dir === 'column-reverse' ? 'frame-column' : 'frame-row'
      }
      return top ? 'artboard' : 'frame'
    }
  }
}
