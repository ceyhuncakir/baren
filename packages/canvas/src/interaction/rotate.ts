import { readRotation, rotateNodes, type NodeFrame } from '@baren/schema'
import { ORIGIN } from '../doc/ops.ts'
import {
  angleAround,
  deltaInParent,
  frameAabb,
  frameCenter,
  framesAabb,
  normalizeAngle,
  rotateFrameAbout,
  snapAngle,
} from '../math/frame.ts'
import { isVirtualRef, type NodeElement } from '../render/scene.ts'
import { isAbsolutelyPositioned } from '../render/styles.ts'
import type { Point, Rect } from '../types.ts'
import { BaseGesture } from './gestures.ts'
import type { CanvasHost } from './host.ts'

interface RotateEntry {
  id: string
  frame: NodeFrame
  /** Own rotation (styles) at the start. */
  own: number
  /** Positioned nodes move around the pivot; flow and instance content only turn. */
  positioned: boolean
  isTop: boolean
  parentRot: number
  el: NodeElement | null
}

/**
 * Rotation from the zones outside the selection corners (contract 5.2). One node turns about
 * its centre (Shift snaps the resulting angle to 15°); several turn about the centre of their
 * union box (Shift snaps the delta). Transform-only preview, one `rotateNodes` commit
 * (`canvas:rotate`). Peers see the gesture as `resize` transients with axis-aligned bounds.
 */
export class RotateGesture extends BaseGesture {
  readonly kind = 'rotate'
  private readonly entries: RotateEntry[]
  private readonly pivot: Point
  private readonly startAngle: number
  private delta = 0
  private moved = false
  private finishing = false
  private frames = new Map<string, NodeFrame>()

  private constructor(host: CanvasHost, e: PointerEvent, entries: RotateEntry[], pivot: Point) {
    super(host)
    this.entries = entries
    this.pivot = pivot
    this.startAngle = angleAround(pivot, this.world(e))
    for (const en of entries)
      host.scenes.setPreviewing(host.scenes.topLevelOf(en.id) ?? en.id, true)
  }

  static create(host: CanvasHost, e: PointerEvent, ids: readonly string[]): RotateGesture | null {
    const scenes = host.scenes
    const entries: RotateEntry[] = []
    for (const id of ids) {
      const info = scenes.info(id)
      const frame = scenes.frameOf(id)
      if (!info || !frame || info.locked || info.type === 'page') continue
      const parentRot = info.isTop ? 0 : (scenes.frameOf(info.parentId ?? '')?.rotation ?? 0)
      const parentType = info.isTop ? 'page' : scenes.typeOf(info.parentId ?? '')
      entries.push({
        id,
        frame,
        own: readRotation(info.styles),
        positioned:
          !isVirtualRef(id) &&
          (info.isTop || parentType === 'group' || isAbsolutelyPositioned(info.styles)),
        isTop: info.isTop,
        parentRot,
        el: scenes.elementOf(id),
      })
    }
    if (entries.length === 0) return null
    const pivot =
      entries.length === 1
        ? frameCenter((entries[0] as RotateEntry).frame)
        : (() => {
            const u = framesAabb(entries.map((en) => en.frame)) as Rect
            return { x: u.x + u.width / 2, y: u.y + u.height / 2 }
          })()
    return new RotateGesture(host, e, entries, pivot)
  }

  move(e: PointerEvent): void {
    const raw = normalizeAngle(angleAround(this.pivot, this.world(e)) - this.startAngle)
    const single = this.entries.length === 1 ? (this.entries[0] as RotateEntry) : null
    let label: number
    if (single) {
      const target = normalizeAngle(single.own + raw)
      const result = e.shiftKey ? normalizeAngle(snapAngle(target)) : target
      this.delta = normalizeAngle(result - single.own)
      label = result
    } else {
      this.delta = e.shiftKey ? snapAngle(raw) : raw
      label = this.delta
    }
    this.frames = new Map(
      this.entries.map((en) => [
        en.id,
        en.positioned
          ? rotateFrameAbout(en.frame, this.pivot, this.delta)
          : { ...en.frame, rotation: normalizeAngle(en.frame.rotation + this.delta) },
      ]),
    )
    this.moved = true
    const p = this.host.local(e)
    this.host.gestureOverlay.angle = { text: `${Math.round(label)}°`, at: p }
    this.host.emitTransient({
      kind: 'resize',
      nodes: [...this.frames].map(([id, f]) => ({ id, rect: frameAabb(f) })),
    })
    this.host.requestFrame()
  }

  up(): void {
    if (this.moved && this.delta !== 0) {
      const host = this.host
      rotateNodes(
        host.doc,
        this.entries.map((en) => en.id),
        this.delta,
        host.geometry(),
        { pivot: this.pivot, origin: ORIGIN.rotate },
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
    this.host.gestureOverlay.angle = null
    this.host.requestFrame()
  }

  override write(): void {
    const scenes = this.host.scenes
    if (this.finishing) {
      for (const en of this.entries) {
        const top = scenes.topLevelOf(en.id) ?? en.id
        if (en.isTop) scenes.setPreviewOffset(en.id, null)
        if (en.el) {
          en.el.style.translate = ''
          scenes.reapplyStyles(en.id, ['rotate', 'translate'])
        }
        scenes.setPreviewing(top, false)
      }
      this.done = true
      return
    }
    if (!this.moved) return
    for (const en of this.entries) {
      const f = this.frames.get(en.id)
      if (!f) continue
      const c0 = frameCenter(en.frame)
      const c1 = frameCenter(f)
      const rotate = `${normalizeAngle(en.own + this.delta)}deg`
      if (en.isTop) {
        scenes.setPreviewOffset(en.id, { x: c1.x - c0.x, y: c1.y - c0.y })
        scenes.setPreviewRotation(en.id, normalizeAngle(en.own + this.delta))
        continue
      }
      const el = en.el
      if (!el) continue
      el.style.rotate = rotate
      if (en.positioned) {
        const d = deltaInParent(c1.x - c0.x, c1.y - c0.y, en.parentRot)
        el.style.translate = `${d.x}px ${d.y}px`
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
}
