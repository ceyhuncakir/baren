import type { LoroDoc } from 'loro-crdt'
import type { ComponentResolver, GeometrySource, NodeFrame } from '@baren/schema'
import type { History } from '../doc/history.ts'
import type { Guide } from '../math/snap.ts'
import type { PenOverlay } from '../overlay/overlay.ts'
import type { SceneManager } from '../render/sceneManager.ts'
import type { Point, Rect, Tool, TransientChange, Viewport } from '../types.ts'
import type { CaretPlacement } from './textEdit.ts'

/** Transient overlay state owned by the active gesture. */
export interface GestureOverlay {
  marquee: Rect | null
  guides: Guide[]
  insertion: { a: Point; b: Point } | null
  draft: Rect | null
  draftLabel: string | null
  /** Reparent target highlighted during a move (null: none / the page). */
  drop: Rect | NodeFrame | null
  /** Live rotation angle pill (screen position). */
  angle: { text: string; at: Point } | null
  /** Pen tool path being drawn. */
  pen: PenOverlay | null
}

/** What gestures may use from the canvas. */
export interface CanvasHost {
  readonly doc: LoroDoc
  readonly scenes: SceneManager
  readonly history: History | null
  readonly gestureOverlay: GestureOverlay
  /** The canvas's component resolver (instances, virtual ids). */
  readonly resolver: ComponentResolver
  /** Measured geometry for schema helpers (getNodeFrame). */
  geometry(): GeometrySource
  viewport(): Viewport
  setViewport(v: Viewport): void
  isReadOnly(): boolean
  getSelection(): string[]
  setSelection(ids: readonly string[]): void
  requestFrame(): void
  /** Client coordinates → container-local screen coordinates. */
  local(e: { clientX: number; clientY: number }): Point
  toWorld(p: Point): Point
  setCursor(cursor: string): void
  emitTransient(change: TransientChange | null): void
  setTool(tool: Tool): void
  /** Start editing as soon as the node's element exists (it may be created this frame). */
  editTextWhenReady(id: string, caret: CaretPlacement, created: boolean): void
}

export interface Gesture {
  readonly kind:
    'pan' | 'press' | 'move' | 'resize' | 'marquee' | 'draw' | 'text' | 'rotate' | 'pen' | 'vector'
  move(e: PointerEvent): void
  up(e: PointerEvent): void
  cancel(): void
  /** Apply DOM previews (write phase). */
  write(): void
  /** World rects that replace measured bounds while previewing. */
  previewRects(): ReadonlyMap<string, Rect> | null
  /** World frames (rotated boxes) that replace measured frames while previewing. */
  previewFrames?(): ReadonlyMap<string, NodeFrame> | null
  /** Overrides the selection size label while active. */
  sizeLabel(): string | null
  /** True once up/cancel ran and the last write() cleaned up. */
  readonly done: boolean
  /** Whether pan/zoom style gesture activity (affects LOD/mount scheduling). */
  readonly isViewportGesture: boolean
}
