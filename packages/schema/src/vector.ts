/**
 * Vectors (contract §2.6, §3.3): structured paths in node-local px, stored as mergeable
 * movable lists of anchor points with relative Bézier handles. `vectorToPathD` is the single
 * path generator (canvas, raster, TS and Rust HTML produce the same `d`).
 */
import { LoroMap, LoroMovableList, type LoroDoc } from 'loro-crdt'
import { decodeVectorPoint } from './decode.ts'
import { autoCommit, nodesTree } from './doc.ts'
import { SchemaError } from './errors.ts'
import { frameCenter, rotatePoint } from './geometry.ts'
import { fitGroups } from './groups.ts'
import { docGeometry } from './geometry.ts'
import { isTreeId } from './ids.ts'
import { nodeTypeOf, pointValue, requireNode } from './nodes.ts'
import {
  NODE_KEY,
  type DesignNode,
  type NodeFrame,
  type Point,
  type Rect,
  type StylePatch,
  type Token,
  type VectorData,
  type VectorPoint,
  type VectorPointMode,
  type VectorSubpath,
} from './types.ts'
import { run, toPx, writeStyles } from './util.ts'

// ---------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------

/** `String(Math.round(n * 1000) / 1000)` with −0 printed as `0`. */
export function formatPathNumber(n: number): string {
  const r = Math.round(n * 1000) / 1000
  return r === 0 ? '0' : String(r)
}

function hx(p: VectorPoint, h: [number, number] | undefined): Point {
  return h ? { x: p.x + h[0], y: p.y + h[1] } : { x: p.x, y: p.y }
}

/** SVG path data (§2.6): `M`, then `L` or `C` per segment, closing `C` only with a handle, `Z`. */
export function vectorToPathD(v: VectorData): string {
  const f = formatPathNumber
  const out: string[] = []
  const segment = (a: VectorPoint, b: VectorPoint): void => {
    if (!a.out && !b.in) {
      out.push('L', f(b.x), f(b.y))
      return
    }
    const c1 = hx(a, a.out)
    const c2 = hx(b, b.in)
    out.push('C', f(c1.x), f(c1.y), f(c2.x), f(c2.y), f(b.x), f(b.y))
  }
  for (const sp of v.subpaths) {
    const pts = sp.points
    const first = pts[0]
    if (!first) continue
    out.push('M', f(first.x), f(first.y))
    for (let i = 0; i + 1 < pts.length; i++)
      segment(pts[i] as VectorPoint, pts[i + 1] as VectorPoint)
    if (sp.closed && pts.length >= 2) {
      const last = pts[pts.length - 1] as VectorPoint
      if (last.out || first.in) {
        const c1 = hx(last, last.out)
        const c2 = hx(first, first.in)
        out.push('C', f(c1.x), f(c1.y), f(c2.x), f(c2.y), f(first.x), f(first.y))
      }
      out.push('Z')
    }
  }
  return out.join(' ')
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Seg {
  p0: Point
  p1: Point
  p2: Point
  p3: Point
  line: boolean
}

/** Segments of a subpath (closing segment included when closed and n ≥ 2). */
function segmentsOf(sp: VectorSubpath): Seg[] {
  const pts = sp.points
  const out: Seg[] = []
  const add = (a: VectorPoint, b: VectorPoint): void => {
    out.push({
      p0: { x: a.x, y: a.y },
      p1: hx(a, a.out),
      p2: hx(b, b.in),
      p3: { x: b.x, y: b.y },
      line: !a.out && !b.in,
    })
  }
  for (let i = 0; i + 1 < pts.length; i++) add(pts[i] as VectorPoint, pts[i + 1] as VectorPoint)
  if (sp.closed && pts.length >= 2) add(pts[pts.length - 1] as VectorPoint, pts[0] as VectorPoint)
  return out
}

function bezier(s: Seg, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * s.p0.x + b * s.p1.x + c * s.p2.x + d * s.p3.x,
    y: a * s.p0.y + b * s.p1.y + c * s.p2.y + d * s.p3.y,
  }
}

/** Parameters in (0, 1) where one coordinate of the cubic has an extremum. */
function extrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const out: number[] = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b)
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      out.push((-b + sq) / (2 * a), (-b - sq) / (2 * a))
    }
  }
  return out.filter((t) => t > 0 && t < 1)
}

/** Tight Bézier bounds of every segment (curve extrema, not handle hulls); null when empty. */
export function vectorBounds(v: VectorData): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (p: Point): void => {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  for (const sp of v.subpaths) {
    for (const p of sp.points) add(p)
    for (const s of segmentsOf(sp)) {
      if (s.line) continue
      for (const t of extrema(s.p0.x, s.p1.x, s.p2.x, s.p3.x)) add(bezier(s, t))
      for (const t of extrema(s.p0.y, s.p1.y, s.p2.y, s.p3.y)) add(bezier(s, t))
    }
  }
  if (x0 === Infinity) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function mapPoints(v: VectorData, fn: (p: VectorPoint) => VectorPoint): VectorData {
  return {
    fillRule: v.fillRule,
    subpaths: v.subpaths.map((sp) => ({ id: sp.id, closed: sp.closed, points: sp.points.map(fn) })),
  }
}

function copyPoint(p: VectorPoint, x: number, y: number): VectorPoint {
  const out: VectorPoint = { x, y }
  if (p.in) out.in = [p.in[0], p.in[1]]
  if (p.out) out.out = [p.out[0], p.out[1]]
  if (p.mode !== undefined) out.mode = p.mode
  return out
}

/** Points scaled by (sx, sy) (handles too). */
export function scaleVector(v: VectorData, sx: number, sy: number): VectorData {
  return mapPoints(v, (p) => {
    const out: VectorPoint = { x: p.x * sx, y: p.y * sy }
    if (p.in) out.in = [p.in[0] * sx, p.in[1] * sy]
    if (p.out) out.out = [p.out[0] * sx, p.out[1] * sy]
    if (p.mode !== undefined) out.mode = p.mode
    return out
  })
}

/**
 * Shift the points so the tight bounds start at (0, 0), size the box to the bounds (≥ 1 × 1)
 * and move the box so the path stays put in world space (rotation-aware).
 */
export function normalizeVector(
  v: VectorData,
  box: NodeFrame,
): { vector: VectorData; box: NodeFrame } {
  const b = vectorBounds(v)
  if (!b) return { vector: v, box }
  const w = Math.max(b.width, 1)
  const h = Math.max(b.height, 1)
  const vector = mapPoints(v, (p) => copyPoint(p, p.x - b.x, p.y - b.y))
  const d = rotatePoint(
    { x: b.x + w / 2 - box.width / 2, y: b.y + h / 2 - box.height / 2 },
    { x: 0, y: 0 },
    box.rotation,
  )
  const c = frameCenter(box)
  return {
    vector,
    box: {
      x: c.x + d.x - w / 2,
      y: c.y + d.y - h / 2,
      width: w,
      height: h,
      rotation: box.rotation,
    },
  }
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * Insert a point on segment `segment` at parameter `t` without changing the shape (de
 * Casteljau). The closing segment of a closed subpath is `points.length - 1`.
 */
export function splitSegment(sp: VectorSubpath, segment: number, t: number): VectorSubpath {
  const pts = sp.points.map((p) => copyPoint(p, p.x, p.y))
  const n = pts.length
  const closing = sp.closed && n >= 2 && segment === n - 1
  if (segment < 0 || (!closing && segment + 1 >= n)) return { ...sp, points: pts }
  const i = segment
  const j = closing ? 0 : segment + 1
  const a = pts[i] as VectorPoint
  const b = pts[j] as VectorPoint
  const tt = Math.min(1, Math.max(0, t))
  let inserted: VectorPoint
  if (!a.out && !b.in) {
    const m = lerp(a, b, tt)
    inserted = { x: m.x, y: m.y }
  } else {
    const p0 = { x: a.x, y: a.y }
    const p1 = hx(a, a.out)
    const p2 = hx(b, b.in)
    const p3 = { x: b.x, y: b.y }
    const q0 = lerp(p0, p1, tt)
    const q1 = lerp(p1, p2, tt)
    const q2 = lerp(p2, p3, tt)
    const r0 = lerp(q0, q1, tt)
    const r1 = lerp(q1, q2, tt)
    const s = lerp(r0, r1, tt)
    a.out = [q0.x - p0.x, q0.y - p0.y]
    b.in = [q2.x - p3.x, q2.y - p3.y]
    inserted = { x: s.x, y: s.y, in: [r0.x - s.x, r0.y - s.y], out: [r1.x - s.x, r1.y - s.y] }
    inserted.mode = 'smooth'
  }
  pts.splice(i + 1, 0, inserted)
  return { id: sp.id, closed: sp.closed, points: pts }
}

/** Closest point on the path to local point `p` within `tolerance` (px), or null. */
export function nearestOnPath(
  v: VectorData,
  p: Point,
  tolerance: number,
): { subpathId: string; segment: number; t: number; point: Point; distance: number } | null {
  let best: {
    subpathId: string
    segment: number
    t: number
    point: Point
    distance: number
  } | null = null
  const dist = (q: Point): number => Math.hypot(q.x - p.x, q.y - p.y)
  for (const sp of v.subpaths) {
    segmentsOf(sp).forEach((s, segment) => {
      const steps = s.line ? 1 : 32
      let bt = 0
      let bd = Infinity
      if (s.line) {
        const dx = s.p3.x - s.p0.x
        const dy = s.p3.y - s.p0.y
        const len2 = dx * dx + dy * dy
        bt =
          len2 === 0
            ? 0
            : Math.min(1, Math.max(0, ((p.x - s.p0.x) * dx + (p.y - s.p0.y) * dy) / len2))
        bd = dist(lerp(s.p0, s.p3, bt))
      } else {
        for (let k = 0; k <= steps; k++) {
          const t = k / steps
          const d = dist(bezier(s, t))
          if (d < bd) {
            bd = d
            bt = t
          }
        }
        let lo = Math.max(0, bt - 1 / steps)
        let hi = Math.min(1, bt + 1 / steps)
        for (let k = 0; k < 24; k++) {
          const m1 = lo + (hi - lo) / 3
          const m2 = hi - (hi - lo) / 3
          if (dist(bezier(s, m1)) < dist(bezier(s, m2))) hi = m2
          else lo = m1
        }
        bt = (lo + hi) / 2
        bd = dist(bezier(s, bt))
      }
      if (bd <= tolerance && (!best || bd < best.distance)) {
        const point = s.line ? lerp(s.p0, s.p3, bt) : bezier(s, bt)
        best = { subpathId: sp.id, segment, t: bt, point, distance: bd }
      }
    })
  }
  return best
}

/**
 * Change an anchor's mode. `corner` removes the handles (a sharp corner); `smooth` makes the
 * handles collinear (creating them from the neighbours when missing); `mirrored` also equalises
 * their lengths.
 */
export function setPointMode(
  sp: VectorSubpath,
  index: number,
  mode: VectorPointMode,
): VectorSubpath {
  const pts = sp.points.map((p) => copyPoint(p, p.x, p.y))
  const p = pts[index]
  if (!p) return { ...sp, points: pts }
  if (mode === 'corner') {
    delete p.in
    delete p.out
    delete p.mode
    return { id: sp.id, closed: sp.closed, points: pts }
  }
  const n = pts.length
  const prev = index > 0 ? pts[index - 1] : sp.closed && n > 1 ? pts[n - 1] : undefined
  const next = index + 1 < n ? pts[index + 1] : sp.closed && n > 1 ? pts[0] : undefined
  let lenIn = p.in
    ? Math.hypot(p.in[0], p.in[1])
    : prev
      ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3
      : 0
  let lenOut = p.out
    ? Math.hypot(p.out[0], p.out[1])
    : next
      ? Math.hypot(next.x - p.x, next.y - p.y) / 3
      : 0
  let ux: number
  let uy: number
  if (p.in && p.out) {
    ux = p.out[0] - p.in[0]
    uy = p.out[1] - p.in[1]
  } else {
    const a = prev ?? p
    const b = next ?? p
    ux = b.x - a.x
    uy = b.y - a.y
  }
  const len = Math.hypot(ux, uy)
  if (len === 0) {
    p.mode = mode
    return { id: sp.id, closed: sp.closed, points: pts }
  }
  ux /= len
  uy /= len
  if (mode === 'mirrored') lenIn = lenOut = (lenIn + lenOut) / 2
  if (lenIn === 0) lenIn = lenOut
  if (lenOut === 0) lenOut = lenIn
  p.in = [-ux * lenIn, -uy * lenIn]
  p.out = [ux * lenOut, uy * lenOut]
  p.mode = mode
  return { id: sp.id, closed: sp.closed, points: pts }
}

// ---------------------------------------------------------------------------
// Standalone SVG (Copy as SVG)
// ---------------------------------------------------------------------------

const PAINT_ATTRS: readonly [string, string][] = [
  ['fill', 'fill'],
  ['fillOpacity', 'fill-opacity'],
  ['stroke', 'stroke'],
  ['strokeWidth', 'stroke-width'],
  ['strokeOpacity', 'stroke-opacity'],
  ['strokeLinecap', 'stroke-linecap'],
  ['strokeLinejoin', 'stroke-linejoin'],
  ['strokeDasharray', 'stroke-dasharray'],
]

/** Replace `var(--x[, fallback])` with token values (fallback, else null when unresolvable). */
export function resolveVars(
  value: string,
  tokens: Record<string, Token>,
  depth = 0,
): string | null {
  if (!value.includes('var(')) return value
  if (depth > 8) return null
  let failed = false
  const out = value.replace(
    /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (_m, name: string, fallback: string | undefined) => {
      const token = tokens[name]
      if (token) {
        const resolved = resolveVars(String(token.value), tokens, depth + 1)
        if (resolved !== null) return resolved
      }
      if (fallback !== undefined && fallback.trim() !== '') {
        const resolved = resolveVars(fallback.trim(), tokens, depth + 1)
        if (resolved !== null) return resolved
      }
      failed = true
      return ''
    },
  )
  return failed ? null : out
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A standalone `<svg>` document for a vector, with resolved paint attributes (§3.3). */
export function vectorToSvgMarkup(
  node: Pick<DesignNode, 'styles' | 'vector'>,
  tokens: Record<string, Token>,
): string {
  const v = node.vector ?? { fillRule: 'nonzero', subpaths: [] }
  const b = vectorBounds(v)
  const w = toPx(node.styles['width']) ?? (b ? b.x + b.width : 0)
  const h = toPx(node.styles['height']) ?? (b ? b.y + b.height : 0)
  const f = formatPathNumber
  let attrs = ''
  for (const [key, attr] of PAINT_ATTRS) {
    const raw = node.styles[key]
    if (raw === undefined) continue
    const value = typeof raw === 'number' ? String(raw) : resolveVars(raw.trim(), tokens)
    if (value === null || value === '') continue
    attrs += ` ${attr}="${escapeAttr(value)}"`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}">` +
    `<path d="${vectorToPathD(v)}" fill-rule="${v.fillRule}"${attrs}/></svg>`
  )
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function vectorMap(doc: LoroDoc, id: string): LoroMap {
  if (!isTreeId(id)) throw new SchemaError('invalid-ref', `Vector edits need a real node: ${id}`)
  const node = requireNode(nodesTree(doc), id)
  const type = nodeTypeOf(node)
  if (type !== 'vector')
    throw new SchemaError('invalid-type', `Node ${id} is a ${type}, not a vector`)
  const existing = node.data.get(NODE_KEY.vector)
  return existing instanceof LoroMap ? existing : node.data.ensureMergeableMap(NODE_KEY.vector)
}

function childMap(map: LoroMap, key: string): LoroMap {
  const existing = map.get(key)
  return existing instanceof LoroMap ? existing : map.ensureMergeableMap(key)
}

function pointsList(entry: LoroMap): LoroMovableList {
  const existing = entry.get('points')
  return existing instanceof LoroMovableList ? existing : entry.ensureMergeableMovableList('points')
}

function samePoint(a: VectorPoint | undefined, b: VectorPoint): boolean {
  if (!a) return false
  const sameHandle = (x?: [number, number], y?: [number, number]): boolean =>
    x === undefined ? y === undefined : y !== undefined && x[0] === y[0] && x[1] === y[1]
  return (
    a.x === b.x &&
    a.y === b.y &&
    sameHandle(a.in, b.in) &&
    sameHandle(a.out, b.out) &&
    (a.mode ?? 'corner') === (b.mode ?? 'corner')
  )
}

/** Replace a movable list's points with a minimal diff (per-point set, inserts, deletes). */
function diffPoints(list: LoroMovableList, next: readonly VectorPoint[]): void {
  const raw = list.toJSON() as unknown[]
  const cur = raw.map((r) => decodeVectorPoint(r))
  let pre = 0
  while (pre < cur.length && pre < next.length && samePoint(cur[pre], next[pre] as VectorPoint))
    pre++
  let suf = 0
  while (
    suf < cur.length - pre &&
    suf < next.length - pre &&
    samePoint(cur[cur.length - 1 - suf], next[next.length - 1 - suf] as VectorPoint)
  )
    suf++
  const oldMid = cur.length - pre - suf
  const newMid = next.length - pre - suf
  const common = Math.min(oldMid, newMid)
  for (let k = 0; k < common; k++) {
    if (!samePoint(cur[pre + k], next[pre + k] as VectorPoint)) {
      list.set(pre + k, pointValue(next[pre + k] as VectorPoint))
    }
  }
  if (newMid > oldMid) {
    for (let k = common; k < newMid; k++)
      list.insert(pre + k, pointValue(next[pre + k] as VectorPoint))
  } else if (oldMid > newMid) {
    list.delete(pre + newMid, oldMid - newMid)
  }
}

/** Empty a subpath entry (its keys deleted, points cleared; the entry key stays). */
function clearSubpath(entry: LoroMap): void {
  for (const key of entry.keys()) {
    if (key === 'points') {
      const list = entry.get('points')
      if (list instanceof LoroMovableList && list.length > 0) list.delete(0, list.length)
    } else {
      entry.delete(key)
    }
  }
}

/** Replace a vector's geometry with a minimal diff (subpath order = array order). */
export function setVector(doc: LoroDoc, id: string, v: VectorData): void {
  const map = vectorMap(doc, id)
  if (v.fillRule === 'evenodd') {
    if (map.get('fillRule') !== 'evenodd') map.set('fillRule', 'evenodd')
  } else if (map.get('fillRule') !== undefined) {
    map.delete('fillRule')
  }
  const subpaths = childMap(map, 'subpaths')
  const keep = new Set<string>()
  v.subpaths.forEach((sp, order) => {
    keep.add(sp.id)
    const entry = childMap(subpaths, sp.id)
    if (entry.get('closed') !== sp.closed) entry.set('closed', sp.closed)
    if (entry.get('order') !== order) entry.set('order', order)
    diffPoints(pointsList(entry), sp.points)
  })
  for (const key of subpaths.keys()) {
    if (keep.has(key)) continue
    const entry = subpaths.get(key)
    if (entry instanceof LoroMap) clearSubpath(entry)
  }
  autoCommit(doc)
}

export type VectorEdit =
  | { kind: 'set'; subpathId: string; index: number; point: VectorPoint }
  | { kind: 'insert'; subpathId: string; index: number; point: VectorPoint }
  | { kind: 'delete'; subpathId: string; index: number }
  | { kind: 'closed'; subpathId: string; closed: boolean }
  | { kind: 'fillRule'; fillRule: 'nonzero' | 'evenodd' }

/** Apply point-level edits directly (each one a single movable-list op). */
export function editVector(doc: LoroDoc, id: string, edits: readonly VectorEdit[]): void {
  const map = vectorMap(doc, id)
  const subpaths = childMap(map, 'subpaths')
  const nextOrder = (): number => {
    let max = -1
    for (const key of subpaths.keys()) {
      const e = subpaths.get(key)
      const o = e instanceof LoroMap ? e.get('order') : undefined
      if (typeof o === 'number' && o > max) max = o
    }
    return max + 1
  }
  for (const edit of edits) {
    if (edit.kind === 'fillRule') {
      if (edit.fillRule === 'evenodd') map.set('fillRule', 'evenodd')
      else if (map.get('fillRule') !== undefined) map.delete('fillRule')
      continue
    }
    const existing = subpaths.get(edit.subpathId)
    if (!(existing instanceof LoroMap) && edit.kind !== 'insert') continue
    const entry = childMap(subpaths, edit.subpathId)
    if (!(existing instanceof LoroMap)) {
      entry.set('closed', false)
      entry.set('order', nextOrder())
    }
    const list = pointsList(entry)
    switch (edit.kind) {
      case 'set':
        if (edit.index >= 0 && edit.index < list.length)
          list.set(edit.index, pointValue(edit.point))
        break
      case 'insert':
        list.insert(Math.min(Math.max(0, edit.index), list.length), pointValue(edit.point))
        break
      case 'delete':
        if (edit.index >= 0 && edit.index < list.length) list.delete(edit.index, 1)
        break
      case 'closed':
        if (entry.get('closed') !== edit.closed) entry.set('closed', edit.closed)
        break
    }
  }
  autoCommit(doc)
}

/** Points + box together (a normalisation result) in one commit; refits enclosing groups. */
export function setVectorGeometry(
  doc: LoroDoc,
  id: string,
  v: VectorData,
  styles: StylePatch,
  opts: { origin?: string } = {},
): void {
  run(doc, opts.origin ?? 'canvas:vector', () => {
    setVector(doc, id, v)
    writeStyles(doc, id, styles)
    fitGroups(doc, [id], docGeometry(doc))
  })
}
