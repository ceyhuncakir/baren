import {
  getNode,
  localToWorld,
  vectorToPathD,
  nearestOnPath,
  normalizeVector,
  removeNodes,
  rotatePoint,
  setPointMode,
  setVectorGeometry,
  splitSegment,
  worldToLocal,
  type NodeFrame,
  type StylePatch,
  type VectorData,
  type VectorPoint,
  type VectorSubpath,
} from '@baren/schema'
import { ORIGIN } from '../doc/ops.ts'
import { readStyleValues } from '../doc/read.ts'
import { movedPosition } from '../math/frame.ts'
import { worldToScreen } from '../math/viewport.ts'
import type { VectorEditOverlay } from '../overlay/overlay.ts'
import { applyVectorPath } from '../render/scene.ts'
import { isAbsolutelyPositioned, pxValue } from '../render/styles.ts'
import type { Point } from '../types.ts'
import { BaseGesture, DRAG_THRESHOLD } from './gestures.ts'
import { penCursor } from './pen.ts'
import type { CanvasHost } from './host.ts'

/** Screen px for hitting anchors and handles. */
const HIT_PX = 6
/** Screen px tolerance for clicking a segment (insert a point). */
const SEGMENT_PX = 4

/** A point address: `${subpathId}:${index}`. */
type PointRef = string

function ref(sp: string, i: number): PointRef {
  return `${sp}:${i}`
}

function parseRef(r: PointRef): { sp: string; i: number } {
  const k = r.lastIndexOf(':')
  return { sp: r.slice(0, k), i: Number(r.slice(k + 1)) }
}

function clonePoint(p: VectorPoint): VectorPoint {
  const out: VectorPoint = { x: p.x, y: p.y }
  if (p.in) out.in = [p.in[0], p.in[1]]
  if (p.out) out.out = [p.out[0], p.out[1]]
  if (p.mode !== undefined) out.mode = p.mode
  return out
}

function cloneVector(v: VectorData): VectorData {
  return {
    fillRule: v.fillRule,
    subpaths: v.subpaths.map((sp) => ({
      id: sp.id,
      closed: sp.closed,
      points: sp.points.map(clonePoint),
    })),
  }
}

/** Snap a vector to the nearest multiple of 45° (Shift). */
export function constrain45(dx: number, dy: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x: 0, y: 0 }
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: Math.cos(a) * len, y: Math.sin(a) * len }
}

/**
 * Move a handle of anchor `p` to `h` (relative); the opposite handle follows the anchor's
 * mode: `smooth` keeps it collinear (its length), `mirrored` mirrors it, `corner` leaves it.
 */
export function moveHandle(p: VectorPoint, which: 'in' | 'out', h: [number, number]): VectorPoint {
  const out = clonePoint(p)
  out[which] = h
  const other = which === 'in' ? 'out' : 'in'
  const mode = p.mode ?? 'corner'
  const len = Math.hypot(h[0], h[1])
  if (mode === 'mirrored') out[other] = [-h[0], -h[1]]
  else if (mode === 'smooth' && len > 0) {
    const o = p[other]
    const olen = o ? Math.hypot(o[0], o[1]) : len
    out[other] = [(-h[0] / len) * olen, (-h[1] / len) * olen]
  }
  return out
}

interface Hit {
  kind: 'anchor' | 'handle' | 'segment'
  point?: PointRef
  handle?: 'in' | 'out'
  segment?: { sp: string; segment: number; t: number; at: Point }
}

/**
 * In-place editing of a vector's points (contract 5.2): anchors as 6 px squares, handles of
 * selected anchors and their neighbours as 5 px circles. Drag anchors / handles (Shift = 45°),
 * click a segment to insert a point, Delete removes selected points, double-click toggles
 * corner ↔ smooth, Escape/Enter or a click outside exits. One `canvas:vector` commit per edit.
 */
export class VectorEditor {
  id: string | null = null
  private selected = new Set<PointRef>()
  /** Geometry shown while dragging (null: the document's). */
  draft: VectorData | null = null
  private insertAt: Point | null = null

  constructor(
    private readonly host: CanvasHost,
    private readonly onChange: (id: string | null) => void,
  ) {}

  get active(): boolean {
    return this.id !== null
  }

  start(id: string): boolean {
    const node = getNode(this.host.doc, id)
    if (!node || node.type !== 'vector' || node.locked || this.host.isReadOnly()) return false
    if (this.id === id) return true
    this.stop()
    this.id = id
    this.selected.clear()
    this.host.setSelection([id])
    this.onChange(id)
    this.host.requestFrame()
    return true
  }

  stop(): void {
    if (this.id === null) return
    const id = this.id
    this.id = null
    this.selected.clear()
    this.draft = null
    this.insertAt = null
    const el = this.host.scenes.elementOf(id)
    if (el) applyVectorPath(el, getNode(this.host.doc, id)?.vector)
    this.onChange(null)
    this.host.requestFrame()
  }

  /** The node vanished or changed type. */
  validate(): void {
    if (this.id === null) return
    const node = getNode(this.host.doc, this.id)
    if (!node || node.type !== 'vector' || node.locked) this.stop()
  }

  private vector(): VectorData | null {
    if (this.draft) return this.draft
    return this.id ? (getNode(this.host.doc, this.id)?.vector ?? null) : null
  }

  private frame(): NodeFrame | null {
    return this.id ? this.host.scenes.frameOf(this.id) : null
  }

  private toWorld(f: NodeFrame, p: Point): Point {
    return localToWorld(f, p)
  }

  /** Handles are shown for selected anchors and their neighbours. */
  private handlesShown(sp: VectorSubpath, i: number): boolean {
    const n = sp.points.length
    const sel = (k: number): boolean => this.selected.has(ref(sp.id, k))
    return (
      sel(i) ||
      sel(i - 1) ||
      sel(i + 1) ||
      (sp.closed && i === 0 && sel(n - 1)) ||
      (sp.closed && i === n - 1 && sel(0))
    )
  }

  /** Overlay state (world coordinates). */
  overlay(): VectorEditOverlay | null {
    const v = this.vector()
    const f = this.frame()
    if (!v || !f) return null
    const anchors: VectorEditOverlay['anchors'] = []
    const handles: VectorEditOverlay['handles'] = []
    for (const sp of v.subpaths) {
      sp.points.forEach((p, i) => {
        const anchor = this.toWorld(f, p)
        anchors.push({ p: anchor, selected: this.selected.has(ref(sp.id, i)) })
        if (!this.handlesShown(sp, i)) return
        if (p.in)
          handles.push({ anchor, handle: this.toWorld(f, { x: p.x + p.in[0], y: p.y + p.in[1] }) })
        if (p.out)
          handles.push({
            anchor,
            handle: this.toWorld(f, { x: p.x + p.out[0], y: p.y + p.out[1] }),
          })
      })
    }
    return { path: { d: vectorToPathD(v), frame: f }, anchors, handles, insert: this.insertAt }
  }

  /** What is under screen point `s`. */
  private hitTest(s: Point): Hit | null {
    const v = this.vector()
    const f = this.frame()
    if (!v || !f) return null
    const vp = this.host.viewport()
    const scr = (p: Point): Point => worldToScreen(vp, this.toWorld(f, p))
    const near = (p: Point): boolean =>
      Math.abs(p.x - s.x) <= HIT_PX && Math.abs(p.y - s.y) <= HIT_PX
    // Handles of the visible set first (they sit on top of anchors).
    for (const sp of v.subpaths) {
      for (let i = 0; i < sp.points.length; i++) {
        if (!this.handlesShown(sp, i)) continue
        const p = sp.points[i] as VectorPoint
        for (const which of ['out', 'in'] as const) {
          const h = p[which]
          if (h && near(scr({ x: p.x + h[0], y: p.y + h[1] })))
            return { kind: 'handle', point: ref(sp.id, i), handle: which }
        }
      }
    }
    for (const sp of v.subpaths)
      for (let i = sp.points.length - 1; i >= 0; i--)
        if (near(scr(sp.points[i] as VectorPoint))) return { kind: 'anchor', point: ref(sp.id, i) }
    const local = worldToLocal(f, this.host.toWorld(s))
    const seg = nearestOnPath(v, local, SEGMENT_PX / vp.zoom)
    if (seg)
      return {
        kind: 'segment',
        segment: { sp: seg.subpathId, segment: seg.segment, t: seg.t, at: seg.point },
      }
    return null
  }

  /** Hover feedback: a dot where a click would insert a point. */
  hover(s: Point | null): string | null {
    if (!this.id) return null
    const hit = s ? this.hitTest(s) : null
    const f = this.frame()
    const at = hit?.kind === 'segment' && f && hit.segment ? this.toWorld(f, hit.segment.at) : null
    if (
      (at?.x ?? null) !== (this.insertAt?.x ?? null) ||
      (at?.y ?? null) !== (this.insertAt?.y ?? null)
    ) {
      this.insertAt = at
      this.host.requestFrame()
    }
    return hit ? (hit.kind === 'segment' ? penCursor('add') : 'default') : null
  }

  /**
   * A press in edit mode. Returns a gesture when it hits the vector's points, handles or path;
   * null when it is outside (the caller exits edit mode and handles the click normally).
   */
  press(e: PointerEvent): BaseGesture | null {
    const host = this.host
    const s = host.local(e)
    const hit = this.hitTest(s)
    const v = this.vector()
    if (!hit || !v || !this.id) return null
    if (hit.kind === 'segment' && hit.segment) {
      const seg = hit.segment
      const next = cloneVector(v)
      const i = next.subpaths.findIndex((sp) => sp.id === seg.sp)
      const sp = next.subpaths[i]
      if (!sp) return null
      next.subpaths[i] = splitSegment(sp, seg.segment, seg.t)
      this.selected = new Set([ref(seg.sp, seg.segment + 1)])
      this.commit(next)
      return new VectorDragGesture(host, e, this, [ref(seg.sp, seg.segment + 1)], null)
    }
    const r = hit.point as PointRef
    if (hit.kind === 'anchor') {
      if (e.shiftKey) {
        if (this.selected.has(r)) this.selected.delete(r)
        else this.selected.add(r)
      } else if (!this.selected.has(r)) this.selected = new Set([r])
      host.requestFrame()
      return new VectorDragGesture(host, e, this, [...this.selected], null)
    }
    return new VectorDragGesture(host, e, this, [r], hit.handle ?? 'out')
  }

  /** Double-click on an anchor toggles corner ↔ smooth. Returns true when handled. */
  toggleMode(s: Point): boolean {
    const hit = this.hitTest(s)
    const v = this.vector()
    if (hit?.kind !== 'anchor' || !v || !hit.point) return false
    const { sp, i } = parseRef(hit.point)
    const next = cloneVector(v)
    const k = next.subpaths.findIndex((x) => x.id === sp)
    const sub = next.subpaths[k]
    const p = sub?.points[i]
    if (!sub || !p) return false
    const corner = (p.mode ?? 'corner') === 'corner' && !p.in && !p.out
    next.subpaths[k] = setPointMode(sub, i, corner ? 'smooth' : 'corner')
    this.selected = new Set([hit.point])
    this.commit(next)
    return true
  }

  /** Delete the selected points (all of them removes the vector). Returns true when handled. */
  deleteSelected(): boolean {
    const v = this.vector()
    if (!v || !this.id || this.selected.size === 0) return false
    const del = new Map<string, Set<number>>()
    for (const r of this.selected) {
      const { sp, i } = parseRef(r)
      let set = del.get(sp)
      if (!set) del.set(sp, (set = new Set()))
      set.add(i)
    }
    const subpaths: VectorSubpath[] = []
    for (const sp of v.subpaths) {
      const gone = del.get(sp.id)
      const points = gone ? sp.points.filter((_, i) => !gone.has(i)) : sp.points
      if (points.length >= 2) subpaths.push({ ...sp, points: points.map(clonePoint) })
    }
    this.selected.clear()
    if (subpaths.length === 0) {
      const id = this.id
      this.stop()
      removeNodes(this.host.doc, [id], this.host.geometry(), { origin: ORIGIN.vector })
      this.host.setSelection([])
      return true
    }
    this.commit({ fillRule: v.fillRule, subpaths })
    return true
  }

  /** Preview `v` on the element (drag in progress). */
  preview(v: VectorData): void {
    this.draft = v
    const el = this.id ? this.host.scenes.elementOf(this.id) : null
    if (el) applyVectorPath(el, v)
    this.host.requestFrame()
  }

  /** Commit `v` (normalised: box = tight bounds, path fixed in world space). */
  commit(v: VectorData): void {
    const id = this.id
    const f = this.frame()
    this.draft = null
    if (!id || !f) return
    const doc = this.host.doc
    const host = this.host
    const info = host.scenes.info(id)
    if (!info) return
    const { vector, box } = normalizeVector(v, f)
    const patch: StylePatch = { width: round2(box.width), height: round2(box.height) }
    if (info.isTop) {
      patch['left'] = round2(box.x)
      patch['top'] = round2(box.y)
    } else if (isAbsolutelyPositioned(info.styles)) {
      const cur = readStyleValues(doc, id, ['left', 'top'])
      const left = pxValue(cur['left'])
      const top = pxValue(cur['top'])
      if (left !== null && top !== null) {
        const parentRot = host.scenes.frameOf(info.parentId ?? '')?.rotation ?? 0
        const pos = movedPosition(left, top, f, box, parentRot)
        patch['left'] = round2(pos.left)
        patch['top'] = round2(pos.top)
      }
    }
    setVectorGeometry(doc, id, vector, patch, { origin: ORIGIN.vector })
    host.requestFrame()
  }

  /** Drag anchors (`refs`) or one handle by a world delta from `base`. */
  dragTo(
    base: VectorData,
    refs: readonly PointRef[],
    handle: 'in' | 'out' | null,
    worldDelta: Point,
    world: Point,
    shift: boolean,
  ): void {
    const f = this.frame()
    if (!f) return
    let d = rotatePoint(worldDelta, { x: 0, y: 0 }, -f.rotation)
    const next = cloneVector(base)
    const find = (r: PointRef): { sub: VectorSubpath; i: number } | null => {
      const { sp, i } = parseRef(r)
      const sub = next.subpaths.find((x) => x.id === sp)
      return sub && sub.points[i] ? { sub, i } : null
    }
    if (handle) {
      const at = find(refs[0] as PointRef)
      if (!at) return
      const p = at.sub.points[at.i] as VectorPoint
      const local = worldToLocal(f, world)
      let h: [number, number] = [local.x - p.x, local.y - p.y]
      if (shift) {
        const c = constrain45(h[0], h[1])
        h = [c.x, c.y]
      }
      at.sub.points[at.i] = moveHandle(p, handle, [round3(h[0]), round3(h[1])])
    } else {
      if (shift) d = constrain45(d.x, d.y)
      for (const r of refs) {
        const at = find(r)
        if (!at) continue
        const p = at.sub.points[at.i] as VectorPoint
        at.sub.points[at.i] = { ...clonePoint(p), x: round3(p.x + d.x), y: round3(p.y + d.y) }
      }
    }
    this.preview(next)
  }

  /** The geometry a drag starts from. */
  base(): VectorData | null {
    return this.vector()
  }

  key(e: KeyboardEvent): boolean {
    if (!this.id) return false
    if (e.key === 'Escape' || e.key === 'Enter') {
      this.stop()
      return true
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return this.deleteSelected()
    return false
  }
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

function round3(n: number): number {
  const r = Math.round(n * 1000) / 1000
  return r === 0 ? 0 : r
}

/** Dragging anchors or a handle in vector edit mode. */
class VectorDragGesture extends BaseGesture {
  readonly kind = 'vector'
  private readonly startWorld: Point
  private readonly startScreen: Point
  private readonly base: VectorData | null
  private dragging = false

  constructor(
    host: CanvasHost,
    e: PointerEvent,
    private readonly editor: VectorEditor,
    private readonly refs: readonly string[],
    private readonly handle: 'in' | 'out' | null,
  ) {
    super(host)
    this.startScreen = host.local(e)
    this.startWorld = host.toWorld(this.startScreen)
    this.base = editor.base()
  }

  move(e: PointerEvent): void {
    const p = this.host.local(e)
    if (
      !this.dragging &&
      Math.hypot(p.x - this.startScreen.x, p.y - this.startScreen.y) < DRAG_THRESHOLD
    )
      return
    this.dragging = true
    if (!this.base) return
    const w = this.host.toWorld(p)
    this.editor.dragTo(
      this.base,
      this.refs,
      this.handle,
      { x: w.x - this.startWorld.x, y: w.y - this.startWorld.y },
      w,
      e.shiftKey,
    )
  }

  up(): void {
    if (this.dragging && this.editor.draft) this.editor.commit(this.editor.draft)
    this.done = true
  }

  override cancel(): void {
    const draft = this.editor.draft
    this.editor.draft = null
    if (draft && this.base) this.editor.preview(this.base)
    this.editor.draft = null
    this.done = true
  }
}
