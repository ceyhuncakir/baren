import {
  createNode,
  newSubpathId,
  rotatePoint,
  transact,
  vectorBounds,
  worldToLocal,
  type NodeFrame,
  type Styles,
  type VectorData,
  type VectorPoint,
} from '@baren/schema'
import { ORIGIN } from '../doc/ops.ts'
import { rectFrame } from '../math/frame.ts'
import type { PenOverlay } from '../overlay/overlay.ts'
import type { Point } from '../types.ts'
import { BaseGesture, DRAG_THRESHOLD, flowIndexFor, type InsertTarget } from './gestures.ts'
import type { CanvasHost } from './host.ts'

const PEN_SVG = (badge: string): string =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
  `<g fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'>` +
  `<path d='M2 2 6.5 13.5 11 15 15 11 13.5 6.5Z'/><path d='M11 15l4.5 4.5 4-4L15 11'/></g>` +
  `<path d='M2 2l5.3 5.3' stroke='black' stroke-width='1'/>` +
  `<circle cx='8.2' cy='8.2' r='1.3' fill='black'/>${badge}</svg>`

const penCursors = new Map<string, string>()

/** CSS cursor for the pen tool: a nib with its tip at the hotspot (`add`: a point on a path,
 *  `close`: closing the path on its first point). */
export function penCursor(kind: 'draw' | 'add' | 'close' = 'draw'): string {
  const cached = penCursors.get(kind)
  if (cached) return cached
  const badge =
    kind === 'add'
      ? `<path d='M19 2v6M16 5h6' stroke='white' stroke-width='3'/><path d='M19 2v6M16 5h6' stroke='black' stroke-width='1.3'/>`
      : kind === 'close'
        ? `<circle cx='19' cy='5' r='2.6' fill='white' stroke='black' stroke-width='1.3'/>`
        : ''
  const css = `url("data:image/svg+xml,${encodeURIComponent(PEN_SVG(badge))}") 2 2, crosshair`
  penCursors.set(kind, css)
  return css
}

/** Screen px within which a click on the first point closes the path. */
export const CLOSE_PX = 6

/** Default paint of pen-drawn vectors (contract 2.6). */
export const PEN_STYLES: Styles = { fill: 'none', stroke: '#000000', strokeWidth: 1 }

/** A point being drawn, in world coordinates (handles relative to the anchor). */
export interface DraftPoint {
  x: number
  y: number
  in?: [number, number]
  out?: [number, number]
  mode?: 'corner' | 'smooth'
}

/** Pen-drawn points → node-local vector data and box, in the containing block's axes. */
export function draftToVector(
  points: readonly DraftPoint[],
  closed: boolean,
  cb: NodeFrame,
  subpathId: string,
): { vector: VectorData; box: { x: number; y: number; width: number; height: number } } | null {
  if (points.length < 2) return null
  const local: VectorPoint[] = points.map((p) => {
    const q = worldToLocal(cb, p)
    const out: VectorPoint = { x: q.x, y: q.y }
    const rot = (h: [number, number]): [number, number] => {
      const r = rotatePoint({ x: h[0], y: h[1] }, { x: 0, y: 0 }, -cb.rotation)
      return [r.x, r.y]
    }
    if (p.in) out.in = rot(p.in)
    if (p.out) out.out = rot(p.out)
    if (p.mode && p.mode !== 'corner') out.mode = p.mode
    return out
  })
  const raw: VectorData = {
    fillRule: 'nonzero',
    subpaths: [{ id: subpathId, closed, points: local }],
  }
  const b = vectorBounds(raw)
  if (!b) return null
  const shifted: VectorData = {
    fillRule: 'nonzero',
    subpaths: [
      {
        id: subpathId,
        closed,
        points: local.map((p) => {
          const q: VectorPoint = { ...p, x: round3(p.x - b.x), y: round3(p.y - b.y) }
          if (p.in) q.in = [round3(p.in[0]), round3(p.in[1])]
          if (p.out) q.out = [round3(p.out[0]), round3(p.out[1])]
          return q
        }),
      },
    ],
  }
  return {
    vector: shifted,
    box: { x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height) },
  }
}

function round3(n: number): number {
  const r = Math.round(n * 1000) / 1000
  return r === 0 ? 0 : r
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

/**
 * The pen tool (contract 5.2): click adds a corner point, click-drag a smooth point (Alt
 * breaks the handle symmetry), clicking the first point closes the path; Enter/Escape finish.
 * The path is created in one `createNode` (`canvas:pen`) in the insertion target of the first
 * click; the tool returns to select with the new vector selected.
 */
export class PenTool {
  private points: DraftPoint[] = []
  private target: InsertTarget | null = null
  private pointer: Point | null = null
  private closing = false

  constructor(private readonly host: CanvasHost) {}

  get active(): boolean {
    return this.points.length > 0
  }

  /** Overlay state (world coordinates). */
  overlay(): PenOverlay | null {
    if (this.points.length === 0) return null
    return {
      points: this.points.map((p) => {
        const o: PenOverlay['points'][number] = { x: p.x, y: p.y }
        if (p.in) o.in = { x: p.x + p.in[0], y: p.y + p.in[1] }
        if (p.out) o.out = { x: p.x + p.out[0], y: p.y + p.out[1] }
        return o
      }),
      pointer: this.pointer,
      closing: this.closing,
    }
  }

  private nearFirst(world: Point): boolean {
    const first = this.points[0]
    if (!first || this.points.length < 2) return false
    const z = this.host.viewport().zoom
    return Math.hypot(first.x - world.x, first.y - world.y) * z <= CLOSE_PX
  }

  /** Pointer moved without a button (rubber band). Returns the cursor to show. */
  hover(world: Point | null): string {
    this.pointer = world
    this.closing = world !== null && this.nearFirst(world)
    this.sync()
    return penCursor(this.closing ? 'close' : 'draw')
  }

  private sync(): void {
    this.host.gestureOverlay.pen = this.overlay()
    this.host.requestFrame()
  }

  /** A press with the pen tool: adds (or closes on) a point; dragging shapes its handles. */
  press(e: PointerEvent, target: () => InsertTarget): BaseGesture {
    const host = this.host
    const w = host.toWorld(host.local(e))
    if (this.nearFirst(w)) {
      this.finish(true)
      return new DoneGesture(host)
    }
    if (this.points.length === 0) this.target = target()
    const point: DraftPoint = { x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100 }
    this.points.push(point)
    this.pointer = w
    this.closing = false
    this.sync()
    return new PenHandleGesture(host, e, point, () => this.sync())
  }

  /** Enter / Escape / tool change: create the vector when it has at least 2 points. */
  finish(closed = false): string | null {
    const points = this.points
    const target = this.target
    this.points = []
    this.target = null
    this.pointer = null
    this.closing = false
    this.host.gestureOverlay.pen = null
    this.host.requestFrame()
    if (points.length < 2 || !target || this.host.isReadOnly()) return null
    const host = this.host
    const scenes = host.scenes
    const pageId = scenes.pageId
    const cb: NodeFrame =
      target.parentId === null
        ? rectFrame({ x: 0, y: 0, width: 0, height: 0 })
        : (target.cbFrame ??
          rectFrame(
            target.containingBlock ?? target.parentRect ?? { x: 0, y: 0, width: 0, height: 0 },
          ))
    const made = draftToVector(points, closed, cb, newSubpathId())
    if (!made) return null
    const { vector, box } = made
    const w = round2(box.width)
    const h = round2(box.height)
    let styles: Styles
    if (target.parentId === null)
      styles = { left: round2(box.x), top: round2(box.y), width: w, height: h }
    else if (target.flex) styles = { width: w, height: h, flexShrink: 0 }
    else
      styles = {
        position: 'absolute',
        left: round2(box.x),
        top: round2(box.y),
        width: w,
        height: h,
      }
    const first = points[0] as DraftPoint
    const index = flowIndexFor(host, target, first)
    const id = transact(
      host.doc,
      () =>
        createNode(host.doc, {
          type: 'vector',
          parentId: target.parentId ?? pageId,
          ...(index !== undefined ? { index } : {}),
          name: 'Vector',
          styles: { ...styles, ...PEN_STYLES },
          vector,
        }),
      { origin: ORIGIN.pen },
    )
    host.setSelection([id])
    host.setTool('select')
    return id
  }

  /** Drop the draft without creating anything. */
  cancel(): void {
    this.points = []
    this.target = null
    this.pointer = null
    this.closing = false
    this.host.gestureOverlay.pen = null
    this.host.requestFrame()
  }
}

/** Drag after placing a pen point: sets its handles. */
class PenHandleGesture extends BaseGesture {
  readonly kind = 'pen'
  private readonly startScreen: Point
  private dragging = false

  constructor(
    host: CanvasHost,
    e: PointerEvent,
    private readonly point: DraftPoint,
    private readonly sync: () => void,
  ) {
    super(host)
    this.startScreen = host.local(e)
  }

  move(e: PointerEvent): void {
    const p = this.host.local(e)
    if (
      !this.dragging &&
      Math.hypot(p.x - this.startScreen.x, p.y - this.startScreen.y) < DRAG_THRESHOLD
    )
      return
    this.dragging = true
    const w = this.host.toWorld(p)
    const out: [number, number] = [
      Math.round((w.x - this.point.x) * 100) / 100,
      Math.round((w.y - this.point.y) * 100) / 100,
    ]
    this.point.out = out
    if (e.altKey) {
      // Alt breaks the symmetry: the in handle stays where it was.
      this.point.mode = 'corner'
    } else {
      this.point.in = [-out[0], -out[1]]
      this.point.mode = 'smooth'
    }
    this.sync()
  }

  up(): void {
    this.done = true
  }
}

/** A press that only ends (the closing click). */
class DoneGesture extends BaseGesture {
  readonly kind = 'pen'
  move(): void {}
  up(): void {
    this.done = true
  }
}
