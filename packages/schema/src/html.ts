/**
 * Node subtree → semantic HTML with inline styles: the TypeScript twin of the Rust core's
 * exporter (`crates/core/src/export/html.rs`; same mapping, declaration order, escaping and
 * sanitising), used by the JS fallback core and the clipboard's `text/html`.
 *
 * page → `<main>`, artboard (child of a page) → `<section>`, frame/rect/group/instance →
 * `<div>`, text → `<h1>`/`<h2>`/`<h3>` by font size (≥ 32/24/20 px) or `<p>`, svg → sanitised
 * `<svg>`, vector → `<svg>` + `<path>`, image → `<img>`. Instances render resolved (§3.2);
 * hidden descendants and hidden paints (`--hidden-*`) are omitted; tokens become `:root`
 * custom properties. Differences from Rust: no intrinsic `<img>` size attributes (the bytes
 * are not available here) and asset URLs come from `assetUrl` (default `baren-asset://`).
 */
import type { LoroDoc } from 'loro-crdt'
import { ASSET_URL_PREFIX, assetRefsInValue, isAssetHash, rewriteAssetUrls } from './assets.ts'
import { isTreeId } from './ids.ts'
import { getNode } from './nodes.ts'
import { createComponentResolver, toRenderSubtree, type ResolvedNode } from './resolve.ts'
import { escapeAttr, escapeText, isSafeCssValue, sanitizeSvgMarkup } from './svgSanitize.ts'
import { getTokens, isTokenName } from './tokens.ts'
import type { StyleValue, Token } from './types.ts'
import { vectorToPathD } from './vector.ts'

export interface HtmlOptions {
  tokens?: Record<string, Token>
  /** Add `data-node-id` attributes (real or virtual ids). */
  includeIds?: boolean
  /** URL for an asset hash; null drops the image (layer or fill). */
  assetUrl?: (hash: string) => string | null
}

const MAX_DEPTH = 256

// ---------------------------------------------------------------------------
// CSS (port of crates/core/src/export/css.rs)
// ---------------------------------------------------------------------------

/** camelCase → kebab-case; custom properties pass through; null for implausible names. */
export function cssPropertyName(key: string): string | null {
  if (key.startsWith('--')) {
    const rest = key.slice(2)
    return rest !== '' && /^[A-Za-z0-9_-]+$/.test(rest) ? key : null
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) return null
  let out = /^ms[A-Z]/.test(key) ? '-' : ''
  for (const c of key) out += c >= 'A' && c <= 'Z' ? `-${c.toLowerCase()}` : c
  return out
}

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
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'fontWeight',
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

function isUnitless(key: string): boolean {
  if (key.startsWith('--')) return true
  for (const prefix of ['Webkit', 'Moz', 'ms', 'O']) {
    if (key.startsWith(prefix) && /^[A-Z]/.test(key.slice(prefix.length))) {
      const r = key.slice(prefix.length)
      return UNITLESS.has(r[0]?.toLowerCase() + r.slice(1))
    }
  }
  return UNITLESS.has(key)
}

/** Rust `format_number`: integers without a fraction, else shortest digits, never exponents. */
export function formatCssNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return String(v === 0 ? 0 : v)
  const s = String(v)
  const e = s.indexOf('e')
  if (e === -1) return s
  const negative = s.startsWith('-')
  const mantissa = s.slice(negative ? 1 : 0, e)
  const exp = Number(s.slice(e + 1))
  const dot = mantissa.indexOf('.')
  const digits = mantissa.replace('.', '')
  const point = (dot === -1 ? mantissa.length : dot) + exp
  let out: string
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length)
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`
  return negative ? `-${out}` : out
}

/** One style value for property `key`, or null to drop it. */
export function cssDeclarationValue(key: string, v: StyleValue): string | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    if (key === 'rotate') return `${formatCssNumber(v)}deg`
    return isUnitless(key) ? formatCssNumber(v) : `${formatCssNumber(v)}px`
  }
  const s = v.trim()
  return s !== '' && isSafeCssValue(s) ? s : null
}

function declaration(key: string, v: StyleValue): string | null {
  const name = cssPropertyName(key)
  if (name === null) return null
  const value = cssDeclarationValue(key, v)
  return value === null ? null : `${name}: ${value}`
}

const PROPERTY_ORDER = [
  'position', 'top', 'right', 'bottom', 'left', 'inset', 'zIndex', 'display', 'flexDirection',
  'flexWrap', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'justifyContent', 'alignItems',
  'alignContent', 'alignSelf', 'gap', 'rowGap', 'columnGap', 'gridTemplateColumns',
  'gridTemplateRows', 'order', 'boxSizing', 'width', 'minWidth', 'maxWidth', 'height',
  'minHeight', 'maxHeight', 'aspectRatio', 'margin', 'marginTop', 'marginRight', 'marginBottom',
  'marginLeft', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'overflow', 'overflowX', 'overflowY', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration', 'textTransform', 'whiteSpace',
  'color', 'background', 'backgroundColor', 'backgroundImage', 'backgroundSize',
  'backgroundPosition', 'backgroundRepeat', 'border', 'borderWidth', 'borderStyle', 'borderColor',
  'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'boxShadow',
  'opacity', 'filter', 'backdropFilter', 'transform', 'transformOrigin', 'transition', 'cursor',
  'pointerEvents',
] // prettier-ignore
const RANK = new Map(PROPERTY_ORDER.map((p, i) => [p, i]))

function sortedStyles(styles: Record<string, StyleValue>): [string, StyleValue][] {
  const rank = (k: string): number => RANK.get(k) ?? PROPERTY_ORDER.length
  // Rust sorts by rank, then by the key's bytes (code-unit order for ASCII keys).
  return Object.entries(styles).sort(
    ([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  )
}

/** A length in px from a number or a `"12px"` / `"12"` string (Rust `px`). */
function px(v: StyleValue | undefined): number | null {
  if (v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = v.trim().replace(/px$/, '').trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && !/^[+-]?(inf|infinity|nan)$/i.test(t))
    return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function textTag(node: ResolvedNode): string {
  const size = px(node.styles['fontSize'])
  if (size !== null && size >= 32) return 'h1'
  if (size !== null && size >= 24) return 'h2'
  if (size !== null && size >= 20) return 'h3'
  return 'p'
}

function tokensCss(tokens: Record<string, Token>): string {
  let decls = ''
  for (const [name, token] of Object.entries(tokens)) {
    if (!isTokenName(name)) continue
    let value: string
    if (typeof token.value === 'number') {
      if (!Number.isFinite(token.value)) continue
      value = formatCssNumber(token.value)
    } else {
      const s = token.value.trim()
      if (s === '' || s.includes(';') || !isSafeCssValue(s)) continue
      value = s
    }
    decls += `  ${name}: ${value};`
    if (token.description !== undefined) {
      const d = token.description
        .replace(/\*\//g, '* /')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '')
      decls += ` /* ${d.trim()} */`
    }
    decls += '\n'
  }
  return decls === '' ? '' : `:root {\n${decls}}\n`
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

type Role =
  | { kind: 'page' }
  | { kind: 'pageArtboard'; dx: number; dy: number }
  | { kind: 'rootArtboard' }
  | { kind: 'layer' }

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function pageBounds(artboards: readonly ResolvedNode[]): Bounds | null {
  let out: Bounds | null = null
  for (const a of artboards) {
    const x = px(a.styles['left']) ?? 0
    const y = px(a.styles['top']) ?? 0
    const w = px(a.styles['width'])
    const h = px(a.styles['height'])
    if (w === null || h === null) continue
    const b = { minX: x, minY: y, maxX: x + w, maxY: y + h }
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : b
  }
  return out
}

const isHiddenPaint = (key: string): boolean => key.startsWith('--hidden-')
const isImageProperty = (key: string): boolean => key === 'backgroundImage' || key === 'background'

class Writer {
  out = ''
  private readonly nodes: Record<string, ResolvedNode>
  private readonly opts: HtmlOptions

  constructor(nodes: Record<string, ResolvedNode>, opts: HtmlOptions) {
    this.nodes = nodes
    this.opts = opts
  }

  private assetUrl(hash: string): string | null {
    return this.opts.assetUrl ? this.opts.assetUrl(hash) : `${ASSET_URL_PREFIX}${hash}`
  }

  private idAttr(node: ResolvedNode): string {
    return this.opts.includeIds ? ` data-node-id="${escapeAttr(node.id)}"` : ''
  }

  private visibleChildren(node: ResolvedNode, depth: number): ResolvedNode[] {
    if (depth >= MAX_DEPTH) return []
    const out: ResolvedNode[] = []
    for (const id of node.children) {
      const c = this.nodes[id]
      if (c && c.hidden !== true) out.push(c)
    }
    return out
  }

  node(node: ResolvedNode, role: Role, indent: number, depth: number): void {
    const pad = '  '.repeat(indent)
    const styles = this.declarations(node, role)
    const styleAttr = styles === '' ? '' : ` style="${escapeAttr(styles)}"`
    switch (node.type) {
      case 'svg': {
        let markup = sanitizeSvgMarkup(node.svg ?? '', styles === '' ? null : styles)
        if (this.opts.includeIds) markup = markup.replace('<svg', `<svg${this.idAttr(node)}`)
        this.out += `${pad}${markup}\n`
        return
      }
      case 'vector': {
        const w = formatCssNumber(px(node.styles['width']) ?? 0)
        const h = formatCssNumber(px(node.styles['height']) ?? 0)
        const overflow = node.styles['overflow'] === undefined ? ' overflow="visible"' : ''
        const v = node.vector ?? { fillRule: 'nonzero', subpaths: [] }
        this.out +=
          `${pad}<svg${this.idAttr(node)} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${overflow}${styleAttr}>` +
          `<path d="${escapeAttr(vectorToPathD(v))}" fill-rule="${v.fillRule}"/></svg>\n`
        return
      }
      case 'image': {
        const hash = node.assetId !== undefined && isAssetHash(node.assetId) ? node.assetId : null
        const src = hash === null ? '' : this.assetUrl(hash)
        if (src === null) return
        this.out += `${pad}<img${this.idAttr(node)} src="${escapeAttr(src)}" alt="${escapeAttr(node.name)}"${styleAttr}>\n`
        return
      }
      case 'text': {
        const tag = textTag(node)
        const content = escapeText(node.text ?? '').replace(/\n/g, '<br>')
        this.out += `${pad}<${tag}${this.idAttr(node)}${styleAttr}>${content}</${tag}>\n`
        return
      }
      default: {
        const tag =
          role.kind === 'page'
            ? 'main'
            : role.kind === 'pageArtboard' || role.kind === 'rootArtboard'
              ? 'section'
              : 'div'
        this.out += `${pad}<${tag}${this.idAttr(node)}${styleAttr}>`
        const children = this.visibleChildren(node, depth)
        if (children.length === 0) {
          this.out += `</${tag}>\n`
          return
        }
        this.out += '\n'
        const origin = role.kind === 'page' ? pageBounds(children) : null
        for (const child of children) {
          const childRole: Role =
            role.kind === 'page'
              ? {
                  kind: 'pageArtboard',
                  dx: origin ? -origin.minX : 0,
                  dy: origin ? -origin.minY : 0,
                }
              : { kind: 'layer' }
          this.node(child, childRole, indent + 1, depth + 1)
        }
        this.out += `${pad}</${tag}>\n`
      }
    }
  }

  private declarations(node: ResolvedNode, role: Role): string {
    const decls: string[] = []
    const has = (key: string): boolean => node.styles[key] !== undefined
    const positional = (key: string): boolean =>
      key === 'left' || key === 'top' || key === 'right' || key === 'bottom' || key === 'position'
    switch (role.kind) {
      case 'page': {
        decls.push('position: relative')
        if (node.background !== undefined && isSafeCssValue(node.background)) {
          decls.push(`background-color: ${node.background}`)
        }
        const b = pageBounds(this.visibleChildren(node, 0))
        if (b) {
          decls.push(`width: ${formatCssNumber(b.maxX - b.minX)}px`)
          decls.push(`height: ${formatCssNumber(b.maxY - b.minY)}px`)
        }
        break
      }
      case 'pageArtboard':
        decls.push('position: absolute')
        decls.push(`left: ${formatCssNumber((px(node.styles['left']) ?? 0) + role.dx)}px`)
        decls.push(`top: ${formatCssNumber((px(node.styles['top']) ?? 0) + role.dy)}px`)
        break
      case 'rootArtboard':
        if (!has('position')) decls.push('position: relative')
        break
      case 'layer':
        // Groups always establish a containing block for their absolute children.
        if (node.type === 'group' && !has('position')) decls.push('position: relative')
        break
    }
    if (node.type === 'text') {
      if (!Object.keys(node.styles).some((k) => k.startsWith('margin'))) decls.push('margin: 0')
      if (textTag(node) !== 'p' && !has('fontWeight')) decls.push('font-weight: inherit')
    }
    const dropPositional = role.kind === 'rootArtboard' || role.kind === 'pageArtboard'
    for (const [key, raw] of sortedStyles(node.styles)) {
      if (
        dropPositional &&
        positional(key) &&
        !(role.kind === 'rootArtboard' && key === 'position')
      )
        continue
      if (isHiddenPaint(key)) continue
      let value: StyleValue = raw
      if (typeof raw === 'string' && isImageProperty(key) && assetRefsInValue(raw).length > 0) {
        let dropped = false
        value = rewriteAssetUrls(raw, (hash) => {
          const url = this.assetUrl(hash)
          if (url === null) {
            dropped = true
            return 'none'
          }
          return `url("${url}")`
        })
        if (dropped) continue
      }
      const d = declaration(key, value)
      if (d !== null) decls.push(d)
    }
    return decls.join('; ')
  }
}

/** Render resolved nodes (from `toRenderSubtree`) rooted at `rootId`. */
export function renderSubtreeHtml(
  nodes: Record<string, ResolvedNode>,
  rootId: string,
  opts: HtmlOptions = {},
): string {
  const body = renderBody(nodes, rootId, opts, rootRole(nodes, rootId))
  const vars = tokensCss(opts.tokens ?? {})
  return vars === '' ? body : `<style>\n${vars}</style>\n${body}`
}

function rootRole(nodes: Record<string, ResolvedNode>, rootId: string): Role {
  const root = nodes[rootId]
  if (root?.type === 'page') return { kind: 'page' }
  const parent = root?.parentId ? nodes[root.parentId] : undefined
  return parent?.type === 'page' ? { kind: 'rootArtboard' } : { kind: 'layer' }
}

function renderBody(
  nodes: Record<string, ResolvedNode>,
  rootId: string,
  opts: HtmlOptions,
  role: Role,
): string {
  const root = nodes[rootId]
  if (!root) return ''
  const w = new Writer(nodes, opts)
  w.node(root, role, 0, 0)
  return w.out
}

/**
 * HTML for `refs` (real or virtual), instances resolved. Tokens (default: the document's) are
 * emitted once as `:root` custom properties; an artboard root drops its canvas position.
 */
export function renderHtml(doc: LoroDoc, refs: readonly string[], opts: HtmlOptions = {}): string {
  const resolver = createComponentResolver(doc)
  let body = ''
  for (const ref of refs) {
    const sub = toRenderSubtree(doc, ref, resolver)
    if (!sub) continue
    const root = sub.nodes[ref]
    let role: Role = { kind: 'layer' }
    if (root?.type === 'page') role = { kind: 'page' }
    else if (root?.parentId && isTreeId(ref) && getNode(doc, root.parentId)?.type === 'page') {
      role = { kind: 'rootArtboard' }
    }
    body += renderBody(sub.nodes, ref, opts, role)
  }
  const vars = tokensCss(opts.tokens ?? getTokens(doc))
  return vars === '' ? body : `<style>\n${vars}</style>\n${body}`
}
