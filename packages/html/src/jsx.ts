/**
 * get_jsx (contract §8.1): resolved nodes → deterministic JSX, with React inline styles or
 * Tailwind classes mapped to the file's tokens.
 */
import {
  ASSET_URL_PREFIX,
  formatCssNumber,
  rewriteAssetUrls,
  sanitizeSvgMarkup,
  vectorToSvgMarkup,
} from '@baren/schema'
import type { ResolvedNode, StyleValue, Styles } from '@baren/schema'
import type { DefaultTreeAdapterTypes } from 'parse5'
import { INHERITED_TEXT_PROPERTIES } from './css/known.ts'
import { canonicalStyles, sortStyleKeys } from './css/partition.ts'
import { normalizeStyles } from './css/normalize.ts'
import { isElement, jsxAttrName, parseMarkup } from './svg.ts'
import { buildTheme, tailwindClasses, type Theme } from './tailwind.ts'
import type { JsxOptions } from './types.ts'

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element

const MAX_DEPTH = 256
const PAINT_KEYS = new Set([
  'fill',
  'fillOpacity',
  'fillRule',
  'stroke',
  'strokeWidth',
  'strokeOpacity',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
])
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A JS single-quoted string literal. */
function jsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
}

/** `{ a: 'x', b: 600 }` with keys in the given order. */
function styleObject(styles: Styles, keys: readonly string[]): string {
  const parts = keys.map((k) => {
    const v = styles[k] as StyleValue
    const key = IDENT_RE.test(k) ? k : jsString(k)
    const value = typeof v === 'number' ? formatCssNumber(v) : jsString(v)
    return `${key}: ${value}`
  })
  return `{ ${parts.join(', ')} }`
}

/** JSX attribute value: a plain string, or an expression when quotes or braces get in the way. */
function attrValue(v: string): string {
  return /["{}\n]/.test(v) ? `{${jsString(v)}}` : `"${v}"`
}

/** Text content for JSX: `{'…'}` for braces, angle brackets and edge spaces; `\n` → `<br />`. */
export function jsxText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*)(.*?)(\s*)$/s.exec(line) as RegExpExecArray
      const lead = m[1] as string
      const body = m[2] as string
      const trail = m[3] as string
      let out = lead === '' ? '' : `{${jsString(lead)}}`
      out += body.replace(/[{}<>]+|&(?=#?[A-Za-z0-9]+;)/g, (s) => `{${jsString(s)}}`)
      if (trail !== '') out += `{${jsString(trail)}}`
      return out
    })
    .join('<br />')
}

class JsxWriter {
  readonly lines: string[] = []
  readonly theme: Theme | null

  readonly nodes: Record<string, ResolvedNode>
  readonly opts: JsxOptions

  constructor(nodes: Record<string, ResolvedNode>, opts: JsxOptions) {
    this.nodes = nodes
    this.opts = opts
    this.theme = opts.format === 'tailwind' ? buildTheme(opts.tokens) : null
  }

  assetUrl(hash: string): string {
    return this.opts.assetUrl ? this.opts.assetUrl(hash) : `${ASSET_URL_PREFIX}${hash}`
  }

  /** Canonical styles with the snippet rules (inherited root styles, top-level, groups). */
  stylesOf(
    node: ResolvedNode,
    root: boolean,
    topLevel: boolean,
  ): { styles: Styles; storedWhiteSpace: boolean } {
    const src: Styles = { ...node.styles }
    if (root && this.opts.inherited) {
      for (const k of INHERITED_TEXT_PROPERTIES) {
        const v = this.opts.inherited[k]
        if (v !== undefined && src[k] === undefined) src[k] = v
      }
    }
    if (root && topLevel)
      for (const k of ['left', 'top', 'position', 'right', 'bottom', 'inset']) delete src[k]
    if (node.type === 'group' && src['position'] === undefined) src['position'] = 'relative'
    if (node.type === 'vector') for (const k of PAINT_KEYS) delete src[k]
    const storedWhiteSpace = src['whiteSpace'] !== undefined
    const styles = canonicalStyles({ type: node.type, styles: src })
    for (const k of ['backgroundImage', 'background']) {
      const v = styles[k]
      if (typeof v === 'string' && v.includes(ASSET_URL_PREFIX)) {
        styles[k] = rewriteAssetUrls(v, (h) => `url("${this.assetUrl(h)}")`)
      }
    }
    return { styles, storedWhiteSpace }
  }

  /** ` className="…"` / ` style={{ … }}` (+ boxSizing for inline styles). */
  styleAttr(node: ResolvedNode, root: boolean, topLevel: boolean): string {
    const { styles, storedWhiteSpace } = this.stylesOf(node, root, topLevel)
    if (this.theme) {
      if (node.type === 'text' && !storedWhiteSpace) delete styles['whiteSpace']
      const classes = tailwindClasses(styles, this.theme)
      return classes.length === 0 ? '' : ` className="${classes.join(' ').replace(/"/g, "'")}"`
    }
    styles['boxSizing'] = 'border-box'
    return ` style={${styleObject(styles, sortStyleKeys(Object.keys(styles)))}}`
  }

  idAttr(node: ResolvedNode): string {
    return this.opts.includeIds ? ` data-node-id="${node.id}"` : ''
  }

  children(node: ResolvedNode, depth: number): ResolvedNode[] {
    if (depth >= MAX_DEPTH) return []
    const out: ResolvedNode[] = []
    for (const id of node.children) {
      const c = this.nodes[id]
      if (c && c.hidden !== true) out.push(c)
    }
    return out
  }

  node(node: ResolvedNode, indent: number, depth: number, root: boolean, topLevel: boolean): void {
    const pad = ' '.repeat(indent)
    const attrs = this.idAttr(node) + this.styleAttr(node, root, topLevel)
    switch (node.type) {
      case 'text': {
        const text = node.text ?? ''
        if (text === '') {
          this.lines.push(`${pad}<div${attrs} />`)
          return
        }
        this.lines.push(`${pad}<div${attrs}>`, `${pad}  ${jsxText(text)}`, `${pad}</div>`)
        return
      }
      case 'image': {
        const src = node.assetId ? ` src="${this.assetUrl(node.assetId)}"` : ''
        this.lines.push(`${pad}<img${src} alt=${attrValue(node.name)}${attrs} />`)
        return
      }
      case 'svg':
        this.svg(sanitizeSvgMarkup(node.svg ?? ''), node, indent, root, topLevel, false)
        return
      case 'vector':
        this.svg(vectorToSvgMarkup(node, this.opts.tokens), node, indent, root, topLevel, true)
        return
      default: {
        const kids = this.children(node, depth)
        if (kids.length === 0) {
          this.lines.push(`${pad}<div${attrs} />`)
          return
        }
        this.lines.push(`${pad}<div${attrs}>`)
        for (const c of kids) this.node(c, indent + 2, depth + 1, false, false)
        this.lines.push(`${pad}</div>`)
      }
    }
  }

  /** SVG markup → JSX lines; the node's own styles go on the root. */
  svg(
    markup: string,
    node: ResolvedNode,
    indent: number,
    root: boolean,
    topLevel: boolean,
    vector: boolean,
  ): void {
    const el = parseMarkup(markup).find((n): n is Element => isElement(n) && n.tagName === 'svg')
    const pad = ' '.repeat(indent)
    if (!el) {
      this.lines.push(`${pad}<svg${this.idAttr(node)}${this.styleAttr(node, root, topLevel)} />`)
      return
    }
    let rootStyle: Styles = {}
    let attrs = this.idAttr(node)
    for (const a of el.attrs) {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name
      if (name === 'style') {
        rootStyle = present(normalizeStyles(a.value).styles)
        continue
      }
      attrs += ` ${jsxAttrName(name)}=${attrValue(a.value)}`
    }
    if (vector && !el.attrs.some((a) => a.name === 'overflow')) attrs += ' overflow="visible"'
    const own = this.styleAttr(node, root, topLevel)
    if (Object.keys(rootStyle).length > 0 && this.theme) {
      attrs += own
      attrs += ` style={${styleObject(rootStyle, sortStyleKeys(Object.keys(rootStyle)))}}`
    } else if (Object.keys(rootStyle).length > 0) {
      const { styles } = this.stylesOf(node, root, topLevel)
      const merged: Styles = { ...rootStyle, ...styles, boxSizing: 'border-box' }
      attrs += ` style={${styleObject(merged, sortStyleKeys(Object.keys(merged)))}}`
    } else attrs += own
    this.svgChildren(el, attrs, indent)
  }

  svgChildren(el: Element, rootAttrs: string | null, indent: number): void {
    const pad = ' '.repeat(indent)
    let attrs = rootAttrs
    if (attrs === null) {
      attrs = ''
      for (const a of el.attrs) {
        const name = a.prefix ? `${a.prefix}:${a.name}` : a.name
        if (name === 'style') {
          const s = present(normalizeStyles(a.value).styles)
          attrs += ` style={${styleObject(s, sortStyleKeys(Object.keys(s)))}}`
        } else attrs += ` ${jsxAttrName(name)}=${attrValue(a.value)}`
      }
    }
    const kids = el.childNodes.filter(
      (c) =>
        isElement(c) ||
        (c.nodeName === '#text' && /\S/.test((c as DefaultTreeAdapterTypes.TextNode).value)),
    )
    if (kids.length === 0) {
      this.lines.push(`${pad}<${el.tagName}${attrs} />`)
      return
    }
    if (kids.every((c) => !isElement(c))) {
      const text = kids
        .map((c) => (c as DefaultTreeAdapterTypes.TextNode).value)
        .join('')
        .trim()
      this.lines.push(`${pad}<${el.tagName}${attrs}>${jsxText(text)}</${el.tagName}>`)
      return
    }
    this.lines.push(`${pad}<${el.tagName}${attrs}>`)
    for (const c of kids as Node[]) {
      if (isElement(c)) this.svgChildren(c, null, indent + 2)
      else
        this.lines.push(`${pad}  ${jsxText((c as DefaultTreeAdapterTypes.TextNode).value.trim())}`)
    }
    this.lines.push(`${pad}</${el.tagName}>`)
  }
}

function present(patch: Record<string, StyleValue | null>): Styles {
  const out: Styles = {}
  for (const [k, v] of Object.entries(patch)) if (v !== null) out[k] = v
  return out
}

/** JSX for a resolved subtree (from `toRenderSubtree`); pages are not allowed. */
export function toJsx(
  nodes: Record<string, ResolvedNode>,
  rootId: string,
  opts: JsxOptions,
): string {
  const root = nodes[rootId]
  if (!root) throw new Error(`Node ${rootId} is not in the subtree`)
  if (root.type === 'page')
    throw new Error('get_jsx works on layers, not pages: pass an artboard or a layer id')
  const topLevel =
    opts.topLevel ??
    (root.parentId !== null &&
      nodes[root.parentId] === undefined &&
      root.styles['position'] === undefined &&
      (root.styles['left'] !== undefined || root.styles['top'] !== undefined))
  const w = new JsxWriter(nodes, opts)
  w.node(root, 4, 0, true, topLevel)
  return `(\n${w.lines.join('\n')}\n  )`
}
