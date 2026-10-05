/**
 * World geometry (contract §2.3–2.4): frames, rotation about the border-box centre and the
 * positioning context each parent imposes on its children.
 */
import type { LoroDoc } from 'loro-crdt'
import { isTreeId, parseVirtualId } from './ids.ts'
import { getNode } from './nodes.ts'
import { createComponentResolver, type ComponentResolver } from './resolve.ts'
import { normalizeDeg, readRotation, rotationValue } from './rotation.ts'
import type {
  DesignNode,
  GeometrySource,
  NodeFrame,
  Point,
  Rect,
  StylePatch,
  StyleValue,
  Styles,
} from './types.ts'
import { isAbsolutePosition, isFlexDisplay, round2, toPx } from './util.ts'

export function frameCenter(f: NodeFrame): Point {
  return { x: f.x + f.width / 2, y: f.y + f.height / 2 }
}

/** `p` rotated by `deg` degrees (clockwise on screen, like CSS) about `pivot`. */
export function rotatePoint(p: Point, pivot: Point, deg: number): Point {
  if (deg === 0) return { x: p.x, y: p.y }
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - pivot.x
  const dy = p.y - pivot.y
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos }
}

/** World corners: top-left, top-right, bottom-right, bottom-left. */
export function frameCorners(f: NodeFrame): [Point, Point, Point, Point] {
  const c = frameCenter(f)
  const pts: [Point, Point, Point, Point] = [
    { x: f.x, y: f.y },
    { x: f.x + f.width, y: f.y },
    { x: f.x + f.width, y: f.y + f.height },
    { x: f.x, y: f.y + f.height },
  ]
  if (f.rotation === 0) return pts
  return pts.map((p) => rotatePoint(p, c, f.rotation)) as [Point, Point, Point, Point]
}

/** Axis-aligned bounds of the rotated frame. */
export function frameAabb(f: NodeFrame): Rect {
  if (f.rotation === 0) return { x: f.x, y: f.y, width: f.width, height: f.height }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of frameCorners(f)) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** True when the world point lies inside the rotated frame. */
export function pointInFrame(f: NodeFrame, p: Point): boolean {
  const local = worldToLocal(f, p)
  return local.x >= 0 && local.y >= 0 && local.x <= f.width && local.y <= f.height
}

/** World point → the parent's unrotated local coordinates (origin = its border-box top-left). */
export function worldToLocal(parent: NodeFrame, p: Point): Point {
  const q = rotatePoint(p, frameCenter(parent), -parent.rotation)
  return { x: q.x - parent.x, y: q.y - parent.y }
}

/** Inverse of `worldToLocal`. */
export function localToWorld(parent: NodeFrame, p: Point): Point {
  return rotatePoint({ x: parent.x + p.x, y: parent.y + p.y }, frameCenter(parent), parent.rotation)
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// ---------------------------------------------------------------------------
// Borders and padding (declared px only)
// ---------------------------------------------------------------------------

const BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i

/** First px length in a shorthand like `"1px solid #000"` (0 when the style is none). */
function shorthandWidth(v: StyleValue | undefined): number | null {
  if (v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const parts = v.trim().split(/\s+/)
  if (parts.some((p) => /^(none|hidden)$/i.test(p))) return 0
  for (const p of parts) {
    if (BORDER_STYLES.test(p)) continue
    const px = toPx(p)
    if (px !== null) return px
  }
  return null
}

/** Side `i` (0 top, 1 right, 2 bottom, 3 left) of a 1–4 value box shorthand. */
function boxSide(v: StyleValue | undefined, side: number): number | null {
  if (v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const parts = v.trim().split(/\s+/)
  const pick =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? parts[side % 2]
        : parts.length === 3
          ? parts[side === 3 ? 1 : side]
          : parts[side]
  return toPx(pick)
}

/** Declared left/top border widths of a frame (unknown = 0). */
export function borderInsets(styles: Styles): { left: number; top: number } {
  const side = (longhand: string, sideShorthand: string, index: number): number =>
    toPx(styles[longhand]) ??
    shorthandWidth(styles[sideShorthand]) ??
    boxSide(styles['borderWidth'], index) ??
    shorthandWidth(styles['border']) ??
    0
  return {
    left: side('borderLeftWidth', 'borderLeft', 3),
    top: side('borderTopWidth', 'borderTop', 0),
  }
}

/** First value of a 1–2 value logical pair like `paddingInline: "8px 12px"` (start, end). */
function pairStart(v: StyleValue | undefined): number | null {
  if (v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return toPx(v.trim().split(/\s+/)[0])
}

/**
 * Declared left/top padding of a frame (unknown = 0). Physical longhands win over logical ones
 * and the shorthand, as `@baren/html` stores padding as `padding`, `paddingBlock` +
 * `paddingInline`, or a mix of physical and logical keys (horizontal-tb, ltr).
 */
function paddingInsets(styles: Styles): { left: number; top: number } {
  return {
    left:
      toPx(styles['paddingLeft']) ??
      toPx(styles['paddingInlineStart']) ??
      pairStart(styles['paddingInline']) ??
      boxSide(styles['padding'], 3) ??
      0,
    top:
      toPx(styles['paddingTop']) ??
      toPx(styles['paddingBlockStart']) ??
      pairStart(styles['paddingBlock']) ??
      boxSide(styles['padding'], 0) ??
      0,
  }
}

// ---------------------------------------------------------------------------
// Placement (§2.4)
// ---------------------------------------------------------------------------

export type PositionContext = 'page' | 'flow' | 'absolute' | 'group'

/** How a parent positions its children (`null` for leaves and unknown parents). */
export function positionContextOf(
  parent: Pick<DesignNode, 'type' | 'styles'> | undefined,
): PositionContext | null {
  if (!parent) return null
  switch (parent.type) {
    case 'page':
      return 'page'
    case 'group':
      return 'group'
    case 'frame':
      return isFlexDisplay(parent.styles) ? 'flow' : 'absolute'
    default:
      return null
  }
}

const POSITION_RESET: StylePatch = { right: null, bottom: null, inset: null }

/**
 * Position styles that put a node with world frame `world` under `parentId` (§2.4), including
 * its rotation relative to the parent: page → `left/top`; flex frame → in flow; other frame →
 * `position: absolute` + `left/top` from the padding box; group → absolute in the group box.
 * `parentFrame` is the parent's world frame (null: read from declared styles). With
 * `absolute`, a flex parent positions the node absolutely (an absolutely positioned child of a
 * flex frame that keeps its place out of the flow).
 */
export function placementStyles(
  doc: LoroDoc,
  parentId: string,
  world: NodeFrame,
  parentFrame: NodeFrame | null,
  opts: { absolute?: boolean } = {},
): StylePatch {
  const parent = getNode(doc, parentId)
  const context = positionContextOf(parent)
  if (!parent || context === null) return {}
  if (context === 'page') {
    return {
      position: null,
      left: round2(world.x),
      top: round2(world.y),
      ...POSITION_RESET,
      rotate: rotationValue(world.rotation),
    }
  }
  const p = parentFrame ?? docGeometry(doc).frameOf(parentId) ?? zeroFrame()
  const rotate = rotationValue(world.rotation - p.rotation)
  // `absolute`: an absolutely positioned child of a flex frame stays out of the flow.
  if (context === 'flow' && !opts.absolute) {
    return { position: null, left: null, top: null, ...POSITION_RESET, rotate }
  }
  const c = worldToLocal(p, frameCenter(world))
  const inset = context === 'group' ? { left: 0, top: 0 } : borderInsets(parent.styles)
  return {
    position: 'absolute',
    left: round2(c.x - world.width / 2 - inset.left),
    top: round2(c.y - world.height / 2 - inset.top),
    ...POSITION_RESET,
    rotate,
  }
}

function zeroFrame(): NodeFrame {
  return { x: 0, y: 0, width: 0, height: 0, rotation: 0 }
}

// ---------------------------------------------------------------------------
// Declared-styles geometry
// ---------------------------------------------------------------------------

type GeoNode = Pick<DesignNode, 'id' | 'type' | 'parentId' | 'styles'>

/**
 * A `GeometrySource` computed from declared styles only (tests, headless use, fallback for
 * unmeasured nodes). Absolute and top-level nodes are exact; flow children are placed at their
 * parent's content origin and nodes without px sizes measure 0 (no layout engine here).
 * Results are cached until the document changes.
 */
export function docGeometry(doc: LoroDoc, resolver?: ComponentResolver): GeometrySource {
  let version = doc.opCount()
  let cache = new Map<string, NodeFrame | null>()
  let r = resolver
  const lookup = (id: string): GeoNode | undefined => {
    if (isTreeId(id)) {
      const n = getNode(doc, id)
      if (n?.type !== 'instance') return n
    } else if (!parseVirtualId(id)) return undefined
    r ??= createComponentResolver(doc)
    return r.resolveNode(id)
  }
  const frameOf = (id: string): NodeFrame | null => {
    const v = doc.opCount()
    if (v !== version) {
      version = v
      cache = new Map()
    }
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const node = lookup(id)
    let out: NodeFrame | null = null
    if (node) {
      if (node.type === 'page') out = zeroFrame()
      else {
        const w = toPx(node.styles['width']) ?? 0
        const h = toPx(node.styles['height']) ?? 0
        const rot = readRotation(node.styles)
        const parent = node.parentId === null ? undefined : lookup(node.parentId)
        if (!parent || parent.type === 'page') {
          out = {
            x: toPx(node.styles['left']) ?? 0,
            y: toPx(node.styles['top']) ?? 0,
            width: w,
            height: h,
            rotation: rot,
          }
        } else {
          const p = frameOf(parent.id) ?? zeroFrame()
          const border = parent.type === 'group' ? { left: 0, top: 0 } : borderInsets(parent.styles)
          let lx: number
          let ly: number
          if (parent.type === 'group' || isAbsolutePosition(node.styles)) {
            lx = border.left + (toPx(node.styles['left']) ?? 0)
            ly = border.top + (toPx(node.styles['top']) ?? 0)
          } else {
            const pad = paddingInsets(parent.styles)
            lx = border.left + pad.left
            ly = border.top + pad.top
          }
          const c = localToWorld(p, { x: lx + w / 2, y: ly + h / 2 })
          out = {
            x: c.x - w / 2,
            y: c.y - h / 2,
            width: w,
            height: h,
            rotation: normalizeDeg(p.rotation + rot),
          }
        }
      }
    }
    cache.set(id, out)
    return out
  }
  return { frameOf }
}

/** `geo.frameOf(id)`, falling back to declared styles. */
export function frameOrDeclared(
  doc: LoroDoc,
  geo: GeometrySource,
  id: string,
  fallback?: GeometrySource,
): NodeFrame | null {
  return geo.frameOf(id) ?? (fallback ?? docGeometry(doc)).frameOf(id)
}
