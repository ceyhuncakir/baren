import type { GeometrySource, NodeFrame, Styles } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

export type { GeometrySource, NodeFrame } from '@baren/schema'

/** A point. World ("canvas") or screen coordinates depending on context. */
export interface Point {
  x: number
  y: number
}

/** Axis-aligned rectangle. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The visible region of the canvas.
 * `x`/`y` is the world coordinate shown at the container's top-left corner,
 * `zoom` is screen pixels per world pixel, `width`/`height` are the container
 * size in screen (CSS) pixels.
 */
export interface Viewport {
  x: number
  y: number
  zoom: number
  width: number
  height: number
}

export type Tool = 'select' | 'hand' | 'artboard' | 'rectangle' | 'text' | 'pen'

export const TOOLS: readonly Tool[] = ['select', 'hand', 'artboard', 'rectangle', 'text', 'pen']

/** One of the 8 resize handles. */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * An in-progress (not yet committed) move or resize, in world coordinates.
 * Emitted to the host (throttled to 30 Hz) so it can be broadcast to peers,
 * and accepted on `RemotePresence.transient` to render peers' gestures.
 */
export interface TransientChange {
  kind: 'move' | 'resize'
  nodes: { id: string; rect: Rect }[]
}

/**
 * Matches the server's presence JSON (plus an optional in-progress gesture).
 *
 * `kind: 'agent'` entries are MCP agents (Phase 4 contract §10.4): the overlay ignores `color`
 * and `cursor`, keeps the top-level artboards of `selection` that are on the current page (the
 * agent's working set) and draws the agent ring, glow, sweep and one "<badge> is working" badge
 * per artboard, in the agent accent (`OverlayTheme.agent*`).
 */
export interface RemotePresence {
  userId: string
  name: string
  color: string
  pageId: string | null
  /** World coordinates. */
  cursor: Point | null
  selection: string[]
  transient?: TransientChange | null
  /** Default `user`. */
  kind?: 'user' | 'agent'
  /** Agents: the display name shown in the badge (falls back to `name`). */
  badge?: string
}

export interface ContextMenuRequest {
  clientX: number
  clientY: number
  world: Point
  /** The node that was hit (and is now selected), or null for empty canvas. */
  targetId: string | null
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
}

/**
 * Which keyboard shortcuts the canvas handles while it has focus.
 * - `all`: tools, nudge, delete, duplicate, escape, select-all, undo/redo, zoom.
 * - `canvas`: like `all` but without undo/redo/zoom/select-all (the host routes
 *   those through its command registry: edit.undo, view.zoomIn, …).
 * - `none`: the canvas handles no keys (Space-to-pan and text editing still work).
 */
export type KeyboardMode = 'all' | 'canvas' | 'none'

export interface OverlayTheme {
  selection: string
  handleFill: string
  label: string
  labelActive: string
  snap: string
  marqueeFill: string
  /** Main components, instances and their content (`--color-overlay-component`). */
  component: string
  /** Agent badge fill and working-edge sweep (`--color-overlay-agent`). */
  agent: string
  /** 2 px ring around an artboard an agent is editing (`--color-agent-ring`). */
  agentRing: string
  /** Soft glow outside that ring (`--color-agent-glow`). */
  agentGlow: string
  fontFamily: string
}

/**
 * Resolves an asset id (blake3 hex) to a URL the renderer can load: image layers'
 * `assetId` and `url("baren-asset://<id>")` image fills (rewritten through it unless
 * it returns that same URL). `null` means missing: a neutral placeholder is drawn until
 * the host calls `reloadAssets`.
 */
export type AssetResolver = (assetId: string) => string | null | Promise<string | null>

/** Options for `CanvasController.dropTargetAt`. */
export interface DropTargetOptions {
  /** Deepest unlocked frame under the point instead of the top-level artboard. */
  deep?: boolean
  /** Reject a candidate parent (e.g. component cycles); the next shallower one is tried. */
  accept?: (parentId: string) => boolean
}

/** Where files dropped at a point land (see `CanvasController.dropTargetAt`). */
export interface DropTarget {
  /**
   * The frame under the point (the top-level artboard, or with `deep` the deepest unlocked
   * frame not inside an instance), else the page.
   */
  parentId: string
  /** World bounds (axis-aligned) of that frame; null on the page. */
  bounds: Rect | null
  /** The drop point in world coordinates. */
  world: Point
  /**
   * Geometry for a new node covering `rect` (world): page → left/top/width/height;
   * absolute artboard → position:absolute + offsets; flex artboard → in-flow size and
   * the flow `index` nearest to the rect's centre.
   */
  place(rect: Rect): { styles: Styles; index?: number }
}

export interface CanvasOptions {
  container: HTMLElement
  doc: LoroDoc
  pageId: string
  readOnly?: boolean
  /** Initial tool. Default `select`. */
  tool?: Tool
  /** Initial viewport; `'fit'` (default) zooms to fit the page content. */
  viewport?: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>> | 'fit'
  resolveAsset?: AssetResolver
  keyboard?: KeyboardMode
  /**
   * Create a Loro UndoManager for this doc (default true). Commits whose origin
   * starts with one of `undoExcludeOriginPrefixes` are not undoable.
   */
  undo?: boolean
  undoExcludeOriginPrefixes?: string[]
  theme?: Partial<OverlayTheme>
  /** Throttle for `onViewportChange` during gestures (ms). The final value is always emitted. Default 100. */
  viewportChangeThrottleMs?: number

  onSelectionChange?: (ids: string[]) => void
  onHoverChange?: (id: string | null) => void
  onViewportChange?: (viewport: Viewport) => void
  onToolChange?: (tool: Tool) => void
  /** Local in-progress move/resize, throttled to 30 Hz; `null` when the gesture ends. */
  onTransientChange?: (change: TransientChange | null) => void
  /** Local pointer position in world coordinates (throttled to 30 Hz); null when it leaves the canvas. */
  onCursorMove?: (world: Point | null) => void
  onContextMenu?: (request: ContextMenuRequest) => void
  onHistoryChange?: (state: HistoryState) => void
  /** Text node currently being edited in place (null when editing stops). */
  onTextEditChange?: (id: string | null) => void
  /** Vector being edited in place (null when editing stops). */
  onVectorEditChange?: (id: string | null) => void
}

export interface CanvasStats {
  artboards: number
  mountedArtboards: number
  mountedNodes: number
  retainedNodes: number
  thumbnails: number
  lod: boolean
  pendingWork: number
}

export interface CanvasController {
  readonly doc: LoroDoc
  getPageId(): string
  setPage(pageId: string): void

  getTool(): Tool
  setTool(tool: Tool): void

  getSelection(): string[]
  select(ids: readonly string[]): void
  selectAll(): void
  /** Hover highlight from outside the canvas (e.g. a layer row); fires `onHoverChange`. */
  setHover(id: string | null): void
  /**
   * World bounds of a real or virtual node, when known (measured or declared). For rotated
   * nodes this is the axis-aligned bounding box of the rotated shape.
   */
  getNodeBounds(id: string): Rect | null
  /**
   * World frame (unrotated box + accumulated rotation, contract 2.3) of a real or virtual node
   * on this page; measures synchronously when needed (commands only, never per frame).
   */
  getNodeFrame(id: string): NodeFrame | null
  /** GeometrySource backed by `getNodeFrame` (falls back to declared styles). */
  geometry(): GeometrySource
  /** Union of the selection's world bounds. */
  getSelectionBounds(): Rect | null

  getViewport(): Viewport
  setViewport(
    viewport: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>,
    options?: { animate?: boolean },
  ): void
  /** Zoom to `scale` keeping `anchor` (screen point, default centre) fixed. */
  zoomTo(scale: number, anchor?: Point, options?: { animate?: boolean }): void
  zoomIn(): void
  zoomOut(): void
  zoomToFit(options?: { animate?: boolean }): void
  zoomToSelection(options?: { animate?: boolean }): void
  screenToCanvas(point: Point): Point
  canvasToScreen(point: Point): Point

  setRemotePresence(list: readonly RemotePresence[]): void

  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean

  deleteSelection(): void
  duplicateSelection(): void
  /** Move the selection by (dx, dy) world pixels in one undo step. */
  nudge(dx: number, dy: number): void

  /** Start editing a text node in place (real or virtual id). */
  editText(id: string): void
  /** Start editing a vector's points in place. */
  editVector(id: string): void
  /** The vector being edited in place, if any. */
  getEditingVector(): string | null
  /** Stop text and vector editing. */
  stopEditing(): void

  setReadOnly(readOnly: boolean): void
  isReadOnly(): boolean

  /**
   * The bytes of these assets became available (or changed): re-resolve them and
   * re-render image layers, image fills, stand-ins and thumbnails that use them.
   */
  reloadAssets(ids: readonly string[]): void
  /**
   * Drop target under a client point (files, images or components dragged over the canvas);
   * highlights that frame until called with `null`.
   */
  dropTargetAt(
    client: { clientX: number; clientY: number } | null,
    options?: DropTargetOptions,
  ): DropTarget | null

  /** Focus the canvas so it receives keyboard shortcuts. */
  focus(): void
  getStats(): CanvasStats
  destroy(): void
}
