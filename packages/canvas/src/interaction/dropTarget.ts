import type { LoroDoc } from 'loro-crdt'
import { canReparent, pointInFrame, type NodeFrame } from '@baren/schema'
import { nodeContains, type IndexedNode } from '../math/hit.ts'
import { containsPoint } from '../math/rect.ts'
import type { SceneManager } from '../render/sceneManager.ts'
import { isVirtualRef } from '../render/scene.ts'
import { flexDirectionOf, type FlexDirection } from '../render/styles.ts'
import { topFrame } from '../render/topRecord.ts'
import type { Point, Rect } from '../types.ts'

/** A frame that can receive dropped / dragged layers. */
export interface FrameTarget {
  id: string
  /** World frame (rotated frames keep their rotation). */
  frame: NodeFrame
  /** World axis-aligned bounds. */
  bounds: Rect
  flex: FlexDirection | null
  type: 'frame' | 'group'
}

export interface FrameTargetOptions {
  /** Dragged nodes: they and their descendants are never targets. */
  exclude?: ReadonlySet<string>
  /** Counts as a candidate even when it is a group (the dragged nodes' current parent). */
  keepParent?: string | null
  /** Extra check (component cycles, …); a rejected candidate falls back to shallower ones. */
  accept?: (id: string) => boolean
  /** Only top-level frames (artboards), as files dropped without `deep`. */
  topOnly?: boolean
}

/**
 * Finds drop targets with the spatial indexes (no DOM reads): the top-most frame under a world
 * point that is not dragged, not inside a dragged node, not locked or hidden (nor inside such a
 * node), not inside an instance and accepted. Eligibility is cached per finder (one gesture).
 */
export class DropTargetFinder {
  private readonly eligible = new Map<string, boolean>()

  constructor(
    private readonly scenes: SceneManager,
    private readonly doc: LoroDoc,
    private readonly opts: FrameTargetOptions = {},
    /** Ids being moved (for the reparent cycle check), or null. */
    private readonly moving: readonly string[] | null = null,
  ) {}

  private isEligible(id: string): boolean {
    const cached = this.eligible.get(id)
    if (cached !== undefined) return cached
    const ok = this.check(id)
    this.eligible.set(id, ok)
    return ok
  }

  private check(id: string): boolean {
    const scenes = this.scenes
    if (isVirtualRef(id)) return false
    const type = scenes.typeOf(id)
    const keep = this.opts.keepParent === id
    if (type !== 'frame' && !(keep && type === 'group')) return false
    const exclude = this.opts.exclude
    // The node and its ancestors: not dragged, locked or hidden.
    let cur: string | null = id
    let guard = 0
    while (cur !== null && cur !== scenes.pageId && guard++ < 10_000) {
      if (exclude?.has(cur)) return false
      const info = scenes.info(cur)
      if (!info || info.locked || info.hidden) return false
      cur = info.parentId
    }
    if (this.opts.accept && !this.opts.accept(id)) return false
    if (this.moving && !keep && !canReparent(this.doc, this.moving, id).ok) return false
    return true
  }

  /** The target under world point `p`, or null (the page). */
  at(p: Point): FrameTarget | null {
    const scenes = this.scenes
    for (const { rec, items } of scenes.indexAt(p)) {
      if (this.opts.topOnly) {
        const inside =
          rec.rotation === 0 ? containsPoint(rec.bounds, p) : pointInFrame(topFrame(rec), p)
        if (!inside) continue
        if (rec.type === 'frame' && this.isEligible(rec.id)) return this.target(rec.id)
        return null
      }
      if (items.length > 0) {
        let best: IndexedNode | null = null
        for (const it of items) {
          if (!nodeContains(it, p)) continue
          if (
            best &&
            (it.order < best.order || (it.order === best.order && it.depth <= best.depth))
          )
            continue
          if (!this.isEligible(it.id)) continue
          best = it
        }
        if (best) return this.target(best.id)
        // Something of this top-level node is under the point but no eligible frame: look below.
        continue
      }
      // Not live or not measured: only the top-level box is known.
      const inside =
        rec.rotation === 0 ? containsPoint(rec.bounds, p) : pointInFrame(topFrame(rec), p)
      if (inside && rec.type === 'frame' && this.isEligible(rec.id)) return this.target(rec.id)
    }
    return null
  }

  private target(id: string): FrameTarget | null {
    const scenes = this.scenes
    const frame = scenes.frameOf(id)
    const bounds = scenes.boundsOf(id)
    const info = scenes.info(id)
    if (!frame || !bounds || !info) return null
    return {
      id,
      frame,
      bounds,
      flex: info.type === 'frame' ? flexDirectionOf(info.styles) : null,
      type: info.type === 'group' ? 'group' : 'frame',
    }
  }
}
