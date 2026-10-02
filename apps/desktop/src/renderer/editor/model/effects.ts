/**
 * Fill, outline, border, shadow and filter values ↔ editable rows. Pure, unit-tested.
 *
 * Hidden paints are kept in CSS custom properties (`--hidden-backgroundColor: #FFF`):
 * valid CSS, ignored by the renderer and exporters, and restored by the eye toggle.
 */
import type { StylePatch, StyleValue, Styles } from '@baren/schema'
import { findColors, formatColor, parseColor, type ColorValue } from './colors'
import { pxValue, toPx } from './styles'

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

export type FillKind = 'solid' | 'gradient' | 'image'

export interface Fill {
  kind: FillKind
  /** Property holding the paint: `backgroundColor`, `backgroundImage`, or `color` (text). */
  prop: 'backgroundColor' | 'backgroundImage' | 'color'
  /** Raw CSS value. */
  value: string
  /** Main color (solid color, or the first gradient stop). */
  color: ColorValue | null
  hidden: boolean
}

export const HIDDEN_PREFIX = '--hidden-'

function str(v: StyleValue | undefined): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function fillFrom(prop: Fill['prop'], value: string, hidden: boolean): Fill {
  if (prop === 'backgroundImage') {
    const isImage = /url\(/i.test(value)
    return {
      kind: isImage ? 'image' : 'gradient',
      prop,
      value,
      color: isImage ? null : (findColors(value)[0]?.color ?? null),
      hidden,
    }
  }
  return { kind: 'solid', prop, value, color: parseColor(value), hidden }
}

/** The node's fill. Text nodes paint with `color`; boxes with background. */
export function readFill(styles: Styles, type: string): Fill | null {
  if (type === 'text') {
    const c = str(styles['color'])
    if (c) return fillFrom('color', c, false)
    const hidden = str(styles[`${HIDDEN_PREFIX}color`])
    return hidden ? fillFrom('color', hidden, true) : null
  }
  for (const prop of ['backgroundImage', 'backgroundColor'] as const) {
    const v = str(styles[prop])
    if (v && v !== 'none') return fillFrom(prop, v, false)
  }
  for (const prop of ['backgroundImage', 'backgroundColor'] as const) {
    const v = str(styles[`${HIDDEN_PREFIX}${prop}`])
    if (v) return fillFrom(prop, v, true)
  }
  const bg = str(styles['background'])
  if (bg)
    return fillFrom(/gradient|url\(/i.test(bg) ? 'backgroundImage' : 'backgroundColor', bg, false)
  return null
}

export function defaultFillColor(type: string): string {
  return type === 'text' ? '#000000' : type === 'rect' ? '#D9D9D9' : '#FFFFFF'
}

export function addFillPatch(type: string): StylePatch {
  return type === 'text' ? { color: '#000000' } : { backgroundColor: defaultFillColor(type) }
}

export function removeFillPatch(fill: Fill): StylePatch {
  const patch: StylePatch = { [fill.prop]: null, [`${HIDDEN_PREFIX}${fill.prop}`]: null }
  if (fill.prop !== 'color') {
    patch['background'] = null
    patch['backgroundSize'] = null
    patch['backgroundPosition'] = null
    patch['backgroundRepeat'] = null
  }
  return patch
}

export function toggleFillPatch(fill: Fill): StylePatch {
  return fill.hidden
    ? { [fill.prop]: fill.value, [`${HIDDEN_PREFIX}${fill.prop}`]: null }
    : { [fill.prop]: null, [`${HIDDEN_PREFIX}${fill.prop}`]: fill.value }
}

/** Patch writing `css` as the solid paint (keeps hidden state). */
export function solidFillPatch(fill: Fill | null, type: string, css: string): StylePatch {
  if (type === 'text') return fill?.hidden ? { [`${HIDDEN_PREFIX}color`]: css } : { color: css }
  const patch: StylePatch = { backgroundImage: null, background: null }
  if (fill?.hidden) patch[`${HIDDEN_PREFIX}backgroundColor`] = css
  else patch['backgroundColor'] = css
  return patch
}

/** Switch the fill type. Gradients start from the current color. */
export function fillKindPatch(fill: Fill | null, type: string, kind: FillKind): StylePatch {
  const base = fill?.color ? colorCss(fill.color) : defaultFillColor(type)
  if (kind === 'solid') return solidFillPatch(fill, type, base)
  if (kind === 'gradient') {
    return {
      backgroundColor: null,
      background: null,
      backgroundImage: `linear-gradient(180deg, ${base} 0%, #FFFFFF00 100%)`,
    }
  }
  return {
    backgroundColor: null,
    background: null,
    backgroundImage: fill?.kind === 'image' ? fill.value : 'none',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  }
}

export function colorCss(color: ColorValue): string {
  return color.kind === 'token' ? `var(${color.token})` : formatColor(color.hex, color.alpha)
}

/** Replace the first gradient stop color (the one the row edits). */
export function gradientWithColor(value: string, css: string): string {
  const first = findColors(value)[0]
  if (!first) return value
  return value.slice(0, first.index) + css + value.slice(first.index + first.text.length)
}

// ---------------------------------------------------------------------------
// Outline / border
// ---------------------------------------------------------------------------

export interface Stroke {
  width: number
  style: string
  color: ColorValue | null
  colorText: string
}

const STROKE_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'none'])

/** Parse `"1.5px solid var(--x)"` (any order). */
export function parseStroke(value: string): Stroke | null {
  const colors = findColors(value)
  let rest = value
  for (const c of colors) rest = rest.replace(c.text, ' ')
  const parts = rest.trim().split(/\s+/).filter(Boolean)
  let width = 1
  let style = 'solid'
  for (const p of parts) {
    const px = toPx(p)
    if (px !== null) width = px
    else if (STROKE_STYLES.has(p)) style = p
  }
  const first = colors[0]
  return {
    width,
    style,
    color: first?.color ?? null,
    colorText: first?.text ?? 'currentColor',
  }
}

export function formatStroke(s: Pick<Stroke, 'width' | 'style' | 'colorText'>): string {
  return `${Math.round(s.width * 100) / 100}px ${s.style} ${s.colorText}`
}

export function readOutline(styles: Styles): Stroke | null {
  const o = str(styles['outline'])
  if (o && o !== 'none' && o !== '0') return parseStroke(o)
  const w = toPx(styles['outlineWidth'])
  const st = str(styles['outlineStyle'])
  const c = str(styles['outlineColor'])
  if (st && st !== 'none') {
    return {
      width: w ?? 1,
      style: st,
      color: c ? parseColor(c) : null,
      colorText: c ?? 'currentColor',
    }
  }
  return null
}

export function outlinePatch(next: Stroke | null): StylePatch {
  return {
    outline: next ? formatStroke(next) : null,
    outlineWidth: null,
    outlineStyle: null,
    outlineColor: null,
  }
}

const BORDER_KEYS = [
  'border',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
] as const

export interface BorderInfo extends Stroke {
  /** Which sides draw (documents often use one side, e.g. a divider). */
  sides: ('top' | 'right' | 'bottom' | 'left')[]
}

export function readBorder(styles: Styles): BorderInfo | null {
  const all = str(styles['border'])
  if (all && all !== 'none') {
    const s = parseStroke(all)
    return s ? { ...s, sides: ['top', 'right', 'bottom', 'left'] } : null
  }
  const style = str(styles['borderStyle'])
  if (style && style !== 'none') {
    const c = str(styles['borderColor'])
    return {
      width: toPx(styles['borderWidth']) ?? 1,
      style,
      color: c ? parseColor(c) : null,
      colorText: c ?? 'currentColor',
      sides: ['top', 'right', 'bottom', 'left'],
    }
  }
  const sides: BorderInfo['sides'] = []
  let first: Stroke | null = null
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const cap = side.charAt(0).toUpperCase() + side.slice(1)
    const short = str(styles[`border${cap}`])
    const st = str(styles[`border${cap}Style`])
    let stroke: Stroke | null = null
    if (short && short !== 'none') stroke = parseStroke(short)
    else if (st && st !== 'none') {
      const c = str(styles[`border${cap}Color`])
      stroke = {
        width: toPx(styles[`border${cap}Width`]) ?? 1,
        style: st,
        color: c ? parseColor(c) : null,
        colorText: c ?? 'currentColor',
      }
    }
    if (stroke) {
      sides.push(side)
      first ??= stroke
    }
  }
  return first ? { ...first, sides } : null
}

/** Write a uniform border as longhands (all per-side keys removed). */
export function borderPatch(next: Stroke | null): StylePatch {
  const patch: StylePatch = {}
  for (const key of BORDER_KEYS) patch[key] = null
  if (next) {
    patch['borderWidth'] = `${Math.round(next.width * 100) / 100}px`
    patch['borderStyle'] = next.style
    patch['borderColor'] = next.colorText
  }
  return patch
}

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

export interface Shadow {
  inset: boolean
  x: number
  y: number
  blur: number
  spread: number
  color: ColorValue | null
  colorText: string
}

/** Split on commas that are not inside parentheses. */
export function splitTopLevel(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = value.slice(start).trim()
  if (last) out.push(last)
  return out
}

export function parseShadows(value: StyleValue | undefined): Shadow[] {
  const v = str(value)
  if (!v || v === 'none') return []
  const out: Shadow[] = []
  for (const part of splitTopLevel(v)) {
    const colors = findColors(part)
    let rest = part
    for (const c of colors) rest = rest.replace(c.text, ' ')
    const tokens = rest.trim().split(/\s+/).filter(Boolean)
    const inset = tokens.includes('inset')
    const lengths = tokens.filter((t) => t !== 'inset').map((t) => toPx(t) ?? 0)
    const first = colors[0]
    out.push({
      inset,
      x: lengths[0] ?? 0,
      y: lengths[1] ?? 0,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color: first?.color ?? null,
      colorText: first?.text ?? '#00000040',
    })
  }
  return out
}

export function formatShadow(s: Shadow): string {
  const n = (v: number) => `${Math.round(v * 100) / 100}px`
  return `${s.inset ? 'inset ' : ''}${n(s.x)} ${n(s.y)} ${n(s.blur)} ${n(s.spread)} ${s.colorText}`
}

export function formatShadows(list: readonly Shadow[]): string | null {
  return list.length === 0 ? null : list.map(formatShadow).join(', ')
}

export function defaultShadow(inset: boolean): Shadow {
  return inset
    ? { inset, x: 0, y: 1, blur: 3, spread: 0, color: null, colorText: '#00000026' }
    : { inset, x: 0, y: 4, blur: 12, spread: 0, color: null, colorText: '#0000001A' }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const FILTER_KINDS = [
  { fn: 'blur', label: 'Blur', unit: 'px', initial: 4, max: 100 },
  { fn: 'brightness', label: 'Brightness', unit: '%', initial: 100, max: 300 },
  { fn: 'contrast', label: 'Contrast', unit: '%', initial: 100, max: 300 },
  { fn: 'grayscale', label: 'Grayscale', unit: '%', initial: 100, max: 100 },
  { fn: 'saturate', label: 'Saturate', unit: '%', initial: 100, max: 300 },
  { fn: 'invert', label: 'Invert', unit: '%', initial: 100, max: 100 },
  { fn: 'sepia', label: 'Sepia', unit: '%', initial: 100, max: 100 },
] as const

export type FilterFn = (typeof FILTER_KINDS)[number]['fn']

export interface Filter {
  fn: FilterFn
  amount: number
}

function isFilterFn(v: string): v is FilterFn {
  return FILTER_KINDS.some((k) => k.fn === v)
}

export function parseFilters(value: StyleValue | undefined): Filter[] {
  const v = str(value)
  if (!v || v === 'none') return []
  const out: Filter[] = []
  for (const m of v.matchAll(/([a-z-]+)\(\s*([^)]*)\)/gi)) {
    const fn = (m[1] ?? '').toLowerCase()
    if (!isFilterFn(fn)) continue
    const arg = (m[2] ?? '').trim()
    let amount: number
    if (fn === 'blur') amount = toPx(arg) ?? 0
    else if (arg.endsWith('%')) amount = Number(arg.slice(0, -1))
    else amount = Number(arg) * 100
    out.push({ fn, amount: Number.isFinite(amount) ? amount : 0 })
  }
  return out
}

export function formatFilters(list: readonly Filter[]): string | null {
  if (list.length === 0) return null
  return list
    .map((f) =>
      f.fn === 'blur' ? `blur(${Math.round(f.amount * 100) / 100}px)` : `${f.fn}(${f.amount}%)`,
    )
    .join(' ')
}

/** Width format helper re-exported for sections that edit stroke widths. */
export function strokeWidthValue(prev: StyleValue | undefined, n: number): StyleValue {
  return pxValue(prev, n)
}
