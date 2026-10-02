/**
 * Decoders for the Phase 3 node data (`overrides`, `vector`) from Loro JSON. The Rust core
 * (`baren_core::schema::snapshot`) applies the same rules: invalid fields are dropped,
 * empty override entries and empty subpaths are omitted.
 */
import type {
  OverrideEntry,
  OverrideStyles,
  StyleValue,
  VectorData,
  VectorPoint,
  VectorPointMode,
  VectorSubpath,
} from './types.ts'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isStyleValue(v: unknown): v is StyleValue {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** One override entry; `undefined` when it carries no valid field. */
export function decodeOverrideEntry(raw: unknown): OverrideEntry | undefined {
  if (!isRecord(raw)) return undefined
  const entry: OverrideEntry = {}
  const rawStyles = raw['styles']
  if (isRecord(rawStyles)) {
    const styles: OverrideStyles = {}
    let any = false
    for (const key in rawStyles) {
      const v = rawStyles[key]
      if (v === null || isStyleValue(v)) {
        styles[key] = v
        any = true
      }
    }
    if (any) entry.styles = styles
  }
  const text = raw['text']
  if (typeof text === 'string') entry.text = text
  const hidden = raw['hidden']
  if (typeof hidden === 'boolean') entry.hidden = hidden
  const assetId = raw['assetId']
  if (typeof assetId === 'string') entry.assetId = assetId
  const assetName = raw['assetName']
  if (typeof assetName === 'string') entry.assetName = assetName
  return entry.styles !== undefined ||
    entry.text !== undefined ||
    entry.hidden !== undefined ||
    entry.assetId !== undefined ||
    entry.assetName !== undefined
    ? entry
    : undefined
}

/** An instance's overrides map; `undefined` when empty. */
export function decodeOverrides(raw: unknown): Record<string, OverrideEntry> | undefined {
  if (!isRecord(raw)) return undefined
  let out: Record<string, OverrideEntry> | undefined
  for (const path in raw) {
    const entry = decodeOverrideEntry(raw[path])
    if (entry) (out ??= {})[path] = entry
  }
  return out
}

const POINT_MODES: ReadonlySet<string> = new Set(['corner', 'smooth', 'mirrored'])

function decodeHandle(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined
  const [dx, dy] = v as unknown[]
  return isFiniteNumber(dx) && isFiniteNumber(dy) ? [dx, dy] : undefined
}

export function decodeVectorPoint(raw: unknown): VectorPoint | undefined {
  if (!isRecord(raw)) return undefined
  const x = raw['x']
  const y = raw['y']
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return undefined
  const point: VectorPoint = { x, y }
  const hIn = decodeHandle(raw['in'])
  if (hIn) point.in = hIn
  const hOut = decodeHandle(raw['out'])
  if (hOut) point.out = hOut
  const mode = raw['mode']
  if (typeof mode === 'string' && POINT_MODES.has(mode)) point.mode = mode as VectorPointMode
  return point
}

/** `data.vector` → `VectorData` (subpaths sorted by (order, id); empty subpaths skipped). */
export function decodeVector(raw: unknown): VectorData | undefined {
  if (!isRecord(raw)) return undefined
  const fillRule = raw['fillRule'] === 'evenodd' ? 'evenodd' : 'nonzero'
  const sorted: { order: number; sp: VectorSubpath }[] = []
  const rawSubpaths = raw['subpaths']
  if (isRecord(rawSubpaths)) {
    for (const id in rawSubpaths) {
      const sp = rawSubpaths[id]
      if (!isRecord(sp)) continue
      const points: VectorPoint[] = []
      const rawPoints = sp['points']
      if (Array.isArray(rawPoints)) {
        for (const p of rawPoints) {
          const point = decodeVectorPoint(p)
          if (point) points.push(point)
        }
      }
      if (points.length === 0) continue
      const order = sp['order']
      sorted.push({
        order: isFiniteNumber(order) ? order : 0,
        sp: { id, closed: sp['closed'] === true, points },
      })
    }
  }
  sorted.sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.sp.id < b.sp.id ? -1 : a.sp.id > b.sp.id ? 1 : 0,
  )
  return { fillRule, subpaths: sorted.map((s) => s.sp) }
}
