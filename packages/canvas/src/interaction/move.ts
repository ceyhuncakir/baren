import {
  reparentNodes,
  rotateOnlyTransform,
  transact,
  type NodeFrame,
  type ReparentMove,
  type StyleValue,
} from '@baren/schema'
import { ORIGIN, commitGeometry, commitReorder, type GeometryPatch } from '../doc/ops.ts'
import { readStyleValues } from '../doc/read.ts'
import { deltaInParent, translateFrame } from '../math/frame.ts'
import { inflate, translate, unionRects } from '../math/rect.ts'
import { snapMove } from '../math/snap.ts'
import { NODE_ID_ATTR, isVirtualRef, type NodeElement } from '../render/scene.ts'
import {
  flexDirectionOf,
  isAbsolutelyPositioned,
  pxValue,
  type FlexDirection,
} from '../render/styles.ts'
import type { Point, Rect } from '../types.ts'
import { DropTargetFinder, type FrameTarget } from './dropTarget.ts'
import { BaseGesture, SNAP_PX, flowDropIndex, flowSiblings } from './gestures.ts'
import type { CanvasHost } from './host.ts'

interface MoveEntry {
  id: string
  kind: 'top' | 'abs' | 'flow'
  /** World axis-aligned bounds at the start. */
  start: Rect
  /** World frame at the start. */
  frame: NodeFrame
  left: number
  top: number
  parentId: string | null
  /** World rotation of the parent (positions are in its local axes). */
  parentRot: number
  virtual: boolean
  el: NodeElement | null
}

/** Inherited text properties copied onto drag-layer clones (they leave their ancestors). */
const INHERITED = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'line-height',
  'color',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-decoration',
  'font-variant',
  'direction',
] as const

/**
 * Move gesture. Top-level nodes preview by offsetting their wrapper; nested nodes are shown
 * as clones in a world-space drag layer (not clipped by their old parent) while the original
 * keeps its space hidden. Every pointer move picks a drop target (contract 5.2): the top-most
 * eligible frame under the pointer (the dragged nodes' own group counts), else the page;
 * Ctrl/⌘ keeps the parent. Pointer up commits once: a plain move/reorder when the target is
 * the current parent, otherwise one `reparentNodes` (`canvas:reparent`).
 */
export class MoveGesture extends BaseGesture {
  readonly kind = 'move'
  private readonly entries: MoveEntry[]
  private readonly startWorld: Point
  private readonly union: Rect | null
  private candidates = new Map<string, Rect[]>()
  private delta: Point = { x: 0, y: 0 }
  private finishing = false
  private readonly flowParent: string | null
  private readonly flowDir: FlexDirection
  private flowIndex: number | null = null
  private readonly flowIds: string[]
  private readonly ids: Set<string>
  private readonly finder: DropTargetFinder | null
  /** Drop target of the last move: a frame, `'page'`, or null (stay in the current parent). */
  private target: FrameTarget | 'page' | null = null
  private targetIndex: number | undefined = undefined
  private layer: HTMLDivElement | null = null
  private readonly clones = new Map<string, Element>()

  private constructor(
    host: CanvasHost,
    e: PointerEvent,
    entries: MoveEntry[],
    flowParent: string | null,
  ) {
    super(host)
    this.entries = entries
    this.startWorld = this.world(e)
    this.union = unionRects(entries.filter((en) => en.kind !== 'flow').map((en) => en.start))
    this.flowParent = flowParent
    const parentStyles = flowParent ? host.scenes.info(flowParent)?.styles : undefined
    this.flowDir = (parentStyles && flexDirectionOf(parentStyles)) ?? 'column'
    this.flowIds = entries.filter((en) => en.kind === 'flow').map((en) => en.id)
    this.ids = new Set(entries.map((en) => en.id))
    const reparentable =
      !host.isReadOnly() &&
      entries.every((en) => !en.virtual) &&
      !entries.some((en) => en.kind === 'top' && host.scenes.typeOf(en.id) === 'frame')
    const parents = new Set(entries.map((en) => en.parentId))
    const common = parents.size === 1 ? [...parents][0] : null
    const keepParent =
      common !== null && common !== undefined && host.scenes.typeOf(common) === 'group'
        ? common
        : null
    this.finder = reparentable
      ? new DropTargetFinder(
          host.scenes,
          host.doc,
          { exclude: this.ids, keepParent },
          entries.map((en) => en.id),
        )
      : null
    host.setCursor('default')
  }

  /** Build a move for `ids`; null when nothing can move (locked/unmeasured). */
  static create(host: CanvasHost, e: PointerEvent, ids: readonly string[]): MoveGesture | null {
    const entries: MoveEntry[] = []
    let flowParent: string | null = null
    const scenes = host.scenes
    for (const id of ids) {
      const info = scenes.info(id)
      const start = scenes.boundsOf(id)
      const frame = scenes.frameOf(id)
      if (!info || !start || !frame || info.locked) continue
      const virtual = isVirtualRef(id)
      const el = scenes.elementOf(id)
      const parentRot = info.isTop ? 0 : (scenes.frameOf(info.parentId ?? '')?.rotation ?? 0)
      const base = { id, start, frame, el, virtual, parentId: info.parentId, parentRot }
      // Positions come from Loro: the rendered mirror catches up only on the next frame.
      const pos = virtual ? info.styles : readStyleValues(host.doc, id, ['left', 'top'])
      if (info.isTop) {
        entries.push({
          ...base,
          kind: 'top',
          left: pxValue(pos['left']) ?? frame.x,
          top: pxValue(pos['top']) ?? frame.y,
        })
      } else if (isAbsolutelyPositioned(info.styles)) {
        const left = pxValue(pos['left'])
        const top = pxValue(pos['top'])
        if (left === null || top === null) continue
        entries.push({ ...base, kind: 'abs', left, top })
      } else {
        // Flow content of an instance does not move (contract 2.7.3).
        if (virtual) continue
        if (flowParent === null) flowParent = info.parentId
        if (info.parentId !== flowParent) continue
        entries.push({ ...base, kind: 'flow', left: 0, top: 0 })
      }
    }
    return entries.length > 0 ? new MoveGesture(host, e, entries, flowParent) : null
  }

  /** Snap candidates for moving into `parentId` (siblings + parent, or nearby artboards). */
  private snapCandidates(parentId: string | null): Rect[] {
    const key = parentId ?? ''
    const cached = this.candidates.get(key)
    if (cached) return cached
    const v = this.host.viewport()
    const near = this.union ? inflate(this.union, v.width / v.zoom, v.height / v.zoom) : null
    let out: Rect[] = []
    if (near) {
      const scenes = this.host.scenes
      if (parentId === null || parentId === scenes.pageId) {
        out = scenes
          .topsInRect(near)
          .filter((r) => !this.ids.has(r.id) && !r.hidden)
          .map((r) => scenes.boundsOf(r.id) ?? r.bounds)
      } else {
        const parentRect = scenes.boundsOf(parentId)
        if (parentRect) out.push(parentRect)
        for (const c of scenes.childrenWithBounds(parentId) ?? [])
          if (!this.ids.has(c.id) && !c.hidden) out.push(c.bounds)
      }
    }
    this.candidates.set(key, out)
    return out
  }

  /** Parent the nodes would end up in (for snapping), before the commit. */
  private snapParent(): string | null {
    const t = this.target
    if (t === 'page') return this.host.scenes.pageId
    if (t) return t.id
    return this.entries[0]?.parentId ?? null
  }

  move(e: PointerEvent): void {
    const w = this.world(e)
    let dx = w.x - this.startWorld.x
    let dy = w.y - this.startWorld.y
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0
      else dx = 0
    }
    const keep = e.ctrlKey || e.metaKey
    const overlay = this.host.gestureOverlay
    overlay.guides = []
    overlay.insertion = null
    overlay.drop = null
    // Drop target (Ctrl/⌘ keeps the parent).
    this.target = null
    if (this.finder && !keep) {
      const t = this.finder.at(w)
      const parents = new Set(this.entries.map((en) => en.parentId))
      const sameParent = parents.size === 1 && parents.has(t ? t.id : this.host.scenes.pageId)
      this.target = sameParent ? null : (t ?? 'page')
      if (t && t.type === 'frame') overlay.drop = t.frame.rotation !== 0 ? t.frame : t.bounds
    }
    if (this.union && !keep) {
      const snap = snapMove(
        translate(this.union, dx, dy),
        this.snapCandidates(this.snapParent()),
        SNAP_PX / this.host.viewport().zoom,
      )
      if (!e.shiftKey || dy === 0) dx += snap.dx
      if (!e.shiftKey || dx === 0) dy += snap.dy
      overlay.guides = snap.guides
    }
    this.delta = { x: Math.round(dx), y: Math.round(dy) }
    // Insertion line: a flex target, or reordering inside the current flex parent.
    this.targetIndex = undefined
    this.flowIndex = null
    const t = this.target
    if (t && t !== 'page' && t.flex) {
      const drop = flowDropIndex(flowSiblings(this.host, t.id, this.ids), w, t.flex, t.bounds)
      this.targetIndex = drop.index
      overlay.insertion = { a: drop.a, b: drop.b }
    } else if (t === null && this.flowParent && this.flowIds.length > 0) {
      const siblings = flowSiblings(this.host, this.flowParent, new Set(this.flowIds))
      const drop = flowDropIndex(
        siblings,
        w,
        this.flowDir,
        this.host.scenes.boundsOf(this.flowParent),
      )
      this.flowIndex = drop.index
      overlay.insertion = { a: drop.a, b: drop.b }
    }
    this.host.emitTransient({
      kind: 'move',
      nodes: this.entries.map((en) => ({
        id: en.id,
        rect: translate(en.start, this.delta.x, this.delta.y),
      })),
    })
    this.host.requestFrame()
  }

  private geometryPatches(only?: (en: MoveEntry) => boolean): GeometryPatch[] {
    const { x: dx, y: dy } = this.delta
    const patches: GeometryPatch[] = []
    if (dx === 0 && dy === 0) return patches
    for (const en of this.entries) {
      if (en.kind === 'flow' || (only && !only(en))) continue
      const d = en.kind === 'top' ? { x: dx, y: dy } : deltaInParent(dx, dy, en.parentRot)
      patches.push({ id: en.id, left: en.left + d.x, top: en.top + d.y })
    }
    return patches
  }

  private commitPlain(): void {
    const host = this.host
    const patches = this.geometryPatches()
    const scenes = host.scenes
    if (patches.length > 0)
      commitGeometry(host.doc, patches, ORIGIN.move, {
        geo: host.geometry(),
        resolver: host.resolver,
        current: (id) => (scenes.info(id)?.styles as Record<string, StyleValue>) ?? null,
      })
    if (this.flowParent && this.flowIndex !== null && this.flowIds.length > 0) {
      commitReorder(host.doc, this.flowIds, this.flowParent, this.flowIndex, ORIGIN.reorder)
    }
  }

  up(): void {
    const t = this.target
    if (t === null) this.commitPlain()
    else {
      const host = this.host
      const parentId = t === 'page' ? host.scenes.pageId : t.id
      const { x: dx, y: dy } = this.delta
      const moves: ReparentMove[] = this.entries.map((en) => ({
        id: en.id,
        world: translateFrame(en.frame, dx, dy),
      }))
      const geo = host.geometry()
      let moved: string[] = []
      transact(
        host.doc,
        () => {
          moved = reparentNodes(
            host.doc,
            moves,
            { parentId, ...(this.targetIndex !== undefined ? { index: this.targetIndex } : {}) },
            geo,
          )
          if (moved.length === 0) return
          // Nodes that already were in the target only reorder there: move them too.
          const stay = this.geometryPatches((en) => en.parentId === parentId)
          if (stay.length > 0) commitGeometry(host.doc, stay, ORIGIN.reparent, { geo })
        },
        { origin: ORIGIN.reparent },
      )
      if (moved.length === 0) this.commitPlain()
    }
    this.finish()
  }

  override cancel(): void {
    this.finish()
  }

  private finish(): void {
    this.finishing = true
    this.host.emitTransient(null)
    const overlay = this.host.gestureOverlay
    overlay.guides = []
    overlay.insertion = null
    overlay.drop = null
    this.host.requestFrame()
  }

  /** A world-space copy of a nested node for the drag layer. */
  private makeClone(en: MoveEntry): Element | null {
    const el = en.el
    if (!el || !el.isConnected) return null
    const clone = el.cloneNode(true) as HTMLElement | SVGElement
    clone.removeAttribute(NODE_ID_ATTR)
    for (const d of clone.querySelectorAll(`[${NODE_ID_ATTR}]`)) d.removeAttribute(NODE_ID_ATTR)
    clone.classList.remove('ic-hidden', 'ic-editing')
    clone.removeAttribute('contenteditable')
    const parent = el.parentElement
    const own = (el as HTMLElement).style
    const st = clone.style
    if (parent) {
      const cs = getComputedStyle(parent)
      for (const prop of INHERITED)
        if (!own.getPropertyValue(prop)) st.setProperty(prop, cs.getPropertyValue(prop))
    }
    const f = en.frame
    st.setProperty('inset', 'auto')
    st.setProperty('left', `${f.x}px`)
    st.setProperty('top', `${f.y}px`)
    st.setProperty('width', `${f.width}px`)
    st.setProperty('height', `${f.height}px`)
    st.setProperty('rotate', f.rotation === 0 ? 'none' : `${f.rotation}deg`)
    if (rotateOnlyTransform(own.getPropertyValue('transform')) !== null)
      st.setProperty('transform', 'none')
    st.setProperty('translate', '0px 0px')
    return clone
  }

  override write(): void {
    const scenes = this.host.scenes
    if (this.finishing) {
      for (const en of this.entries) {
        if (en.kind === 'top') scenes.setPreviewOffset(en.id, null)
        else en.el?.classList.remove('ic-drag-src')
      }
      this.layer?.remove()
      this.layer = null
      this.clones.clear()
      this.done = true
      return
    }
    const { x: dx, y: dy } = this.delta
    for (const en of this.entries) {
      if (en.kind === 'top') {
        scenes.setPreviewOffset(en.id, { x: dx, y: dy })
        continue
      }
      let clone = this.clones.get(en.id)
      if (!clone) {
        const made = this.makeClone(en)
        if (!made) continue
        if (!this.layer) {
          this.layer = document.createElement('div')
          this.layer.className = 'ic-drag'
          const world = en.el?.closest('.ic-world')
          ;(world ?? document.body).appendChild(this.layer)
        }
        this.layer.appendChild(made)
        this.clones.set(en.id, made)
        en.el?.classList.add('ic-drag-src')
        clone = made
      }
      ;(clone as HTMLElement).style.translate = `${dx}px ${dy}px`
    }
  }

  override previewRects(): ReadonlyMap<string, Rect> {
    const out = new Map<string, Rect>()
    for (const en of this.entries) out.set(en.id, translate(en.start, this.delta.x, this.delta.y))
    return out
  }

  override previewFrames(): ReadonlyMap<string, NodeFrame> {
    const out = new Map<string, NodeFrame>()
    for (const en of this.entries)
      out.set(en.id, translateFrame(en.frame, this.delta.x, this.delta.y))
    return out
  }
}
