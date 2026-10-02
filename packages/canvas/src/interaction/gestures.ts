import {
  frameAabb,
  getNode,
  getNodeType,
  scaleVector,
  setVector,
  transact,
  worldToLocal,
  type NodeFrame,
  type StyleValue,
  type Styles,
} from '@baren/schema'
import { ORIGIN, commitGeometry, createNodeWithOrigin, type GeometryPatch } from '../doc/ops.ts'
import { readStyleValues } from '../doc/read.ts'
import {
  deltaInParent,
  mapFrameBetween,
  movedPosition,
  rectFrame,
  resizeFrame,
} from '../math/frame.ts'
import { rectFromPoints, unionRects, inflate } from '../math/rect.ts'
import { resizeRect, roundRect } from '../math/resize.ts'
import { marqueeSelection, sameSelection } from '../math/selection.ts'
import { plainSizeLabel } from '../math/sizeLabel.ts'
import { snapEdges } from '../math/snap.ts'
import { panBy } from '../math/viewport.ts'
import { isVirtualRef, type NodeElement } from '../render/scene.ts'
import {
  flexDirectionOf,
  isAbsolutelyPositioned,
  pxValue,
  type FlexDirection,
} from '../render/styles.ts'
import type { Handle, Point, Rect } from '../types.ts'
import type { CanvasHost, Gesture } from './host.ts'

/** Screen px the pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD = 3
/** Snapping distance in screen px. */
export const SNAP_PX = 6

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export abstract class BaseGesture implements Gesture {
  abstract readonly kind: Gesture['kind']
  readonly isViewportGesture: boolean = false
  done = false
  constructor(protected readonly host: CanvasHost) {}
  abstract move(e: PointerEvent): void
  abstract up(e: PointerEvent): void
  cancel(): void {
    this.done = true
  }
  write(): void {}
  previewRects(): ReadonlyMap<string, Rect> | null {
    return null
  }
  previewFrames(): ReadonlyMap<string, NodeFrame> | null {
    return null
  }
  sizeLabel(): string | null {
    return null
  }
  protected world(e: PointerEvent): Point {
    return this.host.toWorld(this.host.local(e))
  }
}

// -----------------------------------------------------------------------------
// Pan
// -----------------------------------------------------------------------------

export class PanGesture extends BaseGesture {
  readonly kind = 'pan'
  override readonly isViewportGesture = true
  private last: Point

  constructor(host: CanvasHost, e: PointerEvent) {
    super(host)
    this.last = { x: e.clientX, y: e.clientY }
    host.setCursor('grabbing')
  }

  move(e: PointerEvent): void {
    const dx = e.clientX - this.last.x
    const dy = e.clientY - this.last.y
    this.last = { x: e.clientX, y: e.clientY }
    if (dx !== 0 || dy !== 0) this.host.setViewport(panBy(this.host.viewport(), -dx, -dy))
  }

  up(): void {
    this.done = true
  }
}

// -----------------------------------------------------------------------------
// Press: click, or becomes a drag gesture past the threshold
// -----------------------------------------------------------------------------

export class PressGesture extends BaseGesture {
  private delegate: Gesture | null = null
  private readonly start: Point

  constructor(
    host: CanvasHost,
    private readonly down: PointerEvent,
    private readonly onClick: (e: PointerEvent) => void,
    /** Called once the pointer passed the drag threshold, with the original pointerdown event. */
    private readonly onDrag: (down: PointerEvent) => Gesture | null,
  ) {
    super(host)
    this.start = { x: down.clientX, y: down.clientY }
  }

  get kind(): Gesture['kind'] {
    return this.delegate?.kind ?? 'press'
  }

  move(e: PointerEvent): void {
    if (this.delegate) {
      this.delegate.move(e)
      return
    }
    if (dist(this.start, { x: e.clientX, y: e.clientY }) < DRAG_THRESHOLD) return
    this.delegate = this.onDrag(this.down)
    if (!this.delegate) this.done = true
    else this.delegate.move(e)
  }

  up(e: PointerEvent): void {
    if (this.delegate) this.delegate.up(e)
    else {
      this.onClick(e)
      this.done = true
    }
  }

  override cancel(): void {
    this.delegate?.cancel()
    if (!this.delegate) this.done = true
  }

  override write(): void {
    this.delegate?.write()
    if (this.delegate?.done) this.done = true
  }

  override previewRects(): ReadonlyMap<string, Rect> | null {
    return this.delegate?.previewRects() ?? null
  }

  override previewFrames(): ReadonlyMap<string, NodeFrame> | null {
    return this.delegate?.previewFrames?.() ?? null
  }

  override sizeLabel(): string | null {
    return this.delegate?.sizeLabel() ?? null
  }
}

// -----------------------------------------------------------------------------
// Move
// -----------------------------------------------------------------------------

/** Siblings of a flow node with their measured rects, in order (absolutely positioned ones flagged). */
export function flowSiblings(
  host: CanvasHost,
  parentId: string,
  exclude: ReadonlySet<string>,
): FlowSibling[] {
  const kids = host.scenes.childrenWithBounds(parentId) ?? []
  return kids
    .filter((k) => !exclude.has(k.id) && !k.hidden)
    .map((k) => {
      const styles = host.scenes.info(k.id)?.styles
      return { id: k.id, rect: k.bounds, inFlow: !(styles && isAbsolutelyPositioned(styles)) }
    })
}

export interface FlowSibling {
  rect: Rect
  /** False for absolutely positioned siblings: they keep their index but don't affect the drop slot. */
  inFlow?: boolean
}

/**
 * Index among `siblings` (all children except the dragged ones, in order)
 * where a node dropped at `p` lands, plus an indicator line in the gap.
 */
export function flowDropIndex(
  siblings: readonly FlowSibling[],
  p: Point,
  dir: FlexDirection,
  parentRect: Rect | null,
): { index: number; a: Point; b: Point } {
  const main = (r: Rect): [number, number] =>
    dir === 'row' ? [r.x, r.x + r.width] : [r.y, r.y + r.height]
  const pos = dir === 'row' ? p.x : p.y
  let index = siblings.length
  let next: FlowSibling | undefined
  let prev: FlowSibling | undefined
  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i] as FlowSibling
    if (s.inFlow === false) continue
    const [start, end] = main(s.rect)
    if (pos < (start + end) / 2) {
      index = i
      next = s
      break
    }
    prev = s
  }
  let line: number
  if (prev && next) line = (main(prev.rect)[1] + main(next.rect)[0]) / 2
  else if (next) line = main(next.rect)[0]
  else if (prev) line = main(prev.rect)[1]
  else line = pos
  const ref = next ?? prev
  const cross = parentRect ?? ref?.rect ?? { x: p.x, y: p.y, width: 0, height: 0 }
  if (dir === 'row')
    return { index, a: { x: line, y: cross.y }, b: { x: line, y: cross.y + cross.height } }
  return { index, a: { x: cross.x, y: line }, b: { x: cross.x + cross.width, y: line } }
}

// -----------------------------------------------------------------------------
// Resize
// -----------------------------------------------------------------------------

interface ResizeEntry {
  id: string
  kind: 'top' | 'abs' | 'flow'
  /** World axis-aligned bounds at the start. */
  start: Rect
  /** World frame at the start. */
  frame: NodeFrame
  left: number | null
  top: number | null
  /** World rotation of the parent. */
  parentRot: number
  type: string
  el: NodeElement | null
}

const has = (h: Handle, c: string): boolean => h.includes(c)

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Round a frame's size to whole px around its centre (rotated boxes keep fractional positions). */
function roundFrame(f: NodeFrame): NodeFrame {
  if (f.rotation === 0) return rectFrame(roundRect(f))
  const w = Math.max(1, Math.round(f.width))
  const h = Math.max(1, Math.round(f.height))
  const cx = f.x + f.width / 2
  const cy = f.y + f.height / 2
  return { x: round2(cx - w / 2), y: round2(cy - h / 2), width: w, height: h, rotation: f.rotation }
}

/**
 * Resize. One rotated node resizes in its local axes with the opposite handle fixed in world
 * space; otherwise the selection's axis-aligned box is resized (with edge snapping) and each
 * node's centre maps through the box transform (contract 5.2). Groups scale their content
 * (`resizeGroup`), vectors their points; instance content writes overrides.
 */
export class ResizeGesture extends BaseGesture {
  readonly kind = 'resize'
  private readonly entries: ResizeEntry[]
  private readonly group: Rect
  private readonly startWorld: Point
  private frames = new Map<string, NodeFrame>()
  private box: Rect
  private label = ''
  private candidates: Rect[] | null = null
  private finishing = false
  private moved = false
  /** Single rotated node: local-axis resize. */
  private readonly local: ResizeEntry | null

  private constructor(
    host: CanvasHost,
    e: PointerEvent,
    private readonly handle: Handle,
    entries: ResizeEntry[],
    group: Rect,
  ) {
    super(host)
    this.entries = entries
    this.group = group
    this.box = group
    this.startWorld = this.world(e)
    const only = entries.length === 1 ? (entries[0] as ResizeEntry) : null
    this.local = only && only.frame.rotation !== 0 ? only : null
    for (const en of entries)
      host.scenes.setPreviewing(host.scenes.topLevelOf(en.id) ?? en.id, true)
  }

  static create(
    host: CanvasHost,
    e: PointerEvent,
    handle: Handle,
    ids: readonly string[],
  ): ResizeGesture | null {
    const entries: ResizeEntry[] = []
    const scenes = host.scenes
    for (const id of ids) {
      const info = scenes.info(id)
      const start = scenes.boundsOf(id)
      const frame = scenes.frameOf(id)
      if (!info || !start || !frame || info.locked) continue
      const el = scenes.elementOf(id)
      const virtual = isVirtualRef(id)
      const pos = virtual ? info.styles : readStyleValues(host.doc, id, ['left', 'top'])
      const parentRot = info.isTop ? 0 : (scenes.frameOf(info.parentId ?? '')?.rotation ?? 0)
      const base = { id, start, frame, el, parentRot, type: info.type }
      if (info.isTop) entries.push({ ...base, kind: 'top', left: frame.x, top: frame.y })
      else if (isAbsolutelyPositioned(info.styles)) {
        entries.push({
          ...base,
          kind: 'abs',
          left: pxValue(pos['left']),
          top: pxValue(pos['top']),
        })
      } else entries.push({ ...base, kind: 'flow', left: null, top: null })
    }
    const group = unionRects(entries.map((en) => en.start))
    return group && entries.length > 0 ? new ResizeGesture(host, e, handle, entries, group) : null
  }

  private snapCandidates(): Rect[] {
    if (this.candidates) return this.candidates
    const v = this.host.viewport()
    this.candidates = this.host.scenes.snapCandidates(
      this.entries.map((en) => en.id),
      inflate(this.group, v.width / v.zoom, v.height / v.zoom),
    )
    return this.candidates
  }

  move(e: PointerEvent): void {
    const w = this.world(e)
    const dx = w.x - this.startWorld.x
    const dy = w.y - this.startWorld.y
    const h = this.handle
    const overlay = this.host.gestureOverlay
    overlay.guides = []
    if (this.local) {
      const f = roundFrame(
        resizeFrame(this.local.frame, h, dx, dy, { keepAspect: e.shiftKey, fromCenter: e.altKey }),
      )
      this.frames = new Map([[this.local.id, f]])
      this.box = frameAabb(f)
      this.label = plainSizeLabel(f)
    } else {
      let box = resizeRect(this.group, h, dx, dy, { keepAspect: e.shiftKey, fromCenter: e.altKey })
      if (!e.shiftKey && !e.altKey && !(e.ctrlKey || e.metaKey)) {
        const ex = has(h, 'e') ? box.x + box.width : has(h, 'w') ? box.x : undefined
        const ey = has(h, 's') ? box.y + box.height : has(h, 'n') ? box.y : undefined
        const base = box
        const adjust = (sx: number, sy: number): Rect => {
          const r = { ...base }
          if (has(h, 'e')) r.width += sx
          else if (has(h, 'w')) {
            r.x += sx
            r.width -= sx
          }
          if (has(h, 's')) r.height += sy
          else if (has(h, 'n')) {
            r.y += sy
            r.height -= sy
          }
          return r
        }
        const edges: { x?: number; y?: number } = {}
        if (ex !== undefined) edges.x = ex
        if (ey !== undefined) edges.y = ey
        const snap = snapEdges(
          edges,
          adjust,
          this.snapCandidates(),
          SNAP_PX / this.host.viewport().zoom,
        )
        box = adjust(snap.dx, snap.dy)
        overlay.guides = snap.guides
      }
      this.box = roundRect(box)
      if (this.box.width < 1) this.box.width = 1
      if (this.box.height < 1) this.box.height = 1
      this.frames = new Map(
        this.entries.map((en) => [
          en.id,
          roundFrame(mapFrameBetween(en.frame, this.group, this.box)),
        ]),
      )
      this.label = plainSizeLabel(this.box)
    }
    this.moved = true
    this.host.emitTransient({
      kind: 'resize',
      nodes: [...this.frames].map(([id, f]) => ({ id, rect: frameAabb(f) })),
    })
    this.host.requestFrame()
  }

  /** Position styles for an entry's new frame. */
  private patchFor(en: ResizeEntry, f: NodeFrame): GeometryPatch {
    const p: GeometryPatch = {
      id: en.id,
      width: Math.max(1, round2(f.width)),
      height: Math.max(1, round2(f.height)),
    }
    if (en.kind === 'top') {
      p.left = round2(f.x)
      p.top = round2(f.y)
    } else if (en.kind === 'abs' && en.left !== null && en.top !== null) {
      const pos = movedPosition(en.left, en.top, en.frame, f, en.parentRot)
      p.left = round2(pos.left)
      p.top = round2(pos.top)
    }
    return p
  }

  up(): void {
    if (this.moved) {
      const host = this.host
      const doc = host.doc
      const patches: GeometryPatch[] = []
      for (const en of this.entries) {
        const f = this.frames.get(en.id)
        if (f) patches.push(this.patchFor(en, f))
      }
      const scenes = host.scenes
      transact(
        doc,
        () => {
          // Vectors rescale their points with their box (contract 2.6).
          for (const p of patches) {
            if (isVirtualRef(p.id) || getNodeType(doc, p.id) !== 'vector') continue
            const node = getNode(doc, p.id)
            const w = pxValue(node?.styles['width'])
            const hh = pxValue(node?.styles['height'])
            if (!node?.vector || !w || !hh || p.width === undefined || p.height === undefined)
              continue
            setVector(doc, p.id, scaleVector(node.vector, p.width / w, p.height / hh))
          }
          commitGeometry(doc, patches, ORIGIN.resize, {
            geo: host.geometry(),
            resolver: host.resolver,
            current: (id) => (scenes.info(id)?.styles as Record<string, StyleValue>) ?? null,
          })
        },
        { origin: ORIGIN.resize },
      )
    }
    this.finish()
  }

  override cancel(): void {
    this.finish()
  }

  private finish(): void {
    this.finishing = true
    this.host.emitTransient(null)
    this.host.gestureOverlay.guides = []
    this.host.requestFrame()
  }

  override write(): void {
    const scenes = this.host.scenes
    if (this.finishing) {
      for (const en of this.entries) {
        if (en.type === 'group' && en.el) {
          en.el.style.scale = ''
          en.el.style.translate = ''
        }
        if (en.kind === 'top') {
          scenes.setPreviewOffset(en.id, null)
          scenes.setPreviewSize(en.id, null)
        } else scenes.reapplyStyles(en.id, ['width', 'height', 'left', 'top'])
        scenes.setPreviewing(scenes.topLevelOf(en.id) ?? en.id, false)
      }
      this.done = true
      return
    }
    if (!this.moved) return
    for (const en of this.entries) {
      const f = this.frames.get(en.id)
      if (!f) continue
      if (en.type === 'group') {
        // Scale the whole group (children follow) about its centre, then move the centre.
        const el = en.el
        if (!el) continue
        const sx = en.frame.width > 0 ? f.width / en.frame.width : 1
        const sy = en.frame.height > 0 ? f.height / en.frame.height : 1
        const c0x = en.frame.x + en.frame.width / 2
        const c0y = en.frame.y + en.frame.height / 2
        const d = deltaInParent(
          f.x + f.width / 2 - c0x,
          f.y + f.height / 2 - c0y,
          en.kind === 'top' ? 0 : en.parentRot,
        )
        el.style.scale = `${sx} ${sy}`
        el.style.translate = `${d.x}px ${d.y}px`
        continue
      }
      if (en.kind === 'top') {
        scenes.setPreviewOffset(en.id, { x: f.x - en.frame.x, y: f.y - en.frame.y })
        scenes.setPreviewSize(en.id, { width: f.width, height: f.height })
        continue
      }
      const el = en.el
      if (!el) continue
      const p = this.patchFor(en, f)
      el.style.width = `${f.width}px`
      el.style.height = `${f.height}px`
      if (en.kind === 'abs') {
        if (p.left !== undefined) el.style.left = `${p.left}px`
        if (p.top !== undefined) el.style.top = `${p.top}px`
      }
    }
  }

  override previewRects(): ReadonlyMap<string, Rect> | null {
    if (!this.moved) return null
    const out = new Map<string, Rect>()
    for (const [id, f] of this.frames) out.set(id, frameAabb(f))
    return out
  }

  override previewFrames(): ReadonlyMap<string, NodeFrame> | null {
    return this.moved ? this.frames : null
  }

  override sizeLabel(): string | null {
    return this.moved ? this.label : null
  }
}

// -----------------------------------------------------------------------------
// Marquee
// -----------------------------------------------------------------------------

export class MarqueeGesture extends BaseGesture {
  readonly kind = 'marquee'
  private readonly startWorld: Point
  private readonly startScreen: Point
  private readonly base: string[]
  private dragged = false

  constructor(
    host: CanvasHost,
    e: PointerEvent,
    private readonly scope: string | null,
    additive: boolean,
    private readonly onClick: () => void,
  ) {
    super(host)
    this.startScreen = host.local(e)
    this.startWorld = host.toWorld(this.startScreen)
    this.base = additive ? host.getSelection() : []
  }

  move(e: PointerEvent): void {
    const p = this.host.local(e)
    if (!this.dragged && dist(p, this.startScreen) < DRAG_THRESHOLD) return
    this.dragged = true
    const rect = rectFromPoints(this.startWorld, this.host.toWorld(p))
    this.host.gestureOverlay.marquee = rect
    const scenes = this.host.scenes
    const tops = scenes.topsInRect(rect).map((r) => ({
      id: r.id,
      bounds: r.bounds,
      isFrame: r.type === 'frame',
      locked: r.locked,
      hidden: r.hidden,
    }))
    const hits = marqueeSelection(rect, tops, (id) => scenes.childrenWithBounds(id), this.scope)
    const next = [...this.base]
    for (const id of hits) if (!next.includes(id)) next.push(id)
    if (!sameSelection(next, this.host.getSelection())) this.host.setSelection(next)
    this.host.requestFrame()
  }

  up(): void {
    this.host.gestureOverlay.marquee = null
    if (!this.dragged) this.onClick()
    this.done = true
    this.host.requestFrame()
  }

  override cancel(): void {
    this.host.gestureOverlay.marquee = null
    this.done = true
    this.host.requestFrame()
  }
}

// -----------------------------------------------------------------------------
// Insertion target for new nodes (draw / text tools)
// -----------------------------------------------------------------------------

export interface InsertTarget {
  /** Parent node id, or null for the page. */
  parentId: string | null
  flex: FlexDirection | null
  /** World rect of the containing block for absolute positioning. */
  containingBlock: Rect | null
  parentRect: Rect | null
  /** World frame of the containing block when it is rotated. */
  cbFrame?: NodeFrame | null
}

/**
 * Where a node created at a point on `path` goes: the deepest unlocked frame, else the page.
 * Groups and instance content are skipped (frames only; never inside an instance).
 */
export function insertTargetFor(host: CanvasHost, path: readonly string[] | null): InsertTarget {
  const scenes = host.scenes
  if (path) {
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i] as string
      if (isVirtualRef(id)) continue
      const info = scenes.info(id)
      if (!info || info.type !== 'frame' || info.locked) continue
      if (path.slice(0, i).some((a) => scenes.info(a)?.locked)) continue
      const rect = scenes.boundsOf(id)
      // Containing block: nearest positioned ancestor-or-self (the artboard root is always positioned).
      let cb: Rect | null = null
      let cbFrame: NodeFrame | null = null
      for (let j = i; j >= 0; j--) {
        const a = path[j] as string
        const ai = scenes.info(a)
        const pos = ai?.styles['position']
        if (
          j === 0 ||
          pos === 'relative' ||
          pos === 'absolute' ||
          pos === 'fixed' ||
          pos === 'sticky'
        ) {
          cb = scenes.boundsOf(a)
          const f = scenes.frameOf(a)
          if (f && f.rotation !== 0) cbFrame = f
          break
        }
      }
      return {
        parentId: id,
        flex: flexDirectionOf(info.styles),
        containingBlock: cb,
        parentRect: rect,
        cbFrame,
      }
    }
  }
  return { parentId: null, flex: null, containingBlock: null, parentRect: null }
}

export function geometryStyles(target: InsertTarget, r: Rect): { styles: Styles; index?: number } {
  if (target.parentId === null)
    return { styles: { left: r.x, top: r.y, width: r.width, height: r.height } }
  if (target.flex) return { styles: { width: r.width, height: r.height, flexShrink: 0 } }
  if (target.cbFrame) {
    // A rotated containing block: centre the (frame-aligned) node under the drawn rect.
    const c = worldToLocal(target.cbFrame, { x: r.x + r.width / 2, y: r.y + r.height / 2 })
    return {
      styles: {
        position: 'absolute',
        left: round2(c.x - r.width / 2),
        top: round2(c.y - r.height / 2),
        width: r.width,
        height: r.height,
      },
    }
  }
  const cb = target.containingBlock ?? target.parentRect ?? { x: 0, y: 0, width: 0, height: 0 }
  return {
    styles: {
      position: 'absolute',
      left: r.x - cb.x,
      top: r.y - cb.y,
      width: r.width,
      height: r.height,
    },
  }
}

export function flowIndexFor(host: CanvasHost, target: InsertTarget, p: Point): number | undefined {
  if (!target.parentId || !target.flex) return undefined
  const siblings = flowSiblings(host, target.parentId, new Set())
  return flowDropIndex(siblings, p, target.flex, target.parentRect).index
}

// -----------------------------------------------------------------------------
// Draw (artboard / frame / rectangle)
// -----------------------------------------------------------------------------

export const DEFAULT_ARTBOARD = { width: 1440, height: 900 }
export const DEFAULT_SHAPE = { width: 100, height: 100 }

export class DrawGesture extends BaseGesture {
  readonly kind = 'draw'
  private readonly start: Point
  private readonly startScreen: Point
  private rect: Rect | null = null

  constructor(
    host: CanvasHost,
    e: PointerEvent,
    private readonly tool: 'artboard' | 'rectangle',
    private readonly target: InsertTarget,
  ) {
    super(host)
    this.startScreen = host.local(e)
    const w = host.toWorld(this.startScreen)
    this.start = { x: Math.round(w.x), y: Math.round(w.y) }
  }

  move(e: PointerEvent): void {
    const p = this.host.local(e)
    if (!this.rect && dist(p, this.startScreen) < DRAG_THRESHOLD) return
    const w = this.host.toWorld(p)
    let dx = w.x - this.start.x
    let dy = w.y - this.start.y
    if (e.shiftKey) {
      const m = Math.max(Math.abs(dx), Math.abs(dy))
      dx = Math.sign(dx || 1) * m
      dy = Math.sign(dy || 1) * m
    }
    const r = e.altKey
      ? {
          x: this.start.x - Math.abs(dx),
          y: this.start.y - Math.abs(dy),
          width: Math.abs(dx) * 2,
          height: Math.abs(dy) * 2,
        }
      : rectFromPoints(this.start, { x: this.start.x + dx, y: this.start.y + dy })
    this.rect = roundRect(r)
    this.host.gestureOverlay.draft = this.rect
    this.host.gestureOverlay.draftLabel = plainSizeLabel(this.rect)
    this.host.requestFrame()
  }

  up(): void {
    const overlay = this.host.gestureOverlay
    overlay.draft = null
    overlay.draftLabel = null
    this.done = true
    const isTop = this.target.parentId === null
    const size = this.tool === 'artboard' && isTop ? DEFAULT_ARTBOARD : DEFAULT_SHAPE
    const r =
      this.rect && this.rect.width >= 1 && this.rect.height >= 1
        ? this.rect
        : { x: this.start.x, y: this.start.y, ...size }
    const pageId = this.host.scenes.pageId
    const geo = geometryStyles(this.target, r)
    const index = flowIndexFor(this.host, this.target, {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
    })
    const fill: Styles =
      this.tool === 'artboard' ? { backgroundColor: '#FFFFFF' } : { backgroundColor: '#D9D9D9' }
    const extra: Styles = this.tool === 'artboard' && isTop ? { overflow: 'hidden' } : {}
    const name =
      this.tool === 'artboard' ? (isTop ? nextArtboardName(this.host) : 'Frame') : 'Rectangle'
    const id = createNodeWithOrigin(
      this.host.doc,
      {
        type: this.tool === 'artboard' ? 'frame' : 'rect',
        parentId: this.target.parentId ?? pageId,
        ...(index !== undefined ? { index } : {}),
        name,
        styles: { ...geo.styles, ...fill, ...extra },
      },
      ORIGIN.create,
    )
    this.host.setSelection([id])
    this.host.setTool('select')
    this.host.requestFrame()
  }

  override cancel(): void {
    this.host.gestureOverlay.draft = null
    this.host.gestureOverlay.draftLabel = null
    this.done = true
    this.host.requestFrame()
  }

  override sizeLabel(): string | null {
    return null
  }
}

function nextArtboardName(host: CanvasHost): string {
  let n = 0
  for (const rec of host.scenes.records.values()) if (rec.type === 'frame') n++
  return `Artboard ${n + 1}`
}

// -----------------------------------------------------------------------------
// Text tool: click to create a text node and edit it in place
// -----------------------------------------------------------------------------

export const DEFAULT_TEXT_STYLES: Styles = {
  fontFamily: 'Inter',
  fontSize: '16px',
  lineHeight: '20px',
  color: '#000000',
}

export class TextGesture extends BaseGesture {
  readonly kind = 'text'
  private readonly at: Point

  constructor(
    host: CanvasHost,
    e: PointerEvent,
    private readonly target: InsertTarget,
  ) {
    super(host)
    const w = host.toWorld(host.local(e))
    this.at = { x: Math.round(w.x), y: Math.round(w.y - 10) }
  }

  move(): void {}

  up(): void {
    this.done = true
    const pageId = this.host.scenes.pageId
    const r = { x: this.at.x, y: this.at.y, width: 0, height: 0 }
    const geo = geometryStyles(this.target, r)
    const styles: Record<string, StyleValue> = { ...DEFAULT_TEXT_STYLES }
    for (const [k, v] of Object.entries(geo.styles))
      if (k !== 'width' && k !== 'height' && k !== 'flexShrink') styles[k] = v
    const index = flowIndexFor(this.host, this.target, this.at)
    this.host.history?.groupStart()
    const id = createNodeWithOrigin(
      this.host.doc,
      {
        type: 'text',
        parentId: this.target.parentId ?? pageId,
        ...(index !== undefined ? { index } : {}),
        name: 'Text',
        styles,
        text: '',
      },
      ORIGIN.create,
    )
    this.host.setSelection([id])
    this.host.setTool('select')
    this.host.editTextWhenReady(id, { kind: 'end' }, true)
  }
}
