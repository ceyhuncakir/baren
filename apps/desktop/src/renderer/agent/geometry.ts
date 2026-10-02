/**
 * Geometry for agents (contract §5) and artboard placement (§6.21.1).
 *
 * Values come from the declared styles when they are exact (top-level boxes, absolute and group
 * children with px offsets and px sizes), otherwise from a measurement of the node's artboard:
 * the resolved subtree laid out on its own as static DOM with the canvas's rules (`Measurer`,
 * see `measure.ts`), independent of the user's viewport, zoom, virtualisation and level of
 * detail. Without a measurer (Node tests) layout-dependent values are `null`, never guessed.
 */
import {
  docGeometry,
  frameCenter,
  localToWorld,
  readRotation,
  worldToLocal,
  type GeometrySource,
  type NodeFrame,
  type ResolvedNode,
  type StyleValue,
  type Styles,
} from '@baren/schema'
import { artboardOfRef, resolveRef, type DocContext } from './model'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Round to 2 decimals, never `-0`. */
export function round2(n: number): number {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

const PX_RE = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px)?$/i

/** px length of `12`, `"12px"` or `"12"`; null otherwise (auto, %, fit-content, var()…). */
export function toPx(v: StyleValue | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const m = PX_RE.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Placement (§6.21.1)
// ---------------------------------------------------------------------------

export const ARTBOARD_GAP = 80
/** Height assumed for artboards whose height is not known yet (fit-content, unmeasured). */
export const UNKNOWN_HEIGHT = 900

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * Where a new artboard of `size` goes on a page whose top-level nodes cover `existing`: right
 * of the anchor's row (the anchor is the last artboard this agent created there, the source of
 * a duplicate, or the top-most then left-most artboard), 80 px from everything. Pure and
 * deterministic.
 */
export function placeArtboard(
  existing: readonly Rect[],
  anchor: Rect | null,
  size: { width: number; height: number },
): { left: number; top: number } {
  if (existing.length === 0) return { left: 0, top: 0 }
  const a = anchor ?? topLeftMost(existing)
  if (!a) return { left: 0, top: 0 }
  const w = Math.max(0, size.width)
  const h = Math.max(0, size.height)
  const bandTop = a.y
  const bandBottom = a.y + Math.max(a.height, h)
  let right = a.x + a.width
  for (const r of existing) {
    const overlaps = r.y < bandBottom && r.y + r.height > bandTop
    if (overlaps) right = Math.max(right, r.x + r.width)
  }
  let left = right + ARTBOARD_GAP
  const top = a.y
  // Step 3: slide right past anything the candidate (inflated by the gap) touches.
  for (let guard = 0; guard <= existing.length; guard++) {
    const candidate: Rect = {
      x: left - ARTBOARD_GAP,
      y: top - ARTBOARD_GAP,
      width: w + 2 * ARTBOARD_GAP,
      height: h + 2 * ARTBOARD_GAP,
    }
    let moved = false
    for (const r of existing) {
      if (!intersects(candidate, r)) continue
      const next = r.x + r.width + ARTBOARD_GAP
      if (next > left) {
        left = next
        moved = true
      }
    }
    if (!moved) break
  }
  return { left: Math.round(left), top: Math.round(top) }
}

/** The top-most, then left-most rect. */
export function topLeftMost(rects: readonly Rect[]): Rect | null {
  let best: Rect | null = null
  for (const r of rects) {
    if (!best || r.y < best.y || (r.y === best.y && r.x < best.x)) best = r
  }
  return best
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** One node of a measured artboard, in the artboard's unrotated local coordinates. */
export interface MeasuredBox {
  /** Centre of the node's box (rotation-invariant). */
  cx: number
  cy: number
  width: number
  height: number
  /** Rotation relative to the artboard (degrees). */
  rotation: number
}

export interface ArtboardMeasure {
  /** The artboard's own laid-out size. */
  width: number
  height: number
  nodes: ReadonlyMap<string, MeasuredBox>
}

/** Lays out an artboard's subtree on its own (DOM; `measure.ts`). */
export interface Measurer {
  measure(artboardId: string): ArtboardMeasure | null
}

export interface GeometryFields {
  worldX: number | null
  worldY: number | null
  x: number | null
  y: number | null
  width: number | null
  height: number | null
}

const NULL_FIELDS: GeometryFields = {
  worldX: null,
  worldY: null,
  x: null,
  y: null,
  width: null,
  height: null,
}

function isAbsolute(styles: Styles): boolean {
  const p = styles['position']
  return p === 'absolute' || p === 'fixed'
}

/**
 * Geometry of one document for agents. Measurements are cached per artboard until
 * `invalidate()` (called after every agent commit) or until the document's op count moves
 * (remote and user edits).
 */
export class AgentGeometry {
  private cache = new Map<string, ArtboardMeasure | null>()
  private opCount = -1
  private readonly declared: GeometrySource

  constructor(
    private readonly ctx: DocContext,
    private readonly measurer: Measurer | null,
  ) {
    this.declared = docGeometry(ctx.doc, ctx.resolver)
  }

  invalidate(): void {
    this.cache.clear()
    this.opCount = -1
  }

  /** The measurement of an artboard (cached), or null without a measurer. */
  measured(artboardId: string): ArtboardMeasure | null {
    if (!this.measurer) return null
    const ops = this.ctx.doc.opCount()
    if (ops !== this.opCount) {
      this.cache.clear()
      this.opCount = ops
    }
    if (this.cache.has(artboardId)) return this.cache.get(artboardId) ?? null
    let m: ArtboardMeasure | null = null
    try {
      m = this.measurer.measure(artboardId)
    } catch (error) {
      console.warn('[agent] measure failed', error)
    }
    this.cache.set(artboardId, m)
    return m
  }

  /** Measured only when already cached (never lays out). */
  private cachedMeasure(artboardId: string): ArtboardMeasure | null {
    if (this.ctx.doc.opCount() !== this.opCount) return null
    return this.cache.get(artboardId) ?? null
  }

  /** Is the node's top-left exactly known from declared styles? */
  private positionExact(node: ResolvedNode, depth = 0): boolean {
    if (depth > 512) return false
    const s = node.styles
    const parent = node.parentId === null ? undefined : resolveRef(this.ctx, node.parentId)
    if (!parent) return false
    const pxOrAbsent = (k: string) => s[k] === undefined || toPx(s[k]) !== null
    if (parent.type === 'page') return pxOrAbsent('left') && pxOrAbsent('top')
    let own: boolean
    if (parent.type === 'group') own = pxOrAbsent('left') && pxOrAbsent('top')
    else if (parent.type === 'frame' && isAbsolute(s)) {
      own = toPx(s['left']) !== null && toPx(s['top']) !== null
    } else own = false
    if (!own) return false
    if (readRotation(parent.styles) !== 0 && !this.sizeExact(parent).both) return false
    return this.positionExact(parent, depth + 1)
  }

  /** No rotation on the node or any ancestor below the page. */
  private unrotatedChain(node: ResolvedNode): boolean {
    for (let cur: ResolvedNode | undefined = node, i = 0; cur && i < 512; i++) {
      if (cur.type === 'page') return true
      if (readRotation(cur.styles) !== 0) return false
      cur = cur.parentId === null ? undefined : resolveRef(this.ctx, cur.parentId)
    }
    return true
  }

  private sizeExact(node: ResolvedNode): { width: boolean; height: boolean; both: boolean } {
    const width = toPx(node.styles['width']) !== null
    const height = toPx(node.styles['height']) !== null
    return { width, height, both: width && height }
  }

  /**
   * World frame of a node when it can be known (exact declared values, else a measurement);
   * null for pages, unknown nodes and unmeasurable layout-dependent nodes.
   */
  frameOf(ref: string, opts: { measure?: boolean } = {}): NodeFrame | null {
    const node = resolveRef(this.ctx, ref)
    if (!node || node.type === 'page') return null
    const artboard = artboardOfRef(this.ctx, ref)
    if (artboard === null) return null
    const m = (): ArtboardMeasure | null =>
      opts.measure !== false ? this.measured(artboard) : this.cachedMeasure(artboard)
    if (artboard === ref) {
      const s = node.styles
      const width = toPx(s['width']) ?? m()?.width ?? null
      const height = toPx(s['height']) ?? m()?.height ?? null
      if (width === null || height === null) return null
      return {
        x: toPx(s['left']) ?? 0,
        y: toPx(s['top']) ?? 0,
        width,
        height,
        rotation: readRotation(s),
      }
    }
    if (this.positionExact(node) && this.sizeExact(node).both) return this.declared.frameOf(ref)
    const box = m()?.nodes.get(ref)
    const board = box ? this.frameOf(artboard, opts) : null
    if (!box || !board) return null
    const c = localToWorld(board, { x: box.cx, y: box.cy })
    return {
      x: c.x - box.width / 2,
      y: c.y - box.height / 2,
      width: box.width,
      height: box.height,
      rotation: board.rotation + box.rotation,
    }
  }

  /** Contract §5 fields (2 decimals), `null` per value when it is not known. */
  fields(ref: string): GeometryFields {
    const node = resolveRef(this.ctx, ref)
    if (!node || node.type === 'page') return { ...NULL_FIELDS }
    const frame = this.frameOf(ref)
    if (frame) {
      const out: GeometryFields = {
        worldX: round2(frame.x),
        worldY: round2(frame.y),
        x: round2(frame.x),
        y: round2(frame.y),
        width: round2(frame.width),
        height: round2(frame.height),
      }
      const parent = node.parentId === null ? undefined : resolveRef(this.ctx, node.parentId)
      if (parent && parent.type !== 'page') {
        // An unrotated parent only needs its position (its size may depend on layout).
        let pf = this.frameOf(parent.id)
        if (!pf && readRotation(parent.styles) === 0 && this.positionExact(parent)) {
          pf = this.declared.frameOf(parent.id)
        }
        if (pf) {
          const local = worldToLocal(pf, frameCenter(frame))
          out.x = round2(local.x - frame.width / 2)
          out.y = round2(local.y - frame.height / 2)
        } else {
          out.x = null
          out.y = null
        }
      }
      return out
    }
    // Unknown frame: the declared px size when there is one, and the position when it is
    // exact and nothing on the way is rotated (it does not depend on the size then).
    const w = toPx(node.styles['width'])
    const h = toPx(node.styles['height'])
    const out: GeometryFields = {
      ...NULL_FIELDS,
      width: w === null ? null : round2(w),
      height: h === null ? null : round2(h),
    }
    if (this.positionExact(node) && this.unrotatedChain(node)) {
      const d = this.declared.frameOf(ref)
      if (d) {
        out.worldX = round2(d.x)
        out.worldY = round2(d.y)
        const parent = node.parentId === null ? undefined : resolveRef(this.ctx, node.parentId)
        const pd = parent && parent.type !== 'page' ? this.declared.frameOf(parent.id) : null
        out.x = round2(pd ? d.x - pd.x : d.x)
        out.y = round2(pd ? d.y - pd.y : d.y)
      }
    }
    return out
  }

  /**
   * A `GeometrySource` for schema helpers (reparent, paste, fit groups, the html applier):
   * exact or cached-measured frames, else declared styles. `measure: false` never lays out
   * (inside transactions).
   */
  source(opts: { measure?: boolean } = {}): GeometrySource {
    return {
      frameOf: (id) => this.frameOf(id, opts) ?? this.declared.frameOf(id),
    }
  }

  /**
   * Bounds of a page's top-level nodes for placement: declared px, else measured, else
   * `UNKNOWN_HEIGHT` for heights (and 0 for widths).
   */
  topLevelRects(pageId: string, opts: { measure?: boolean } = {}): { id: string; rect: Rect }[] {
    const page = resolveRef(this.ctx, pageId)
    if (!page || page.type !== 'page') return []
    const out: { id: string; rect: Rect }[] = []
    for (const id of page.children) {
      const node = resolveRef(this.ctx, id)
      if (!node) continue
      const s = node.styles
      let width = toPx(s['width'])
      let height = toPx(s['height'])
      if (width === null || height === null) {
        const m = opts.measure === false ? this.cachedMeasure(id) : this.measured(id)
        width ??= m?.width ?? 0
        height ??= m?.height ?? UNKNOWN_HEIGHT
      }
      const x = toPx(s['left']) ?? 0
      const y = toPx(s['top']) ?? 0
      const rot = readRotation(s)
      if (rot === 0) out.push({ id, rect: { x, y, width, height } })
      else {
        // Axis-aligned bounds of the rotated box.
        const rad = (rot * Math.PI) / 180
        const cos = Math.abs(Math.cos(rad))
        const sin = Math.abs(Math.sin(rad))
        const bw = width * cos + height * sin
        const bh = width * sin + height * cos
        out.push({
          id,
          rect: { x: x + width / 2 - bw / 2, y: y + height / 2 - bh / 2, width: bw, height: bh },
        })
      }
    }
    return out
  }
}
