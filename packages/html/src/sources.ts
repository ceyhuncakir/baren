/**
 * Image sources of a write_html / update_styles / create_artboard call (contract §4.8). A light
 * entry (`@baren/html/sources`): parse5 only, no `@baren/schema` or Loro, so Electron
 * main can resolve sources before forwarding a call without loading the document model.
 */
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { cssUrls } from './css/syntax.ts'
import { HTML_NS, attr, hoistSelfClosing, isElement } from './dom.ts'

type Element = DefaultTreeAdapterTypes.Element
type ParentNode = DefaultTreeAdapterTypes.ParentNode

/** `<img src>` values and `url(…)` sources in style attributes, deduped, in order (§4.8). */
export function collectImageSources(html: string): string[] {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
  hoistSelfClosing(fragment, html)
  const out: string[] = []
  const seen = new Set<string>()
  const add = (src: string): void => {
    const s = src.trim()
    if (s === '' || s.startsWith('#') || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  // Depth-first, children left to right (document order); SVG subtrees are not entered.
  const stack: ParentNode[] = [fragment]
  while (stack.length > 0) {
    const parent = stack.pop() as ParentNode
    const kids = parent.childNodes.filter(isElement) as Element[]
    for (let i = kids.length - 1; i >= 0; i--) {
      const el = kids[i] as Element
      if (el.namespaceURI === HTML_NS) stack.push(el)
    }
    if (!isElement(parent) || parent.namespaceURI !== HTML_NS) continue
    if (parent.tagName === 'img') {
      const src = attr(parent, 'src')
      if (src !== null) add(src)
    }
    const style = attr(parent, 'style')
    if (style !== null) for (const u of cssUrls(style)) add(u)
  }
  return out
}

/** `url(…)` sources in a style record's values, deduped, in order. */
export function collectCssUrls(styles: Record<string, string | number | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of Object.values(styles)) {
    if (typeof v !== 'string') continue
    for (const u of cssUrls(v)) {
      const s = u.trim()
      if (s === '' || s.startsWith('#') || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out
}
