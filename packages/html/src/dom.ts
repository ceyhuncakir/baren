/**
 * parse5 tree helpers shared by the parser and the light `sources` entry (no `@baren/schema`
 * or Loro imports here: Electron main loads this through `@baren/html/sources`).
 */
import type { DefaultTreeAdapterTypes } from 'parse5'

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element
type ParentNode = DefaultTreeAdapterTypes.ParentNode

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const HTML_NS = 'http://www.w3.org/1999/xhtml'

export const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track',
  'wbr', 'param', 'keygen',
]) // prettier-ignore

export function isElement(node: Node | ParentNode): node is Element {
  return 'tagName' in node
}

/** An attribute value (no namespace prefix), or null. */
export function attr(el: Element, name: string): string | null {
  for (const a of el.attrs) if (a.name === name && !a.prefix) return a.value
  return null
}

/**
 * A `/>` on a non-void HTML element is not self-closing in HTML: the following siblings end
 * up inside it. Agents write `<x-baren-clone … />` and `<div … />` meaning "empty", so those
 * children are moved back out (they become the next siblings, as the author meant).
 */
export function hoistSelfClosing(root: ParentNode, html: string): void {
  const stack: ParentNode[] = [root]
  while (stack.length > 0) {
    const parent = stack.pop() as ParentNode
    const kids = parent.childNodes
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i] as Node
      if (!isElement(node)) continue
      if (node.namespaceURI === HTML_NS && !VOID.has(node.tagName) && node.childNodes.length > 0) {
        const loc = node.sourceCodeLocation?.startTag
        if (loc && /\/\s*>$/.test(html.slice(loc.startOffset, loc.endOffset))) {
          const moved = node.childNodes
          node.childNodes = []
          for (const m of moved) m.parentNode = parent
          kids.splice(i + 1, 0, ...moved)
        }
      }
      if (node.namespaceURI === HTML_NS || node.tagName === 'svg') stack.push(node)
    }
  }
}
