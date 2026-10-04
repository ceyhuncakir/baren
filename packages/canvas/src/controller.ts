import type { LoroDoc } from 'loro-crdt'
import {
  DEFAULT_PAGE_BACKGROUND,
  createComponentResolver,
  docGeometry,
  findMainComponent,
  fitGroups,
  getNode,
  getTokens,
  readRotation,
  subscribeNodes,
  transact,
  type ComponentResolver,
  type GeometrySource,
  type NodeChangeBatch,
  type NodeFrame,
  type Styles,
} from '@baren/schema'
import { History } from './doc/history.ts'
import { ORIGIN } from './doc/ops.ts'
import { nodeExists } from './doc/read.ts'
import {
  duplicate,
  editableSelection,
  nudgeNodes,
  remove,
  runKeyCommand,
} from './interaction/commands.ts'
import type { GestureOverlay } from './interaction/host.ts'
import { PointerInput, type InputHost } from './interaction/input.ts'
import type { KeyCommand } from './interaction/keyboard.ts'
import { DropTargetFinder } from './interaction/dropTarget.ts'
import { PenTool } from './interaction/pen.ts'
import { textIO, type CaretPlacement, type TextIO } from './interaction/textEdit.ts'
import { TextEditing } from './interaction/textEditing.ts'
import { VectorEditor } from './interaction/vectorEdit.ts'
import { pathFromTop } from './math/hit.ts'
import { unionRects } from './math/rect.ts'
import { sameSelection } from './math/selection.ts'
import {
  clampZoom,
  fitRect,
  nextZoomStep,
  screenToWorld,
  worldToScreen,
  worldTransform,
  zoomAt,
} from './math/viewport.ts'
import {
  flowDropIndex,
  flowSiblings,
  geometryStyles,
  insertTargetFor,
} from './interaction/gestures.ts'
import {
  AGENT_ORIGIN_PREFIX,
  INCOMING_MAX,
  INCOMING_WAIT_MS,
  incomingPhase,
  prefersReducedMotion,
  type IncomingOverlay,
} from './overlay/incoming.ts'
import { buildOverlayModel, selectionRects } from './overlay/model.ts'
import { layoutSize } from './render/measure.ts'
import { isVirtualRef } from './render/scene.ts'
import { Overlay } from './overlay/overlay.ts'
import { ensureBaseCss } from './render/baseCss.ts'
import { AssetUrlCache } from './render/assets.ts'
import { SvgCache } from './render/sanitizeSvg.ts'
import type { RenderContext } from './render/scene.ts'
import { SceneManager } from './render/sceneManager.ts'
import type {
  CanvasController,
  CanvasOptions,
  CanvasStats,
  ContextMenuRequest,
  DropTarget,
  DropTargetOptions,
  KeyboardMode,
  Point,
  Rect,
  RemotePresence,
  Tool,
  TransientChange,
  Viewport,
} from './types.ts'
import { throttle, type Throttled } from './util/throttle.ts'
import { Camera } from './viewport/camera.ts'

const FIT_PADDING = 48
/** Per-frame time budget for loading/attaching artboard DOM while idle. */
const MOUNT_BUDGET_MS = 8
/** Props that do not change what the canvas shows: an agent setting them gets no flash. */
const QUIET_PROPS = new Set(['name', 'locked'])
const REMOTE_HZ = 30

/** Create a canvas inside `options.container`. */
export function createCanvas(options: CanvasOptions): CanvasController {
  return new Canvas(options)
}

/**
 * The canvas: owns the DOM layers (world, measuring host, overlay), the
 * frame loop (write → read → draw, at most one layout per frame) and the
 * selection/tool/page state, and wires the scene manager, input routing,
 * text editing, camera and undo history together.
 */
class Canvas implements CanvasController, InputHost {
  readonly doc: LoroDoc
  readonly history: History | null
  readonly gestureOverlay: GestureOverlay = {
    marquee: null,
    guides: [],
    insertion: null,
    draft: null,
    draftLabel: null,
    drop: null,
    angle: null,
    pen: null,
  }
  readonly root: HTMLDivElement
  readonly world: HTMLDivElement
  readonly keyboard: KeyboardMode
  readonly text: TextEditing
  /** One component resolver per canvas: instances render through it. */
  readonly resolver: ComponentResolver
  readonly pen: PenTool
  readonly vectorEdit: VectorEditor
  scenes: SceneManager

  private readonly opts: CanvasOptions
  private readonly measureHost: HTMLDivElement
  private readonly overlay: Overlay
  private readonly renderCtx: RenderContext
  private readonly camera: Camera
  private readonly input: PointerInput

  private pageId: string
  private tool: Tool
  private readOnly: boolean
  private overlayDirty = true
  private rafId = 0
  private selection: string[] = []
  private hoverId: string | null = null
  private cursor = ''
  private wasGesturing = false
  private pendingBatches: NodeChangeBatch[] = []
  /** The next local batch comes from undo/redo (see flushBatches). */
  private afterHistory = false
  private remotes: RemotePresence[] = []
  /**
   * Layers an agent just added (staged in: hidden, then revealed) or edited (only flashed),
   * oldest first (overlay/incoming.ts).
   */
  private readonly incoming = new Map<
    string,
    { addedAt: number; startAt: number | null; revealed: boolean }
  >()
  private incomingOverlay: IncomingOverlay[] = []
  private rootRect: DOMRect
  private dpr: number
  private lastSceneVersion = -1
  private destroyed = false
  private readonly pageViewports = new Map<string, Viewport>()
  /** Frame highlighted while files or components are dragged over the canvas. */
  private dropIndicator: Rect | NodeFrame | null = null
  private readonly cleanups: (() => void)[] = []
  private readonly emitViewport: Throttled<Viewport>
  private readonly emitTransientT: Throttled<TransientChange | null>
  private readonly emitCursorT: Throttled<Point | null>
  private readonly io: TextIO
  /** Nodes inside groups changed locally: refit their groups after the next measurement. */
  private readonly pendingFits = new Set<string>()
  /** Last frame's main-thread time in ms (bench instrumentation). */
  lastFrameMs = 0

  constructor(options: CanvasOptions) {
    this.opts = options
    this.doc = options.doc
    this.pageId = options.pageId
    this.tool = options.tool ?? 'select'
    this.readOnly = options.readOnly === true
    this.keyboard = options.keyboard ?? 'all'
    this.dpr = window.devicePixelRatio || 1
    const container = options.container

    ensureBaseCss(container.ownerDocument)
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'

    this.root = document.createElement('div')
    this.root.className = 'ic-root'
    this.root.tabIndex = 0
    this.root.setAttribute('role', 'application')
    this.root.setAttribute('aria-label', 'Design canvas')
    this.world = document.createElement('div')
    this.world.className = 'ic-world'
    this.measureHost = document.createElement('div')
    this.measureHost.className = 'ic-measure'
    this.measureHost.setAttribute('aria-hidden', 'true')
    this.root.append(this.world, this.measureHost)
    container.appendChild(this.root)
    this.overlay = new Overlay(this.root, options.theme, () => this.invalidate())

    this.rootRect = this.root.getBoundingClientRect()
    this.emitViewport = throttle(
      (v: Viewport) => this.opts.onViewportChange?.(v),
      options.viewportChangeThrottleMs ?? 100,
    )
    this.emitTransientT = throttle(
      (t: TransientChange | null) => this.opts.onTransientChange?.(t),
      1000 / REMOTE_HZ,
    )
    this.emitCursorT = throttle((p: Point | null) => this.opts.onCursorMove?.(p), 1000 / REMOTE_HZ)
    this.camera = new Camera(
      { x: 0, y: 0, zoom: 1, width: this.rootRect.width, height: this.rootRect.height },
      (v) => {
        this.emitViewport.call(v)
        this.requestFrame()
      },
    )
    this.overlay.resize(this.rootRect.width, this.rootRect.height, this.dpr)

    const assets = new AssetUrlCache(options.resolveAsset, (ids) => {
      if (this.destroyed) return
      this.scenes.queueAssetChange(ids, false)
      this.requestFrame()
    })
    this.renderCtx = {
      svgCache: new SvgCache(),
      assets,
      rewrite: (value) => assets.rewriteCss(value),
      loadingImages: new Set(),
      imageSettled: (id) => {
        if (!this.destroyed) this.scenes.imageSettled(id)
      },
    }
    this.resolver = createComponentResolver(this.doc)
    this.io = textIO(this.doc, () => this.resolver)
    this.history =
      options.undo === false
        ? null
        : new History(this.doc, {
            excludeOriginPrefixes: options.undoExcludeOriginPrefixes ?? [
              'remote',
              'sync',
              'bench',
              'derived',
            ],
            getSelection: () => [...this.selection],
            restoreSelection: (ids) => this.setSelection(ids.filter((id) => this.refAlive(id))),
            ...(options.onHistoryChange ? { onChange: options.onHistoryChange } : {}),
          })
    this.text = new TextEditing({
      doc: this.doc,
      history: this.history,
      io: this.io,
      exists: (id) => this.refAlive(id),
      scenes: () => this.scenes,
      isReadOnly: () => this.readOnly,
      setSelection: (ids) => this.setSelection(ids),
      undo: () => this.undo(),
      redo: () => this.redo(),
      focus: () => this.focus(),
      invalidate: () => this.invalidate(),
      onChange: (id) => this.opts.onTextEditChange?.(id),
    })
    this.pen = new PenTool(this)
    this.vectorEdit = new VectorEditor(this, (id) => this.opts.onVectorEditChange?.(id))
    this.scenes = this.createScenes(this.pageId)
    this.scenes.load()
    this.applyAllTokens()
    this.applyPageBackground()

    const initial = options.viewport ?? 'fit'
    if (initial === 'fit') this.camera.set(this.fitViewport(), false)
    else
      this.camera.set(
        { ...this.camera.viewport, ...initial, zoom: clampZoom(initial.zoom ?? 1) },
        false,
      )
    this.camera.markRasterised()

    this.input = new PointerInput(this)
    this.listen()
    this.cleanups.push(
      subscribeNodes(this.doc, (batch) => {
        this.pendingBatches.push(batch)
        this.requestFrame()
      }),
    )
    this.requestFrame()
  }

  private createScenes(pageId: string): SceneManager {
    return new SceneManager({
      doc: this.doc,
      pageId,
      world: this.world,
      measureHost: this.measureHost,
      ctx: this.renderCtx,
      isEditing: (id) => this.text.isEditing(id),
      devicePixelRatio: () => this.dpr,
      requestFrame: () => this.requestFrame(),
      resolver: this.resolver,
    })
  }

  /** Whether a real or virtual node exists (and, for virtual ids, still resolves). */
  refAlive(id: string): boolean {
    if (!isVirtualRef(id)) return nodeExists(this.doc, id)
    return this.resolver.resolveNode(id) !== undefined
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  private listen(): void {
    const root = this.root
    this.cleanups.push(
      this.input.attach((type, fn, options) => {
        root.addEventListener(type, fn, options)
        this.cleanups.push(() => root.removeEventListener(type, fn, options))
      }),
    )

    const ro = new ResizeObserver(() => this.onResize())
    ro.observe(root)
    this.cleanups.push(() => ro.disconnect())

    const watchDpr = (): void => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      const fn = (): void => {
        this.dpr = window.devicePixelRatio || 1
        const v = this.camera.viewport
        this.overlay.resize(v.width, v.height, this.dpr)
        this.invalidate()
        watchDpr()
      }
      mq.addEventListener('change', fn, { once: true })
      this.cleanups.push(() => mq.removeEventListener('change', fn))
    }
    watchDpr()

    const fonts = document.fonts
    const onFonts = (): void => {
      if (this.destroyed) return
      this.overlay.resetTextCache()
      this.scenes.invalidateAll()
      this.invalidate()
    }
    void fonts.ready.then(onFonts)
    fonts.addEventListener('loadingdone', onFonts)
    this.cleanups.push(() => fonts.removeEventListener('loadingdone', onFonts))
  }

  private onResize(): void {
    const r = this.root.getBoundingClientRect()
    this.rootRect = r
    if (!this.camera.resize(r.width, r.height)) return
    this.overlay.resize(r.width, r.height, this.dpr)
    this.invalidate()
  }

  // ---------------------------------------------------------------------------
  // Frame loop: write → read → draw
  // ---------------------------------------------------------------------------

  requestFrame(): void {
    if (this.rafId === 0 && !this.destroyed) this.rafId = requestAnimationFrame(this.frame)
  }

  invalidate(): void {
    this.overlayDirty = true
    this.requestFrame()
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0
    if (this.destroyed) return
    const t0 = performance.now()
    const camera = this.camera

    // Write phase.
    const applied = this.pendingBatches.length > 0
    if (applied) this.flushBatches()
    if (camera.animating) camera.step(now)
    if (camera.dirty) {
      this.world.style.transform = worldTransform(camera.viewport)
      camera.dirty = false
      this.overlayDirty = true
    }
    if (this.input.activeGesture) {
      this.input.write()
      this.overlayDirty = true
    }
    const viewportGesture = camera.isGesturing(t0, this.input.viewportGesture)
    if (this.wasGesturing && !viewportGesture) this.emitViewport.flush()
    this.wasGesturing = viewportGesture
    camera.updateRaster(this.world, viewportGesture)
    const busy = viewportGesture || this.input.busy
    const more = this.scenes.update(camera.viewport, {
      gesturing: busy,
      budgetMs: busy ? 0 : MOUNT_BUDGET_MS,
      startedAt: t0,
      deferThumbnails: applied,
    })
    if (this.text.hasPending) this.text.tick()

    // Read phase (one layout at most).
    if (this.scenes.hasDirtyMeasure) {
      this.rootRect = this.root.getBoundingClientRect()
      if (this.scenes.measure(camera.viewport, this.rootRect)) this.overlayDirty = true
    }
    if (this.pendingFits.size > 0 && !this.input.busy) this.runPendingFits()

    // Draw.
    const staging = this.tickIncoming(t0)
    if (this.scenes.version !== this.lastSceneVersion) {
      this.lastSceneVersion = this.scenes.version
      this.overlayDirty = true
    }
    if (this.overlayDirty) {
      this.overlayDirty = false
      this.drawOverlay()
    }
    this.lastFrameMs = performance.now() - t0
    if (
      more ||
      viewportGesture ||
      camera.animating ||
      camera.rerasterPending ||
      this.text.hasPending ||
      this.input.finishing ||
      staging
    )
      this.requestFrame()
  }

  /**
   * Layers an agent changed in this batch. The top-most ones it created start hidden, until
   * their placeholder has shown where they land; the top-most ones it edited (styles, text,
   * moves, vectors, overrides, visible props) only get the placeholder flash. Local agent writes
   * carry the `agent:` origin; remote ones carry none, so a remote change counts when its
   * artboard is in an agent's working set.
   */
  private collectIncoming(batch: NodeChangeBatch): void {
    if (batch.changes.length === 0) return
    const local = batch.by === 'local' && (batch.origin ?? '').startsWith(AGENT_ORIGIN_PREFIX)
    const working = local || batch.by !== 'import' ? null : this.agentWorkingTops()
    if (!local && (working === null || working.size === 0)) return
    const created = new Set<string>()
    const edited = new Set<string>()
    for (const c of batch.changes) {
      if (c.kind === 'created') created.add(c.id)
      else if (c.kind === 'deleted') continue
      else if (c.kind !== 'props' || c.keys.some((k) => !QUIET_PROPS.has(k))) edited.add(c.id)
    }
    const onPage = (id: string) => {
      const top = this.scenes.topLevelOf(id)
      return top !== null && (working === null || working.has(top))
    }
    const hide = !prefersReducedMotion()
    const now = performance.now()
    for (const c of batch.changes) {
      if (c.kind !== 'created' || (c.parentId !== null && created.has(c.parentId))) continue
      if (!onPage(c.id)) continue
      this.incoming.set(c.id, { addedAt: now, startAt: null, revealed: false })
      if (hide) this.scenes.setIncoming(c.id, 'hidden')
    }
    for (const id of edited) {
      if (created.has(id) || !onPage(id) || this.hasEditedAncestor(id, edited)) continue
      // A layer still being staged in keeps its own timeline; an edited one flashes again.
      if (this.incoming.get(id)?.revealed === false) continue
      this.incoming.delete(id)
      this.incoming.set(id, { addedAt: now, startAt: null, revealed: true })
    }
    for (const id of this.incoming.keys()) {
      if (this.incoming.size <= INCOMING_MAX) break
      this.scenes.setIncoming(id, null)
      this.incoming.delete(id)
    }
    this.requestFrame()
  }

  /** Whether an ancestor of `id` is in `ids` (its flash already covers `id`). */
  private hasEditedAncestor(id: string, ids: ReadonlySet<string>): boolean {
    let p = this.scenes.parentOf(id)
    for (let n = 0; p !== null && n < 64; n++) {
      if (ids.has(p)) return true
      p = this.scenes.parentOf(p)
    }
    return false
  }

  /** Artboards any agent is working on (agent presence keeps its working set as selection). */
  private agentWorkingTops(): Set<string> {
    const out = new Set<string>()
    for (const r of this.remotes) if (r.kind === 'agent') for (const id of r.selection) out.add(id)
    return out
  }

  /**
   * Advances the staged additions: each starts once measured, is revealed after its hold and
   * leaves after the fade. True while any is still on its way (keep drawing frames).
   */
  private tickIncoming(now: number): boolean {
    if (this.incoming.size === 0) {
      if (this.incomingOverlay.length > 0) {
        this.incomingOverlay = []
        this.overlayDirty = true
      }
      return false
    }
    const reduced = prefersReducedMotion()
    const out: IncomingOverlay[] = []
    for (const [id, e] of this.incoming) {
      const bounds = this.scenes.boundsOf(id)
      if (e.startAt === null) {
        if (bounds && this.scenes.isMeasured(id)) e.startAt = now
        else {
          // Off screen, deleted or never measured: just show it.
          if (now - e.addedAt > INCOMING_WAIT_MS || this.scenes.topLevelOf(id) === null) {
            this.scenes.setIncoming(id, null)
            this.incoming.delete(id)
          }
          continue
        }
      }
      const phase = incomingPhase(now - e.startAt, reduced)
      if (!phase.hidden && !e.revealed) {
        e.revealed = true
        this.scenes.setIncoming(id, reduced ? null : 'reveal')
      }
      if (phase.done || !bounds) {
        this.scenes.setIncoming(id, null)
        this.incoming.delete(id)
        continue
      }
      out.push({ bounds, alpha: phase.alpha, shimmer: phase.shimmer })
    }
    this.incomingOverlay = out
    this.overlayDirty = true
    return this.incoming.size > 0
  }

  private flushBatches(): void {
    const batches = this.pendingBatches
    this.pendingBatches = []
    let pageChanged = false
    let restoredRoots: string[] = []
    // Instances: what each batch changed for the resolver, then drop its stale caches.
    const components = new Set<string>()
    const instances = new Set<string>()
    // Style-only main edits patch the changed paths of each instance (`stylePaths` must be
    // read before `apply`); any batch that needs more makes the whole flush take the full path.
    let stylePaths: Map<string, Set<string>> | null = new Map()
    for (const batch of batches) {
      const a = this.resolver.affectedBy(batch)
      for (const k of a.components) components.add(k)
      for (const k of a.instances) instances.add(k)
      if (stylePaths && a.components.size > 0) {
        const plan = this.resolver.stylePaths(batch)
        if (plan) {
          for (const [key, paths] of plan) {
            let set = stylePaths.get(key)
            if (!set) stylePaths.set(key, (set = new Set()))
            for (const p of paths) set.add(p)
          }
        } else stylePaths = null
      }
      this.resolver.apply(batch)
    }
    const editingVirtual = this.text.id !== null && isVirtualRef(this.text.id) ? this.text.id : null
    for (const batch of batches) {
      if (this.afterHistory && batch.by === 'local') {
        // Loro re-creates nodes restored by undo/redo under new ids: select those roots.
        this.afterHistory = false
        const created = new Set(batch.changes.filter((c) => c.kind === 'created').map((c) => c.id))
        restoredRoots = batch.changes
          .filter((c): c is Extract<typeof c, { kind: 'created' }> => c.kind === 'created')
          .filter((c) => c.parentId === null || !created.has(c.parentId))
          .map((c) => c.id)
      }
      this.scenes.apply(batch.changes)
      this.collectIncoming(batch)
      for (const c of batch.changes) {
        if (c.id === this.pageId && c.kind === 'props') pageChanged = true
        if (c.kind === 'text' && batch.origin !== ORIGIN.text && this.text.isEditing(c.id)) {
          this.text.applyExternal(c.id, this.io.read(c.id))
        }
        if (
          editingVirtual !== null &&
          c.kind === 'overrides' &&
          batch.origin !== ORIGIN.text &&
          editingVirtual.startsWith(`${c.id}/`)
        ) {
          this.text.applyExternal(editingVirtual, this.io.read(editingVirtual))
        }
      }
      if (batch.tokens.length > 0) this.applyTokens(batch.tokens)
      if (batch.by === 'local' && !(batch.origin ?? '').startsWith('derived'))
        this.collectFits(batch)
    }
    if (components.size > 0 || instances.size > 0)
      this.scenes.refreshInstances({ components, instances, stylePaths })
    if (pageChanged) this.applyPageBackground()
    this.text.validate()
    this.vectorEdit.validate()
    const alive = this.selection.filter(
      (id) => this.refAlive(id) && this.scenes.topLevelOf(id) !== null,
    )
    if (alive.length === 0 && restoredRoots.length > 0) {
      this.setSelection(restoredRoots.filter((id) => this.scenes.topLevelOf(id) !== null))
    } else if (alive.length !== this.selection.length) this.setSelection(alive)
    if (this.hoverId && !this.refAlive(this.hoverId)) this.setHover(null)
    this.history?.notify()
    this.overlayDirty = true
  }

  /**
   * Local changes to nodes inside groups whose size is only known after layout (text, fonts,
   * images) refit their groups after the next measurement (contract 2.5.1).
   */
  private collectFits(batch: NodeChangeBatch): void {
    const scenes = this.scenes
    // Siblings share ancestors: look each one's type up once per batch (a node outside the
    // loaded scenes is read from the document with all its children, so N new children of
    // one frame made this O(N²) — seconds for a large paste or agent write).
    const types = new Map<string, ReturnType<typeof scenes.typeOf>>()
    const typeOf = (id: string): ReturnType<typeof scenes.typeOf> => {
      let t = types.get(id)
      if (t === undefined) {
        t = scenes.typeOf(id)
        types.set(id, t)
      }
      return t
    }
    for (const c of batch.changes) {
      if (c.kind === 'deleted' || c.kind === 'moved' || c.kind === 'overrides') continue
      let cur = scenes.parentOf(c.id)
      let guard = 0
      while (cur !== null && cur !== this.pageId && guard++ < 1000) {
        if (typeOf(cur) === 'group') {
          this.pendingFits.add(c.id)
          break
        }
        cur = scenes.parentOf(cur)
      }
    }
  }

  private runPendingFits(): void {
    const ids = [...this.pendingFits].filter(
      (id) => !this.scenes.isLoaded(id) || this.scenes.isMeasured(id),
    )
    if (ids.length === 0) return
    for (const id of ids) this.pendingFits.delete(id)
    const live = ids.filter((id) => nodeExists(this.doc, id))
    if (live.length === 0 || this.readOnly) return
    const geo = this.geometry()
    transact(this.doc, () => fitGroups(this.doc, live, geo), { origin: ORIGIN.groupFit })
  }

  private applyAllTokens(): void {
    const tokens = getTokens(this.doc)
    for (const name in tokens) {
      const t = tokens[name]
      if (t) this.root.style.setProperty(name, String(t.value))
    }
  }

  private applyTokens(names: readonly string[]): void {
    const tokens = getTokens(this.doc)
    for (const name of names) {
      const t = tokens[name]
      if (t) this.root.style.setProperty(name, String(t.value))
      else this.root.style.removeProperty(name)
    }
    this.scenes.invalidateAll()
  }

  private applyPageBackground(): void {
    const background = getNode(this.doc, this.pageId)?.background
    // The default ground is app chrome: it follows the host's canvas colour (the app theme,
    // `--color-canvas-ground`). Any other page background is document data and is drawn as is.
    this.root.style.backgroundColor =
      background === undefined || background.toUpperCase() === DEFAULT_PAGE_BACKGROUND
        ? `var(--color-canvas-ground, ${DEFAULT_PAGE_BACKGROUND})`
        : background
    this.overlay.groundChanged()
  }

  private drawOverlay(): void {
    this.overlay.draw(
      buildOverlayModel({
        viewport: this.camera.viewport,
        scenes: this.scenes,
        pageId: this.pageId,
        selection: this.selection,
        hoverId: this.hoverId,
        editingId: this.text.id,
        gesture: this.input.activeGesture,
        gestureOverlay: this.gestureOverlay,
        remotes: this.remotes,
        showHandles: this.input.showHandles(),
        drop: this.dropIndicator,
        vector: this.vectorEdit.overlay(),
        mainOutline: this.mainOfSelection(),
        incoming: this.incomingOverlay,
      }),
    )
  }

  private mainCache: { key: string; mainId: string | null } | null = null

  /** The main component of a single selected instance, when it is on this page. */
  private mainOfSelection(): NodeFrame | null {
    if (this.selection.length !== 1) return null
    const id = this.selection[0] as string
    const info = this.scenes.info(id)
    if (info?.type !== 'instance' || info.componentKey === undefined) return null
    const cacheKey = `${id}|${info.componentKey}|${this.doc.opCount()}`
    let mainId: string | null
    if (this.mainCache?.key === cacheKey) mainId = this.mainCache.mainId
    else {
      const hint = isVirtualRef(id) ? undefined : getNode(this.doc, id)?.mainId
      const found = findMainComponent(this.doc, info.componentKey, hint)
      mainId = found && !found.deleted ? found.mainId : null
      this.mainCache = { key: cacheKey, mainId }
    }
    if (mainId === null || this.scenes.topLevelOf(mainId) === null) return null
    return this.scenes.frameOf(mainId)
  }

  // ---------------------------------------------------------------------------
  // Host API (gestures and input routing)
  // ---------------------------------------------------------------------------

  viewport(): Viewport {
    return this.camera.viewport
  }

  setViewport(v: Viewport): void
  setViewport(v: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>, options?: { animate?: boolean }): void
  setViewport(v: Partial<Viewport>, options?: { animate?: boolean }): void {
    const cur = this.camera.viewport
    const target: Viewport = {
      ...cur,
      ...(v.x !== undefined ? { x: v.x } : {}),
      ...(v.y !== undefined ? { y: v.y } : {}),
      ...(v.zoom !== undefined ? { zoom: clampZoom(v.zoom) } : {}),
    }
    this.moveCamera(target, options?.animate === true)
  }

  private moveCamera(target: Viewport, animate: boolean): void {
    if (animate) this.camera.animateTo(target)
    else this.camera.set(target, true)
    this.requestFrame()
  }

  getSelection(): string[] {
    return [...this.selection]
  }

  setSelection(ids: readonly string[]): void {
    const unique = [...new Set(ids)]
    if (sameSelection(unique, this.selection)) return
    this.selection = unique
    this.invalidate()
    this.opts.onSelectionChange?.([...unique])
  }

  setHover(id: string | null): void {
    if (id === this.hoverId) return
    this.hoverId = id
    this.invalidate()
    this.opts.onHoverChange?.(id)
  }

  local(e: { clientX: number; clientY: number }): Point {
    return { x: e.clientX - this.rootRect.left, y: e.clientY - this.rootRect.top }
  }

  toWorld(p: Point): Point {
    return screenToWorld(this.camera.viewport, p)
  }

  refreshRootRect(): void {
    this.rootRect = this.root.getBoundingClientRect()
  }

  labelAt(p: Point): string | null {
    return this.overlay.labelAt(p)
  }

  setCursor(cursor: string): void {
    if (cursor === this.cursor) return
    this.cursor = cursor
    this.root.style.cursor = cursor
  }

  emitTransient(change: TransientChange | null): void {
    if (change === null) {
      this.emitTransientT.cancel()
      this.opts.onTransientChange?.(null)
      return
    }
    this.emitTransientT.call(change)
  }

  emitCursor(world: Point | null): void {
    this.emitCursorT.call(world)
  }

  contextMenu(request: ContextMenuRequest): void {
    this.opts.onContextMenu?.(request)
  }

  flushPending(): void {
    if (this.pendingBatches.length > 0) this.flushBatches()
  }

  runCommand(cmd: KeyCommand): boolean {
    return runKeyCommand(cmd, this)
  }

  editTextWhenReady(id: string, caret: CaretPlacement, created: boolean): void {
    this.text.whenReady(id, caret, created)
    this.requestFrame()
  }

  // ---------------------------------------------------------------------------
  // CanvasController
  // ---------------------------------------------------------------------------

  getPageId(): string {
    return this.pageId
  }

  setPage(pageId: string): void {
    if (pageId === this.pageId) return
    this.text.stop()
    this.vectorEdit.stop()
    this.pen.cancel()
    this.input.cancel()
    this.pageViewports.set(this.pageId, this.camera.viewport)
    this.scenes.clear()
    this.pageId = pageId
    this.scenes = this.createScenes(pageId)
    this.scenes.load()
    this.applyPageBackground()
    this.setSelection([])
    this.setHover(null)
    const saved = this.pageViewports.get(pageId)
    this.camera.set(saved ?? this.fitViewport(), false)
    this.lastSceneVersion = -1
    this.requestFrame()
  }

  getTool(): Tool {
    return this.tool
  }

  setTool(tool: Tool): void {
    if (tool === this.tool) return
    this.text.stop()
    this.vectorEdit.stop()
    if (tool !== 'pen' && this.pen.active) this.pen.finish(false)
    if (tool === this.tool) return
    this.tool = tool
    if (tool !== 'select') this.setHover(null)
    this.input.updateCursor()
    this.invalidate()
    this.opts.onToolChange?.(tool)
  }

  select(ids: readonly string[]): void {
    if (this.vectorEdit.active && !(ids.length === 1 && ids[0] === this.vectorEdit.id))
      this.vectorEdit.stop()
    this.setSelection(ids.filter((id) => this.refAlive(id) && this.scenes.topLevelOf(id) !== null))
  }

  selectAll(): void {
    const first = this.selection[0]
    const parent = first !== undefined ? this.scenes.parentOf(first) : this.pageId
    if (parent === null) return
    const ids =
      parent === this.pageId
        ? [...this.scenes.topIds()]
        : [...(this.scenes.info(parent)?.children ?? [])]
    this.setSelection(
      ids.filter((id) => {
        const info = this.scenes.info(id)
        return info !== null && !info.locked && !info.hidden
      }),
    )
  }

  getNodeBounds(id: string): Rect | null {
    return this.scenes.boundsOf(id)
  }

  nodePathAt(world: Point): string[] | null {
    if (this.pendingBatches.length > 0) this.flushBatches()
    return this.scenes.hitTestWorld(world, false)
  }

  getNodeFrame(id: string): NodeFrame | null {
    // Apply committed changes to the DOM first (commands may run right after an edit).
    if (this.pendingBatches.length > 0) this.flushBatches()
    return this.frameOf(id)
  }

  /**
   * World frame of a real or virtual node: the current measurement, else the live element
   * (forced layout: commands only), else the top-level box or declared styles.
   */
  private frameOf(id: string): NodeFrame | null {
    const scenes = this.scenes
    if (scenes.records.has(id)) return scenes.frameOf(id)
    if (scenes.isMeasured(id)) {
      const f = scenes.frameOf(id)
      if (f) return f
    }
    const el = scenes.elementOf(id)
    if (el && el.isConnected && scenes.isLive(id)) return this.measureElement(id, el)
    if (scenes.topLevelOf(id) === null) return null
    return scenes.frameOf(id) ?? docGeometry(this.doc, this.resolver).frameOf(id)
  }

  private measureElement(id: string, el: Element): NodeFrame {
    this.refreshRootRect()
    const v = this.camera.viewport
    const r = el.getBoundingClientRect()
    const tl = screenToWorld(v, { x: r.left - this.rootRect.left, y: r.top - this.rootRect.top })
    const w = r.width / v.zoom
    const h = r.height / v.zoom
    let rotation = 0
    const scenes = this.scenes
    for (
      let cur: string | null = id;
      cur !== null && cur !== this.pageId;
      cur = scenes.parentOf(cur)
    ) {
      const info = scenes.info(cur)
      if (info) rotation += readRotation(info.styles)
    }
    rotation = ((((rotation + 180) % 360) + 360) % 360) - 180
    if (rotation === -180) rotation = 180
    if (Math.abs(rotation) < 1e-9) return { x: tl.x, y: tl.y, width: w, height: h, rotation: 0 }
    const styles = scenes.info(id)?.styles ?? {}
    const size = layoutSize(el, styles, { width: w, height: h }, rotation)
    const cx = tl.x + w / 2
    const cy = tl.y + h / 2
    return {
      x: cx - size.width / 2,
      y: cy - size.height / 2,
      width: size.width,
      height: size.height,
      rotation,
    }
  }

  geometry(): GeometrySource {
    return { frameOf: (id) => this.frameOf(id) }
  }

  editVector(id: string): void {
    this.text.stop()
    this.vectorEdit.start(id)
  }

  getEditingVector(): string | null {
    return this.vectorEdit.id
  }

  getSelectionBounds(): Rect | null {
    return unionRects(selectionRects(this.scenes, this.selection, this.input.activeGesture))
  }

  getViewport(): Viewport {
    return { ...this.camera.viewport }
  }

  zoomTo(scale: number, anchor?: Point, options?: { animate?: boolean }): void {
    const v = this.camera.viewport
    const a = anchor ?? { x: v.width / 2, y: v.height / 2 }
    this.moveCamera(zoomAt(v, scale, a), options?.animate !== false)
  }

  zoomIn(): void {
    this.zoomTo(nextZoomStep(this.camera.targetZoom, 1))
  }

  zoomOut(): void {
    this.zoomTo(nextZoomStep(this.camera.targetZoom, -1))
  }

  private fitViewport(): Viewport {
    const v = this.camera.viewport
    const content = this.scenes.contentBounds()
    if (!content) return { ...v, zoom: 1, x: -v.width / 2, y: -v.height / 2 }
    return fitRect(content, v.width, v.height, FIT_PADDING, 1)
  }

  zoomToFit(options?: { animate?: boolean }): void {
    this.moveCamera(this.fitViewport(), options?.animate !== false)
  }

  zoomToSelection(options?: { animate?: boolean }): void {
    let box = this.getSelectionBounds()
    if (!box) {
      // Nodes in never-rendered artboards have no measured bounds yet: frame their artboards.
      const tops = this.selection
        .map((id) => this.scenes.topLevelOf(id))
        .filter((t): t is string => t !== null)
      box = unionRects(
        tops.map((t) => this.scenes.boundsOf(t)).filter((r): r is Rect => r !== null),
      )
    }
    if (!box) return
    const v = this.camera.viewport
    this.moveCamera(fitRect(box, v.width, v.height, FIT_PADDING), options?.animate !== false)
  }

  screenToCanvas(point: Point): Point {
    return screenToWorld(this.camera.viewport, point)
  }

  canvasToScreen(point: Point): Point {
    return worldToScreen(this.camera.viewport, point)
  }

  setRemotePresence(list: readonly RemotePresence[]): void {
    this.remotes = [...list]
    this.invalidate()
  }

  undo(): boolean {
    if (!this.history || this.readOnly) return false
    this.afterHistory = true
    const ok = this.history.undo()
    if (!ok) this.afterHistory = false
    return ok
  }

  redo(): boolean {
    if (!this.history || this.readOnly) return false
    this.afterHistory = true
    const ok = this.history.redo()
    if (!ok) this.afterHistory = false
    return ok
  }

  canUndo(): boolean {
    return this.history?.canUndo() ?? false
  }

  canRedo(): boolean {
    return this.history?.canRedo() ?? false
  }

  deleteSelection(): void {
    if (this.readOnly) return
    const ids = editableSelection(this.scenes, this.selection)
    if (ids.length === 0) return
    this.vectorEdit.stop()
    remove(this.doc, ids, this.geometry())
    this.setSelection([])
  }

  duplicateSelection(): void {
    if (this.readOnly) return
    const ids = editableSelection(this.scenes, this.selection)
    if (ids.length === 0) return
    const created = duplicate(this.doc, this.scenes, this.pageId, ids, this.geometry())
    if (created.length > 0) this.setSelection(created)
  }

  nudge(dx: number, dy: number): void {
    if (this.readOnly) return
    nudgeNodes(this.doc, this.scenes, editableSelection(this.scenes, this.selection), dx, dy, {
      geo: this.geometry(),
      resolver: this.resolver,
    })
  }

  editText(id: string): void {
    this.vectorEdit.stop()
    this.text.edit(id)
    this.requestFrame()
  }

  stopEditing(): void {
    this.text.stop()
    this.vectorEdit.stop()
  }

  setReadOnly(readOnly: boolean): void {
    if (readOnly === this.readOnly) return
    this.readOnly = readOnly
    if (readOnly) {
      this.text.stop()
      this.vectorEdit.stop()
      this.pen.cancel()
      this.input.cancel()
      if (this.tool !== 'select' && this.tool !== 'hand') this.setTool('select')
    }
    this.invalidate()
  }

  isReadOnly(): boolean {
    return this.readOnly
  }

  focus(): void {
    if (document.activeElement !== this.root) this.root.focus({ preventScroll: true })
  }

  getStats(): CanvasStats {
    let measuring = 0
    for (const rec of this.scenes.records.values()) if (rec.where === 'measure') measuring++
    return {
      ...this.scenes.stats(),
      lod: this.scenes.isLod,
      pendingWork:
        measuring +
        this.pendingBatches.length +
        this.renderCtx.assets.pending +
        this.renderCtx.loadingImages.size,
    }
  }

  reloadAssets(ids: readonly string[]): void {
    if (ids.length === 0 || this.destroyed) return
    this.renderCtx.assets.invalidate(ids)
    this.scenes.queueAssetChange(ids, true)
    this.requestFrame()
  }

  dropTargetAt(
    client: { clientX: number; clientY: number } | null,
    options?: DropTargetOptions,
  ): DropTarget | null {
    const prev = this.dropIndicator
    if (!client) {
      this.dropIndicator = null
      if (prev) this.invalidate()
      return null
    }
    this.flushPending()
    const local = this.local(client)
    const world = this.toWorld(local)
    const finder = new DropTargetFinder(this.scenes, this.doc, {
      ...(options?.accept ? { accept: options.accept } : {}),
      topOnly: options?.deep !== true,
    })
    const found = this.readOnly ? null : finder.at(world)
    const parentId = found?.id ?? this.pageId
    const bounds = found?.bounds ?? null
    const indicator = found ? (found.frame.rotation !== 0 ? found.frame : found.bounds) : null
    const changed =
      (prev === null) !== (indicator === null) ||
      (prev !== null &&
        indicator !== null &&
        (prev.x !== indicator.x ||
          prev.y !== indicator.y ||
          prev.width !== indicator.width ||
          prev.height !== indicator.height))
    this.dropIndicator = indicator
    if (changed) this.invalidate()
    const path = found ? pathFromTop(found.id, (n) => this.scenes.parentOf(n), this.pageId) : null
    const target = found ? insertTargetFor(this, path) : null
    return {
      parentId,
      bounds,
      world,
      place: (rect): { styles: Styles; index?: number } => {
        const r = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
        if (!target || target.parentId === null) {
          return { styles: { left: r.x, top: r.y, width: r.width, height: r.height } }
        }
        const { styles } = geometryStyles(target, r)
        const out: Styles = {}
        for (const [k, v] of Object.entries(styles))
          out[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v
        if (target.flex) {
          const index = flowDropIndex(
            flowSiblings(this, target.parentId, new Set()),
            { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
            target.flex,
            target.parentRect,
          ).index
          return { styles: out, index }
        }
        return { styles: out }
      },
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.text.stop()
    this.vectorEdit.stop()
    this.pen.cancel()
    this.input.cancel()
    this.destroyed = true
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    for (const fn of this.cleanups.splice(0)) fn()
    this.emitViewport.cancel()
    this.emitTransientT.cancel()
    this.emitCursorT.cancel()
    this.history?.dispose()
    this.incoming.clear()
    this.scenes.clear()
    this.resolver.dispose()
    this.overlay.dispose()
    this.root.remove()
  }
}
