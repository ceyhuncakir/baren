import type { NodeFrame } from '@baren/schema'
import type { RemotePresence, Rect, Viewport } from '../types.ts'
import type { Gesture, GestureOverlay } from '../interaction/host.ts'
import { intersects, unionRects } from '../math/rect.ts'
import { plainSizeLabel, sizeLabel } from '../math/sizeLabel.ts'
import { isVirtualRef } from '../render/scene.ts'
import type { SceneManager } from '../render/sceneManager.ts'
import { flexDirectionOf } from '../render/styles.ts'
import { topAabb } from '../render/topRecord.ts'
import {
  emptyOverlayModel,
  type OverlayModel,
  type PenOverlay,
  type VectorEditOverlay,
} from './overlay.ts'
import type { IncomingOverlay } from './incoming.ts'

/* ---------------------------------------------------------------- agents (Phase 4 §10.4) */

/** Display name of an agent presence entry ("Agent" when it has none). */
function agentName(r: RemotePresence): string {
  return (r.badge ?? r.name).trim() || 'Agent'
}

/**
 * The agents working on each top-level artboard of this page: `kind: 'agent'` entries keep
 * only the ids of their `selection` (working set) that `isTop` accepts, grouped by artboard
 * with each name once, in presence order. Cursors and colours of agents are ignored.
 */
export function agentWork(
  remotes: readonly RemotePresence[],
  isTop: (id: string) => boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const r of remotes) {
    if (r.kind !== 'agent') continue
    const name = agentName(r)
    for (const id of r.selection) {
      if (!isTop(id)) continue
      const names = out.get(id)
      if (!names) out.set(id, [name])
      else if (!names.includes(name)) names.push(name)
    }
  }
  return out
}

/** The island text: "Claude Code", "Claude Code & Cursor", "A, B & C". */
export function agentBadgeText(names: readonly string[]): string {
  const list = names.length > 0 ? names : ['Agent']
  if (list.length === 1) return list[0] as string
  return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`
}

export interface OverlayInput {
  viewport: Viewport
  scenes: SceneManager
  pageId: string
  selection: readonly string[]
  hoverId: string | null
  editingId: string | null
  gesture: Gesture | null
  gestureOverlay: GestureOverlay
  remotes: readonly RemotePresence[]
  showHandles: boolean
  /** Artboard highlighted as a file drop target. */
  drop?: Rect | NodeFrame | null
  pen?: PenOverlay | null
  vector?: VectorEditOverlay | null
  /** World frame of the main component of the selected instance (outlined 2 px outside). */
  mainOutline?: NodeFrame | null
  /** Layers an agent just added (placeholders, already timed by the controller). */
  incoming?: readonly IncomingOverlay[]
}

/** World frames of the selection (gesture previews win over measured frames). */
export function selectionFrames(
  scenes: SceneManager,
  selection: readonly string[],
  gesture: Gesture | null,
): NodeFrame[] {
  const preview = gesture?.previewFrames?.()
  const rects = preview ? null : gesture?.previewRects()
  const out: NodeFrame[] = []
  for (const id of selection) {
    const p = preview?.get(id)
    if (p) {
      out.push(p)
      continue
    }
    const r = rects?.get(id)
    if (r) {
      out.push({ ...r, rotation: 0 })
      continue
    }
    const f = scenes.frameOf(id)
    if (f) out.push(f)
  }
  return out
}

/** Whether the selection belongs to a component (main, instance or instance content). */
export function isComponentSelection(scenes: SceneManager, selection: readonly string[]): boolean {
  if (selection.length === 0) return false
  return selection.every((id) => {
    if (isVirtualRef(id)) return true
    const info = scenes.info(id)
    return info !== null && (info.type === 'instance' || info.componentKey !== undefined)
  })
}

/** World rects of the selection (gesture previews win over measured bounds). */
export function selectionRects(
  scenes: SceneManager,
  selection: readonly string[],
  gesture: Gesture | null,
): Rect[] {
  const preview = gesture?.previewRects()
  const out: Rect[] = []
  for (const id of selection) {
    const r = preview?.get(id) ?? scenes.boundsOf(id)
    if (r) out.push(r)
  }
  return out
}

function selectionSizeLabel(
  scenes: SceneManager,
  selection: readonly string[],
  rects: Rect[],
  box: Rect,
  frame?: NodeFrame,
): string {
  if (selection.length === 1 && rects.length === 1) {
    const info = scenes.info(selection[0] as string)
    if (info) {
      const parent = info.parentId && !info.isTop ? scenes.info(info.parentId) : null
      // Rotated nodes report their own (unrotated) size.
      const size = frame && frame.rotation !== 0 ? frame : box
      return sizeLabel(info.styles, size, {
        type: info.type,
        isTop: info.isTop,
        parentFlexDirection: parent ? flexDirectionOf(parent.styles) : null,
      })
    }
  }
  return plainSizeLabel(box)
}

/** Artboards smaller than this on screen (CSS px) keep their edges (see Overlay.drawEdges). */
const EDGE_MIN_CSS_SIZE = 12

/** Everything the overlay draws this frame, in world coordinates. */
export function buildOverlayModel(input: OverlayInput): OverlayModel {
  const { scenes, gesture, viewport: v } = input
  const model = emptyOverlayModel(v)
  if (input.incoming) model.incoming = [...input.incoming]
  const preview = gesture?.previewRects()
  const selected = new Set(input.selection)
  const hoverTop = input.hoverId && scenes.records.has(input.hoverId) ? input.hoverId : null
  const work = agentWork(input.remotes, (id) => scenes.records.has(id))
  for (const rec of scenes.visibleTops(v)) {
    const names = work.size > 0 ? work.get(rec.id) : undefined
    if ((rec.type === 'frame' || rec.type === 'instance') && rec.rotation === 0) {
      const box = preview?.get(rec.id) ?? scenes.boundsOf(rec.id) ?? rec.bounds
      // Big enough on screen to snap (the overlay checks device px), and not where another
      // top-level layer overlaps it: snapping would cut into that layer.
      const onScreen = Math.min(box.width, box.height) * v.zoom >= EDGE_MIN_CSS_SIZE
      if (
        onScreen &&
        !scenes.topsInRect(box).some((o) => o !== rec && !o.hidden && intersects(topAabb(o), box))
      )
        model.edges.push(box)
    }
    if (rec.type !== 'frame' && !names) continue
    const bounds = preview?.get(rec.id) ?? scenes.boundsOf(rec.id) ?? rec.bounds
    const badge = names ? agentBadgeText(names) : undefined
    if (badge !== undefined) model.agents.push({ id: rec.id, bounds, badge })
    if (rec.type !== 'frame') continue
    const label: OverlayModel['labels'][number] = {
      id: rec.id,
      name: rec.name,
      bounds,
      active: selected.has(rec.id) || hoverTop === rec.id,
    }
    if (rec.componentKey !== null) label.component = true
    if (badge !== undefined) label.badge = badge
    model.labels.push(label)
  }
  const rects = selectionRects(scenes, input.selection, gesture)
  const frames = selectionFrames(scenes, input.selection, gesture)
  const box = unionRects(rects)
  model.selectionRects = frames.length === rects.length ? frames : rects
  // Component colour for mains, instances and their content (blue while dragging, artboard 33).
  model.componentAccent = gesture?.kind !== 'move' && isComponentSelection(scenes, input.selection)
  if (input.editingId) {
    model.editing = scenes.frameOf(input.editingId) ?? scenes.boundsOf(input.editingId)
  } else if (box && !input.vector) {
    model.selectionBox = box
    const single = frames.length === 1 && input.selection.length === 1 ? frames[0] : undefined
    model.selectionFrame = single ?? { ...box, rotation: 0 }
    model.handles = input.showHandles
    // The live angle pill replaces the size pill while rotating (artboard 29).
    model.sizeLabel =
      gesture?.kind === 'rotate'
        ? null
        : (gesture?.sizeLabel() ?? selectionSizeLabel(scenes, input.selection, rects, box, single))
  }
  if (model.componentAccent && !gesture) model.mainOutline = input.mainOutline ?? null
  if (input.hoverId && !selected.has(input.hoverId) && (!gesture || gesture.kind === 'press')) {
    model.hover = scenes.frameOf(input.hoverId) ?? scenes.boundsOf(input.hoverId)
  }
  const g = input.gestureOverlay
  model.marquee = g.marquee
  model.guides = g.guides
  model.insertion = g.insertion
  model.draft = g.draft
  model.draftLabel = g.draftLabel
  model.drop = g.drop ?? input.drop ?? null
  model.angle = g.angle
  model.pen = input.pen ?? g.pen
  model.vector = input.vector ?? null
  for (const r of input.remotes) {
    if (r.kind === 'agent') continue
    if (r.pageId !== null && r.pageId !== input.pageId) continue
    const rs: (Rect | NodeFrame)[] = []
    for (const id of r.selection) {
      const b = scenes.frameOf(id) ?? scenes.boundsOf(id)
      if (b) rs.push(b)
    }
    model.remotes.push({
      name: r.name,
      color: r.color,
      cursor: r.cursor,
      rects: rs,
      ghosts: r.transient?.nodes.map((n) => n.rect) ?? [],
    })
  }
  return model
}
