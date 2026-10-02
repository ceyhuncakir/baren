import type { StyleValue, Styles } from '@baren/schema'

/** Properties whose numeric values are unitless (React's list, trimmed to CSS that matters here). */
const UNITLESS: ReadonlySet<string> = new Set([
  'animationIterationCount',
  'aspectRatio',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'boxFlex',
  'boxFlexGroup',
  'boxOrdinalGroup',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'fontWeight',
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'scale',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
])

const nameCache = new Map<string, string | null>()
const KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/
const CUSTOM_RE = /^--[A-Za-z0-9_-]+$/

/**
 * camelCase style key → CSS property name (`backgroundColor` → `background-color`,
 * `WebkitFontSmoothing` → `-webkit-font-smoothing`, `--x` → `--x`).
 * Returns null for keys that are not valid property names.
 */
export function cssPropertyName(key: string): string | null {
  const cached = nameCache.get(key)
  if (cached !== undefined) return cached
  let out: string | null = null
  if (key.startsWith('--')) {
    out = CUSTOM_RE.test(key) ? key : null
  } else if (KEY_RE.test(key)) {
    let name = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    if (/^(webkit|moz|ms)-/.test(name)) name = `-${name}`
    out = name
  }
  nameCache.set(key, out)
  return out
}

/** Value as CSS text: numbers get `px` unless the property is unitless (`rotate` gets `deg`). */
export function cssValue(key: string, value: StyleValue): string {
  if (typeof value === 'number') {
    if (key === 'rotate') return `${value}deg`
    if (key.startsWith('--') || UNITLESS.has(key) || value === 0) return String(value)
    return `${value}px`
  }
  return value
}

/** Values that could break out of a declaration when concatenated into cssText. */
const UNSAFE_VALUE = /[;{}]|\/\*|<\//

export function isSafeCssValue(value: string): boolean {
  return !UNSAFE_VALUE.test(value)
}

/** Rewrites asset URLs inside a background value (see `AssetUrlCache.rewriteCss`). */
export type AssetCssRewrite = (value: string) => string

const ASSET_PREFIX = 'baren-asset://'

/** Properties whose values may hold `url(baren-asset://…)` images (image fills). */
export function isImageProperty(key: string): boolean {
  return key === 'backgroundImage' || key === 'background'
}

/**
 * CSS text for one value, with asset URLs rewritten when `rewrite` is given and the
 * property can carry an image fill.
 */
export function renderValue(key: string, value: StyleValue, rewrite?: AssetCssRewrite): string {
  const css = cssValue(key, value)
  return rewrite && typeof value === 'string' && isImageProperty(key) && css.includes(ASSET_PREFIX)
    ? rewrite(css)
    : css
}

/**
 * Build a cssText string for `styles`, skipping `omit` keys. Returns null if a
 * value can't be safely concatenated; the caller then falls back to
 * `setProperty` (which parses each value in isolation).
 */
export function stylesToCssText(
  styles: Styles,
  omit?: ReadonlySet<string>,
  rewrite?: AssetCssRewrite,
): string | null {
  let out = ''
  for (const key in styles) {
    if (omit?.has(key)) continue
    const v = styles[key]
    if (v === undefined) continue
    const name = cssPropertyName(key)
    if (name === null) continue
    const value = renderValue(key, v, rewrite)
    if (!isSafeCssValue(value)) return null
    out += `${name}:${value};`
  }
  return out
}

/** True when any image property of `styles` references an asset. */
/**
 * Style keys that change only how a node paints, never its box or any other node's box
 * (no layout effect). A change limited to these keys keeps the measured geometry valid.
 */
const PAINT_ONLY_KEYS: ReadonlySet<string> = new Set([
  'color',
  'backgroundColor',
  'backgroundImage',
  'background',
  'opacity',
  'boxShadow',
  'outlineColor',
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'textDecorationColor',
  'fill',
  'fillOpacity',
  'stroke',
  'strokeOpacity',
  'mixBlendMode',
])

export function isPaintOnlyKey(key: string): boolean {
  return PAINT_ONLY_KEYS.has(key)
}

export function hasAssetStyles(styles: Styles): boolean {
  const a = styles['backgroundImage']
  const b = styles['background']
  return (
    (typeof a === 'string' && a.includes(ASSET_PREFIX)) ||
    (typeof b === 'string' && b.includes(ASSET_PREFIX))
  )
}

/** Read a numeric pixel value (`120`, `"120px"`, `"120"`); null for anything else. */
export function pxValue(v: StyleValue | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const m = /^\s*(-?\d+(?:\.\d+)?)(px)?\s*$/.exec(v)
  return m ? Number(m[1]) : null
}

export type FlexDirection = 'row' | 'column'

/** Main axis of a flex container, or null when the styles don't describe one. */
export function flexDirectionOf(styles: Styles): FlexDirection | null {
  const display = styles['display']
  if (display !== 'flex' && display !== 'inline-flex') return null
  const dir = styles['flexDirection']
  return dir === 'column' || dir === 'column-reverse' ? 'column' : 'row'
}

/** True when the node is taken out of flow (positioned with left/top). */
export function isAbsolutelyPositioned(styles: Styles): boolean {
  const p = styles['position']
  return p === 'absolute' || p === 'fixed'
}

/** True when the node clips its content (overflow hidden/clip/scroll/auto). */
export function clipsContent(styles: Styles): boolean {
  const o = styles['overflow']
  return o === 'hidden' || o === 'clip' || o === 'scroll' || o === 'auto'
}
