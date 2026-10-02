/**
 * Styles → Tailwind v4 classes (contract §8.1): a fixed category order, the file's tokens as
 * the theme (`--color-*` → `bg-`/`text-`/`border-`…, `--spacing-*`, `--radius-*`, `--text-*`,
 * `--leading-*`, `--tracking-*`, `--font-*`, `--font-weight-*`, `--shadow-*`, `--opacity-*`,
 * `--container-*`), Tailwind's default spacing scale for multiples of 4 px, and arbitrary
 * values / properties for everything else. Deterministic: depends only on the styles and the
 * tokens, never on key order.
 */
import { cssDeclarationValue, cssPropertyName, formatCssNumber, resolveVars } from '@baren/schema'
import type { StyleValue, Styles, Token } from '@baren/schema'
import { colorKey, parseAnyColor } from './css/color.ts'
import { remToPx, splitTopLevel } from './css/syntax.ts'

type Namespace =
  | 'color'
  | 'spacing'
  | 'radius'
  | 'text'
  | 'leading'
  | 'tracking'
  | 'font'
  | 'font-weight'
  | 'shadow'
  | 'opacity'
  | 'container'

const NAMESPACES: readonly Namespace[] = [
  'font-weight',
  'color',
  'spacing',
  'radius',
  'text',
  'leading',
  'tracking',
  'font',
  'shadow',
  'opacity',
  'container',
]

export interface Theme {
  tokens: Record<string, Token>
  /** namespace → normalised value → utility names (sorted). */
  byValue: Map<Namespace, Map<string, string[]>>
  /** token name → [namespace, utility name]. */
  byName: Map<string, [Namespace, string]>
}

function nsOf(name: string): [Namespace, string] | null {
  for (const ns of NAMESPACES) {
    const prefix = `--${ns}-`
    if (name.startsWith(prefix)) {
      const rest = name.slice(prefix.length)
      if (rest === '' || rest.includes('--')) return null
      return [ns, rest]
    }
  }
  return null
}

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`
const PX_RE = new RegExp(`^(${NUM})px$`, 'i')
const BARE_RE = new RegExp(`^(${NUM})$`, 'i')
const PCT_RE = new RegExp(`^(${NUM})%$`, 'i')

/** px value of a literal (`16px`, `1rem`, numbers), or null. */
function pxOf(v: string): number | null {
  const t = remToPx(v.trim())
  const m = PX_RE.exec(t)
  if (m) return Number(m[1])
  if (t === '0') return 0
  return null
}

/** Normalised value key for token matching in a namespace. */
function valueKey(ns: Namespace, raw: string): string {
  const v = raw.trim()
  if (ns === 'color') return colorKey(v) ?? `s:${v.toLowerCase()}`
  if (ns === 'font') return `f:${fontKey(v)}`
  if (ns === 'opacity' || ns === 'font-weight') {
    const p = PCT_RE.exec(v)
    if (p) return `n:${Number(p[1]) / 100}`
    const b = BARE_RE.exec(v)
    if (b) return `n:${Number(b[1])}`
    return `s:${v.toLowerCase()}`
  }
  if (ns === 'leading') {
    const b = BARE_RE.exec(v)
    if (b) return `n:${Number(b[1])}`
  }
  const p = pxOf(v)
  if (p !== null) return `px:${p}`
  return `s:${v.replace(/\s+/g, ' ').toLowerCase()}`
}

/** Font family list without quote or spacing differences. */
function fontKey(v: string): string {
  return splitTopLevel(v, ',')
    .map((f) =>
      f
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    )
    .join(',')
}

export function buildTheme(tokens: Record<string, Token>): Theme {
  const byValue = new Map<Namespace, Map<string, string[]>>()
  const byName = new Map<string, [Namespace, string]>()
  for (const name of Object.keys(tokens).sort()) {
    const ns = nsOf(name)
    if (!ns) continue
    byName.set(name, ns)
    const token = tokens[name] as Token
    const raw =
      typeof token.value === 'number'
        ? formatCssNumber(token.value)
        : resolveVars(token.value, tokens)
    if (raw === null || raw.trim() === '') continue
    const key = valueKey(ns[0], raw)
    let m = byValue.get(ns[0])
    if (!m) {
      m = new Map()
      byValue.set(ns[0], m)
    }
    const list = m.get(key) ?? []
    list.push(ns[1])
    m.set(key, list)
  }
  return { tokens, byValue, byName }
}

type Match = { token: string } | { ambiguous: true } | null

const VAR_ONLY_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/

/** A whole-value `var(--token)` reference, or null. */
function varRef(v: string): string | null {
  return VAR_ONLY_RE.exec(v.trim())?.[1] ?? null
}

function lookup(theme: Theme, ns: Namespace, value: string): Match {
  const ref = varRef(value)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    return hit && hit[0] === ns ? { token: hit[1] } : null
  }
  const names = theme.byValue.get(ns)?.get(valueKey(ns, value))
  if (!names || names.length === 0) return null
  if (names.length > 1) return { ambiguous: true }
  return { token: names[0] as string }
}

/** Arbitrary value text: quotes → `'`, no spaces after commas, spaces → `_`. */
export function arb(value: string): string {
  return value
    .trim()
    .replace(/_/g, '\\_')
    .replace(/"/g, "'")
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, '_')
}

function cssText(key: string, v: StyleValue): string {
  return cssDeclarationValue(key, v) ?? String(v)
}

function arbProp(key: string, v: StyleValue): string {
  const name = cssPropertyName(key) ?? key
  return `[${name}:${arb(cssText(key, v))}]`
}

const str = (v: StyleValue): string => (typeof v === 'number' ? formatCssNumber(v) : v.trim())

// ---------------------------------------------------------------------------
// Value mappers
// ---------------------------------------------------------------------------

const FRACTIONS: Record<string, string> = {
  '50': '1/2',
  '25': '1/4',
  '75': '3/4',
  '20': '1/5',
  '40': '2/5',
  '60': '3/5',
  '80': '4/5',
  '100': 'full',
}

/**
 * Spacing-like utility (`p-4`, `w-[26px]`, `-left-2`): tokens, keywords, the default 4 px
 * scale, fractions, arbitrary values.
 */
function spacing(
  theme: Theme,
  prefix: string,
  key: string,
  v: StyleValue,
  opts: {
    negative?: boolean
    container?: boolean
    keywords?: Record<string, string>
    percent?: boolean
  } = {},
): string {
  const s = typeof v === 'number' ? `${formatCssNumber(v)}px` : v.trim()
  const kw = opts.keywords?.[s.toLowerCase()]
  if (kw !== undefined) return kw === '' ? prefix : `${prefix}-${kw}`
  const ref = varRef(s)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    if (hit && (hit[0] === 'spacing' || (opts.container && hit[0] === 'container')))
      return `${prefix}-${hit[1]}`
    return arbProp(key, v)
  }
  const negative = opts.negative && /^-/.test(s) && s !== '-0'
  const abs = negative ? s.slice(1) : s
  const sign = negative ? '-' : ''
  const m = lookup(theme, 'spacing', abs)
  if (m && 'token' in m) return `${sign}${prefix}-${m.token}`
  if (opts.container && !negative) {
    const c = lookup(theme, 'container', abs)
    if (c && 'token' in c) return `${prefix}-${c.token}`
  }
  const p = pxOf(abs)
  if (p !== null && (!m || !('ambiguous' in m))) {
    if (p === 0) return `${prefix}-0`
    if (p === 1) return `${sign}${prefix}-px`
    // Tailwind's documented spacing steps run 0…96 (384 px); beyond that, arbitrary values read better.
    if (Number.isInteger(p / 4) && p / 4 <= 96) return `${sign}${prefix}-${p / 4}`
  }
  if (opts.percent) {
    const pct = PCT_RE.exec(abs)
    if (pct && !negative) {
      const f = FRACTIONS[formatCssNumber(Number(pct[1]))]
      if (f !== undefined) return `${prefix}-${f}`
    }
  }
  if (/^-?[a-z-]+$/i.test(s) && !/^-?\d/.test(s)) return arbProp(key, v)
  return `${prefix}-[${arb(s)}]`
}

/** Colour utility (`bg-input`, `text-[#8A8A8A]`, `[color:#FFFFFF]` when ambiguous). */
function color(theme: Theme, prefix: string, key: string, v: StyleValue): string {
  const s = str(v)
  const lower = s.toLowerCase()
  if (lower === 'transparent') return `${prefix}-transparent`
  if (lower === 'currentcolor') return `${prefix}-current`
  if (lower === 'inherit') return `${prefix}-inherit`
  const ref = varRef(s)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    return hit && hit[0] === 'color' ? `${prefix}-${hit[1]}` : arbProp(key, v)
  }
  if (parseAnyColor(s) === null) return arbProp(key, v)
  const m = lookup(theme, 'color', s)
  if (m && 'token' in m) return `${prefix}-${m.token}`
  if (m) return arbProp(key, v)
  return `${prefix}-[${arb(s)}]`
}

/** A namespaced token utility (`rounded-lg`, `shadow-md`), else null. */
function tokenOnly(theme: Theme, ns: Namespace, prefix: string, v: StyleValue): string | null {
  const m = lookup(theme, ns, str(v))
  return m && 'token' in m ? `${prefix}-${m.token}` : null
}

function keyword(map: Record<string, string>, key: string, v: StyleValue): string {
  const hit = map[str(v).toLowerCase()]
  return hit ?? arbProp(key, v)
}

function integerUtility(prefix: string, key: string, v: StyleValue, negativeOk: boolean): string {
  const s = str(v)
  if (/^-?\d+$/.test(s)) {
    if (s.startsWith('-')) return negativeOk ? `-${prefix}-${s.slice(1)}` : arbProp(key, v)
    return `${prefix}-${s}`
  }
  return `${prefix}-[${arb(s)}]`
}

function radius(theme: Theme, prefix: string, key: string, v: StyleValue): string {
  const s = str(v)
  if (typeof v === 'string' && s.includes('/')) return arbProp(key, v)
  const t = tokenOnly(theme, 'radius', prefix, v)
  if (t) return t
  const p = pxOf(typeof v === 'number' ? `${v}px` : s)
  if (p !== null && p >= 9999) return `${prefix}-full`
  if (p === 0) return `${prefix}-none`
  if (varRef(s) !== null) return arbProp(key, v)
  return `${prefix}-[${arb(typeof v === 'number' ? `${formatCssNumber(v)}px` : s)}]`
}

function borderWidth(prefix: string, key: string, v: StyleValue): string {
  const s = typeof v === 'number' ? `${formatCssNumber(v)}px` : v.trim()
  const p = pxOf(s)
  if (p !== null && Number.isInteger(p) && p >= 0) return p === 1 ? prefix : `${prefix}-${p}`
  if (varRef(s) !== null) return arbProp(key, v)
  return `${prefix}-[${arb(s)}]`
}

const ALIGN_ITEMS: Record<string, string> = {
  'flex-start': 'items-start',
  start: 'items-start',
  'flex-end': 'items-end',
  end: 'items-end',
  center: 'items-center',
  baseline: 'items-baseline',
  stretch: 'items-stretch',
}
const JUSTIFY: Record<string, string> = {
  'flex-start': 'justify-start',
  start: 'justify-start',
  'flex-end': 'justify-end',
  end: 'justify-end',
  center: 'justify-center',
  'space-between': 'justify-between',
  'space-around': 'justify-around',
  'space-evenly': 'justify-evenly',
  stretch: 'justify-stretch',
  normal: 'justify-normal',
}
const ALIGN_CONTENT: Record<string, string> = {
  'flex-start': 'content-start',
  start: 'content-start',
  'flex-end': 'content-end',
  end: 'content-end',
  center: 'content-center',
  'space-between': 'content-between',
  'space-around': 'content-around',
  'space-evenly': 'content-evenly',
  stretch: 'content-stretch',
  normal: 'content-normal',
  baseline: 'content-baseline',
}
const ALIGN_SELF: Record<string, string> = {
  auto: 'self-auto',
  'flex-start': 'self-start',
  start: 'self-start',
  'flex-end': 'self-end',
  end: 'self-end',
  center: 'self-center',
  stretch: 'self-stretch',
  baseline: 'self-baseline',
}
const JUSTIFY_ITEMS: Record<string, string> = {
  start: 'justify-items-start',
  end: 'justify-items-end',
  center: 'justify-items-center',
  stretch: 'justify-items-stretch',
  normal: 'justify-items-normal',
}
const JUSTIFY_SELF: Record<string, string> = {
  auto: 'justify-self-auto',
  start: 'justify-self-start',
  end: 'justify-self-end',
  center: 'justify-self-center',
  stretch: 'justify-self-stretch',
}
const DISPLAY: Record<string, string> = {
  flex: 'flex',
  'inline-flex': 'inline-flex',
  block: 'block',
  'inline-block': 'inline-block',
  inline: 'inline',
  grid: 'grid',
  'inline-grid': 'inline-grid',
  none: 'hidden',
  contents: 'contents',
  'flow-root': 'flow-root',
  'list-item': 'list-item',
}
const FLEX_DIRECTION: Record<string, string> = {
  row: 'flex-row',
  'row-reverse': 'flex-row-reverse',
  column: 'flex-col',
  'column-reverse': 'flex-col-reverse',
}
const FLEX_WRAP: Record<string, string> = {
  wrap: 'flex-wrap',
  nowrap: 'flex-nowrap',
  'wrap-reverse': 'flex-wrap-reverse',
}
const POSITION: Record<string, string> = {
  static: 'static',
  relative: 'relative',
  absolute: 'absolute',
  fixed: 'fixed',
  sticky: 'sticky',
}
const OVERFLOW = ['auto', 'hidden', 'clip', 'visible', 'scroll']
const BORDER_STYLE = ['solid', 'dashed', 'dotted', 'double', 'hidden', 'none']
const FONT_WEIGHTS: Record<string, string> = {
  '100': 'thin',
  '200': 'extralight',
  '300': 'light',
  '400': 'normal',
  '500': 'medium',
  '600': 'semibold',
  '700': 'bold',
  '800': 'extrabold',
  '900': 'black',
  bold: 'bold',
  normal: 'normal',
}
const BLEND = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color',
  'luminosity', 'plus-darker', 'plus-lighter',
] // prettier-ignore
const SIZE_KEYWORDS: Record<string, string> = {
  auto: 'auto',
  '100%': 'full',
  'fit-content': 'fit',
  'max-content': 'max',
  'min-content': 'min',
}

function fromList(prefix: string, list: readonly string[], key: string, v: StyleValue): string {
  const s = str(v).toLowerCase()
  return list.includes(s) ? `${prefix}-${s}` : arbProp(key, v)
}

/** Font family utility: a matching `--font-*` token, else an arbitrary family list. */
function fontFamily(theme: Theme, key: string, v: StyleValue): string {
  const s = str(v)
  const ref = varRef(s)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    return hit && hit[0] === 'font' ? `font-${hit[1]}` : arbProp(key, v)
  }
  const m = lookup(theme, 'font', s)
  if (m && 'token' in m) return `font-${m.token}`
  const families = splitTopLevel(s, ',').map((f) => {
    const t = f.trim()
    const q = /^(["'])(.*)\1$/.exec(t)
    return q ? `'${(q[2] as string).replace(/\s+/g, '_')}'` : t.replace(/\s+/g, '_')
  })
  return `font-[${families.join(',')}]`
}

function fontWeight(theme: Theme, key: string, v: StyleValue): string {
  const s = str(v)
  const ref = varRef(s)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    return hit && hit[0] === 'font-weight' ? `font-${hit[1]}` : arbProp(key, v)
  }
  const m = lookup(theme, 'font-weight', s)
  if (m && 'token' in m) return `font-${m.token}`
  const named = FONT_WEIGHTS[s.toLowerCase()]
  if (named !== undefined) return `font-${named}`
  return /^\d+$/.test(s) ? `font-[${s}]` : arbProp(key, v)
}

function opacity(theme: Theme, key: string, v: StyleValue): string {
  const t = tokenOnly(theme, 'opacity', 'opacity', v)
  if (t) return t
  const s = str(v)
  const pct = PCT_RE.exec(s)
  const n = pct ? Number(pct[1]) / 100 : BARE_RE.test(s) ? Number(s) : null
  if (n !== null && Number.isInteger(Math.round(n * 1e6) / 1e4))
    return `opacity-${Math.round(n * 100)}`
  if (varRef(s) !== null) return arbProp(key, v)
  return `opacity-[${arb(s)}]`
}

function rotate(key: string, v: StyleValue): string {
  const s = typeof v === 'number' ? `${formatCssNumber(v)}deg` : v.trim()
  const m = /^(-?)(\d+(?:\.\d+)?)deg$/.exec(s)
  if (m && Number.isInteger(Number(m[2]))) return `${m[1] ? '-' : ''}rotate-${m[2]}`
  return /^-?[\d.]+deg$/.test(s) ? `rotate-[${s}]` : arbProp(key, v)
}

/** Line-height utility: `leading-*` tokens, spacing tokens, `leading-none`, else arbitrary. */
function lineHeight(theme: Theme, key: string, v: StyleValue): string {
  const s = str(v)
  const ref = varRef(s)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    if (hit && (hit[0] === 'leading' || hit[0] === 'spacing')) return `leading-${hit[1]}`
    return arbProp(key, v)
  }
  const t = lookup(theme, 'leading', s)
  if (t && 'token' in t) return `leading-${t.token}`
  if (typeof v === 'number' || BARE_RE.test(s)) {
    if (Number(s) === 1) return 'leading-none'
    return `leading-[${s}]`
  }
  const sp = lookup(theme, 'spacing', s)
  if (sp && 'token' in sp) return `leading-${sp.token}`
  return `leading-[${arb(s)}]`
}

/** The `--leading-*` token a line height resolves to, if any. */
function leadingToken(theme: Theme, v: StyleValue): string | null {
  const s = str(v)
  const ref = varRef(s)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    return hit && hit[0] === 'leading' ? hit[1] : null
  }
  const t = lookup(theme, 'leading', s)
  return t && 'token' in t ? t.token : null
}

function fontSize(theme: Theme, key: string, v: StyleValue): { cls: string; token: boolean } {
  const s = typeof v === 'number' ? `${formatCssNumber(v)}px` : v.trim()
  const ref = varRef(s)
  if (ref !== null) {
    const hit = theme.byName.get(ref)
    return hit && hit[0] === 'text'
      ? { cls: `text-${hit[1]}`, token: true }
      : { cls: arbProp(key, v), token: false }
  }
  const m = lookup(theme, 'text', s)
  if (m && 'token' in m) return { cls: `text-${m.token}`, token: true }
  if (m || !/^[\d.]/.test(s)) return { cls: arbProp(key, v), token: false }
  return { cls: `text-[${arb(s)}]`, token: false }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

type Handler = (theme: Theme, key: string, v: StyleValue, styles: Styles) => string | null

const INSET_KW = { auto: 'auto' }
const sp =
  (prefix: string, opts: Parameters<typeof spacing>[4] = {}): Handler =>
  (t, k, v) =>
    spacing(t, prefix, k, v, opts)
const col =
  (prefix: string): Handler =>
  (t, k, v) =>
    color(t, prefix, k, v)

/** Category order and, within each, property order (contract §8.1). */
const ORDER: [string, Handler][] = [
  // display
  ['display', (_t, k, v) => keyword(DISPLAY, k, v)],
  // flex direction / wrap
  ['flexDirection', (_t, k, v) => keyword(FLEX_DIRECTION, k, v)],
  ['flexWrap', (_t, k, v) => keyword(FLEX_WRAP, k, v)],
  // align / justify
  ['alignItems', (_t, k, v) => keyword(ALIGN_ITEMS, k, v)],
  ['justifyContent', (_t, k, v) => keyword(JUSTIFY, k, v)],
  ['alignContent', (_t, k, v) => keyword(ALIGN_CONTENT, k, v)],
  ['alignSelf', (_t, k, v) => keyword(ALIGN_SELF, k, v)],
  ['justifyItems', (_t, k, v) => keyword(JUSTIFY_ITEMS, k, v)],
  ['justifySelf', (_t, k, v) => keyword(JUSTIFY_SELF, k, v)],
  ['order', (_t, k, v) => integerUtility('order', k, v, true)],
  // position + offsets
  ['position', (_t, k, v) => keyword(POSITION, k, v)],
  ['top', sp('top', { negative: true, keywords: INSET_KW, percent: true })],
  ['right', sp('right', { negative: true, keywords: INSET_KW, percent: true })],
  ['bottom', sp('bottom', { negative: true, keywords: INSET_KW, percent: true })],
  ['left', sp('left', { negative: true, keywords: INSET_KW, percent: true })],
  ['zIndex', (_t, k, v) => (str(v) === 'auto' ? 'z-auto' : integerUtility('z', k, v, true))],
  // size
  [
    'width',
    sp('w', { container: true, keywords: { ...SIZE_KEYWORDS, '100vw': 'screen' }, percent: true }),
  ],
  ['height', sp('h', { keywords: { ...SIZE_KEYWORDS, '100vh': 'screen' }, percent: true })],
  ['minWidth', sp('min-w', { container: true, keywords: SIZE_KEYWORDS, percent: true })],
  ['minHeight', sp('min-h', { keywords: { ...SIZE_KEYWORDS, '100vh': 'screen' }, percent: true })],
  [
    'maxWidth',
    sp('max-w', { container: true, keywords: { ...SIZE_KEYWORDS, none: 'none' }, percent: true }),
  ],
  ['maxHeight', sp('max-h', { keywords: { ...SIZE_KEYWORDS, none: 'none' }, percent: true })],
  [
    'aspectRatio',
    (_t, k, v) => {
      const s = str(v).replace(/\s+/g, '')
      if (s === '1' || s === '1/1') return 'aspect-square'
      if (s === '16/9') return 'aspect-video'
      if (s === 'auto') return 'aspect-auto'
      return /^[\d./]+$/.test(s) ? `aspect-[${s}]` : arbProp(k, v)
    },
  ],
  [
    'flexGrow',
    (_t, k, v) => {
      const s = str(v)
      return s === '1' ? 'grow' : /^\d+$/.test(s) ? `grow-${s}` : arbProp(k, v)
    },
  ],
  [
    'flexShrink',
    (_t, k, v) => {
      const s = str(v)
      return s === '1' ? 'shrink' : /^\d+$/.test(s) ? `shrink-${s}` : arbProp(k, v)
    },
  ],
  [
    'flexBasis',
    sp('basis', { container: true, keywords: { auto: 'auto', '100%': 'full' }, percent: false }),
  ],
  // padding
  ['padding', sp('p')],
  ['paddingBlock', sp('py')],
  ['paddingInline', sp('px')],
  ['paddingTop', sp('pt')],
  ['paddingRight', sp('pr')],
  ['paddingBottom', sp('pb')],
  ['paddingLeft', sp('pl')],
  // margin
  ['margin', sp('m', { negative: true, keywords: { auto: 'auto' } })],
  ['marginBlock', sp('my', { negative: true, keywords: { auto: 'auto' } })],
  ['marginInline', sp('mx', { negative: true, keywords: { auto: 'auto' } })],
  ['marginTop', sp('mt', { negative: true, keywords: { auto: 'auto' } })],
  ['marginRight', sp('mr', { negative: true, keywords: { auto: 'auto' } })],
  ['marginBottom', sp('mb', { negative: true, keywords: { auto: 'auto' } })],
  ['marginLeft', sp('ml', { negative: true, keywords: { auto: 'auto' } })],
  // radius
  ['borderRadius', (t, k, v) => radius(t, 'rounded', k, v)],
  ['borderTopLeftRadius', (t, k, v) => radius(t, 'rounded-tl', k, v)],
  ['borderTopRightRadius', (t, k, v) => radius(t, 'rounded-tr', k, v)],
  ['borderBottomRightRadius', (t, k, v) => radius(t, 'rounded-br', k, v)],
  ['borderBottomLeftRadius', (t, k, v) => radius(t, 'rounded-bl', k, v)],
  // gap
  ['gap', sp('gap')],
  ['rowGap', sp('gap-y')],
  ['columnGap', sp('gap-x')],
  // overflow
  ['overflow', (_t, k, v) => fromList('overflow', OVERFLOW, k, v)],
  ['overflowX', (_t, k, v) => fromList('overflow-x', OVERFLOW, k, v)],
  ['overflowY', (_t, k, v) => fromList('overflow-y', OVERFLOW, k, v)],
  // border
  ['borderWidth', (_t, k, v) => borderWidth('border', k, v)],
  ['borderStyle', (_t, k, v) => fromList('border', BORDER_STYLE, k, v)],
  ['borderColor', col('border')],
  ['borderTopWidth', (_t, k, v) => borderWidth('border-t', k, v)],
  ['borderTopStyle', (_t, k, v) => arbProp(k, v)],
  ['borderTopColor', col('border-t')],
  ['borderRightWidth', (_t, k, v) => borderWidth('border-r', k, v)],
  ['borderRightStyle', (_t, k, v) => arbProp(k, v)],
  ['borderRightColor', col('border-r')],
  ['borderBottomWidth', (_t, k, v) => borderWidth('border-b', k, v)],
  ['borderBottomStyle', (_t, k, v) => arbProp(k, v)],
  ['borderBottomColor', col('border-b')],
  ['borderLeftWidth', (_t, k, v) => borderWidth('border-l', k, v)],
  ['borderLeftStyle', (_t, k, v) => arbProp(k, v)],
  ['borderLeftColor', col('border-l')],
  ['outlineWidth', (_t, k, v) => borderWidth('outline', k, v)],
  [
    'outlineStyle',
    (_t, k, v) => fromList('outline', ['solid', 'dashed', 'dotted', 'double', 'none'], k, v),
  ],
  ['outlineColor', col('outline')],
  [
    'outlineOffset',
    (_t, k, v) =>
      borderWidth('outline-offset', k, v).replace(/^outline-offset$/, 'outline-offset-1'),
  ],
  // background
  ['backgroundColor', col('bg')],
  ['backgroundImage', (_t, k, v) => (str(v) === 'none' ? 'bg-none' : arbProp(k, v))],
  [
    'backgroundSize',
    (_t, k, v) => keyword({ cover: 'bg-cover', contain: 'bg-contain', auto: 'bg-auto' }, k, v),
  ],
  [
    'backgroundPosition',
    (_t, k, v) =>
      keyword(
        {
          center: 'bg-center',
          top: 'bg-top',
          bottom: 'bg-bottom',
          left: 'bg-left',
          right: 'bg-right',
          'left top': 'bg-top-left',
          'top left': 'bg-top-left',
          'right top': 'bg-top-right',
          'top right': 'bg-top-right',
          'left bottom': 'bg-bottom-left',
          'bottom left': 'bg-bottom-left',
          'right bottom': 'bg-bottom-right',
          'bottom right': 'bg-bottom-right',
        },
        k,
        v,
      ),
  ],
  [
    'backgroundRepeat',
    (_t, k, v) =>
      keyword(
        {
          repeat: 'bg-repeat',
          'no-repeat': 'bg-no-repeat',
          'repeat-x': 'bg-repeat-x',
          'repeat-y': 'bg-repeat-y',
          round: 'bg-repeat-round',
          space: 'bg-repeat-space',
        },
        k,
        v,
      ),
  ],
  [
    'objectFit',
    (_t, k, v) => fromList('object', ['contain', 'cover', 'fill', 'none', 'scale-down'], k, v),
  ],
  [
    'objectPosition',
    (_t, k, v) =>
      keyword(
        {
          center: 'object-center',
          top: 'object-top',
          bottom: 'object-bottom',
          left: 'object-left',
          right: 'object-right',
        },
        k,
        v,
      ),
  ],
  // typography (fontSize may absorb lineHeight as text-x/y)
  ['fontSize', () => null],
  ['lineHeight', () => null],
  [
    'letterSpacing',
    (t, k, v) => {
      const s = str(v)
      const ref = varRef(s)
      if (ref !== null) {
        const hit = t.byName.get(ref)
        return hit && hit[0] === 'tracking' ? `tracking-${hit[1]}` : arbProp(k, v)
      }
      return (
        tokenOnly(t, 'tracking', 'tracking', v) ??
        `tracking-[${arb(typeof v === 'number' ? `${formatCssNumber(v)}px` : s)}]`
      )
    },
  ],
  ['fontFamily', (t, k, v) => fontFamily(t, k, v)],
  ['fontWeight', (t, k, v) => fontWeight(t, k, v)],
  ['fontStyle', (_t, k, v) => keyword({ italic: 'italic', normal: 'not-italic' }, k, v)],
  [
    'textTransform',
    (_t, k, v) =>
      keyword(
        {
          uppercase: 'uppercase',
          lowercase: 'lowercase',
          capitalize: 'capitalize',
          none: 'normal-case',
        },
        k,
        v,
      ),
  ],
  [
    'textDecoration',
    (_t, k, v) =>
      keyword(
        {
          underline: 'underline',
          'line-through': 'line-through',
          overline: 'overline',
          none: 'no-underline',
        },
        k,
        v,
      ),
  ],
  [
    'textDecorationLine',
    (_t, k, v) =>
      keyword(
        {
          underline: 'underline',
          'line-through': 'line-through',
          overline: 'overline',
          none: 'no-underline',
        },
        k,
        v,
      ),
  ],
  ['textDecorationColor', col('decoration')],
  [
    'textAlign',
    (_t, k, v) => fromList('text', ['left', 'center', 'right', 'justify', 'start', 'end'], k, v),
  ],
  [
    'whiteSpace',
    (_t, k, v) =>
      fromList(
        'whitespace',
        ['normal', 'nowrap', 'pre', 'pre-line', 'pre-wrap', 'break-spaces'],
        k,
        v,
      ),
  ],
  [
    'wordBreak',
    (_t, k, v) =>
      keyword({ 'break-all': 'break-all', 'keep-all': 'break-keep', normal: 'break-normal' }, k, v),
  ],
  [
    'overflowWrap',
    (_t, k, v) =>
      keyword(
        { 'break-word': 'wrap-break-word', anywhere: 'wrap-anywhere', normal: 'wrap-normal' },
        k,
        v,
      ),
  ],
  ['textOverflow', (_t, k, v) => keyword({ ellipsis: 'text-ellipsis', clip: 'text-clip' }, k, v)],
  // colour
  ['color', col('text')],
  ['fill', col('fill')],
  ['stroke', col('stroke')],
  // opacity
  ['opacity', (t, k, v) => opacity(t, k, v)],
  // shadow
  [
    'boxShadow',
    (t, k, v) =>
      str(v) === 'none' ? 'shadow-none' : (tokenOnly(t, 'shadow', 'shadow', v) ?? arbProp(k, v)),
  ],
  // filters
  ['filter', (_t, k, v) => arbProp(k, v)],
  ['backdropFilter', (_t, k, v) => arbProp(k, v)],
  ['mixBlendMode', (_t, k, v) => fromList('mix-blend', BLEND, k, v)],
  // transform / rotate
  ['rotate', (_t, k, v) => rotate(k, v)],
  ['transform', (_t, k, v) => (str(v) === 'none' ? 'transform-none' : arbProp(k, v))],
  [
    'transformOrigin',
    (_t, k, v) =>
      keyword(
        {
          center: 'origin-center',
          top: 'origin-top',
          bottom: 'origin-bottom',
          left: 'origin-left',
          right: 'origin-right',
          'top left': 'origin-top-left',
          'left top': 'origin-top-left',
          'top right': 'origin-top-right',
          'right top': 'origin-top-right',
          'bottom left': 'origin-bottom-left',
          'left bottom': 'origin-bottom-left',
          'bottom right': 'origin-bottom-right',
          'right bottom': 'origin-bottom-right',
        },
        k,
        v,
      ),
  ],
]

const ORDER_INDEX = new Map(ORDER.map(([k], i) => [k, i]))
const FONT_SIZE_INDEX = ORDER_INDEX.get('fontSize') as number

/** Tailwind classes for canonical styles, in the fixed category order. */
export function tailwindClasses(styles: Styles, theme: Theme): string[] {
  const out: string[] = []
  const rest: [string, StyleValue][] = []
  const known: [number, string, StyleValue][] = []
  for (const [k, v] of Object.entries(styles)) {
    const i = ORDER_INDEX.get(k)
    if (i === undefined) rest.push([k, v])
    else known.push([i, k, v])
  }
  known.sort((a, b) => a[0] - b[0])
  for (const [i, k, v] of known) {
    if (i === FONT_SIZE_INDEX) {
      const fs = fontSize(theme, k, v)
      const lh = styles['lineHeight']
      const lead = lh === undefined || !fs.token ? null : leadingToken(theme, lh)
      if (lead !== null) out.push(`${fs.cls}/${lead}`)
      else {
        out.push(fs.cls)
        if (lh !== undefined) out.push(lineHeight(theme, 'lineHeight', lh))
      }
      continue
    }
    if (k === 'lineHeight') {
      if (styles['fontSize'] === undefined) out.push(lineHeight(theme, k, v))
      continue
    }
    const handler = (ORDER[i] as [string, Handler])[1]
    const cls = handler(theme, k, v, styles)
    if (cls !== null) out.push(cls)
  }
  rest.sort(([a], [b]) => {
    const na = cssPropertyName(a) ?? a
    const nb = cssPropertyName(b) ?? b
    return na < nb ? -1 : na > nb ? 1 : 0
  })
  for (const [k, v] of rest) out.push(arbProp(k, v))
  return out
}
