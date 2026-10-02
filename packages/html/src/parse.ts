/**
 * write_html parser (contract §7.3–7.5): HTML → IR (no Loro). parse5 builds the tree; each
 * element maps to a frame, text, image, svg or clone; styles are normalised; anything dropped
 * or changed is a warning.
 */
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { sanitizeSvgMarkup, type StylePatch, type StyleValue, type Token } from '@baren/schema'
import { normalizeStyles } from './css/normalize.ts'
import { attr, hoistSelfClosing } from './dom.ts'
import {
  HTML_NS,
  SVG_NS,
  attrPx,
  isElement,
  serializeSvgElement,
  svgLengthToCss,
  viewBoxSize,
} from './svg.ts'
import type { HtmlWarning, IrNode, ParseOptions, ParsedHtml } from './types.ts'
import { WARNING_TOKEN, Warnings } from './warnings.ts'

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element
type ParentNode = DefaultTreeAdapterTypes.ParentNode
type TextNode = DefaultTreeAdapterTypes.TextNode

export const MAX_CREATED_NODES = 5000
export const MAX_DEPTH = 64
const MAX_NAME = 50

const DROPPED = new Set([
  'script', 'style', 'link', 'meta', 'template', 'iframe', 'object', 'embed', 'video', 'audio',
  'canvas', 'noscript', 'slot', 'dialog', 'title', 'base', 'head', 'math', 'frame', 'frameset',
  'applet', 'portal', 'map', 'area',
]) // prettier-ignore

/** Dropped without a warning (they carry no visible content). */
const DROPPED_SILENTLY = new Set(['source', 'track', 'param', 'col', 'colgroup', 'datalist'])

const PHRASING = new Set([
  'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'code',
  'kbd', 'samp', 'a', 'abbr', 'cite', 'q', 'time', 'label', 'br', 'wbr',
]) // prettier-ignore

/** Inline formatting that a single-style text layer cannot keep. */
const RICH = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'sub',
  'sup',
  'code',
])

const CLONE_TAG = 'x-baren-clone'

/** Attributes ignored without a warning (semantics, accessibility, behaviour). */
const SILENT_ATTRS = new Set([
  'id', 'href', 'title', 'role', 'tabindex', 'type', 'name', 'for', 'target', 'rel', 'lang', 'dir',
  'xmlns', 'disabled', 'checked', 'selected', 'readonly', 'required', 'autofocus',
  'autocomplete', 'spellcheck', 'draggable', 'contenteditable', 'translate', 'method', 'action',
  'colspan', 'rowspan', 'scope', 'loading', 'decoding', 'srcset', 'sizes', 'crossorigin',
  'referrerpolicy', 'fetchpriority', 'datetime', 'cite', 'open', 'download', 'accept', 'multiple',
  'min', 'max', 'step', 'pattern', 'maxlength', 'minlength', 'rows', 'cols', 'wrap', 'label',
  'start', 'reversed', 'abbr', 'headers', 'span', 'inputmode', 'enterkeyhint', 'slot', 'part',
  'is', 'nonce', 'accesskey', 'itemprop', 'itemscope', 'itemtype', 'value', 'placeholder',
  'popover', 'popovertarget', 'form', 'formaction', 'novalidate', 'hreflang', 'ping', 'media',
  'usemap', 'ismap', 'alt',
]) // prettier-ignore

const SVG_ROOT_SKIP = new Set(['style', 'layer-name', 'data-layer-name', 'hidden', 'class'])

/** UA defaults applied when the property is not set inline (contract §7.4). */
function uaDefaults(tag: string): StylePatch {
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'th':
    case 'b':
    case 'strong':
      return { fontWeight: 700 }
    case 'i':
    case 'em':
      return { fontStyle: 'italic' }
    case 'u':
    case 'ins':
      return { textDecoration: 'underline' }
    case 's':
    case 'del':
      return { textDecoration: 'line-through' }
    case 'pre':
      return { fontFamily: 'JetBrains Mono', whiteSpace: 'pre' }
    case 'code':
    case 'kbd':
    case 'samp':
      return { fontFamily: 'JetBrains Mono' }
    default:
      return {}
  }
}

const isText = (n: Node): n is TextNode => n.nodeName === '#text'

function truncateName(name: string): string {
  const chars = Array.from(name.trim())
  return chars.length > MAX_NAME ? chars.slice(0, MAX_NAME).join('') : chars.join('')
}

/** Layer name of a text layer: its first non-empty line, trimmed, ≤ 50 characters. */
export function textLayerName(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t !== '') return truncateName(t)
  }
  return 'Text'
}

type WsMode = 'normal' | 'pre' | 'pre-line'

function wsMode(value: StyleValue | null | undefined): WsMode | null {
  if (typeof value !== 'string') return null
  const v = value.toLowerCase()
  if (v === 'pre' || v === 'pre-wrap' || v === 'break-spaces') return 'pre'
  if (v === 'pre-line') return 'pre-line'
  if (v === 'normal' || v === 'nowrap') return 'normal'
  return null
}

/** Marker for `<br>` while collapsing whitespace (parse5 never yields U+0000 in text). */
const BR = '\u0000'

/** Whitespace processing (contract §7.4); `<br>` markers become newlines. */
export function processWhitespace(raw: string, mode: WsMode): string {
  if (mode === 'pre') return raw.split(BR).join('\n')
  let s: string
  if (mode === 'pre-line') {
    s = raw.replace(/[ \t\f\r]+/g, ' ').replace(/ ?\n ?/g, '\n')
    s = s.split(BR).join('\n')
    s = s.replace(/ ?\n ?/g, '\n')
    return s.replace(/^[\s]+|[\s]+$/g, '')
  }
  s = raw.replace(/[ \t\n\f\r]+/g, ' ')
  s = s.replace(new RegExp(` ?${BR} ?`, 'g'), BR)
  s = s.replace(/^ +| +$/g, '')
  return s.split(BR).join('\n')
}

interface Scope {
  path: string
  depth: number
  ws: WsMode
}

class Parser {
  readonly w = new Warnings()
  count = 0
  readonly tokens: Record<string, Token> | undefined
  readonly maxNodes: number
  /** Custom properties declared anywhere in the call (their var()s are not unknown tokens). */
  readonly declared = new Set<string>()
  private readonly styleCache = new Map<string, { styles: StylePatch; warnings: HtmlWarning[] }>()

  constructor(opts: ParseOptions) {
    this.tokens = opts.tokens
    this.maxNodes = opts.maxNodes ?? MAX_CREATED_NODES
  }

  /** Normalised inline styles (cached per style string; warnings re-pathed). */
  styles(el: Element, path: string): StylePatch {
    const raw = attr(el, 'style')
    if (raw === null || raw.trim() === '') return {}
    let hit = this.styleCache.get(raw)
    if (!hit) {
      const r = normalizeStyles(raw, this.tokens ? { tokens: this.tokens } : {})
      hit = { styles: r.styles, warnings: r.warnings }
      for (const k of Object.keys(r.styles)) if (k.startsWith('--')) this.declared.add(k)
      if (this.styleCache.size < 2000) this.styleCache.set(raw, hit)
    }
    for (const warning of hit.warnings) {
      const extra: { path?: string; property?: string; token?: string } = { path }
      if (warning.property !== undefined) extra.property = warning.property
      const token = WARNING_TOKEN.get(warning)
      if (token !== undefined) extra.token = token
      if (warning.code === 'list-markers-dropped' || warning.code === 'table-as-flex')
        this.w.once(warning.code, warning.message)
      else this.w.add(warning.code, warning.message, extra)
    }
    return { ...hit.styles }
  }

  /** Name, hidden flag and attribute warnings shared by every element kind. */
  common(
    el: Element,
    path: string,
    allowed: ReadonlySet<string> = new Set(),
  ): { name: string | null; hidden: boolean } {
    let name: string | null = null
    let hidden = false
    for (const a of el.attrs) {
      const n = a.prefix ? `${a.prefix}:${a.name}` : a.name
      if (n === 'layer-name' || (n === 'data-layer-name' && name === null)) {
        const v = truncateName(a.value)
        if (v !== '') name = v
      } else if (n === 'hidden') hidden = true
      else if (n === 'class') {
        if (a.value.trim() !== '')
          this.w.once(
            'class-ignored',
            'class attributes are ignored: use inline styles (style="…").',
            { path },
          )
      } else if (
        n === 'style' ||
        allowed.has(n) ||
        SILENT_ATTRS.has(n) ||
        n.startsWith('aria-') ||
        n.startsWith('data-') ||
        n.startsWith('on')
      ) {
        continue
      } else {
        this.w.add('attribute-ignored', `The ${n} attribute has no effect; use inline styles.`, {
          path,
          property: n,
        })
      }
    }
    return { name, hidden }
  }

  node(): boolean {
    this.count++
    return this.count <= this.maxNodes
  }

  // -------------------------------------------------------------------------

  children(parent: ParentNode, scope: Scope, flex: boolean | null): IrNode[] {
    const out: IrNode[] = []
    let run = ''
    let index = 0
    const flush = (): void => {
      if (run === '') return
      const text = processWhitespace(run, scope.ws === 'pre' ? 'pre' : scope.ws)
      run = ''
      if (text.trim() === '') return
      if (!this.node()) return
      out.push({
        kind: 'text',
        name: textLayerName(text),
        styles: {},
        hidden: false,
        path: scope.path,
        text,
      })
    }
    for (const child of parent.childNodes) {
      if (isText(child)) {
        run += child.value
        continue
      }
      if (!isElement(child)) continue
      index++
      flush()
      const seg = `${child.tagName}[${index}]`
      const path = scope.path === '' ? seg : `${scope.path} > ${seg}`
      const ir = this.element(child, { path, depth: scope.depth + 1, ws: scope.ws })
      if (ir) out.push(ir)
    }
    flush()
    if (flex === false) {
      const inFlow = out.filter((n) => n.styles['position'] !== 'absolute').length
      if (inFlow >= 2)
        this.w.add(
          'block-flow',
          'This container is not display: flex, so its children stack in block flow, which the inspector cannot edit. Use display: flex with flex-direction and gap.',
          { path: scope.path },
        )
    }
    return out
  }

  element(el: Element, scope: Scope): IrNode | null {
    const tag = el.tagName
    if (scope.depth > MAX_DEPTH) {
      this.w.once('depth-limit', `Elements nested deeper than ${MAX_DEPTH} levels were dropped.`, {
        path: scope.path,
      })
      return null
    }
    if (el.namespaceURI === SVG_NS) {
      if (tag === 'svg') return this.svg(el, scope)
      this.w.add('unsupported-element', `<${tag}> outside an <svg> was dropped.`, {
        path: scope.path,
      })
      return null
    }
    if (el.namespaceURI !== HTML_NS) {
      this.w.add('unsupported-element', `<${tag}> is not supported and was dropped.`, {
        path: scope.path,
      })
      return null
    }
    if (DROPPED_SILENTLY.has(tag)) return null
    if (DROPPED.has(tag)) {
      if (tag === 'style')
        this.w.add(
          'stylesheet-ignored',
          '<style> blocks are ignored: put styles inline (style="…").',
          { path: scope.path },
        )
      else
        this.w.add('unsupported-element', `<${tag}> is not supported and was dropped.`, {
          path: scope.path,
        })
      return null
    }
    if (tag === CLONE_TAG) return this.clone(el, scope)
    switch (tag) {
      case 'img':
        return this.image(el, scope)
      case 'br':
      case 'wbr':
        return null
      case 'hr':
        return this.hr(el, scope)
      case 'input':
      case 'textarea':
      case 'select':
        return this.formControl(el, scope)
      default:
        return this.generic(el, scope)
    }
  }

  generic(el: Element, scope: Scope): IrNode | null {
    const tag = el.tagName
    const { name, hidden } = this.common(el, scope.path)
    const styles = this.styles(el, scope.path)
    for (const [k, v] of Object.entries(uaDefaults(tag))) if (!(k in styles)) styles[k] = v
    if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'tr') {
      if (!('display' in styles)) {
        styles['display'] = 'flex'
        if (tag !== 'tr' && !('flexDirection' in styles)) styles['flexDirection'] = 'column'
      }
      this.w.once(
        'table-as-flex',
        'Table elements were converted to flex frames (tables are not supported).',
        {
          path: scope.path,
        },
      )
    } else if (tag === 'ul' || tag === 'ol') {
      this.w.once(
        'list-markers-dropped',
        'List markers (bullets and numbers) are not drawn; add them as text or SVG.',
        {
          path: scope.path,
        },
      )
    }
    const ws = wsMode(styles['whiteSpace']) ?? (tag === 'pre' ? 'pre' : scope.ws)
    const display = styles['display']
    const flex = display === 'flex' || display === 'inline-flex'
    const grid = display === 'grid' || display === 'inline-grid'
    // Element children of a flex/grid container are separate items (each its own layer), so
    // such a container is a frame even when its children are phrasing elements.
    const itemized =
      (flex || grid) &&
      el.childNodes.some((c) => isElement(c) && c.tagName !== 'br' && c.tagName !== 'wbr')
    const text = itemized ? null : this.textContent(el, ws, scope.path)
    if (text !== null) {
      if (!this.node()) return null
      if (styles['display'] === 'block') delete styles['display']
      return {
        kind: 'text',
        name: name ?? textLayerName(text),
        styles,
        hidden,
        path: scope.path,
        text,
      }
    }
    if (!this.node()) return null
    const children = this.children(
      el,
      { path: scope.path, depth: scope.depth, ws },
      flex || grid ? null : false,
    )
    // Absolutely positioned children are placed in this frame (the canvas model, Phase 3 §2.4).
    if (
      styles['position'] === undefined &&
      children.some((c) => c.styles['position'] === 'absolute')
    ) {
      styles['position'] = 'relative'
    }
    return { kind: 'frame', name: name ?? 'Frame', styles, hidden, path: scope.path, children }
  }

  /**
   * The text of a text-only element (text and phrasing elements), whitespace-processed; null
   * when the element has other content or no visible text. Warns for flattened formatting.
   */
  textContent(el: Element, ws: WsMode, path: string): string | null {
    let raw = ''
    let rich = false
    let visible = false
    const stack: Node[] = [...el.childNodes].reverse()
    let steps = 0
    while (stack.length > 0) {
      if (++steps > 100_000) return null
      const node = stack.pop() as Node
      if (isText(node)) {
        raw += node.value
        if (!visible && /\S/.test(node.value)) visible = true
        continue
      }
      if (!isElement(node)) continue
      if (node.namespaceURI !== HTML_NS || !PHRASING.has(node.tagName)) return null
      if (node.tagName === 'br') {
        raw += BR
        continue
      }
      if (node.tagName === 'wbr') continue
      if (attr(node, 'hidden') !== null) continue
      if (RICH.has(node.tagName) || (attr(node, 'style') ?? '').trim() !== '') rich = true
      if ((attr(node, 'class') ?? '').trim() !== '')
        this.w.once(
          'class-ignored',
          'class attributes are ignored: use inline styles (style="…").',
          { path },
        )
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i] as Node)
    }
    if (!visible) return null
    const text = processWhitespace(raw, ws)
    if (text === '') return null
    if (rich) {
      this.w.add(
        'rich-text-flattened',
        'Inline formatting inside a text layer was flattened (one style per text layer). Put differently styled runs in separate elements inside a flex row.',
        { path },
      )
    }
    return text
  }

  image(el: Element, scope: Scope): IrNode | null {
    const { name, hidden } = this.common(el, scope.path, new Set(['src', 'alt', 'width', 'height']))
    if (!this.node()) return null
    const styles = this.styles(el, scope.path)
    const alt = attr(el, 'alt')
    return {
      kind: 'image',
      name: name ?? (alt !== null && alt.trim() !== '' ? truncateName(alt) : null),
      styles,
      hidden,
      path: scope.path,
      src: (attr(el, 'src') ?? '').trim(),
      alt: alt === null ? null : alt.trim(),
      attrWidth: attrPx(attr(el, 'width')),
      attrHeight: attrPx(attr(el, 'height')),
    }
  }

  svg(el: Element, scope: Scope): IrNode | null {
    if (!this.node()) return null
    let name: string | null = null
    let hidden = false
    for (const a of el.attrs) {
      if (a.name === 'layer-name' || (a.name === 'data-layer-name' && name === null)) {
        const v = truncateName(a.value)
        if (v !== '') name = v
      } else if (a.name === 'hidden') hidden = true
    }
    const styles = this.styles(el, scope.path)
    const width = svgLengthToCss(attr(el, 'width'))
    const height = svgLengthToCss(attr(el, 'height'))
    if (!('width' in styles) && width !== null) styles['width'] = width
    if (!('height' in styles) && height !== null) styles['height'] = height
    if (!('width' in styles) && !('height' in styles)) {
      const vb = viewBoxSize(attr(el, 'viewBox'))
      if (vb) {
        styles['width'] = `${vb.width}px`
        styles['height'] = `${vb.height}px`
      }
    }
    const markup = sanitizeSvgMarkup(serializeSvgElement(el, SVG_ROOT_SKIP))
    return { kind: 'svg', name: name ?? 'SVG', styles, hidden, path: scope.path, markup }
  }

  clone(el: Element, scope: Scope): IrNode | null {
    const { name, hidden } = this.common(el, scope.path, new Set(['node-id']))
    const nodeId = (attr(el, 'node-id') ?? '').trim()
    if (nodeId === '') {
      this.w.add(
        'clone-not-found',
        `<${el.tagName}> needs a node-id attribute; nothing was copied.`,
        { path: scope.path },
      )
      return null
    }
    if (el.childNodes.some((c) => isElement(c) || (isText(c) && /\S/.test(c.value)))) {
      this.w.add(
        'clone-children-ignored',
        `Children of <${el.tagName}> are ignored (the copy keeps the source's content).`,
        {
          path: scope.path,
        },
      )
    }
    if (!this.node()) return null
    return {
      kind: 'clone',
      name,
      styles: this.styles(el, scope.path),
      hidden,
      path: scope.path,
      nodeId,
    }
  }

  hr(el: Element, scope: Scope): IrNode | null {
    const { name, hidden } = this.common(el, scope.path)
    if (!this.node()) return null
    const styles = this.styles(el, scope.path)
    const has = (k: string): boolean => styles[k] !== undefined && styles[k] !== null
    if (!has('backgroundColor') && !has('background') && !has('backgroundImage')) {
      const color =
        styles['borderTopColor'] ?? styles['borderColor'] ?? styles['color'] ?? '#E5E5E5'
      styles['backgroundColor'] = color === null ? '#E5E5E5' : color
    }
    if (!has('height')) {
      const t = styles['borderTopWidth'] ?? styles['borderWidth']
      styles['height'] = t === null || t === undefined || /^0/.test(String(t)) ? '1px' : t
    }
    for (const k of Object.keys(styles))
      if (k.startsWith('border') && !k.endsWith('Radius')) delete styles[k]
    delete styles['color']
    return { kind: 'frame', name: name ?? 'Frame', styles, hidden, path: scope.path, children: [] }
  }

  formControl(el: Element, scope: Scope): IrNode | null {
    const tag = el.tagName
    const type = (attr(el, 'type') ?? '').toLowerCase()
    if (tag === 'input' && type === 'hidden') return null
    const { name, hidden } = this.common(el, scope.path, new Set(['value', 'placeholder']))
    if (!this.node()) return null
    const styles = this.styles(el, scope.path)
    let text: string | null = null
    let placeholder = false
    if (tag === 'input') {
      if (type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'color') {
        const value = attr(el, 'value')
        if (value !== null && value !== '') text = value
        else {
          const p = attr(el, 'placeholder')
          if (p !== null && p !== '') {
            text = p
            placeholder = true
          }
        }
      }
    } else if (tag === 'textarea') {
      const content = el.childNodes
        .filter(isText)
        .map((t) => t.value)
        .join('')
      if (content !== '') text = content
      else {
        const p = attr(el, 'placeholder')
        if (p !== null && p !== '') {
          text = p
          placeholder = true
        }
      }
    } else {
      const options: Element[] = []
      const stack = [...el.childNodes]
      while (stack.length > 0) {
        const n = stack.shift() as Node
        if (!isElement(n)) continue
        if (n.tagName === 'option') options.push(n)
        else if (n.tagName === 'optgroup') stack.unshift(...n.childNodes)
      }
      const chosen = options.find((o) => attr(o, 'selected') !== null) ?? options[0]
      if (chosen) {
        const t = processWhitespace(
          chosen.childNodes
            .filter(isText)
            .map((c) => c.value)
            .join(''),
          'normal',
        )
        if (t !== '') text = t
      }
    }
    const children: IrNode[] = []
    if (text !== null && this.node()) {
      const childStyles: StylePatch = {}
      if (placeholder && styles['opacity'] === undefined) childStyles['opacity'] = '0.5'
      children.push({
        kind: 'text',
        name: textLayerName(text),
        styles: childStyles,
        hidden: false,
        path: scope.path,
        text: tag === 'textarea' ? text : text.replace(/[\r\n]+/g, ' '),
      })
    }
    return { kind: 'frame', name: name ?? 'Frame', styles, hidden, path: scope.path, children }
  }
}

export { collectCssUrls, collectImageSources } from './sources.ts'

/** Parse write_html input into IR + warnings (contract §7). */
export function parseHtml(html: string, opts: ParseOptions = {}): ParsedHtml {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
  hoistSelfClosing(fragment, html)
  const parser = new Parser(opts)
  const roots = parser.children(fragment, { path: '', depth: 0, ws: 'normal' }, null)
  // A var() of a custom property declared anywhere in the call is not an unknown token.
  const warnings = parser.w.items.filter(
    (w) => w.code !== 'unknown-token' || !parser.declared.has(WARNING_TOKEN.get(w) ?? ''),
  )
  return { roots, warnings, nodeCount: parser.count }
}
