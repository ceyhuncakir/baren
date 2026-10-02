/**
 * Allowlist sanitizer for SVG markup stored in `svg` nodes. The document is
 * shared with remote collaborators, so markup is untrusted: scripts, event
 * handlers, foreign content, external references and <style> (which would
 * leak into the whole page) are removed.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'symbol',
  'use',
  'marker',
  'title',
  'desc',
  'image',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
])

const SAFE_IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i

function compact(value: string): string {
  // Browsers ignore whitespace/control chars inside URL schemes ("java\nscript:").
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000- ]+/g, '').toLowerCase()
}

/** url(...) references are only allowed to point inside the SVG (url(#id)). */
function hasExternalUrl(value: string): boolean {
  const re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi
  for (let m = re.exec(value); m !== null; m = re.exec(value)) {
    const target = (m[2] ?? '').trim()
    if (!target.startsWith('#')) return true
  }
  return false
}

function isSafeAttribute(el: Element, name: string, value: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('on')) return false
  const c = compact(value)
  if (c.includes('javascript:') || c.includes('vbscript:') || c.includes('data:text/html'))
    return false
  if (lower === 'href' || lower === 'xlink:href') {
    const v = value.trim()
    if (v.startsWith('#')) return true
    return el.localName === 'image' && SAFE_IMAGE_DATA.test(v)
  }
  if (lower === 'style') {
    if (c.includes('expression(') || c.includes('@import') || c.includes('behavior:')) return false
    return !hasExternalUrl(value)
  }
  if (value.includes('url(')) return !hasExternalUrl(value)
  return true
}

function sanitizeElement(el: Element): void {
  for (const child of Array.from(el.children)) {
    if (child.namespaceURI !== SVG_NS || !ALLOWED_TAGS.has(child.localName)) {
      child.remove()
      continue
    }
    sanitizeElement(child)
  }
  for (const attr of Array.from(el.attributes)) {
    if (!isSafeAttribute(el, attr.name, attr.value))
      el.removeAttributeNS(attr.namespaceURI, attr.localName)
  }
  // Drop processing instructions / comments; keep text (for <text>, <title>).
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== 1 && node.nodeType !== 3) node.remove()
  }
}

let parser: DOMParser | null = null

/**
 * Parse and sanitize `markup`. Returns a detached, sanitized <svg> element
 * (owned by the current document) or null when the markup is not an SVG.
 */
export function sanitizeSvg(markup: string): SVGSVGElement | null {
  parser ??= new DOMParser()
  const parsed = parser.parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null
  if (parsed.getElementsByTagName('parsererror').length > 0) return null
  sanitizeElement(root)
  const imported = document.importNode(root, true)
  return imported as unknown as SVGSVGElement
}

/**
 * Sanitize SVG markup for storing in a document (SVG files dropped or picked as images).
 * Returns the cleaned markup and its intrinsic size (width/height attributes in px, else
 * the viewBox), or null when `markup` is not an SVG.
 */
export function sanitizeSvgMarkup(
  markup: string,
): { markup: string; width: number | null; height: number | null } | null {
  const svg = sanitizeSvg(markup)
  if (!svg) return null
  const len = (name: string): number | null => {
    const v = svg.getAttribute(name)?.trim() ?? ''
    const m = /^(\d+(?:\.\d+)?)(px)?$/.exec(v)
    return m ? Number(m[1]) : null
  }
  let width = len('width')
  let height = len('height')
  const vb = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (
    vb.length === 4 &&
    vb.every(Number.isFinite) &&
    (vb[2] as number) > 0 &&
    (vb[3] as number) > 0
  ) {
    const [, , vw, vh] = vb as [number, number, number, number]
    if (width === null && height === null) {
      width = vw
      height = vh
    } else if (width === null && height !== null) width = (height * vw) / vh
    else if (height === null && width !== null) height = (width * vh) / vw
  }
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', SVG_NS)
  return { markup: new XMLSerializer().serializeToString(svg), width, height }
}

/** Sanitized templates keyed by markup; repeated icons are cloned instead of re-parsed. */
export class SvgCache {
  private readonly cache = new Map<string, SVGSVGElement | null>()

  constructor(private readonly max = 500) {}

  /** A fresh sanitized element for `markup` (a clone of the cached template). */
  get(markup: string): SVGSVGElement | null {
    let tpl = this.cache.get(markup)
    if (tpl === undefined) {
      tpl = sanitizeSvg(markup)
      if (this.cache.size >= this.max) {
        const first = this.cache.keys().next()
        if (!first.done) this.cache.delete(first.value)
      }
      this.cache.set(markup, tpl)
    }
    return tpl ? (tpl.cloneNode(true) as SVGSVGElement) : null
  }
}
