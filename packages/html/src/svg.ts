/**
 * SVG helpers: serialise a parse5 `<svg>` subtree to markup (for `sanitizeSvgMarkup`), read
 * an SVG's intrinsic size, and convert sanitised markup to JSX.
 */
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { formatCssNumber } from '@baren/schema'

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element

export { HTML_NS, SVG_NS, isElement } from './dom.ts'
import { isElement } from './dom.ts'

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textPath', 'title', 'desc'])

function attrName(a: { name: string; prefix?: string }): string {
  return a.prefix ? `${a.prefix}:${a.name}` : a.name
}

/**
 * Markup of a parse5 SVG element; `skipRootAttrs` are left off the root (its `style`,
 * `layer-name`… become node data instead).
 */
export function serializeSvgElement(root: Element, skipRootAttrs: ReadonlySet<string>): string {
  let out = ''
  const stack: ({ node: Node; root: boolean } | { close: string })[] = [{ node: root, root: true }]
  while (stack.length > 0) {
    const item = stack.pop() as { node: Node; root: boolean } | { close: string }
    if ('close' in item) {
      out += item.close
      continue
    }
    const node = item.node
    if (node.nodeName === '#text') {
      const value = (node as DefaultTreeAdapterTypes.TextNode).value
      // Indentation between elements is dropped; text inside <text>, <title>… is kept.
      const parent = node.parentNode
      const inText = parent !== null && isElement(parent) && TEXT_ELEMENTS.has(parent.tagName)
      if (inText || /\S/.test(value)) out += escapeText(value)
      continue
    }
    if (!isElement(node)) continue
    let tag = `<${node.tagName}`
    for (const a of node.attrs) {
      const name = attrName(a)
      if (item.root && skipRootAttrs.has(name.toLowerCase())) continue
      tag += ` ${name}="${escapeAttr(a.value)}"`
    }
    out += `${tag}>`
    stack.push({ close: `</${node.tagName}>` })
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      stack.push({ node: node.childNodes[i] as Node, root: false })
  }
  return out
}

/** A length attribute (`24`, `24px`, `1.5em`) as a CSS length; null for `auto`/empty. */
export function svgLengthToCss(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const v = raw.trim()
  if (v === '' || v === 'auto') return null
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) return `${formatCssNumber(Number(v))}px`
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(px|em|rem|%|pt|vw|vh|ch|ex)$/i.test(v))
    return v.toLowerCase().endsWith('rem') ? `${formatCssNumber(Number(v.slice(0, -3)) * 16)}px` : v
  return null
}

/** A px number from an attribute (`24`, `24px`); null otherwise. */
export function attrPx(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))(px)?\s*$/i.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** `viewBox` width/height. */
export function viewBoxSize(
  raw: string | null | undefined,
): { width: number; height: number } | null {
  if (!raw) return null
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const width = parts[2] as number
  const height = parts[3] as number
  return width > 0 && height > 0 ? { width, height } : null
}

/** Root `<svg>` width/height/viewBox attributes of a markup string. */
export function svgRootAttrs(markup: string): {
  width: string | null
  height: string | null
  viewBox: string | null
} {
  const m = /<svg\b([^>]*)>/i.exec(markup)
  const attrs = m?.[1] ?? ''
  const get = (name: string): string | null => {
    const r = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
      attrs,
    )
    return r ? (r[1] ?? r[2] ?? r[3] ?? null) : null
  }
  return { width: get('width'), height: get('height'), viewBox: get('viewBox') }
}

// ---------------------------------------------------------------------------
// Markup → JSX
// ---------------------------------------------------------------------------

const JSX_ATTR_EXCEPTIONS: Record<string, string> = {
  class: 'className',
  'xlink:href': 'xlinkHref',
  'xlink:title': 'xlinkTitle',
  'xmlns:xlink': 'xmlnsXlink',
  'xml:space': 'xmlSpace',
  'xml:lang': 'xmlLang',
  for: 'htmlFor',
}

/** SVG/HTML attribute → React prop name (`stroke-width` → `strokeWidth`; aria/data stay). */
export function jsxAttrName(name: string): string {
  const special = JSX_ATTR_EXCEPTIONS[name]
  if (special) return special
  if (name.startsWith('aria-') || name.startsWith('data-')) return name
  return name.replace(/[-:]([a-z])/g, (_m, c: string) => c.toUpperCase())
}

/** Parse markup into parse5 nodes (SVG namespace inside `<svg>`). */
export function parseMarkup(markup: string): Node[] {
  return parseFragment(markup).childNodes
}
