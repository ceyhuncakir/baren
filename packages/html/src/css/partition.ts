/**
 * Inert styles (contract §7.7, update_styles) and canonical declared styles (§8.2).
 */
import type { DesignNode, NodeType, StylePatch, StyleValue, Styles } from '@baren/schema'
import { formatCssNumber } from '@baren/schema'
import { isUnitless } from './known.ts'

const FLEX_CONTAINER_KEYS = new Set([
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'alignContent',
  'gap',
  'rowGap',
  'columnGap',
])
const OFFSET_KEYS = new Set(['left', 'top', 'right', 'bottom', 'inset'])
const TYPOGRAPHY_KEYS = new Set([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textTransform',
  'whiteSpace',
])
const LEAF_TYPES: ReadonlySet<NodeType> = new Set(['rect', 'image', 'svg', 'vector', 'instance'])

function after(patch: StylePatch, styles: Styles, key: string): StyleValue | undefined {
  if (key in patch) {
    const v = patch[key]
    return v === null ? undefined : v
  }
  return styles[key]
}

/** Split a normalised patch into what applies to a node and the inert keys (§7.7). */
export function partitionStyles(
  patch: StylePatch,
  ctx: { type: NodeType; styles: Styles; isTopLevel: boolean },
): { apply: StylePatch; ignored: string[] } {
  const apply: StylePatch = {}
  const ignored: string[] = []
  const display = after(patch, ctx.styles, 'display')
  const flexText = display === 'flex' || display === 'inline-flex'
  const position = after(patch, ctx.styles, 'position')
  const isStatic = position === undefined || position === 'static'
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    let inert = false
    if (ctx.type === 'page') inert = key !== 'backgroundColor' && key !== 'background'
    else if (FLEX_CONTAINER_KEYS.has(key) && LEAF_TYPES.has(ctx.type)) inert = true
    else if (FLEX_CONTAINER_KEYS.has(key) && ctx.type === 'text' && !flexText) inert = true
    else if (OFFSET_KEYS.has(key) && !ctx.isTopLevel && isStatic) inert = true
    else if ((key === 'objectFit' || key === 'objectPosition') && ctx.type !== 'image') inert = true
    else if (
      (TYPOGRAPHY_KEYS.has(key) || key.startsWith('textDecoration')) &&
      (ctx.type === 'rect' || ctx.type === 'image' || ctx.type === 'vector')
    )
      inert = true
    // Removing an inert key is harmless and cleans up; only values are reported.
    if (inert && value !== null) ignored.push(key)
    else apply[key] = value
  }
  return { apply, ignored }
}

function compareKeys(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Sort style keys the way snippets print them (case-insensitive, then code units). */
export function sortStyleKeys(keys: Iterable<string>): string[] {
  return [...keys].sort(compareKeys)
}

/**
 * Canonical declared styles (§8.2): `--hidden-*` dropped, px numbers as `"<n>px"`, numeric
 * `fontWeight` strings as numbers, text nodes `whiteSpace: 'pre-wrap'` when absent, keys
 * sorted. Shorthands and `var()` references stay as stored.
 */
export function canonicalStyles(node: Pick<DesignNode, 'type' | 'styles'>): Styles {
  const src: Styles = { ...node.styles }
  if (node.type === 'text' && src['whiteSpace'] === undefined) src['whiteSpace'] = 'pre-wrap'
  const out: Styles = {}
  for (const key of sortStyleKeys(Object.keys(src))) {
    if (key.startsWith('--hidden-')) continue
    let v = src[key] as StyleValue
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue
      if (key === 'rotate') v = `${formatCssNumber(v)}deg`
      else if (!isUnitless(key)) v = `${formatCssNumber(v)}px`
    } else if (key === 'fontWeight' && /^\d+(\.\d+)?$/.test(v.trim())) {
      v = Number(v.trim())
    }
    out[key] = v
  }
  return out
}
