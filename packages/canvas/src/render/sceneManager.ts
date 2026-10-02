import RBush from 'rbush'
import type { LoroDoc } from 'loro-crdt'
import {
  assetRefsInValue,
  getChildIds,
  getNode,
  parseVirtualId,
  pointInFrame,
  readRotation,
  toSubtreeSnapshot,
  virtualId,
  type AffectedByBatch,
  type ComponentResolver,
  type DesignNode,
  type NodeChange,
  type NodeFrame,
  type NodeType,
  type StyleValue,
  type Styles,
} from '@baren/schema'
import { pathFromTop, pointBox, topmostAt, type IndexedNode } from '../math/hit.ts'
import { containsPoint, inflate, intersects, toBBox, unionRects } from '../math/rect.ts'
import { screenToWorld, visibleWorldRect } from '../math/viewport.ts'
import type { Point, Rect, Viewport } from '../types.ts'
import { loroParentId, readProps, readStyleValues, readText, topLevelOf } from '../doc/read.ts'
import { measureScene, type ThumbOp } from './measure.ts'
import { Thumbnails } from './thumbnails.ts'
import {
  DEFAULT_TOP_SIZE,
  applyStandinStyles,
  applyTopWrapper,
  computeTopBounds,
  createTopRecord,
  topAabb,
  topFrame,
  type TopItem,
  type TopRecord,
} from './topRecord.ts'
import {
  NODE_ID_ATTR,
  Scene,
  TOP_LEVEL_OMIT,
  isVirtualRef,
  type RenderContext,
  type SceneNode,
} from './scene.ts'
import { hasAssetStyles, pxValue } from './styles.ts'

/** Below this zoom artboards render as bitmap stand-ins (with hysteresis). */
export const LOD_ENTER_ZOOM = 0.24
export const LOD_EXIT_ZOOM = 0.26
/** Max nodes attached to the live DOM (visible + prefetched rings). */
export const MAX_LIVE_NODES = 16_000
/**
 * Max nodes newly attached per frame. JS cost of attaching retained DOM is tiny,
 * but the browser's style/layout/paint for it lands in the same frame
 * (~1 ms per 100–150 nodes), so this bounds settle frames to well under 50 ms.
 */
export const MAX_ATTACH_NODES_PER_FRAME = 1_200
/** Max nodes kept as detached DOM for fast re-mount. */
export const MAX_RETAINED_NODES = 40_000
/** Above this many changes in one batch the page is rebuilt instead of patched. */
const RELOAD_THRESHOLD = 4_000

export interface NodeInfo {
  id: string
  type: NodeType
  name: string
  parentId: string | null
  styles: Styles
  locked: boolean
  hidden: boolean
  isTop: boolean
  children: readonly string[]
  /** Main components (frames) and instances. */
  componentKey?: string
}

export interface SceneManagerOptions {
  doc: LoroDoc
  pageId: string
  world: HTMLElement
  measureHost: HTMLElement
  ctx: RenderContext
  /** True while a text node is being edited (its DOM is the source of truth). */
  isEditing: (id: string) => boolean
  devicePixelRatio: () => number
  /** Ask the host for another frame (async work such as thumbnail encoding finished). */
  requestFrame: () => void
  /** Expands instances (one resolver per canvas). */
  resolver: ComponentResolver
}

/**
 * `snapshot` with every instance expanded through `resolver` (roots resolved, content as
 * virtual nodes). Returns the input unchanged when it holds no instance, so documents without
 * components do no resolver work.
 */
export function expandInstances(
  snapshot: Record<string, DesignNode>,
  resolver: ComponentResolver,
): { nodes: Record<string, DesignNode>; instances: string[] } {
  let instances: string[] | null = null
  for (const id in snapshot) {
    if ((snapshot[id] as DesignNode).type === 'instance') (instances ??= []).push(id)
  }
  if (!instances) return { nodes: snapshot, instances: [] }
  const nodes: Record<string, DesignNode> = { ...snapshot }
  for (const id of instances) {
    const exp = resolver.expandInstance(id)
    if (!exp) continue
    for (const vid in exp.nodes) nodes[vid] = exp.nodes[vid] as DesignNode
  }
  return { nodes, instances }
}

export interface UpdateOptions {
  gesturing: boolean
  /** Time budget (ms) for loading/attaching scenes this frame. */
  budgetMs: number
  /**
   * When the frame started (`performance.now()`): work done earlier in the frame (applying
   * document changes, e.g. a main edit re-rendering many instances) counts against the
   * budget, so thumbnails and mounts wait for a lighter frame. Default: now.
   */
  startedAt?: number
  /**
   * The frame applied document changes: start no stand-in thumbnail this frame (re-measuring
   * a large stand-in costs tens of ms), so the edit itself reaches the screen first; the
   * thumbnails follow in the next frames.
   */
  deferThumbnails?: boolean
}

function now(): number {
  return performance.now()
}

/**
 * Owns the DOM for one page: a wrapper per top-level node (artboard) inside
 * the world layer, each showing either live DOM (its `Scene`) or a cheap
 * stand-in (background box + LOD thumbnail). Decides what is live from the
 * viewport (virtualization), keeps per-artboard rbush indexes of measured
 * node bounds, and applies incremental document changes.
 */
export class SceneManager {
  readonly records = new Map<string, TopRecord>()
  private order: string[] = []
  private readonly topIndex = new RBush<TopItem>(9)
  /** Node id → top-level id for nodes inside loaded scenes. */
  private readonly nodeTop = new Map<string, string>()
  private lod = false
  private dirtyMeasure = new Set<string>()
  private readonly thumbs: Thumbnails
  /** Top-level ids that must stay live (text editing), regardless of LOD and rings. */
  private readonly pinned = new Set<string>()
  private frameCounter = 0
  /** Asset ids whose state changed (resolved, loaded, failed) since the last update. */
  private assetChanges = new Set<string>()
  /** Asset ids whose bytes were reloaded: image layers need a fresh request. */
  private assetReloads = new Set<string>()
  /** Loaded instances (scene roots of expanded content) → their top-level record id. */
  private readonly instances = new Map<string, string>()
  /** Bumped whenever something the overlay draws from (bounds, rects, names) changed. */
  version = 0

  constructor(private readonly opts: SceneManagerOptions) {
    this.thumbs = new Thumbnails((rec) => this.records.get(rec.id) === rec, opts.requestFrame)
  }

  get pageId(): string {
    return this.opts.pageId
  }

  get isLod(): boolean {
    return this.lod
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  load(): void {
    this.clear()
    let ids: string[] = []
    try {
      ids = getChildIds(this.opts.doc, this.opts.pageId)
    } catch {
      ids = []
    }
    const items: TopItem[] = []
    const frag = document.createDocumentFragment()
    ids.forEach((id, i) => {
      const node = this.topNode(id)
      if (!node) return
      const rec = this.createRecord(node, i)
      frag.appendChild(rec.wrapper)
      items.push(rec.item)
    })
    this.opts.world.appendChild(frag)
    this.order = ids.filter((id) => this.records.has(id))
    this.reindexOrder()
    this.topIndex.load(items)
    this.version++
  }

  clear(): void {
    for (const rec of this.records.values()) {
      rec.wrapper.remove()
      rec.measureWrap?.remove()
      this.thumbs.release(rec)
    }
    this.records.clear()
    this.pinned.clear()
    this.nodeTop.clear()
    this.instances.clear()
    this.topIndex.clear()
    this.order = []
    this.dirtyMeasure.clear()
    this.thumbs.clear()
    this.version++
  }

  /** A top-level node's data (instances resolved, so they carry their main's styles). */
  private topNode(id: string): DesignNode | undefined {
    const node = getNode(this.opts.doc, id)
    if (node?.type !== 'instance') return node
    return this.opts.resolver.resolveNode(id) ?? node
  }

  private createRecord(node: DesignNode, order: number): TopRecord {
    const rec = createTopRecord(node, order, this.opts.ctx.rewrite)
    this.records.set(node.id, rec)
    return rec
  }

  private updateTopItem(rec: TopRecord): void {
    const e = rec.extent
    if (
      rec.item.minX === e.x &&
      rec.item.minY === e.y &&
      rec.item.maxX === e.x + e.width &&
      rec.item.maxY === e.y + e.height
    )
      return
    this.topIndex.remove(rec.item)
    rec.item = { ...toBBox(e), id: rec.id }
    this.topIndex.insert(rec.item)
    this.version++
  }

  private reindexOrder(): void {
    this.order.forEach((id, i) => {
      const rec = this.records.get(id)
      if (rec) rec.order = i
    })
  }

  // ---------------------------------------------------------------------------
  // Scenes
  // ---------------------------------------------------------------------------

  /** A node's subtree as rendered: `toSubtreeSnapshot` with instances expanded. */
  private renderSubtree(
    id: string,
  ): { nodes: Record<string, DesignNode>; instances: string[] } | null {
    const snap = toSubtreeSnapshot(this.opts.doc, id)
    if (!snap) return null
    return expandInstances(snap.nodes, this.opts.resolver)
  }

  private trackInstances(rec: TopRecord, ids: readonly string[]): void {
    if (ids.length === 0) return
    const deps = new Set(rec.instanceDeps ?? [])
    for (const id of ids) {
      this.instances.set(id, rec.id)
      for (const k of this.opts.resolver.expandInstance(id)?.dependsOn ?? []) deps.add(k)
    }
    rec.instanceDeps = deps
  }

  private loadScene(rec: TopRecord): Scene | null {
    if (rec.scene) return rec.scene
    const snap = this.renderSubtree(rec.id)
    if (!snap) return null
    const scene = Scene.fromSnapshot(rec.id, snap.nodes, this.opts.ctx)
    for (const id of scene.nodes.keys()) this.nodeTop.set(id, rec.id)
    this.trackInstances(rec, snap.instances)
    rec.scene = scene
    rec.measuredVersion = -1
    return scene
  }

  private disposeScene(rec: TopRecord): void {
    const scene = rec.scene
    if (!scene) return
    this.detach(rec)
    scene.releaseImages()
    for (const id of scene.nodes.keys()) {
      this.nodeTop.delete(id)
      this.instances.delete(id)
    }
    rec.scene = null
    rec.index = null
    rec.rects = null
    rec.frames = null
    rec.measuredVersion = -1
  }

  private attachLive(rec: TopRecord): void {
    const scene = rec.scene
    if (!scene) return
    if (rec.where === 'offscreen') {
      rec.wrapper.classList.remove('ic-offscreen')
    } else if (rec.where !== 'live') {
      rec.wrapper.appendChild(scene.rootEl)
    }
    rec.where = 'live'
    rec.standin.classList.add('ic-hidden')
    rec.lastUsed = this.frameCounter
    this.dirtyMeasure.add(rec.id)
  }

  private attachOffscreen(rec: TopRecord): void {
    const scene = rec.scene
    if (!scene || rec.where === 'offscreen') return
    if (rec.where !== 'live') rec.wrapper.appendChild(scene.rootEl)
    rec.wrapper.classList.add('ic-offscreen')
    rec.where = 'offscreen'
    rec.standin.classList.add('ic-hidden')
  }

  private attachMeasure(rec: TopRecord): void {
    const scene = rec.scene
    if (!scene || rec.where === 'measure') return
    if (rec.where !== 'none') this.detach(rec)
    if (!rec.measureWrap) {
      rec.measureWrap = document.createElement('div')
      rec.measureWrap.className = 'ic-mwrap'
    }
    // A rotated root is laid out unrotated in the measuring host (thumbnails are drawn in the
    // unrotated box and the stand-in rotates them): the wrapper cancels the root's rotation.
    rec.measureWrap.style.rotate = rec.rotation === 0 ? '' : `${-rec.rotation}deg`
    rec.measureWrap.appendChild(scene.rootEl)
    this.opts.measureHost.appendChild(rec.measureWrap)
    rec.where = 'measure'
    this.dirtyMeasure.add(rec.id)
  }

  private detach(rec: TopRecord): void {
    if (rec.where === 'none') return
    rec.scene?.rootEl.remove()
    rec.measureWrap?.remove()
    rec.wrapper.classList.remove('ic-offscreen')
    rec.standin.classList.remove('ic-hidden')
    rec.where = 'none'
  }

  private liveNodeCount(): number {
    let n = 0
    for (const rec of this.records.values())
      if (rec.where === 'live' || rec.where === 'offscreen') n += rec.scene?.size ?? 0
    return n
  }

  // ---------------------------------------------------------------------------
  // Virtualization (write phase)
  // ---------------------------------------------------------------------------

  /**
   * Decide what is live for `v`. Cheap state flips happen even during
   * gestures; loading new scenes, thumbnails and LOD switches wait until the
   * gesture settles and respect `budgetMs`.
   * Returns true when work remains (the caller should schedule another frame).
   */
  update(v: Viewport, options: UpdateOptions): boolean {
    this.frameCounter++
    if (this.thumbs.hasReady) this.thumbs.apply()
    if (this.assetChanges.size > 0) this.applyAssetChanges()
    const start = options.startedAt ?? now()
    const overBudget = (): boolean => now() - start > options.budgetMs
    if (!options.gesturing) {
      if (!this.lod && v.zoom < LOD_ENTER_ZOOM) this.lod = true
      else if (this.lod && v.zoom > LOD_EXIT_ZOOM) this.lod = false
    }
    const vis = visibleWorldRect(v)
    const inner = inflate(vis, vis.width * 0.25, vis.height * 0.25)
    const outer = inflate(vis, vis.width, vis.height)
    const innerIds = new Set(this.topIndex.search(toBBox(inner)).map((i) => i.id))
    const outerIds = new Set(this.topIndex.search(toBBox(outer)).map((i) => i.id))
    let pending = false

    // Pinned records are always live.
    for (const id of this.pinned) {
      const rec = this.records.get(id)
      if (!rec || rec.where === 'live') continue
      if (rec.where === 'measure') this.detach(rec)
      if (this.loadScene(rec)) this.attachLive(rec)
    }

    // Demote what left the rings (or everything, in LOD once the gesture settled).
    for (const rec of this.records.values()) {
      if (rec.where !== 'live' && rec.where !== 'offscreen') continue
      if (rec.preview || this.pinned.has(rec.id)) continue
      const demoteAll = this.lod && !options.gesturing
      if (demoteAll || !outerIds.has(rec.id)) this.detach(rec)
      else if (rec.where === 'live' && !innerIds.has(rec.id) && !options.gesturing)
        this.attachOffscreen(rec)
    }

    const center = { x: vis.x + vis.width / 2, y: vis.y + vis.height / 2 }
    const byDistance = (ids: Set<string>): TopRecord[] =>
      [...ids]
        .map((id) => this.records.get(id))
        .filter((r): r is TopRecord => r !== undefined && !r.hidden)
        .sort((a, b) => distance(topAabb(a), center) - distance(topAabb(b), center))

    // Budget for DOM newly attached this frame (the first attach is always allowed).
    let attachBudget = MAX_ATTACH_NODES_PER_FRAME
    let attached = 0
    const canAttach = (nodes: number): boolean => attached === 0 || attachBudget - nodes >= 0
    const spend = (nodes: number): void => {
      attachBudget -= nodes
      attached++
    }

    if (!this.lod) {
      let live = this.liveNodeCount()
      let flips = 0
      for (const rec of byDistance(innerIds)) {
        if (rec.where === 'live') {
          rec.lastUsed = this.frameCounter
          continue
        }
        if (rec.where === 'offscreen') {
          // Layout is kept by content-visibility; showing it again costs paint only.
          const cost = Math.ceil((rec.scene?.size ?? 0) / 2)
          if ((options.gesturing && flips >= 4) || !canAttach(cost)) {
            pending = true
            continue
          }
          this.attachLive(rec)
          spend(cost)
          flips++
          continue
        }
        if (options.gesturing) {
          pending = true
          continue
        }
        if (overBudget() || !canAttach(rec.scene?.size ?? DEFAULT_TOP_SIZE)) {
          pending = true
          break
        }
        const size = rec.scene?.size ?? 0
        if (live + size > MAX_LIVE_NODES) continue
        if (rec.where === 'measure') this.detach(rec)
        if (!this.loadScene(rec)) continue
        live += rec.scene?.size ?? 0
        if (!canAttach(rec.scene?.size ?? 0)) {
          pending = true
          break
        }
        spend(rec.scene?.size ?? 0)
        this.attachLive(rec)
      }
      // Prefetch the outer ring while idle.
      if (!options.gesturing && !overBudget()) {
        for (const rec of byDistance(outerIds)) {
          if (innerIds.has(rec.id) || rec.where === 'live' || rec.where === 'offscreen') continue
          if (overBudget()) {
            pending = true
            break
          }
          if (!rec.scene && live + DEFAULT_TOP_SIZE > MAX_LIVE_NODES) break
          if (!canAttach(rec.scene?.size ?? DEFAULT_TOP_SIZE)) {
            pending = true
            break
          }
          if (!this.loadScene(rec)) continue
          if (live + (rec.scene?.size ?? 0) > MAX_LIVE_NODES) continue
          live += rec.scene?.size ?? 0
          // content-visibility: hidden skips style/layout/paint; only DOM insertion is paid.
          spend(Math.ceil((rec.scene?.size ?? 0) / 4))
          this.attachOffscreen(rec)
        }
      }
    }

    // Thumbnails for stand-ins that are (nearly) visible.
    if (!options.gesturing) {
      let measuring = options.deferThumbnails === true ? 2 : 0
      for (const rec of this.records.values()) if (rec.where === 'measure') measuring++
      for (const rec of byDistance(innerIds)) {
        if (rec.where === 'live' || rec.where === 'offscreen' || rec.where === 'measure') continue
        if (rec.thumbVersion === rec.contentVersion) continue
        if (measuring >= 2 || overBudget()) {
          pending = true
          break
        }
        if (!this.loadScene(rec)) continue
        this.attachMeasure(rec)
        measuring++
      }
      this.evictRetained()
    }
    return pending || this.dirtyMeasure.size > 0
  }

  private evictRetained(): void {
    let retained = 0
    const detached: TopRecord[] = []
    for (const rec of this.records.values()) {
      if (rec.scene && rec.where === 'none') {
        retained += rec.scene.size
        detached.push(rec)
      }
    }
    if (retained <= MAX_RETAINED_NODES) return
    detached.sort((a, b) => a.lastUsed - b.lastUsed)
    for (const rec of detached) {
      if (retained <= MAX_RETAINED_NODES) break
      retained -= rec.scene?.size ?? 0
      this.disposeScene(rec)
    }
  }

  /** Keep a top-level node live (loaded and attached) until unpinned. */
  pin(topId: string): void {
    this.pinned.add(topId)
  }

  unpin(topId: string): void {
    this.pinned.delete(topId)
  }

  /** Mark a top-level node as needing re-measurement (e.g. fonts loaded). */
  invalidateAll(): void {
    for (const rec of this.records.values()) {
      rec.contentVersion++
      if (rec.where === 'live') this.dirtyMeasure.add(rec.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Measurement (read phase)
  // ---------------------------------------------------------------------------

  /**
   * Measure live/measuring scenes whose content changed. All DOM reads; the
   * only writes (thumbnail insertion, detaching measured scenes) happen after
   * every read, so layout is computed at most once.
   */
  measure(v: Viewport, containerRect: DOMRect): boolean {
    if (this.dirtyMeasure.size === 0) return false
    const thumbsToDraw: { rec: TopRecord; ops: ThumbOp[]; w: number; h: number }[] = []
    const done: TopRecord[] = []
    let changed = false
    for (const id of this.dirtyMeasure) {
      const rec = this.records.get(id)
      if (!rec?.scene) {
        this.dirtyMeasure.delete(id)
        continue
      }
      // Gesture previews offset the DOM; measure once the gesture has committed.
      if (rec.preview) continue
      if (rec.where !== 'live' && rec.where !== 'measure') {
        this.dirtyMeasure.delete(id)
        continue
      }
      // Thumbnails are only needed for stand-ins; they are drawn from the measuring host.
      const wantThumb = rec.where === 'measure' && rec.thumbVersion !== rec.contentVersion
      let origin: Point
      let scale: number
      const live = rec.where === 'live'
      if (live) {
        const r = rec.scene.rootEl.getBoundingClientRect()
        origin = screenToWorld(v, { x: r.left - containerRect.left, y: r.top - containerRect.top })
        scale = v.zoom
      } else {
        origin = { x: rec.bounds.x, y: rec.bounds.y }
        scale = 1
      }
      const rootRotation = live ? readRotation(rec.scene.root.styles) : 0
      const m = measureScene(
        rec.scene,
        origin,
        scale,
        wantThumb,
        this.opts.ctx.assets,
        rootRotation,
      )
      rec.measuredSize = m.size
      // Content of a rotated root measured unrotated (measuring host) has no world positions.
      const worldValid = live || rec.rotation === 0
      rec.index = worldValid ? new RBush<IndexedNode>(16).load(m.items) : null
      rec.rects = worldValid ? m.rects : null
      rec.frames = worldValid && m.frames.size > 0 ? m.frames : null
      rec.measuredVersion = rec.contentVersion
      const prevBounds = rec.bounds
      computeTopBounds(rec)
      const box = topAabb(rec)
      rec.extent = worldValid ? (unionRects([box, m.extent]) ?? box) : box
      if (prevBounds.width !== rec.bounds.width || prevBounds.height !== rec.bounds.height)
        applyTopWrapper(rec)
      this.updateTopItem(rec)
      if (m.thumbOps) {
        thumbsToDraw.push({ rec, ops: m.thumbOps, w: m.size.width, h: m.size.height })
        rec.thumbWaiting = m.thumbWaiting && m.thumbWaiting.size > 0 ? m.thumbWaiting : null
      }
      done.push(rec)
      this.dirtyMeasure.delete(id)
      changed = true
    }
    // Writes after all reads.
    for (const t of thumbsToDraw) {
      this.thumbs.paint(t.rec, t.ops, t.w, t.h, LOD_EXIT_ZOOM * this.opts.devicePixelRatio())
    }
    for (const rec of done) if (rec.where === 'measure') this.detach(rec)
    if (changed) this.version++
    return changed
  }

  /** Whether any scene needs measuring this frame. */
  get hasDirtyMeasure(): boolean {
    return this.dirtyMeasure.size > 0
  }

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  /**
   * Asset state changed (resolution finished, a load failed, a probe decoded) or, with
   * `reload`, the host re-stored the bytes. Applied in the next write phase.
   */
  queueAssetChange(ids: Iterable<string>, reload: boolean): void {
    for (const id of ids) {
      this.assetChanges.add(id)
      if (reload) this.assetReloads.add(id)
    }
  }

  /** Re-render nodes, stand-ins and thumbnails that reference changed assets. */
  private applyAssetChanges(): void {
    const ids = this.assetChanges
    const reloads = this.assetReloads
    this.assetChanges = new Set()
    this.assetReloads = new Set()
    const touches = (value: unknown): boolean =>
      typeof value === 'string' && assetRefsInValue(value).some((h) => ids.has(h))
    for (const rec of this.records.values()) {
      let dirty = false
      if (rec.scene) {
        if (rec.scene.refreshAssets(ids, false)) dirty = true
        if (reloads.size > 0 && rec.scene.refreshAssets(reloads, true)) dirty = true
      }
      if (rec.thumbWaiting && [...rec.thumbWaiting].some((h) => ids.has(h))) dirty = true
      if (
        hasAssetStyles(rec.styles) &&
        (touches(rec.styles['backgroundImage']) || touches(rec.styles['background']))
      ) {
        applyStandinStyles(rec, this.opts.ctx.rewrite)
        dirty = true
      }
      if (dirty) this.bump(rec)
    }
  }

  /** An image layer loaded or failed: re-measure when its box depends on the natural size. */
  imageSettled(nodeId: string): void {
    const top = this.nodeTop.get(nodeId)
    const rec = top ? this.records.get(top) : undefined
    const sn = rec?.scene?.nodes.get(nodeId)
    if (!rec || !sn) return
    if (pxValue(sn.styles['width']) !== null && pxValue(sn.styles['height']) !== null) return
    this.bump(rec)
    this.opts.requestFrame()
  }

  // ---------------------------------------------------------------------------
  // Document changes (write phase)
  // ---------------------------------------------------------------------------

  /** Apply one batch of changes. Returns ids whose element was replaced or removed. */
  apply(changes: readonly NodeChange[]): void {
    if (changes.length > RELOAD_THRESHOLD) {
      this.load()
      return
    }
    for (const c of changes) this.applyChange(c)
    this.version++
  }

  /** Instance roots are rendered from their resolution (see `refreshInstances`). */
  private isInstanceRoot(id: string): boolean {
    return this.instances.has(id) || this.records.get(id)?.type === 'instance'
  }

  private bump(rec: TopRecord): void {
    rec.contentVersion++
    if (rec.where === 'live') this.dirtyMeasure.add(rec.id)
  }

  /**
   * A paint-only content change (colours, opacity, shadows): thumbnails need redrawing, but
   * a current measurement stays valid, so live scenes are not re-measured.
   */
  private paintBump(rec: TopRecord): void {
    const current =
      rec.measuredVersion === rec.contentVersion &&
      rec.rects !== null &&
      !this.dirtyMeasure.has(rec.id)
    rec.contentVersion++
    if (current) rec.measuredVersion = rec.contentVersion
    else if (rec.where === 'live') this.dirtyMeasure.add(rec.id)
  }

  private topOf(id: string | null): string | null {
    if (id === null) return null
    if (this.records.has(id)) return id
    const loaded = this.nodeTop.get(id)
    if (loaded !== undefined) return loaded
    if (isVirtualRef(id)) {
      const v = parseVirtualId(id)
      return v ? this.topOf(v.instanceId) : null
    }
    return topLevelOf(this.opts.doc, id, this.opts.pageId)
  }

  private applyChange(c: NodeChange): void {
    const page = this.opts.pageId
    switch (c.kind) {
      case 'created': {
        if (c.parentId === page) {
          this.addTop(c.id, c.index)
          return
        }
        const top = this.topOf(c.parentId)
        const rec = top ? this.records.get(top) : undefined
        if (!rec || c.parentId === null) return
        this.bump(rec)
        if (rec.scene && !rec.scene.nodes.has(c.id)) {
          const node = getNode(this.opts.doc, c.id)
          if (node?.type === 'instance') this.insertSubtree(rec, c.id, c.parentId, c.index)
          else if (node && rec.scene.insert(node, c.parentId, c.index))
            this.nodeTop.set(c.id, rec.id)
        }
        return
      }
      case 'moved': {
        const fromTop = c.oldParentId === page ? c.id : this.topOf(c.oldParentId)
        if (c.parentId === page) {
          if (c.oldParentId === page) {
            this.reorderTop(c.id, c.index)
            return
          }
          if (fromTop) this.removeFromScene(fromTop, c.id)
          this.addTop(c.id, c.index)
          return
        }
        if (c.oldParentId === page) this.removeTop(c.id)
        const toTop = this.topOf(c.parentId)
        if (fromTop && fromTop === toTop && c.parentId !== null) {
          const rec = this.records.get(fromTop)
          if (rec) {
            this.bump(rec)
            if (rec.scene?.nodes.has(c.id)) rec.scene.move(c.id, c.parentId, c.index)
          }
          return
        }
        if (fromTop && c.oldParentId !== page) this.removeFromScene(fromTop, c.id)
        const toRec = toTop ? this.records.get(toTop) : undefined
        if (toRec && c.parentId !== null) {
          this.bump(toRec)
          if (toRec.scene && !toRec.scene.nodes.has(c.id))
            this.insertSubtree(toRec, c.id, c.parentId, c.index)
        }
        return
      }
      case 'deleted': {
        if (c.oldParentId === page) {
          this.removeTop(c.id)
          return
        }
        const top = this.nodeTop.get(c.id) ?? this.topOf(c.oldParentId)
        if (top) this.removeFromScene(top, c.id)
        return
      }
      case 'styles': {
        if (this.isInstanceRoot(c.id)) return
        const top = this.topOf(c.id)
        const rec = top ? this.records.get(top) : undefined
        if (!rec) return
        const values = readStyleValues(this.opts.doc, c.id, c.keys)
        if (rec.id === c.id) this.updateTopStyles(rec, values)
        else {
          this.bump(rec)
          rec.scene?.setStyles(c.id, values)
        }
        return
      }
      case 'text': {
        const top = this.topOf(c.id)
        const rec = top ? this.records.get(top) : undefined
        if (!rec) return
        this.bump(rec)
        rec.scene?.setText(c.id, readText(this.opts.doc, c.id), this.opts.isEditing(c.id))
        return
      }
      case 'props': {
        if (this.isInstanceRoot(c.id) && !c.keys.includes('type')) return
        const top = this.topOf(c.id)
        const rec = top ? this.records.get(top) : undefined
        if (!rec) return
        const props = readProps(this.opts.doc, c.id, c.keys)
        if ('type' in props && props['type'] !== rec.scene?.nodes.get(c.id)?.type) {
          // A changed type needs a different element (and instances an expansion).
          if (rec.id === c.id) this.reloadTop(c.id)
          else this.reinsert(rec, c.id)
          return
        }
        if (rec.id === c.id) {
          if ('name' in props) rec.name = typeof props['name'] === 'string' ? props['name'] : ''
          if ('hidden' in props) {
            rec.hidden = props['hidden'] === true
            rec.wrapper.classList.toggle('ic-hidden', rec.hidden)
          }
          if ('locked' in props) rec.locked = props['locked'] === true
          if ('componentKey' in props)
            rec.componentKey =
              typeof props['componentKey'] === 'string' ? props['componentKey'] : null
        }
        if ('svg' in props || 'assetId' in props || 'hidden' in props) this.bump(rec)
        rec.scene?.setProps(c.id, props)
        return
      }
      case 'vector': {
        const top = this.topOf(c.id)
        const rec = top ? this.records.get(top) : undefined
        if (!rec) return
        this.bump(rec)
        rec.scene?.setVector(c.id, getNode(this.opts.doc, c.id)?.vector)
        return
      }
      case 'overrides':
        // Re-rendered by `refreshInstances` (the resolver reports the instance).
        return
    }
  }

  /** Insert a node's rendered subtree (instances expanded) into a loaded scene. */
  private insertSubtree(rec: TopRecord, id: string, parentId: string, index: number): void {
    const scene = rec.scene
    if (!scene) return
    const snap = this.renderSubtree(id)
    if (!snap) return
    scene.insertSubtree(id, snap.nodes, parentId, index)
    for (const nid of Object.keys(snap.nodes))
      if (scene.nodes.has(nid)) this.nodeTop.set(nid, rec.id)
    this.trackInstances(rec, snap.instances)
  }

  /** Re-create a node inside a scene from the document (type changes). */
  private reinsert(rec: TopRecord, id: string): void {
    const sn = rec.scene?.nodes.get(id)
    if (!rec.scene || !sn || sn.parentId === null) return
    const parentId = sn.parentId
    const index = rec.scene.nodes.get(parentId)?.children.indexOf(id) ?? 0
    this.removeFromScene(rec.id, id)
    this.insertSubtree(rec, id, parentId, index)
  }

  /** Rebuild a top-level record (its type changed). */
  private reloadTop(id: string): void {
    const rec = this.records.get(id)
    if (!rec) return
    const index = rec.order
    this.removeTop(id)
    this.addTop(id, index)
  }

  /**
   * Re-render loaded instances whose own data or component content changed (contract 3.2
   * live propagation). Unchanged structure is patched in place; changed structure rebuilds
   * only the affected instance subtrees. Call after `apply` with the resolver's `affectedBy`.
   */
  refreshInstances(
    affected: AffectedByBatch & {
      /** `resolver.stylePaths` of the batches (merged); null/absent = full re-expansion. */
      stylePaths?: ReadonlyMap<string, ReadonlySet<string>> | null
    },
  ): void {
    const { components, instances } = affected
    const stylePaths = affected.stylePaths ?? null
    if (components.size === 0 && instances.size === 0) return
    const resolver = this.opts.resolver
    const touches = (deps: ReadonlySet<string> | undefined | null): boolean => {
      if (!deps || components.size === 0) return false
      for (const k of deps) if (components.has(k)) return true
      return false
    }
    // Top-level instance records (loaded or not): root styles and geometry.
    for (const rec of this.records.values()) {
      if (rec.type === 'instance') {
        const own = instances.has(rec.id)
        if (own || (components.size > 0 && touches(resolver.expandInstance(rec.id)?.dependsOn)))
          this.refreshTopInstance(rec)
      } else if (!rec.scene && touches(rec.instanceDeps)) {
        rec.contentVersion++
      }
    }
    for (const [id, topId] of [...this.instances]) {
      const own = instances.has(id)
      if (!own && components.size === 0) continue
      const rec = this.records.get(topId)
      if (!rec?.scene?.nodes.has(id)) {
        this.instances.delete(id)
        continue
      }
      if (rec.id === id) continue // done by refreshTopInstance
      if (!own && stylePaths && this.patchInstanceStyles(rec, id, stylePaths)) continue
      const exp = resolver.expandInstance(id)
      if (!exp || (!own && !touches(exp.dependsOn))) continue
      this.syncInstance(rec, id, exp.nodes)
    }
    this.version++
  }

  /**
   * Style-only main edits (contract §9): restyle just the instance's nodes on the changed
   * paths from `resolver.resolveStyles`, instead of expanding the whole instance and diffing
   * every node. Returns false when the instance needs the full path (it is then synced as
   * before); true when it was handled (patched, or not affected by these paths).
   */
  private patchInstanceStyles(
    rec: TopRecord,
    id: string,
    stylePaths: ReadonlyMap<string, ReadonlySet<string>>,
  ): boolean {
    const scene = rec.scene
    const key = scene?.nodes.get(id)?.componentKey
    if (!scene || key === undefined) return false
    const paths = stylePaths.get(key)
    // Not in the plan: the instance's own component is not affected (every affected
    // component has an entry, see `stylePaths`).
    if (!paths) return true
    const resolver = this.opts.resolver
    let layout = false
    for (const path of paths) {
      const styles = resolver.resolveStyles(id, path)
      if (!styles) return false
      const r = scene.patchStyles(virtualId(id, path), styles)
      if (r?.layout) layout = true
    }
    if (layout) this.bump(rec)
    else this.paintBump(rec)
    return true
  }

  private syncInstance(rec: TopRecord, id: string, nodes: Record<string, DesignNode>): void {
    const scene = rec.scene
    if (!scene) return
    const { added, removed, layout } = scene.syncSubtree(id, nodes, (nid) =>
      this.opts.isEditing(nid),
    )
    for (const r of removed) {
      this.nodeTop.delete(r)
      this.instances.delete(r)
    }
    for (const a of added) this.nodeTop.set(a, rec.id)
    const deps = new Set(rec.instanceDeps ?? [])
    for (const k of this.opts.resolver.expandInstance(id)?.dependsOn ?? []) deps.add(k)
    rec.instanceDeps = deps
    // A main edit that only repaints (colours…) keeps every measured box valid: skip the
    // re-measurement of the whole artboard (the bulk of propagation with many instances).
    if (layout) this.bump(rec)
    else this.paintBump(rec)
  }

  private refreshTopInstance(rec: TopRecord): void {
    const exp = this.opts.resolver.expandInstance(rec.id)
    const root = exp?.nodes[rec.id]
    if (!exp || !root) return
    const values: Record<string, StyleValue | undefined> = {}
    for (const k in rec.styles) if (!(k in root.styles)) values[k] = undefined
    for (const k in root.styles) if (rec.styles[k] !== root.styles[k]) values[k] = root.styles[k]
    if (Object.keys(values).length > 0) this.updateTopStyles(rec, values)
    rec.name = root.name
    rec.componentKey = root.componentKey ?? null
    if ((root.hidden === true) !== rec.hidden) {
      rec.hidden = root.hidden === true
      rec.wrapper.classList.toggle('ic-hidden', rec.hidden)
    }
    rec.locked = root.locked === true
    if (rec.scene) this.syncInstance(rec, rec.id, exp.nodes)
    else rec.contentVersion++
  }

  private updateTopStyles(rec: TopRecord, values: Record<string, StyleValue | undefined>): void {
    let geometry = false
    let visual = false
    for (const k in values) {
      const v = values[k]
      if (v === undefined) delete rec.styles[k]
      else rec.styles[k] = v
      if (
        TOP_LEVEL_OMIT.has(k) ||
        k === 'width' ||
        k === 'height' ||
        k === 'rotate' ||
        k === 'transform'
      )
        geometry = true
      if (!TOP_LEVEL_OMIT.has(k)) visual = true
    }
    rec.scene?.setStyles(rec.id, values)
    if (geometry) {
      computeTopBounds(rec)
      const box = topAabb(rec)
      if (rec.measuredVersion < 0 || !rec.rects) rec.extent = box
      else rec.extent = unionRects([box, rec.extent]) ?? box
      applyTopWrapper(rec)
      this.updateTopItem(rec)
    }
    applyStandinStyles(rec, this.opts.ctx.rewrite)
    // A move changes every node's world position; content changes need a new thumbnail.
    if (visual) this.bump(rec)
    else {
      rec.measuredVersion = -1
      if (rec.where === 'live') this.dirtyMeasure.add(rec.id)
    }
    this.version++
  }

  private addTop(id: string, index: number): void {
    if (this.records.has(id)) {
      this.reorderTop(id, index)
      return
    }
    const node = this.topNode(id)
    if (!node) return
    const rec = this.createRecord(node, index)
    const i = Math.max(0, Math.min(index, this.order.length))
    const beforeId = this.order[i]
    const before = beforeId ? this.records.get(beforeId)?.wrapper : undefined
    this.opts.world.insertBefore(rec.wrapper, before ?? null)
    this.order.splice(i, 0, id)
    this.reindexOrder()
    this.topIndex.insert(rec.item)
    // New artboards often arrive with children (paste/duplicate/remote); load lazily via virtualization.
    this.version++
  }

  private reorderTop(id: string, index: number): void {
    const rec = this.records.get(id)
    if (!rec) return
    this.order = this.order.filter((o) => o !== id)
    const i = Math.max(0, Math.min(index, this.order.length))
    const beforeId = this.order[i]
    const before = beforeId ? this.records.get(beforeId)?.wrapper : undefined
    this.opts.world.insertBefore(rec.wrapper, before ?? null)
    this.order.splice(i, 0, id)
    this.reindexOrder()
    this.version++
  }

  private removeTop(id: string): void {
    const rec = this.records.get(id)
    if (!rec) return
    this.disposeScene(rec)
    rec.wrapper.remove()
    this.thumbs.release(rec)
    this.topIndex.remove(rec.item)
    this.records.delete(id)
    this.order = this.order.filter((o) => o !== id)
    this.reindexOrder()
    this.dirtyMeasure.delete(id)
    this.version++
  }

  private removeFromScene(topId: string, id: string): void {
    const rec = this.records.get(topId)
    if (!rec) return
    this.bump(rec)
    if (!rec.scene) return
    for (const removed of rec.scene.remove(id)) {
      this.nodeTop.delete(removed)
      this.instances.delete(removed)
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  topIds(): readonly string[] {
    return this.order
  }

  topsInRect(r: Rect): TopRecord[] {
    return this.topIndex
      .search(toBBox(r))
      .map((i) => this.records.get(i.id))
      .filter((rec): rec is TopRecord => rec !== undefined)
      .sort((a, b) => a.order - b.order)
  }

  sceneNode(id: string): SceneNode | undefined {
    const top = this.nodeTop.get(id)
    return top ? this.records.get(top)?.scene?.nodes.get(id) : undefined
  }

  isLoaded(id: string): boolean {
    return this.records.has(id) || this.nodeTop.has(id)
  }

  /** Top-level id of a node (loaded or not), null when not on this page. */
  topLevelOf(id: string): string | null {
    return this.topOf(id)
  }

  parentOf(id: string): string | null {
    if (this.records.has(id)) return this.opts.pageId
    const sn = this.sceneNode(id)
    if (sn) return sn.parentId
    return loroParentId(this.opts.doc, id)
  }

  info(id: string): NodeInfo | null {
    const rec = this.records.get(id)
    if (rec) {
      return {
        id,
        type: rec.type,
        name: rec.name,
        parentId: this.opts.pageId,
        styles: rec.styles,
        locked: rec.locked,
        hidden: rec.hidden,
        isTop: true,
        children: rec.scene?.root.children ?? [],
        ...(rec.componentKey !== null ? { componentKey: rec.componentKey } : {}),
      }
    }
    const sn = this.sceneNode(id)
    if (sn) {
      return {
        id,
        type: sn.type,
        name: sn.name,
        parentId: sn.parentId,
        styles: sn.styles,
        locked: sn.locked,
        hidden: sn.hidden,
        isTop: false,
        children: sn.children,
        ...(sn.componentKey !== undefined ? { componentKey: sn.componentKey } : {}),
      }
    }
    const node = isVirtualRef(id)
      ? this.opts.resolver.resolveNode(id)
      : getNode(this.opts.doc, id)?.type === 'instance'
        ? this.opts.resolver.resolveNode(id)
        : getNode(this.opts.doc, id)
    if (!node || this.topOf(id) === null) return null
    return {
      id,
      type: node.type,
      name: node.name,
      parentId: node.parentId,
      styles: node.styles,
      locked: node.locked === true,
      hidden: node.hidden === true,
      isTop: node.parentId === this.opts.pageId,
      children: node.children,
      ...(node.componentKey !== undefined ? { componentKey: node.componentKey } : {}),
    }
  }

  /** Node type (loaded, or from the document / resolver). */
  typeOf(id: string): NodeType | null {
    return this.records.get(id)?.type ?? this.sceneNode(id)?.type ?? this.info(id)?.type ?? null
  }

  /** Best known world bounds of a node (axis-aligned bounds of rotated nodes). */
  boundsOf(id: string): Rect | null {
    const rec = this.records.get(id)
    if (rec) {
      const box = topAabb(rec)
      const p = rec.preview
      return p ? { ...box, x: box.x + p.x, y: box.y + p.y } : box
    }
    const top = this.nodeTop.get(id)
    const r = top ? this.records.get(top)?.rects?.get(id) : undefined
    return r ?? null
  }

  /** Best known world frame of a node (unrotated box + accumulated rotation). */
  frameOf(id: string): NodeFrame | null {
    const rec = this.records.get(id)
    if (rec) {
      const p = rec.preview
      const f = topFrame(rec)
      return p ? { ...f, x: f.x + p.x, y: f.y + p.y } : f
    }
    const top = this.nodeTop.get(id)
    const trec = top ? this.records.get(top) : undefined
    const f = trec?.frames?.get(id)
    if (f) return f
    const r = trec?.rects?.get(id)
    return r ? { ...r, rotation: 0 } : null
  }

  /** Whether the node's measurement is current (no content change since). */
  isMeasured(id: string): boolean {
    const top = this.records.has(id) ? id : this.nodeTop.get(id)
    const rec = top ? this.records.get(top) : undefined
    return rec !== undefined && rec.measuredVersion === rec.contentVersion && rec.rects !== null
  }

  elementOf(id: string): HTMLElement | SVGSVGElement | null {
    const rec = this.records.get(id)
    if (rec) return rec.scene && rec.where === 'live' ? rec.scene.rootEl : null
    return this.sceneNode(id)?.el ?? null
  }

  wrapperOf(id: string): HTMLDivElement | null {
    return this.records.get(id)?.wrapper ?? null
  }

  /** Is the node's top-level record rendered live (not as a stand-in)? */
  isLive(id: string): boolean {
    const top = this.records.has(id) ? id : this.nodeTop.get(id)
    return top ? this.records.get(top)?.where === 'live' : false
  }

  /** Path (top-level → node) for a DOM element inside the world layer. */
  pathForElement(el: Element | null): string[] | null {
    const target = el?.closest(`[${NODE_ID_ATTR}]`)
    const id = target?.getAttribute(NODE_ID_ATTR)
    if (!id || !this.isLoaded(id)) return null
    const path = pathFromTop(id, (n) => this.parentOf(n), this.opts.pageId)
    return path.length > 0 ? path : null
  }

  /**
   * Spatial hit test in world coordinates (for stand-ins / LOD, or when the
   * DOM hit test found nothing). `wholeTops` returns only top-level ids.
   */
  hitTestWorld(p: Point, wholeTops: boolean): string[] | null {
    const tops = this.topIndex
      .search(pointBox(p))
      .map((i) => this.records.get(i.id))
      .filter((r): r is TopRecord => r !== undefined && !r.hidden)
      .sort((a, b) => b.order - a.order)
    for (const rec of tops) {
      if (!wholeTops && rec.index && rec.measuredVersion === rec.contentVersion) {
        // Groups have no paint of their own: empty areas inside them hit what lies below.
        const hit = topmostAt(
          rec.index.search(pointBox(p)),
          p,
          (n) => this.sceneNode(n.id)?.type !== 'group',
        )
        if (hit) {
          const path = pathFromTop(hit.id, (n) => this.parentOf(n), this.opts.pageId)
          if (path.length > 0) return path
        }
        continue
      }
      const inside =
        rec.rotation === 0 ? containsPoint(rec.bounds, p) : pointInFrame(topFrame(rec), p)
      if (inside) return [rec.id]
    }
    return null
  }

  /** Index entries of the measured, live scenes under a world point (top-most first). */
  indexAt(p: Point): { rec: TopRecord; items: IndexedNode[] }[] {
    return this.topIndex
      .search(pointBox(p))
      .map((i) => this.records.get(i.id))
      .filter((r): r is TopRecord => r !== undefined && !r.hidden)
      .sort((a, b) => b.order - a.order)
      .map((rec) => ({
        rec,
        items:
          rec.index && rec.measuredVersion === rec.contentVersion
            ? rec.index.search(pointBox(p))
            : [],
      }))
  }

  /** Index entries of measured scenes intersecting a world rect. */
  indexIn(r: Rect): IndexedNode[] {
    const out: IndexedNode[] = []
    for (const rec of this.topsInRect(r)) {
      if (rec.hidden || !rec.index || rec.measuredVersion !== rec.contentVersion) continue
      out.push(...rec.index.search(toBBox(r)))
    }
    return out
  }

  /** Direct children of a loaded node with their measured bounds (marquee). */
  childrenWithBounds(
    id: string,
  ): { id: string; bounds: Rect; locked: boolean; hidden: boolean }[] | null {
    const info = this.info(id)
    const top = this.topOf(id)
    const rects = top ? this.records.get(top)?.rects : null
    if (!info || !rects) return null
    const out: { id: string; bounds: Rect; locked: boolean; hidden: boolean }[] = []
    for (const c of info.children) {
      const r = rects.get(c)
      const sn = this.sceneNode(c)
      if (r && sn) out.push({ id: c, bounds: r, locked: sn.locked, hidden: sn.hidden })
    }
    return out
  }

  /** Rects to snap against while moving/resizing `ids` (siblings + parent, or nearby artboards). */
  snapCandidates(ids: readonly string[], near: Rect): Rect[] {
    const exclude = new Set(ids)
    const first = ids[0]
    if (first === undefined) return []
    const parent = this.parentOf(first)
    const out: Rect[] = []
    if (parent === this.opts.pageId) {
      for (const rec of this.topsInRect(near))
        if (!exclude.has(rec.id) && !rec.hidden) out.push(topAabb(rec))
      return out
    }
    if (parent === null) return out
    const parentRect = this.boundsOf(parent)
    if (parentRect) out.push(parentRect)
    for (const c of this.childrenWithBounds(parent) ?? [])
      if (!exclude.has(c.id) && !c.hidden) out.push(c.bounds)
    return out
  }

  /** Visible top-level records (for labels). */
  visibleTops(v: Viewport): TopRecord[] {
    const vis = visibleWorldRect(v)
    // Labels sit above artboards: extend the query upwards by the label height.
    const q = { x: vis.x, y: vis.y, width: vis.width, height: vis.height + 24 / v.zoom }
    return this.topsInRect(q).filter((r) => !r.hidden && intersects(topAabb(r), q))
  }

  /** Union of all visible top-level bounds. */
  contentBounds(): Rect | null {
    return unionRects([...this.records.values()].filter((r) => !r.hidden).map((r) => topAabb(r)))
  }

  // ---------------------------------------------------------------------------
  // Gesture previews
  // ---------------------------------------------------------------------------

  setPreviewOffset(id: string, offset: Point | null): void {
    const rec = this.records.get(id)
    if (!rec) return
    rec.preview = offset
    rec.wrapper.style.willChange = offset ? 'transform' : ''
    applyTopWrapper(rec)
    if (!offset) {
      rec.measuredVersion = -1
      if (rec.where === 'live') this.dirtyMeasure.add(rec.id)
    }
  }

  /** Preview a top-level node's rotation (stand-in + live root); `setPreviewOffset(null)` and
   *  `reapplyStyles(id, ['rotate'])` restore it. */
  setPreviewRotation(id: string, deg: number): void {
    const rec = this.records.get(id)
    if (!rec) return
    const value = deg === 0 ? 'none' : `${deg}deg`
    rec.standin.style.rotate = value
    if (rec.scene) rec.scene.rootEl.style.rotate = value
  }

  /** Preview a top-level node's size during a resize (stand-in + live root), or restore it from styles. */
  setPreviewSize(id: string, size: { width: number; height: number } | null): void {
    const rec = this.records.get(id)
    if (!rec) return
    const el = rec.scene?.rootEl
    if (size) {
      rec.standin.style.width = `${size.width}px`
      rec.standin.style.height = `${size.height}px`
      if (el) {
        el.style.width = `${size.width}px`
        el.style.height = `${size.height}px`
      }
      return
    }
    applyTopWrapper(rec)
    if (rec.scene) this.reapplyStyles(id, ['width', 'height'])
  }

  /** Re-write `keys` on a node's element from the mirrored styles (drops gesture previews). */
  reapplyStyles(id: string, keys: readonly string[]): void {
    const top = this.records.has(id) ? id : this.nodeTop.get(id)
    const scene = top ? this.records.get(top)?.scene : null
    const sn = scene?.nodes.get(id)
    if (!scene || !sn) return
    const values: Record<string, StyleValue | undefined> = {}
    for (const k of keys) values[k] = sn.styles[k]
    scene.setStyles(id, values)
  }

  /** Mark a top-level as being previewed by a non-move gesture (skips measurement). */
  setPreviewing(id: string, on: boolean): void {
    const rec = this.records.get(id)
    if (!rec) return
    if (on) rec.preview ??= { x: 0, y: 0 }
    else {
      rec.preview = null
      rec.measuredVersion = -1
      if (rec.where === 'live') this.dirtyMeasure.add(rec.id)
    }
  }

  stats(): {
    artboards: number
    mountedArtboards: number
    mountedNodes: number
    retainedNodes: number
    thumbnails: number
  } {
    let mountedArtboards = 0
    let mountedNodes = 0
    let retainedNodes = 0
    let thumbnails = 0
    for (const rec of this.records.values()) {
      if (rec.where === 'live') {
        mountedArtboards++
        mountedNodes += rec.scene?.size ?? 0
      } else if (rec.scene) retainedNodes += rec.scene.size
      if (rec.thumb) thumbnails++
    }
    return {
      artboards: this.records.size,
      mountedArtboards,
      mountedNodes,
      retainedNodes,
      thumbnails,
    }
  }
}

function distance(r: Rect, p: Point): number {
  const cx = r.x + r.width / 2
  const cy = r.y + r.height / 2
  return Math.hypot(cx - p.x, cy - p.y)
}

export type { TopRecord } from './topRecord.ts'
