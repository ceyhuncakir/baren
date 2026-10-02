/**
 * Vector paint (contract §2.6): `fill` and `stroke` are ordinary style keys on the vector's
 * `<svg>`; "no paint" is the value `none` (an absent SVG fill would paint black). Hidden
 * paints keep their value in `--hidden-<prop>` like other fills. Pure, unit-tested.
 */
import type { StylePatch, StyleValue, Styles } from '@baren/schema'
import { parseColor, type ColorValue } from './colors'
import { HIDDEN_PREFIX } from './effects'

export type PaintProp = 'fill' | 'stroke'

export interface VectorPaint {
  prop: PaintProp
  value: string
  color: ColorValue | null
  hidden: boolean
}

function str(v: StyleValue | undefined): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

export function readVectorPaint(styles: Styles, prop: PaintProp): VectorPaint | null {
  const v = str(styles[prop])
  if (v && v !== 'none') return { prop, value: v, color: parseColor(v), hidden: false }
  const hidden = str(styles[`${HIDDEN_PREFIX}${prop}`])
  if (hidden) return { prop, value: hidden, color: parseColor(hidden), hidden: true }
  return null
}

export const DEFAULT_VECTOR_FILL = '#D9D9D9'
export const DEFAULT_VECTOR_STROKE = '#000000'

export function addVectorPaintPatch(prop: PaintProp): StylePatch {
  return prop === 'fill'
    ? { fill: DEFAULT_VECTOR_FILL, [`${HIDDEN_PREFIX}fill`]: null }
    : { stroke: DEFAULT_VECTOR_STROKE, strokeWidth: 1, [`${HIDDEN_PREFIX}stroke`]: null }
}

export function removeVectorPaintPatch(prop: PaintProp): StylePatch {
  return { [prop]: 'none', [`${HIDDEN_PREFIX}${prop}`]: null }
}

export function toggleVectorPaintPatch(paint: VectorPaint): StylePatch {
  return paint.hidden
    ? { [paint.prop]: paint.value, [`${HIDDEN_PREFIX}${paint.prop}`]: null }
    : { [paint.prop]: 'none', [`${HIDDEN_PREFIX}${paint.prop}`]: paint.value }
}

/** Write a colour, keeping the hidden state. */
export function vectorPaintColorPatch(
  paint: VectorPaint | null,
  prop: PaintProp,
  css: string,
): StylePatch {
  return paint?.hidden ? { [`${HIDDEN_PREFIX}${prop}`]: css } : { [prop]: css }
}

export type StrokeCap = 'butt' | 'round' | 'square'
export type StrokeJoin = 'miter' | 'round' | 'bevel'
export type StrokeDash = 'solid' | 'dashed' | 'dotted'

export function readStrokeWidth(styles: Styles): number {
  const v = styles['strokeWidth']
  if (typeof v === 'number') return v
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number.NaN
  return Number.isFinite(n) ? n : 1
}

export function readCap(styles: Styles): StrokeCap {
  const v = styles['strokeLinecap']
  return v === 'round' || v === 'square' ? v : 'butt'
}

export function readJoin(styles: Styles): StrokeJoin {
  const v = styles['strokeLinejoin']
  return v === 'round' || v === 'bevel' ? v : 'miter'
}

/** Dash patterns relative to the stroke width (solid = no dash array). */
export function readDash(styles: Styles): StrokeDash {
  const v = styles['strokeDasharray']
  if (v === undefined || v === 'none' || v === '' || v === 0) return 'solid'
  const parts = String(v)
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite)
  return parts[0] !== undefined && parts[0] <= readStrokeWidth(styles) ? 'dotted' : 'dashed'
}

export function dashPatch(styles: Styles, dash: StrokeDash): StylePatch {
  const w = Math.max(1, readStrokeWidth(styles))
  if (dash === 'solid') return { strokeDasharray: null }
  if (dash === 'dotted') return { strokeDasharray: `0 ${w * 2}`, strokeLinecap: 'round' }
  return { strokeDasharray: `${w * 3} ${w * 2}` }
}
