/**
 * Rotation (contract §2.3): `styles.rotate = "<n>deg"`, `n` in (−180, 180] with 2 decimals,
 * absent = 0, about the border-box centre. Readers also accept turn/rad/grad units, bare
 * numbers (degrees) and — as a legacy form — a `transform` made only of `rotate()` functions.
 */
import type { LoroDoc } from 'loro-crdt'
import { fitGroups } from './groups.ts'
import {
  frameAabb,
  frameCenter,
  docGeometry,
  frameOrDeclared,
  placementStyles,
  rotatePoint,
  unionRects,
} from './geometry.ts'
import { isTreeId } from './ids.ts'
import { getNode } from './nodes.ts'
import { setStylesAt } from './overrides.ts'
import { topmostRefs } from './refs.ts'
import { createComponentResolver } from './resolve.ts'
import type { GeometrySource, Point, StylePatch, StyleValue, Styles } from './types.ts'
import { isAbsolutePosition, realIdOf, round2, run, writeStyles } from './util.ts'

/** Normalise to (−180, 180]. */
export function normalizeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  let r = deg % 360
  if (r <= -180) r += 360
  else if (r > 180) r -= 360
  return r === 0 ? 0 : r
}

const ANGLE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|turn|rad|grad)?$/i

/** Degrees from a CSS angle (`"15deg"`, `"0.25turn"`, `"1rad"`, `"10grad"`, `"15"`). */
export function parseAngle(value: string): number | null {
  const m = ANGLE_RE.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  switch ((m[2] ?? 'deg').toLowerCase()) {
    case 'turn':
      return n * 360
    case 'rad':
      return (n * 180) / Math.PI
    case 'grad':
      return n * 0.9
    default:
      return n
  }
}

const TRANSFORM_FN_RE = /([a-zA-Z]+)\(([^()]*)\)/g

/** Sum of the angles of a transform made only of `rotate()`/`rotateZ()`; null otherwise. */
export function rotateOnlyTransform(value: StyleValue | undefined): number | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (t === '' || t === 'none') return null
  let total = 0
  let consumed = ''
  for (const m of t.matchAll(TRANSFORM_FN_RE)) {
    const fn = (m[1] as string).toLowerCase()
    if (fn !== 'rotate' && fn !== 'rotatez') return null
    const a = parseAngle(m[2] as string)
    if (a === null) return null
    total += a
    consumed += m[0]
  }
  return consumed.replace(/\s+/g, '') === t.replace(/\s+/g, '') && consumed !== '' ? total : null
}

/** A node's own rotation in degrees, normalised to (−180, 180]. */
export function readRotation(styles: Styles): number {
  let deg = 0
  const r = styles['rotate']
  if (typeof r === 'number') deg = Number.isFinite(r) ? r : 0
  else if (typeof r === 'string') {
    const t = r.trim()
    if (t !== 'none') deg = parseAngle(t) ?? 0
  }
  deg += rotateOnlyTransform(styles['transform']) ?? 0
  return normalizeDeg(deg)
}

/** Canonical stored value: `"15deg"`, or null (remove the key) for 0. */
export function rotationValue(deg: number): string | null {
  let n = round2(normalizeDeg(deg))
  if (n <= -180) n += 360
  return n === 0 ? null : `${n}deg`
}

/** Patch removing a legacy rotate-only `transform` (other transforms are left alone). */
function legacyTransformReset(styles: Styles): StylePatch {
  return rotateOnlyTransform(styles['transform']) !== null ? { transform: null } : {}
}

/** Set each node's own rotation (about its own centre). Inspector field. */
export function setRotation(
  doc: LoroDoc,
  refs: readonly string[],
  deg: number,
  geo: GeometrySource,
  opts: { origin?: string } = {},
): void {
  run(doc, opts.origin ?? 'editor:inspector', () => {
    const resolver = createComponentResolver(doc)
    const touched: string[] = []
    for (const ref of new Set(refs)) {
      const node = resolver.resolveNode(ref)
      if (!node || node.type === 'page') continue
      setStylesAt(
        doc,
        ref,
        { ...legacyTransformReset(node.styles), rotate: rotationValue(deg) },
        { resolver },
      )
      touched.push(realIdOf(ref))
    }
    fitGroups(doc, touched, geo)
  })
}

/**
 * Rotate around a pivot (default: centre of the union AABB). Absolute and top-level nodes
 * move their centre around the pivot and add `delta`; flow nodes and virtual nodes only add
 * `delta`. Fits groups.
 */
export function rotateNodes(
  doc: LoroDoc,
  refs: readonly string[],
  delta: number,
  geo: GeometrySource,
  opts: { pivot?: Point; origin?: string } = {},
): void {
  run(doc, opts.origin ?? 'canvas:rotate', () => {
    const resolver = createComponentResolver(doc)
    const top = topmostRefs(doc, refs, resolver)
    const declared = docGeometry(doc, resolver)
    const frames = top.map((id) => frameOrDeclared(doc, geo, id, declared))
    const union = unionRects(frames.filter((f) => f !== null).map((f) => frameAabb(f)))
    const pivot: Point =
      opts.pivot ??
      (union ? { x: union.x + union.width / 2, y: union.y + union.height / 2 } : { x: 0, y: 0 })
    const touched: string[] = []
    top.forEach((ref, i) => {
      const node = resolver.resolveNode(ref)
      const f = frames[i]
      if (!node) return
      touched.push(realIdOf(ref))
      const parent = node.parentId === null ? undefined : getNode(doc, node.parentId)
      const positioned =
        isTreeId(ref) &&
        parent !== undefined &&
        (parent.type === 'page' || parent.type === 'group' || isAbsolutePosition(node.styles))
      if (positioned && f && parent) {
        const c = rotatePoint(frameCenter(f), pivot, delta)
        const world = {
          x: c.x - f.width / 2,
          y: c.y - f.height / 2,
          width: f.width,
          height: f.height,
          rotation: f.rotation + delta,
        }
        const parentFrame =
          parent.type === 'page' ? null : frameOrDeclared(doc, geo, parent.id, declared)
        const patch = placementStyles(doc, parent.id, world, parentFrame, {
          absolute: isAbsolutePosition(node.styles),
        })
        const keep: StylePatch = { left: patch['left'] ?? null, top: patch['top'] ?? null }
        keep['rotate'] = patch['rotate'] ?? null
        writeStyles(doc, ref, { ...legacyTransformReset(node.styles), ...keep })
        return
      }
      setStylesAt(
        doc,
        ref,
        {
          ...legacyTransformReset(node.styles),
          rotate: rotationValue(readRotation(node.styles) + delta),
        },
        { resolver },
      )
    })
    fitGroups(doc, touched, geo)
  })
}
