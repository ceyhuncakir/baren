import { nearestOnPath, worldToLocal, type NodeFrame } from '@baren/schema'
import { frameHandleAt, frameToScreen, rotateCursor, rotationZoneAt } from '../math/frame.ts'
import { pathFromTop } from '../math/hit.ts'
import { inflate } from '../math/rect.ts'
import { handleCursor } from '../math/resize.ts'
import {
  normalizeSelection,
  resolveClickTarget,
  resolveDoubleClickTarget,
  toggleInSelection,
  type SelectionContext,
} from '../math/selection.ts'
import { normalizeWheel, panBy, wheelZoomFactor, zoomAt } from '../math/viewport.ts'
import { selectionFrames } from '../overlay/model.ts'
import { framesAabb } from '../math/frame.ts'
import { pxValue } from '../render/styles.ts'
import type { ContextMenuRequest, KeyboardMode, Point, Tool } from '../types.ts'
import {
  DrawGesture,
  MarqueeGesture,
  PanGesture,
  PressGesture,
  ResizeGesture,
  TextGesture,
  insertTargetFor,
} from './gestures.ts'
import type { CanvasHost, Gesture } from './host.ts'
import { isEditableTarget, keyToCommand, type KeyCommand } from './keyboard.ts'
import { MoveGesture } from './move.ts'
import { penCursor, type PenTool } from './pen.ts'
import { RotateGesture } from './rotate.ts'
import type { TextEditing } from './textEditing.ts'
import type { VectorEditor } from './vectorEdit.ts'

/** Screen px around a vector's visible path that still hits it (contract 5.2). */
const VECTOR_HIT_PX = 4

/** What pointer/keyboard routing needs from the canvas, beyond the gesture host. */
export interface InputHost extends CanvasHost {
  readonly root: HTMLElement
  readonly world: HTMLElement
  readonly keyboard: KeyboardMode
  readonly text: TextEditing
  readonly pen: PenTool
  readonly vectorEdit: VectorEditor
  getTool(): Tool
  labelAt(p: Point): string | null
  setHover(id: string | null): void
  refreshRootRect(): void
  focus(): void
  /** Overlay needs a redraw. */
  invalidate(): void
  /** Apply queued document changes now (before a finished gesture clears its preview). */
  flushPending(): void
  emitCursor(world: Point | null): void
  contextMenu(request: ContextMenuRequest): void
  runCommand(cmd: KeyCommand): boolean
}

type Listen = <K extends keyof HTMLElementEventMap>(
  type: K,
  fn: (e: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
) => void

/**
 * Routes DOM input to gestures and commands: pointer (select / move / resize
 * / marquee / draw / text / pan), wheel (pan, Ctrl/Meta or pinch zoom at the
 * cursor), double click, context menu and keyboard (Space-to-pan, shortcuts).
 */
export class PointerInput {
  private gesture: Gesture | null = null
  private pointerId: number | null = null
  private spaceHeld = false

  constructor(private readonly host: InputHost) {}

  /** Register listeners on the canvas root; returns a disposer for the window listener. */
  attach(listen: Listen): () => void {
    listen('pointerdown', this.onPointerDown)
    listen('pointermove', this.onPointerMove)
    listen('pointerup', this.onPointerUp)
    listen('pointercancel', this.onPointerCancel)
    listen('pointerleave', this.onPointerLeave)
    listen('wheel', this.onWheel, { passive: false })
    listen('dblclick', this.onDblClick)
    listen('contextmenu', this.onContextMenu)
    listen('keydown', this.onKeyDown)
    listen('keyup', this.onKeyUp)
    const onBlur = (): void => {
      this.spaceHeld = false
      this.updateCursor()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }

  get activeGesture(): Gesture | null {
    return this.gesture
  }

  /** A pointer gesture other than a pending press (pan, move, resize, …) is running. */
  get busy(): boolean {
    return this.gesture !== null && this.gesture.kind !== 'press'
  }

  get viewportGesture(): boolean {
    return this.gesture?.isViewportGesture === true
  }

  /** The gesture ended and still has to clean up its preview. */
  get finishing(): boolean {
    return this.gesture?.done === true
  }

  /** Write phase: let the gesture apply its DOM preview. */
  write(): void {
    const g = this.gesture
    if (!g) return
    g.write()
    if (g.done) {
      this.gesture = null
      this.updateCursor()
    }
  }

  showHandles(): boolean {
    return (
      !this.host.isReadOnly() &&
      !this.host.text.active &&
      !this.host.vectorEdit.active &&
      this.host.getTool() === 'select' &&
      this.gesture?.kind !== 'move' &&
      this.gesture?.kind !== 'rotate'
    )
  }

  cancel(): void {
    const g = this.gesture
    if (!g) return
    this.releaseCapture()
    g.cancel()
    if (g.done) this.gesture = null
    this.updateCursor()
    this.host.invalidate()
  }

  updateCursor(): void {
    const tool = this.host.getTool()
    if (this.gesture?.kind === 'pan') this.host.setCursor('grabbing')
    else if (this.spaceHeld || tool === 'hand') this.host.setCursor('grab')
    else if (tool === 'artboard' || tool === 'rectangle') this.host.setCursor('crosshair')
    else if (tool === 'pen') this.host.setCursor(penCursor('draw'))
    else if (tool === 'text') this.host.setCursor('text')
    else this.host.setCursor('default')
  }

  private releaseCapture(): void {
    if (this.pointerId !== null) {
      try {
        this.host.root.releasePointerCapture(this.pointerId)
      } catch {
        // Not captured.
      }
    }
    this.pointerId = null
  }

  // ---------------------------------------------------------------------------
  // Hit testing helpers
  // ---------------------------------------------------------------------------

  private hitPath(e: { target: EventTarget | null }, world: Point): string[] | null {
    const scenes = this.host.scenes
    const target = e.target instanceof Element ? e.target : null
    let path: string[] | null = null
    if (target && this.host.world.contains(target)) path = scenes.pathForElement(target)
    path ??= scenes.hitTestWorld(world, scenes.isLod)
    if (scenes.isLod) return path
    return this.nearVector(world, path) ?? path
  }

  /**
   * Vectors are hit on their visible path; a few screen px around it still count. Returns the
   * path to a vector painted above the current hit whose stroke/fill passes near `world`.
   */
  private nearVector(world: Point, path: string[] | null): string[] | null {
    const scenes = this.host.scenes
    const deepest = path?.[path.length - 1]
    if (deepest !== undefined && scenes.typeOf(deepest) === 'vector') return null
    const zoom = this.host.viewport().zoom
    const tol = VECTOR_HIT_PX / zoom
    const items = scenes.indexIn(inflate({ x: world.x, y: world.y, width: 0, height: 0 }, tol))
    if (items.length === 0) return null
    let floor = -1
    for (const it of items) if (it.id === deepest) floor = it.order
    let best: { id: string; order: number } | null = null
    for (const it of items) {
      if (it.order <= floor || (best && it.order <= best.order)) continue
      const sn = scenes.sceneNode(it.id)
      if (!sn || sn.type !== 'vector' || !sn.vector) continue
      const f: NodeFrame = it.frame ?? { ...it.rect, rotation: 0 }
      const local = worldToLocal(f, world)
      const stroke = (pxValue(sn.styles['strokeWidth']) ?? 0) / 2
      if (nearestOnPath(sn.vector, local, tol + stroke)) best = { id: it.id, order: it.order }
    }
    if (!best) return null
    const p = pathFromTop(best.id, (n) => scenes.parentOf(n), scenes.pageId)
    return p.length > 0 ? p : null
  }

  private selectionContext(): SelectionContext {
    const scenes = this.host.scenes
    return {
      selection: this.host.getSelection(),
      parentOf: (id) => scenes.parentOf(id),
      isLocked: (id) => scenes.info(id)?.locked === true,
      kind: (id) => {
        const t = scenes.typeOf(id)
        return t === 'group' || t === 'instance' || t === 'frame' ? t : 'other'
      },
    }
  }

  /** Clicks on stand-ins (LOD or not yet mounted artboards) select whole artboards. */
  private isLodPath(path: readonly string[]): boolean {
    const top = path[0]
    const scenes = this.host.scenes
    return scenes.isLod || (top !== undefined && !scenes.isLive(top))
  }

  /** The selection box in screen space: a single node's rotated frame, else the union box. */
  private selectionScreenBox(): NodeFrame | null {
    const selection = this.host.getSelection()
    const frames = selectionFrames(this.host.scenes, selection, this.gesture)
    if (frames.length === 0) return null
    const v = this.host.viewport()
    if (frames.length === 1 && selection.length === 1)
      return frameToScreen(v, frames[0] as NodeFrame)
    const box = framesAabb(frames)
    return box ? frameToScreen(v, { ...box, rotation: 0 }) : null
  }

  private normalizedSelection(): string[] {
    const scenes = this.host.scenes
    return normalizeSelection(this.host.getSelection(), (id) => scenes.parentOf(id))
  }

  // ---------------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) return
    const host = this.host
    if (this.gesture) {
      if (this.pointerId !== null) return
      // The previous gesture already ended; finish its cleanup now.
      host.flushPending()
      this.gesture.write()
      this.gesture = null
    }
    const target = e.target instanceof Node ? e.target : null
    const editing = host.text.element
    if (editing) {
      if (target && editing.contains(target)) return
      host.text.stop()
    }
    host.refreshRootRect()
    host.focus()
    const g = this.createGesture(e)
    if (!g) return
    e.preventDefault()
    this.gesture = g
    this.pointerId = e.pointerId
    try {
      host.root.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }
    host.setHover(null)
    host.requestFrame()
  }

  private createGesture(e: PointerEvent): Gesture | null {
    const host = this.host
    const tool = host.getTool()
    if (e.button === 1 || this.spaceHeld || tool === 'hand') return new PanGesture(host, e)
    if (e.button !== 0) return null
    const p = host.local(e)
    const w = host.toWorld(p)
    if (tool === 'pen') {
      if (host.isReadOnly()) return null
      return host.pen.press(e, () => insertTargetFor(host, this.hitPath(e, w)))
    }
    if (host.vectorEdit.active) {
      const g = host.vectorEdit.press(e)
      if (g) return g
      host.vectorEdit.stop()
    }
    if (tool === 'artboard' || tool === 'rectangle') {
      if (host.isReadOnly()) return null
      return new DrawGesture(host, e, tool, insertTargetFor(host, this.hitPath(e, w)))
    }
    if (tool === 'text') {
      if (host.isReadOnly()) return null
      return new TextGesture(host, e, insertTargetFor(host, this.hitPath(e, w)))
    }
    return this.selectGesture(e, p, w)
  }

  private readonly moveSelection = (down: PointerEvent): Gesture | null =>
    this.host.isReadOnly() ? null : MoveGesture.create(this.host, down, this.normalizedSelection())

  private selectGesture(e: PointerEvent, p: Point, w: Point): Gesture | null {
    const host = this.host
    const selection = host.getSelection()
    if (this.showHandles()) {
      const box = this.selectionScreenBox()
      const h = box ? frameHandleAt(box, p) : null
      if (h) {
        const g = ResizeGesture.create(host, e, h, this.normalizedSelection())
        if (g) return g
      }
      // Artboard labels win over the rotation zone they overlap.
      if (box && !host.labelAt(p) && rotationZoneAt(box, p)) {
        const g = RotateGesture.create(host, e, this.normalizedSelection())
        if (g) return g
      }
    }
    const labelId = host.labelAt(p)
    if (labelId) {
      if (e.shiftKey) host.setSelection(toggleInSelection(selection, labelId))
      else if (!selection.includes(labelId)) host.setSelection([labelId])
      return new PressGesture(host, e, () => {}, this.moveSelection)
    }
    const path = this.hitPath(e, w)
    const lod = path !== null && this.isLodPath(path)
    const target = path
      ? resolveClickTarget(path, this.selectionContext(), { deep: e.ctrlKey || e.metaKey, lod })
      : null
    if (target === null) {
      const additive = e.shiftKey
      return new MarqueeGesture(host, e, null, additive, () => {
        if (!additive) host.setSelection([])
      })
    }
    // Pressing an unselected artboard's background: click selects it, drag
    // draws a marquee over its children (artboards behave like canvases).
    const onTopBackground =
      path !== null &&
      path.length === 1 &&
      target === path[0] &&
      host.scenes.info(target)?.type === 'frame' &&
      !lod
    if (onTopBackground && !selection.includes(target) && !e.shiftKey) {
      return new MarqueeGesture(host, e, target, false, () => host.setSelection([target]))
    }
    if (e.shiftKey) {
      host.setSelection(toggleInSelection(selection, target))
      return new PressGesture(
        host,
        e,
        () => {},
        (down) => (host.getSelection().includes(target) ? this.moveSelection(down) : null),
      )
    }
    const wasSelected = selection.includes(target)
    if (!wasSelected) host.setSelection([target])
    return new PressGesture(
      host,
      e,
      () => {
        if (wasSelected && host.getSelection().length > 1) host.setSelection([target])
      },
      this.moveSelection,
    )
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const host = this.host
    const p = host.local(e)
    host.emitCursor(host.toWorld(p))
    if (this.gesture && e.pointerId === this.pointerId) {
      this.gesture.move(e)
      host.invalidate()
      return
    }
    if (!this.gesture) this.updateHover(e, p)
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    const g = this.gesture
    if (!g || e.pointerId !== this.pointerId) return
    this.releaseCapture()
    g.up(e)
    if (g.done) this.gesture = null
    this.updateCursor()
    this.host.invalidate()
  }

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.gesture && e.pointerId === this.pointerId) this.cancel()
  }

  private readonly onPointerLeave = (): void => {
    this.host.emitCursor(null)
    if (!this.gesture) this.host.setHover(null)
    if (this.host.getTool() === 'pen') this.host.pen.hover(null)
  }

  private updateHover(e: PointerEvent, p: Point): void {
    const host = this.host
    if (host.getTool() === 'pen' && !this.spaceHeld) {
      host.setCursor(host.pen.hover(host.toWorld(p)))
      host.setHover(null)
      return
    }
    if (host.getTool() !== 'select' || this.spaceHeld) {
      host.setHover(null)
      this.updateCursor()
      return
    }
    if (host.vectorEdit.active) {
      const cursor = host.vectorEdit.hover(p)
      if (cursor) {
        host.setCursor(cursor)
        host.setHover(null)
        return
      }
    }
    if (this.showHandles()) {
      const box = this.selectionScreenBox()
      const h = box ? frameHandleAt(box, p) : null
      if (h && box) {
        host.setCursor(handleCursor(rotatedHandle(h, box.rotation)))
        host.setHover(null)
        return
      }
      const corner = box && !host.labelAt(p) ? rotationZoneAt(box, p) : null
      if (corner && box) {
        host.setCursor(rotateCursor(corner, box.rotation))
        host.setHover(null)
        return
      }
    }
    host.setCursor('default')
    const labelId = host.labelAt(p)
    if (labelId) {
      host.setHover(labelId)
      return
    }
    const path = this.hitPath(e, host.toWorld(p))
    const target = path
      ? resolveClickTarget(path, this.selectionContext(), {
          deep: e.ctrlKey || e.metaKey,
          lod: this.isLodPath(path),
        })
      : null
    host.setHover(target)
  }

  // ---------------------------------------------------------------------------
  // Wheel, double click, context menu
  // ---------------------------------------------------------------------------

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const host = this.host
    const v = host.viewport()
    const d = normalizeWheel(e, v.height)
    // Trackpad pinch arrives as Ctrl+wheel in Chromium.
    if (e.ctrlKey || e.metaKey)
      host.setViewport(zoomAt(v, v.zoom * wheelZoomFactor(d.y), host.local(e)))
    else host.setViewport(panBy(v, d.x, d.y))
  }

  private readonly onDblClick = (e: MouseEvent): void => {
    const host = this.host
    if (host.getTool() === 'pen') {
      // Finishing the path leaves the tool on select: stop before this enters vector editing.
      if (host.pen.active) host.pen.finishOnDoubleClick()
      return
    }
    if (host.getTool() !== 'select' || host.text.active) return
    const p = host.local(e)
    if (host.vectorEdit.active && host.vectorEdit.toggleMode(p)) return
    if (host.labelAt(p)) return
    const path = this.hitPath(e, host.toWorld(p))
    if (!path) return
    const r = resolveDoubleClickTarget(path, this.selectionContext(), (id) => {
      const t = host.scenes.typeOf(id)
      return t === 'text' || t === 'vector'
    })
    if (!r) return
    if (r.editText && !host.isReadOnly()) {
      if (host.scenes.typeOf(r.id) === 'vector') {
        if (!host.vectorEdit.active) host.vectorEdit.start(r.id)
        return
      }
      host.vectorEdit.stop()
      host.text.edit(r.id, { kind: 'point', clientX: e.clientX, clientY: e.clientY })
      host.requestFrame()
    } else host.setSelection([r.id])
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const host = this.host
    if (host.text.active) return
    host.refreshRootRect()
    const p = host.local(e)
    const w = host.toWorld(p)
    const labelId = host.labelAt(p)
    const path = labelId ? [labelId] : this.hitPath(e, w)
    const target = path
      ? resolveClickTarget(path, this.selectionContext(), { lod: this.isLodPath(path) })
      : null
    if (target && !host.getSelection().includes(target)) host.setSelection([target])
    host.contextMenu({ clientX: e.clientX, clientY: e.clientY, world: w, targetId: target })
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const host = this.host
    if (e.defaultPrevented || host.text.active) return
    if (e.target !== host.root && isEditableTarget(e.target)) return
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      if (!e.repeat) {
        this.spaceHeld = true
        host.setHover(null)
        this.updateCursor()
      }
      return
    }
    if (host.pen.active && (e.key === 'Enter' || e.key === 'Escape') && !this.gesture) {
      host.pen.finish(false)
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (
      host.vectorEdit.active &&
      !this.gesture &&
      host.keyboard !== 'none' &&
      host.vectorEdit.key(e)
    ) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const cmd = keyToCommand(e, host.keyboard)
    if (!cmd) return
    if (cmd.kind === 'escape' && this.gesture) {
      this.cancel()
      e.preventDefault()
      return
    }
    if (host.runCommand(cmd)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.spaceHeld = false
      this.updateCursor()
    }
  }
}

/** The resize handle a screen-space handle looks like on a box rotated by `rotation`. */
function rotatedHandle(
  h: import('../types.ts').Handle,
  rotation: number,
): import('../types.ts').Handle {
  const order = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
  const i = order.indexOf(h)
  const steps = Math.round(rotation / 45)
  return order[(((i + steps) % 8) + 8) % 8] as import('../types.ts').Handle
}
