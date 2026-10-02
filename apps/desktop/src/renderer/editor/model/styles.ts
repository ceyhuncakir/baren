/**
 * Pure helpers that turn a node's camelCase `styles` map into the values the inspector
 * shows, and inspector edits back into style patches. No Loro, no DOM: unit-tested.
 *
 * Conventions (shared with @baren/canvas): numbers are px; strings keep their unit.
 * When a property already exists we keep its format (12 vs "12px") so documents written
 * by other peers or tools do not churn.
 */
import type { StylePatch, StyleValue, Styles } from '@baren/schema'

const PX_RE = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*(px)?\s*$/i

/** `12`, `"12"`, `"12px"` → 12. Anything else (auto, 50%, var()) → null. */
export function toPx(value: StyleValue | undefined | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const m = PX_RE.exec(value)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** Round for display (two decimals max, no trailing zeros). */
export function roundForDisplay(n: number): number {
  return Math.round(n * 100) / 100
}

/** Write `n` px in the same format as `prev` (number stays number, default "Npx"). */
export function pxValue(prev: StyleValue | undefined, n: number): StyleValue {
  const rounded = roundForDisplay(n)
  return typeof prev === 'number' ? rounded : `${rounded}px`
}

/** A unitless number (opacity, flexGrow, fontWeight): numbers stay numbers. */
export function toNumber(value: StyleValue | undefined | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const n = Number(value.trim())
  return value.trim() !== '' && Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Multi-selection values
// ---------------------------------------------------------------------------

/** The common value of `values`, or `MIXED` when they differ. Empty input → undefined. */
export const MIXED: unique symbol = Symbol('mixed')
export type Mixed<T> = T | typeof MIXED

export function common<T>(values: readonly T[], equal: (a: T, b: T) => boolean = Object.is) {
  if (values.length === 0) return undefined
  const first = values[0] as T
  for (let i = 1; i < values.length; i++) if (!equal(first, values[i] as T)) return MIXED
  return first
}

// ---------------------------------------------------------------------------
// Position, size, rotation
// ---------------------------------------------------------------------------

export type SizeMode = 'fixed' | 'hug' | 'fill' | 'fit'
export type FlexDirection = 'row' | 'column'

export interface SizeContext {
  type: string
  /** Direct child of a page (artboard or top-level layer). */
  isTop: boolean
  /** Parent's main axis when the parent is a flex container. */
  parentFlexDirection: FlexDirection | null
}

const INTRINSIC = new Set(['auto', 'fit-content', 'max-content', 'min-content'])
const NUMERIC = /^-?\d+(\.\d+)?(px)?$/

/** Mirrors `sizeMode` in @baren/canvas (math/sizeLabel.ts) so labels agree. */
export function sizeMode(styles: Styles, axis: 'width' | 'height', ctx: SizeContext): SizeMode {
  const v = styles[axis]
  if (typeof v === 'number') return 'fixed'
  if (typeof v === 'string') {
    const s = v.trim()
    if (NUMERIC.test(s)) return 'fixed'
    if (s === '100%' || s === 'stretch' || s === '-webkit-fill-available') return 'fill'
    if (INTRINSIC.has(s)) return ctx.isTop ? 'fit' : 'hug'
    return 'fixed'
  }
  if (ctx.isTop) return 'fit'
  const main =
    ctx.parentFlexDirection === 'row'
      ? 'width'
      : ctx.parentFlexDirection === 'column'
        ? 'height'
        : null
  const grow = toNumber(styles['flexGrow']) ?? 0
  if (main === axis && grow > 0) return 'fill'
  if (ctx.type === 'text' && axis === 'height') return 'fixed'
  return 'hug'
}

export const SIZE_MODE_LABEL: Record<SizeMode, string> = {
  fixed: 'Fixed',
  hug: 'Hug',
  fill: 'Fill',
  fit: 'Fit',
}

/**
 * Patch that switches `axis` to `mode`. `measured` is the current rendered size (used
 * when switching to Fixed so the node does not jump).
 */
export function sizeModePatch(
  styles: Styles,
  axis: 'width' | 'height',
  mode: SizeMode,
  ctx: SizeContext,
  measured: number | null,
): StylePatch {
  const main =
    ctx.parentFlexDirection === 'row'
      ? 'width'
      : ctx.parentFlexDirection === 'column'
        ? 'height'
        : null
  const patch: StylePatch = {}
  switch (mode) {
    case 'fixed':
      patch[axis] = pxValue(styles[axis], Math.round(measured ?? toPx(styles[axis]) ?? 100))
      if (main === axis && (toNumber(styles['flexGrow']) ?? 0) > 0) patch['flexGrow'] = null
      break
    case 'hug':
    case 'fit':
      patch[axis] = null
      if (main === axis) {
        patch['flexGrow'] = null
        patch['flexBasis'] = null
      }
      break
    case 'fill':
      if (main === axis) {
        patch[axis] = null
        patch['flexGrow'] = 1
        patch['flexBasis'] = '0%'
      } else {
        patch[axis] = '100%'
      }
      break
  }
  return patch
}

/** Rotation in degrees from `rotate: "15deg"` / number, or a `transform: rotate(…)`. */
export function readRotation(styles: Styles): number {
  const r = styles['rotate']
  if (typeof r === 'number') return r
  if (typeof r === 'string') {
    const m = /^\s*(-?\d*\.?\d+)\s*deg\s*$/i.exec(r)
    if (m) return Number(m[1])
  }
  const t = styles['transform']
  if (typeof t === 'string') {
    const m = /rotate\(\s*(-?\d*\.?\d+)\s*deg\s*\)/i.exec(t)
    if (m) return Number(m[1])
  }
  return 0
}

export function rotationPatch(deg: number): StylePatch {
  const normalized = ((((deg + 180) % 360) + 360) % 360) - 180
  const value = roundForDisplay(normalized === -180 ? 180 : normalized)
  return { rotate: value === 0 ? null : `${value}deg` }
}

// ---------------------------------------------------------------------------
// Flex layout
// ---------------------------------------------------------------------------

export function isFlex(styles: Styles): boolean {
  const d = styles['display']
  return d === 'flex' || d === 'inline-flex'
}

export function flexDirection(styles: Styles): FlexDirection {
  const d = styles['flexDirection']
  return d === 'column' || d === 'column-reverse' ? 'column' : 'row'
}

export type AxisAlign = 'start' | 'center' | 'end'

function toAxis(value: StyleValue | undefined): AxisAlign {
  switch (value) {
    case 'center':
      return 'center'
    case 'end':
    case 'flex-end':
    case 'right':
    case 'bottom':
      return 'end'
    default:
      return 'start'
  }
}

export interface FlexAlignment {
  x: AxisAlign
  y: AxisAlign
  distribution: 'packed' | 'space-between'
}

/** Inspector alignment grid value: x = horizontal, y = vertical, whatever the direction. */
export function readAlignment(styles: Styles): FlexAlignment {
  const dir = flexDirection(styles)
  const justify = styles['justifyContent']
  const items = styles['alignItems']
  const spread = justify === 'space-between' || justify === 'space-around'
  const main = toAxis(justify)
  const cross = toAxis(items)
  return dir === 'row'
    ? { x: main, y: cross, distribution: spread ? 'space-between' : 'packed' }
    : { x: cross, y: main, distribution: spread ? 'space-between' : 'packed' }
}

const CSS_ALIGN: Record<AxisAlign, string> = { start: 'start', center: 'center', end: 'end' }

export function alignmentPatch(
  styles: Styles,
  next: { x: AxisAlign; y: AxisAlign },
  keepSpread: boolean,
): StylePatch {
  const dir = flexDirection(styles)
  const main = dir === 'row' ? next.x : next.y
  const cross = dir === 'row' ? next.y : next.x
  const spread = keepSpread && readAlignment(styles).distribution === 'space-between'
  return {
    justifyContent: spread ? 'space-between' : main === 'start' ? null : CSS_ALIGN[main],
    alignItems: CSS_ALIGN[cross],
  }
}

/** Default flex container patch ("Add flex layout", Shift+A). */
export function addFlexPatch(direction: FlexDirection = 'column'): StylePatch {
  return { display: 'flex', flexDirection: direction, gap: '8px' }
}

export function removeFlexPatch(): StylePatch {
  return {
    display: null,
    flexDirection: null,
    justifyContent: null,
    alignItems: null,
    gap: null,
    rowGap: null,
    columnGap: null,
    flexWrap: null,
  }
}

export function readGap(styles: Styles): number {
  return toPx(styles['gap']) ?? toPx(styles['rowGap']) ?? toPx(styles['columnGap']) ?? 0
}

// ---------------------------------------------------------------------------
// Padding
// ---------------------------------------------------------------------------

export interface Sides {
  top: number
  right: number
  bottom: number
  left: number
}

/** CSS 1–4 value shorthand → sides (px only; other units count as 0). */
export function parseShorthand(value: StyleValue | undefined): Sides | null {
  if (value === undefined) return null
  if (typeof value === 'number') return { top: value, right: value, bottom: value, left: value }
  const parts = value.trim().split(/\s+/).map(toPx)
  if (parts.length === 0 || parts.length > 4) return null
  const v = parts.map((p) => p ?? 0)
  const [a = 0, b = a, c = a, d = b] = v
  return { top: a, right: b, bottom: c, left: d }
}

function parsePair(value: StyleValue | undefined): [number, number] | null {
  if (value === undefined) return null
  if (typeof value === 'number') return [value, value]
  const parts = value.trim().split(/\s+/).map(toPx)
  if (parts.length === 0 || parts.length > 2) return null
  const a = parts[0] ?? 0
  const b = parts[1] ?? a
  return [a ?? 0, b ?? 0]
}

/** Effective padding from `padding`, `paddingBlock/Inline` and the longhands (later wins). */
export function readPadding(styles: Styles): Sides {
  const out: Sides = parseShorthand(styles['padding']) ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const block = parsePair(styles['paddingBlock'])
  if (block) [out.top, out.bottom] = block
  const inline = parsePair(styles['paddingInline'])
  if (inline) [out.left, out.right] = inline
  const longhands: [keyof Sides, string][] = [
    ['top', 'paddingTop'],
    ['right', 'paddingRight'],
    ['bottom', 'paddingBottom'],
    ['left', 'paddingLeft'],
  ]
  for (const [side, key] of longhands) {
    const v = toPx(styles[key])
    if (v !== null) out[side] = v
  }
  return out
}

/** Writes the padding as four longhands (shorthands removed so they cannot disagree). */
export function paddingPatch(styles: Styles, next: Sides): StylePatch {
  const patch: StylePatch = { padding: null, paddingBlock: null, paddingInline: null }
  const sides: [keyof Sides, string][] = [
    ['top', 'paddingTop'],
    ['right', 'paddingRight'],
    ['bottom', 'paddingBottom'],
    ['left', 'paddingLeft'],
  ]
  for (const [side, key] of sides) {
    const v = next[side]
    patch[key] = v === 0 ? null : pxValue(styles[key], v)
  }
  // Keep unchanged documents untouched: only emit keys whose value really changes.
  for (const key of Object.keys(patch)) {
    if (patch[key] === null && styles[key] === undefined) delete patch[key]
    else if (patch[key] !== null && patch[key] === styles[key]) delete patch[key]
  }
  return patch
}

// ---------------------------------------------------------------------------
// Radius, opacity, blend
// ---------------------------------------------------------------------------

const CORNERS = [
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
] as const

/** Uniform radius, or MIXED when corners differ. */
export function readRadius(styles: Styles): Mixed<number> {
  const base = parseShorthand(styles['borderRadius'])
  const corners = [base?.top ?? 0, base?.right ?? 0, base?.bottom ?? 0, base?.left ?? 0]
  CORNERS.forEach((key, i) => {
    const v = toPx(styles[key])
    if (v !== null) corners[i] = v
  })
  return common(corners) ?? 0
}

export function radiusPatch(styles: Styles, radius: number): StylePatch {
  const patch: StylePatch = {
    borderRadius: radius === 0 ? null : pxValue(styles['borderRadius'], radius),
  }
  for (const key of CORNERS) if (styles[key] !== undefined) patch[key] = null
  return patch
}

/** 0..100 (percent) from `opacity: 0.5 | "50%"`. */
export function readOpacity(styles: Styles): number {
  const v = styles['opacity']
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const n = Number(v.trim().slice(0, -1))
    return Number.isFinite(n) ? n : 100
  }
  const n = toNumber(v)
  return n === null ? 100 : roundForDisplay(n * 100)
}

export function opacityPatch(percent: number): StylePatch {
  const clamped = Math.min(100, Math.max(0, percent))
  return { opacity: clamped === 100 ? null : roundForDisplay(clamped / 100) }
}

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

export function readBlendMode(styles: Styles): BlendMode {
  const v = styles['mixBlendMode']
  return typeof v === 'string' && (BLEND_MODES as readonly string[]).includes(v)
    ? (v as BlendMode)
    : 'normal'
}

export function blendLabel(mode: string): string {
  return mode
    .split('-')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export interface Typography {
  family: string
  weight: number
  size: number
  /** px, or null for "Auto" (normal). */
  lineHeight: number | null
  /** Percent of the font size (the inspector shows letter spacing in %). */
  letterSpacing: number
  align: 'left' | 'center' | 'right' | 'justify'
}

export function readTypography(styles: Styles): Typography {
  const family = typeof styles['fontFamily'] === 'string' ? styles['fontFamily'] : 'Inter'
  const weightRaw = styles['fontWeight']
  const weight =
    weightRaw === 'bold' ? 700 : weightRaw === 'normal' ? 400 : (toNumber(weightRaw) ?? 400)
  const size = toPx(styles['fontSize']) ?? 16
  const lh = styles['lineHeight']
  let lineHeight: number | null = toPx(lh)
  if (typeof lh === 'number' && lh < 4) lineHeight = roundForDisplay(lh * size)
  if (typeof lh === 'string' && /^\d*\.?\d+$/.test(lh.trim()) && Number(lh) < 4) {
    lineHeight = roundForDisplay(Number(lh) * size)
  }
  if (typeof lh === 'string' && lh.trim().endsWith('%')) {
    lineHeight = roundForDisplay((Number(lh.trim().slice(0, -1)) / 100) * size)
  }
  const ls = styles['letterSpacing']
  let letterSpacing = 0
  if (typeof ls === 'string') {
    const t = ls.trim()
    if (t.endsWith('em')) letterSpacing = roundForDisplay(Number(t.slice(0, -2)) * 100)
    else if (t.endsWith('%')) letterSpacing = Number(t.slice(0, -1))
    else {
      const px = toPx(t)
      if (px !== null && size > 0) letterSpacing = roundForDisplay((px / size) * 100)
    }
  } else if (typeof ls === 'number' && size > 0) {
    letterSpacing = roundForDisplay((ls / size) * 100)
  }
  if (!Number.isFinite(letterSpacing)) letterSpacing = 0
  const alignRaw = styles['textAlign']
  const align =
    alignRaw === 'center' || alignRaw === 'right' || alignRaw === 'justify' ? alignRaw : 'left'
  return { family, weight, size, lineHeight, letterSpacing, align }
}

export function letterSpacingPatch(percent: number): StylePatch {
  return { letterSpacing: percent === 0 ? null : `${roundForDisplay(percent / 100)}em` }
}

// ---------------------------------------------------------------------------
// Sizing helpers for the Layout section
// ---------------------------------------------------------------------------

/** Whether a node is laid out by its parent's flex flow (X/Y are not its own). */
export function isInFlow(styles: Styles, isTop: boolean, parentIsFlex: boolean): boolean {
  if (isTop) return false
  const pos = styles['position']
  if (pos === 'absolute' || pos === 'fixed') return false
  return parentIsFlex
}
