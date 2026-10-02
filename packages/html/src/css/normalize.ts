/**
 * Style normalisation (contract §7.6): CSS declarations or a style record → a `StylePatch`
 * with camelCase keys, canonical shorthand families, `rem` → px, the property policy and
 * warnings. Used by write_html (parse), update_styles and create_artboard (runtime).
 */
import { assetCssUrl, isAssetHash, parseAngle, rotationValue } from '@baren/schema'
import type { StylePatch, StyleValue, Styles } from '@baren/schema'
import type { HtmlWarning, ImageLookup, NormalizeContext, NormalizeResult } from '../types.ts'
import { Warnings } from '../warnings.ts'
import {
  applyToState,
  emitState,
  familyOf,
  newState,
  type Family,
  type FamilyState,
} from './families.ts'
import { isKnownProperty, unprefixed } from './known.ts'
import { isSafeCssValue } from './safe.ts'
import {
  cssUrls,
  mapOutsideStrings,
  parseDeclarations,
  recordKey,
  remToPx,
  replaceCssUrls,
  splitValues,
  stripImportant,
  toCamelKey,
  varNames,
} from './syntax.ts'

/** Properties whose `url(…)` values are images (resolved to `baren-asset://`). */
export const IMAGE_PROPERTIES: ReadonlySet<string> = new Set([
  'background',
  'backgroundImage',
  'maskImage',
  'WebkitMaskImage',
  'mask',
  'WebkitMask',
  'borderImageSource',
  'borderImage',
  'listStyleImage',
])

const DROPPED_UNSUPPORTED = new Set([
  'cursor',
  'pointerEvents',
  'userSelect',
  'content',
  'willChange',
  'resize',
  'caretColor',
  'appearance',
  'userDrag',
  'tapHighlightColor',
  'touchAction',
])

const SYSTEM_FONTS = new Set([
  'caption',
  'icon',
  'menu',
  'message-box',
  'small-caption',
  'status-bar',
])
const CUSTOM_PROPERTY_RE = /^--[A-Za-z0-9_-]+$/

interface Decl {
  key: string
  value: StyleValue | null
}

/** Collapse whitespace runs (outside strings and urls) and trim. */
const NEEDS_TIDY = /[\t\n\r\f]| {2}/

function tidy(value: string): string {
  if (!NEEDS_TIDY.test(value)) return value.trim()
  return mapOutsideStrings(value, (part) => part.replace(/\s+/g, ' ')).trim()
}

function declsOf(
  input: string | Record<string, StyleValue | null>,
  w: Warnings,
  path: string | undefined,
): Decl[] {
  const out: Decl[] = []
  if (typeof input === 'string') {
    for (const [name, raw] of parseDeclarations(input)) {
      const key = name.startsWith('--') ? name : toCamelKey(name)
      const value = tidy(stripImportant(raw))
      out.push({ key, value: value === '' ? null : value })
    }
    return out
  }
  for (const [k, raw] of Object.entries(input)) {
    if (raw === undefined) continue
    const key = recordKey(k.trim())
    if (raw === null) out.push({ key, value: null })
    else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) {
        w.add(
          'unsafe-value',
          `${key}: the value is not a finite number and was dropped.`,
          withPath(path, key),
        )
        continue
      }
      out.push({ key, value: raw })
    } else if (typeof raw === 'string') {
      const value = tidy(stripImportant(raw))
      out.push({ key, value: value === '' ? null : value })
    } else {
      w.add(
        'unsafe-value',
        `${key}: only strings and numbers are style values.`,
        withPath(path, key),
      )
    }
  }
  return out
}

function withPath(path: string | undefined, property: string): { path?: string; property: string } {
  return path === undefined ? { property } : { path, property }
}

/** Number of `url(` openings (any case). */
function urlTokenCount(value: string): number {
  return (value.match(/url\(/gi) ?? []).length
}

/** True when every `url(…)` in a stored value points at an asset or a local `#id`. */
export function onlyLocalUrls(value: string): boolean {
  if (!/url\(/i.test(value)) return true
  const urls = cssUrls(value)
  return (
    urls.length === urlTokenCount(value) &&
    urls.every((u) => u.startsWith('#') || /^baren-asset:\/\/[0-9a-f]{64}$/.test(u))
  )
}

/** Mask `url(…)` contents (they are checked once resolved). */
function withoutUrls(value: string): string {
  return replaceCssUrls(value, () => 'url()')
}

type Policy =
  | { action: 'drop' }
  | { action: 'keep'; key: string; value: StyleValue | null; tableColumn?: boolean }
  | { action: 'expand'; entries: Decl[] }

const DISPLAY_TABLE: Record<string, 'column' | 'row' | null> = {
  table: 'column',
  'inline-table': 'column',
  'table-row-group': 'column',
  'table-header-group': 'column',
  'table-footer-group': 'column',
  'table-row': 'row',
  'table-cell': null,
  'table-column': null,
  'table-column-group': null,
  'table-caption': null,
}

const FONT_STYLE = new Set(['normal', 'italic', 'oblique'])
const FONT_WEIGHT_WORDS = new Set(['bold', 'bolder', 'lighter'])
const FONT_SIZE_WORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'larger',
  'smaller',
])
const FONT_STRETCH = new Set([
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded',
])

/** `font` shorthand → longhands (missing ones reset), or null when not understood. */
export function parseFont(value: string): Decl[] | null {
  const tokens = splitValues(value)
  let style: string | null = null
  let weight: StyleValue | null = null
  let i = 0
  for (; i < tokens.length; i++) {
    const t = (tokens[i] as string).toLowerCase()
    if (t === 'normal') continue
    if (FONT_STYLE.has(t) && style === null) style = t
    else if (FONT_WEIGHT_WORDS.has(t) && weight === null) weight = t
    else if (/^[1-9]00$|^1000$/.test(t) && weight === null) weight = Number(t)
    else if (t === 'small-caps' || FONT_STRETCH.has(t)) continue
    else break
  }
  const sizeToken = tokens[i]
  if (sizeToken === undefined) return null
  let size = sizeToken
  let lineHeight: string | null = null
  const slash = size.indexOf('/')
  if (slash !== -1) {
    lineHeight = size.slice(slash + 1) || null
    size = size.slice(0, slash)
  }
  i++
  if (lineHeight === null && tokens[i] === '/') {
    lineHeight = tokens[i + 1] ?? null
    i += 2
  } else if (lineHeight === null && tokens[i]?.startsWith('/')) {
    lineHeight = (tokens[i] as string).slice(1)
    i++
  }
  const sizeOk =
    /^[+-]?(?:\d+\.?\d*|\.\d+)[a-z%]+$/i.test(size) ||
    FONT_SIZE_WORDS.has(size.toLowerCase()) ||
    /^(var|calc|clamp|min|max)\(/i.test(size)
  if (!sizeOk) return null
  const family = tokens.slice(i).join(' ').trim()
  if (family === '') return null
  return [
    { key: 'fontStyle', value: style },
    { key: 'fontWeight', value: weight },
    { key: 'fontSize', value: size },
    { key: 'lineHeight', value: lineHeight },
    { key: 'fontFamily', value: family },
  ]
}

const FLEX_DIRECTIONS = new Set(['row', 'row-reverse', 'column', 'column-reverse'])
const FLEX_WRAPS = new Set(['nowrap', 'wrap', 'wrap-reverse'])

/** Policy per property (contract §7.6 rule 5) and the shorthands that expand to plain keys. */
function policy(d: Decl, w: Warnings, path: string | undefined): Policy {
  const { key, value } = d
  const at = withPath(path, key)
  if (key.startsWith('--')) {
    if (!CUSTOM_PROPERTY_RE.test(key)) {
      w.add('unknown-property', `${key} is not a valid custom property name; it was dropped.`, at)
      return { action: 'drop' }
    }
    return { action: 'keep', key, value }
  }
  const base = unprefixed(key)
  if (base === 'boxSizing') return { action: 'drop' }
  if (
    base.startsWith('transition') ||
    base.startsWith('animation') ||
    base.startsWith('scroll') ||
    base.startsWith('counter') ||
    DROPPED_UNSUPPORTED.has(base)
  ) {
    w.add('unsupported-property', `${key} is not supported in designs and was dropped.`, at)
    return { action: 'drop' }
  }
  if (base.startsWith('listStyle')) {
    w.add('unsupported-property', `${key} is not supported in designs and was dropped.`, at)
    w.once(
      'list-markers-dropped',
      'List markers (bullets and numbers) are not drawn; add them as text or SVG.',
    )
    return { action: 'drop' }
  }
  if (key === 'position' && typeof value === 'string' && /^(fixed|sticky)$/i.test(value)) {
    w.add('position-converted', `position: ${value} became position: absolute.`, at)
    return { action: 'keep', key, value: 'absolute' }
  }
  if (key === 'display' && typeof value === 'string') {
    const v = value.toLowerCase()
    if (v in DISPLAY_TABLE) {
      w.once('table-as-flex', 'Table layout was converted to flexbox (tables are not supported).', {
        path: path ?? '',
      })
      return { action: 'keep', key, value: 'flex', tableColumn: DISPLAY_TABLE[v] === 'column' }
    }
    if (v === 'contents') {
      w.add('unsupported-property', 'display: contents is not supported and was dropped.', at)
      return { action: 'drop' }
    }
    if (v === 'grid' || v === 'inline-grid' || v === 'inline' || v === 'inline-block') {
      w.add(
        'discouraged-property',
        `display: ${v} renders, but the inspector cannot edit it. Use display: flex.`,
        at,
      )
    }
    return { action: 'keep', key, value }
  }
  if (base.startsWith('margin')) {
    w.add(
      'discouraged-property',
      `${key} renders, but the inspector cannot edit it. Use padding and gap.`,
      at,
    )
  } else if (base.startsWith('grid') && !/^grid(Row|Column)?Gap$/.test(base)) {
    w.add(
      'discouraged-property',
      `${key} renders, but the inspector cannot edit it. Use flexbox.`,
      at,
    )
  } else if (base === 'float' || base === 'clear') {
    w.add(
      'discouraged-property',
      `${key} renders, but the inspector cannot edit it. Use flexbox.`,
      at,
    )
  }
  if (key === 'font') {
    if (value === null) {
      return {
        action: 'expand',
        entries: ['fontStyle', 'fontWeight', 'fontSize', 'lineHeight', 'fontFamily'].map((k) => ({
          key: k,
          value: null,
        })),
      }
    }
    const s = String(value)
    if (SYSTEM_FONTS.has(s.toLowerCase())) {
      w.add('unsupported-property', `font: ${s} (a system font keyword) is not supported.`, at)
      return { action: 'drop' }
    }
    const entries = parseFont(s)
    if (!entries) {
      w.add(
        'unsupported-property',
        `font: ${s} could not be read; set fontSize and fontFamily instead.`,
        at,
      )
      return { action: 'drop' }
    }
    return { action: 'expand', entries }
  }
  if (key === 'flexFlow') {
    if (value === null)
      return {
        action: 'expand',
        entries: [
          { key: 'flexDirection', value: null },
          { key: 'flexWrap', value: null },
        ],
      }
    let dir: string | null = null
    let wrap: string | null = null
    for (const t of splitValues(String(value))) {
      const l = t.toLowerCase()
      if (FLEX_DIRECTIONS.has(l)) dir = l
      else if (FLEX_WRAPS.has(l)) wrap = l
    }
    return {
      action: 'expand',
      entries: [
        { key: 'flexDirection', value: dir },
        { key: 'flexWrap', value: wrap },
      ],
    }
  }
  const place = /^place(Items|Content|Self)$/.exec(key)
  if (place) {
    const suffix = place[1] as string
    const tokens = value === null ? [] : splitValues(String(value))
    const align = value === null ? null : (tokens[0] ?? null)
    const justify = value === null ? null : (tokens[1] ?? tokens[0] ?? null)
    return {
      action: 'expand',
      entries: [
        { key: `align${suffix}`, value: align },
        { key: `justify${suffix}`, value: justify },
      ],
    }
  }
  if (!isKnownProperty(key)) {
    w.add('unknown-property', `${key} is not a known CSS property and was dropped.`, at)
    return { action: 'drop' }
  }
  return { action: 'keep', key, value }
}

/**
 * Value rules (contract §7.6 rule 3, 5, 6, 7): rem → px, rotate, fontWeight, safety, urls,
 * unknown tokens. Returns undefined to drop the declaration.
 */
function processValue(
  key: string,
  value: StyleValue | null,
  w: Warnings,
  ctx: NormalizeContext,
  declared: ReadonlySet<string>,
): StyleValue | null | undefined {
  if (value === null) return null
  const at = withPath(ctx.path, key)
  if (typeof value === 'number') {
    if (key === 'rotate') return rotationValue(value)
    return value
  }
  let v = key.startsWith('--') ? value : remToPx(value)
  if (key === 'rotate') {
    const deg = parseAngle(v)
    if (deg !== null) return rotationValue(deg)
    if (/^none$/i.test(v)) return null
  }
  if (key === 'fontWeight' && /^\d+(\.\d+)?$/.test(v)) return Number(v)
  const isImage = IMAGE_PROPERTIES.has(key)
  const hasUrl = v.includes('url(') || /url\(/i.test(v)
  const urls = hasUrl ? cssUrls(v) : []
  if (hasUrl && urlTokenCount(v) !== urls.length) {
    w.add('unsafe-value', `${key}: the url() is malformed; the value was dropped.`, at)
    return undefined
  }
  if (urls.length > 0 && !isImage && !key.startsWith('--')) {
    if (urls.some((u) => !u.startsWith('#'))) {
      w.add(
        'unsafe-value',
        `${key}: url() is only supported in background images; the value was dropped.`,
        at,
      )
      return undefined
    }
  }
  if (
    !isSafeCssValue(isImage || key.startsWith('--') ? withoutUrls(v) : v) ||
    urls.some((u) => /(?:java|vb)script:/i.test(u.replace(/[\s\\]/g, '')))
  ) {
    w.add('unsafe-value', `${key}: the value is not allowed and was dropped.`, at)
    return undefined
  }
  if (key.startsWith('--') && urls.length > 0) {
    w.add(
      'unsafe-value',
      `${key}: url() is not allowed in custom properties; the value was dropped.`,
      at,
    )
    return undefined
  }
  if (ctx.tokens !== undefined) {
    for (const name of varNames(v)) {
      if (ctx.tokens[name] !== undefined || ctx.localVars?.has(name) || declared.has(name)) continue
      w.add(
        'unknown-token',
        `${name} is not a token of this file (the value is kept; it renders its fallback).`,
        { ...at, token: name },
      )
    }
  }
  if (isImage && urls.length > 0 && ctx.image !== undefined) {
    const resolved = resolveValueImages(key, v, ctx.image, w, ctx.path)
    if (resolved === undefined) return undefined
    v = resolved
  }
  return v
}

/**
 * Rewrite the `url(…)` sources of one image property value through `image`: rasters →
 * `url("baren-asset://<hash>")`; anything else drops the property with a warning.
 */
export function resolveValueImages(
  key: string,
  value: string,
  image: ImageLookup,
  w: Warnings,
  path: string | undefined,
): string | undefined {
  let failed: { src: string; reason: string } | null = null
  const out = replaceCssUrls(value, (src) => {
    if (failed) return null
    const assetHash = /^baren-asset:\/\/([0-9a-f]{64})$/.exec(src)?.[1]
    const r = src === '' ? { error: 'empty url()' } : image(src)
    if (r === null && assetHash !== undefined && isAssetHash(assetHash))
      return assetCssUrl(assetHash)
    if (r !== null && 'kind' in r && r.kind === 'raster') return assetCssUrl(r.hash)
    const reason =
      r === null
        ? 'the source was not resolved'
        : 'error' in r
          ? r.error
          : 'SVG images cannot be used as CSS images (use <img> or inline <svg>)'
    failed = { src, reason }
    return null
  })
  if (failed !== null) {
    const f = failed as { src: string; reason: string }
    w.add(
      'image-unresolved',
      `${key}: image ${short(f.src)} could not be used (${f.reason}); it was dropped.`,
      withPath(path, key),
    )
    return undefined
  }
  return out
}

function short(src: string): string {
  return src.length > 80 ? `${src.slice(0, 77)}…` : src
}

/**
 * Resolve image `url(…)`s of a whole patch (write_html IR styles, update_styles): returns the
 * patch with rasters rewritten and failing image properties removed (warnings added).
 */
export function resolveStyleImages(
  styles: StylePatch,
  image: ImageLookup,
  path?: string,
): { styles: StylePatch; warnings: HtmlWarning[] } {
  const w = new Warnings()
  const out: StylePatch = {}
  for (const [key, value] of Object.entries(styles)) {
    if (typeof value === 'string' && IMAGE_PROPERTIES.has(key) && cssUrls(value).length > 0) {
      const v = resolveValueImages(key, value, image, w, path)
      if (v !== undefined && onlyLocalUrls(v)) out[key] = v
      else if (v !== undefined)
        w.add(
          'unsafe-value',
          `${key}: the url() is not allowed; the value was dropped.`,
          path === undefined ? { property: key } : { path, property: key },
        )
      continue
    }
    if (typeof value === 'string' && !onlyLocalUrls(value)) {
      w.add(
        'unsafe-value',
        `${key}: the url() is not allowed; the value was dropped.`,
        path === undefined ? { property: key } : { path, property: key },
      )
      continue
    }
    out[key] = value
  }
  return { styles: out, warnings: w.items }
}

/** Run the declarations through families and plain keys, in order. */
function assemble(decls: readonly Decl[]): {
  patch: StylePatch
  families: Map<Family, FamilyState>
} {
  const order: (string | Family)[] = []
  const plain = new Map<string, StyleValue | null>()
  const families = new Map<Family, FamilyState>()
  for (const d of decls) {
    const f = familyOf(d.key)
    if (f) {
      let state = families.get(f)
      if (!state) {
        state = newState()
        families.set(f, state)
        order.push(f)
      }
      applyToState(f, state, d.key, d.value)
      continue
    }
    if (!plain.has(d.key)) order.push(d.key)
    plain.set(d.key, d.value)
  }
  const patch: StylePatch = {}
  for (const item of order) {
    if (typeof item === 'string') {
      patch[item] = plain.get(item) as StyleValue | null
      continue
    }
    for (const [k, v] of emitState(item, families.get(item) as FamilyState)) patch[k] = v
  }
  return { patch, families }
}

/** Normalise CSS declarations or a style record (contract §7.6). */
export function normalizeStyles(
  input: string | Record<string, StyleValue | null>,
  ctx: NormalizeContext = {},
): NormalizeResult {
  const w = new Warnings()
  const raw = declsOf(input, w, ctx.path)
  const declared = new Set(raw.filter((d) => d.key.startsWith('--')).map((d) => d.key))
  const decls: Decl[] = []
  let tableColumn = false
  const push = (d: Decl): void => {
    const value = processValue(d.key, d.value, w, ctx, declared)
    if (value === undefined) return
    decls.push({ key: d.key, value })
  }
  for (const d of raw) {
    const p = policy(d, w, ctx.path)
    if (p.action === 'drop') continue
    if (p.action === 'expand') {
      for (const e of p.entries) push(e)
      continue
    }
    if (p.tableColumn) tableColumn = true
    push({ key: p.key, value: p.value })
  }
  const { patch } = assemble(decls)
  if (tableColumn && !('flexDirection' in patch)) patch['flexDirection'] = 'column'
  return { styles: patch, warnings: w.items }
}

/**
 * Update clearing (contract §7.6 rule 4): `patch` merged with the family keys needed so the
 * stored styles of each touched family end up in canonical form — shorthands replaced by the
 * remaining longhands, stale keys `null`. Returns the full patch to write (it includes
 * `patch`'s own entries).
 */
export function clearedFamilyKeys(patch: StylePatch, existing: Styles): StylePatch {
  const touched = new Map<Family, FamilyState>()
  const order: (string | Family)[] = []
  for (const key of Object.keys(patch)) {
    const f = familyOf(key)
    if (!f) {
      order.push(key)
      continue
    }
    if (touched.has(f)) continue
    const state = newState()
    for (const k of f.readOrder) {
      const v = existing[k]
      if (v !== undefined) applyToState(f, state, k, v)
    }
    touched.set(f, state)
    order.push(f)
  }
  // Removals first, then values (a normalised patch lists resets that its values refine).
  for (const pass of [true, false]) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || (value === null) !== pass) continue
      const f = familyOf(key)
      if (f) applyToState(f, touched.get(f) as FamilyState, key, value)
    }
  }
  const out: StylePatch = {}
  for (const item of order) {
    if (typeof item === 'string') {
      const v = patch[item]
      if (v !== undefined) out[item] = v
      continue
    }
    const existingKeys = [...item.cover.keys()].filter((k) => existing[k] !== undefined)
    for (const [k, v] of emitState(item, touched.get(item) as FamilyState, existingKeys)) {
      if (v === null && existing[k] === undefined && patch[k] === undefined) continue
      out[k] = v
    }
  }
  return out
}
