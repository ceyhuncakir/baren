/**
 * SVG sanitizer for HTML export — a port of `crates/core/src/export/svg.rs` (same allowlists,
 * same tokenizer, same output). The markup is tokenised and re-serialised from an allowlist:
 * only known presentational elements and attributes survive, entities are decoded and
 * re-escaped, comments/PIs/doctypes are dropped and disallowed elements (`script`, `style`,
 * `foreignObject`, `a`, …) are removed with their subtree. References must be local (`#id`),
 * except raster `data:` images on `<image>`. No DOM needed (runs in workers and Node).
 */

const ELEMENTS = [
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'linearGradient', 'radialGradient',
  'stop', 'clipPath', 'mask', 'pattern', 'marker', 'image', 'filter', 'feBlend', 'feColorMatrix',
  'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
] // prettier-ignore

const ATTRIBUTES = [
  'id', 'class', 'style', 'transform', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
  'rx', 'ry', 'fx', 'fy', 'fr', 'dx', 'dy', 'width', 'height', 'viewBox', 'preserveAspectRatio',
  'points', 'pathLength', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-opacity', 'opacity', 'clip-path', 'clip-rule', 'mask', 'filter',
  'color', 'display', 'visibility', 'overflow', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'filterUnits',
  'primitiveUnits', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
  'marker-start', 'marker-mid', 'marker-end', 'font-family', 'font-size', 'font-weight',
  'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'letter-spacing', 'word-spacing', 'text-decoration', 'rotate', 'textLength', 'lengthAdjust',
  'startOffset', 'xmlns', 'xmlns:xlink', 'version', 'href', 'xlink:href', 'in', 'in2', 'result',
  'stdDeviation', 'mode', 'operator', 'k1', 'k2', 'k3', 'k4', 'values', 'type', 'tableValues',
  'slope', 'intercept', 'amplitude', 'exponent', 'kernelMatrix', 'order', 'divisor', 'bias',
  'targetX', 'targetY', 'edgeMode', 'kernelUnitLength', 'preserveAlpha', 'surfaceScale',
  'diffuseConstant', 'specularConstant', 'specularExponent', 'lighting-color', 'flood-color',
  'flood-opacity', 'baseFrequency', 'numOctaves', 'seed', 'stitchTiles', 'scale',
  'xChannelSelector', 'yChannelSelector', 'radius', 'azimuth', 'elevation', 'pointsAtX',
  'pointsAtY', 'pointsAtZ', 'limitingConeAngle', 'shape-rendering', 'color-interpolation',
  'color-interpolation-filters', 'vector-effect', 'paint-order', 'mix-blend-mode', 'isolation',
  'role', 'aria-hidden', 'aria-label', 'focusable',
] // prettier-ignore

const ELEMENT_BY_LOWER = new Map(ELEMENTS.map((e) => [e.toLowerCase(), e]))
const ATTRIBUTE_BY_LOWER = new Map(ATTRIBUTES.map((a) => [a.toLowerCase(), a]))

const element = (name: string): string | undefined => ELEMENT_BY_LOWER.get(name.toLowerCase())
const attribute = (name: string): string | undefined => ATTRIBUTE_BY_LOWER.get(name.toLowerCase())

export function escapeText(s: string): string {
  if (!/[&<>]/.test(s)) return s
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(s: string): string {
  if (!/[&<>"']/.test(s)) return s
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function decodeOne(name: string): string | null {
  switch (name) {
    case 'amp':
      return '&'
    case 'lt':
      return '<'
    case 'gt':
      return '>'
    case 'quot':
      return '"'
    case 'apos':
      return "'"
    case 'nbsp':
      return ' '
  }
  if (!name.startsWith('#')) return null
  const num = name.slice(1)
  let code: number
  if (num.startsWith('x') || num.startsWith('X')) {
    if (!/^[0-9a-fA-F]+$/.test(num.slice(1))) return null
    code = parseInt(num.slice(1), 16)
  } else {
    if (!/^[0-9]+$/.test(num)) return null
    code = parseInt(num, 10)
  }
  if (!Number.isFinite(code) || code > 0xffffffff) return null
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
  return String.fromCodePoint(code)
}

/** Decode XML entities, `&nbsp;` and numeric references (others are left as-is). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  let out = ''
  let rest = s
  for (let amp = rest.indexOf('&'); amp !== -1; amp = rest.indexOf('&')) {
    out += rest.slice(0, amp)
    rest = rest.slice(amp)
    const end = rest.indexOf(';')
    const decoded = end !== -1 && end <= 12 ? decodeOne(rest.slice(1, end)) : null
    if (decoded !== null) {
      out += decoded
      rest = rest.slice(end + 1)
    } else {
      out += '&'
      rest = rest.slice(1)
    }
  }
  return out + rest
}

/** True when `value` is safe in a `style` attribute or `<style>` block (after escaping). */
export function isSafeCssValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[<>{}\u0000-\u001f\u007f-\u009f]/.test(value)) return false
  const squashed = value.replace(/[\s\\]/g, '').toLowerCase()
  return !['javascript:', 'vbscript:', 'expression(', '@import', 'behavior:', '-moz-binding'].some(
    (bad) => squashed.includes(bad),
  )
}

function attributeValueOk(el: string, name: string, value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const squashed = value.replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '').toLowerCase()
  if (name === 'href' || name === 'xlink:href') {
    const raster = ['png', 'jpeg', 'jpg', 'gif', 'webp', 'avif'].some((t) =>
      squashed.startsWith(`data:image/${t};base64,`),
    )
    return squashed.startsWith('#') || (el === 'image' && raster)
  }
  if (
    squashed.includes('javascript:') ||
    squashed.includes('vbscript:') ||
    squashed.includes('data:')
  ) {
    return false
  }
  let rest = squashed
  for (let i = rest.indexOf('url('); i !== -1; i = rest.indexOf('url(')) {
    rest = rest.slice(i + 4)
    if (!rest.replace(/^["']+/, '').startsWith('#')) return false
  }
  return name !== 'style' || isSafeCssValue(value)
}

type Token =
  | { kind: 'start'; name: string; attrs: [string, string][]; selfClosing: boolean }
  | { kind: 'end'; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'cdata'; text: string }

const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isNameChar = (c: string): boolean => /[A-Za-z0-9:_.-]/.test(c)

function* tokenize(src: string): Generator<Token> {
  let pos = 0
  const nameLen = (from: number): number => {
    let n = 0
    while (from + n < src.length && isNameChar(src[from + n] as string)) n++
    return n
  }
  const skipPast = (pat: string): void => {
    const i = src.indexOf(pat, pos)
    pos = i === -1 ? src.length : i + pat.length
  }
  const skipWs = (): void => {
    while (pos < src.length && isWs(src[pos])) pos++
  }
  const startTag = (): Token | null => {
    pos += 1
    const len = nameLen(pos)
    const name = src.slice(pos, pos + len)
    pos += len
    const attrs: [string, string][] = []
    for (;;) {
      skipWs()
      if (pos >= src.length) return null
      if (src.startsWith('/>', pos)) {
        pos += 2
        return { kind: 'start', name, attrs, selfClosing: true }
      }
      if (src[pos] === '>') {
        pos += 1
        return { kind: 'start', name, attrs, selfClosing: false }
      }
      let len2 = 0
      while (pos + len2 < src.length) {
        const c = src[pos + len2] as string
        if (isWs(c) || c === '=' || c === '>' || c === '/') break
        len2++
      }
      if (len2 === 0) {
        pos += 1
        continue
      }
      const attrName = src.slice(pos, pos + len2)
      pos += len2
      skipWs()
      let value = ''
      if (src[pos] === '=') {
        pos += 1
        skipWs()
        const q = src[pos]
        if (q === '"' || q === "'") {
          const bodyStart = pos + 1
          const end = src.indexOf(q, bodyStart)
          const stop = end === -1 ? src.length : end
          value = src.slice(bodyStart, stop)
          pos = end === -1 ? src.length : end + 1
        } else {
          let end = pos
          while (end < src.length && !isWs(src[end]) && src[end] !== '>') end++
          value = src.slice(pos, end)
          pos = end
        }
      }
      attrs.push([attrName, value])
    }
  }
  while (pos < src.length) {
    if (src[pos] !== '<') {
      const end = src.indexOf('<', pos)
      const stop = end === -1 ? src.length : end
      const text = src.slice(pos, stop)
      pos = stop
      yield { kind: 'text', text }
      continue
    }
    if (src.startsWith('<!--', pos)) {
      skipPast('-->')
      continue
    }
    if (src.startsWith('<![CDATA[', pos)) {
      const bodyStart = pos + 9
      const end = src.indexOf(']]>', bodyStart)
      const text = src.slice(bodyStart, end === -1 ? src.length : end)
      skipPast(']]>')
      yield { kind: 'cdata', text }
      continue
    }
    if (src.startsWith('<!', pos) || src.startsWith('<?', pos)) {
      skipPast('>')
      continue
    }
    if (src.startsWith('</', pos)) {
      const len = nameLen(pos + 2)
      const name = src.slice(pos + 2, pos + 2 + len)
      skipPast('>')
      yield { kind: 'end', name }
      continue
    }
    if (/[A-Za-z]/.test(src[pos + 1] ?? '')) {
      const token = startTag()
      if (!token) {
        pos = src.length
        return
      }
      yield token
      continue
    }
    pos += 1
    yield { kind: 'text', text: '<' }
  }
}

function writeStart(
  el: string,
  attrs: readonly [string, string][],
  extraStyle: string | null,
): string {
  let out = `<${el}`
  let style: string | null = null
  for (const [rawName, rawValue] of attrs) {
    const name = attribute(rawName)
    if (name === undefined) continue
    const value = decodeEntities(rawValue)
    if (!attributeValueOk(el, name, value)) continue
    if (name === 'style') {
      style = value
      continue
    }
    out += ` ${name}="${escapeAttr(value)}"`
  }
  const extra = extraStyle !== null && extraStyle !== '' ? extraStyle : null
  if (style !== null && extra !== null) style = `${style.replace(/[; ]+$/, '')}; ${extra}`
  else style ??= extra
  if (style !== null) out += ` style="${escapeAttr(style)}"`
  return out
}

/** Sanitise `markup` into a single `<svg>` element; `rootStyle` is appended to its style. */
export function sanitizeSvgMarkup(markup: string, rootStyle: string | null = null): string {
  let out = ''
  const open: string[] = []
  let skip: number | null = null
  let rootClosed = false
  for (const token of tokenize(markup)) {
    if (rootClosed) break
    if (skip !== null) {
      if (token.kind === 'start' && !token.selfClosing) skip++
      else if (token.kind === 'end') {
        skip--
        if (skip === 0) skip = null
      }
      continue
    }
    switch (token.kind) {
      case 'start': {
        const canonical = element(token.name)
        const el =
          canonical !== undefined && (open.length > 0 || canonical === 'svg')
            ? canonical
            : undefined
        if (el === undefined) {
          if (!token.selfClosing) skip = 1
          break
        }
        const isRoot = open.length === 0
        out += writeStart(el, token.attrs, isRoot ? rootStyle : null)
        if (token.selfClosing) {
          out += '/>'
          rootClosed = isRoot
        } else {
          out += '>'
          open.push(el)
        }
        break
      }
      case 'end': {
        const el = element(token.name)
        if (el === undefined) break
        const at = open.lastIndexOf(el)
        if (at !== -1) {
          while (open.length > at) out += `</${open.pop() as string}>`
          rootClosed = open.length === 0
        }
        break
      }
      case 'text':
        if (open.length > 0) out += escapeText(decodeEntities(token.text))
        break
      case 'cdata':
        if (open.length > 0) out += escapeText(token.text)
        break
    }
  }
  while (open.length > 0) out += `</${open.pop() as string}>`
  if (out === '') out = `${writeStart('svg', [], rootStyle)}></svg>`
  return out
}

/**
 * `markup` as a standalone SVG file (Copy as SVG, SVG export): sanitised, with the namespace
 * declarations that SVG inlined in HTML may leave out (write_html stores it that way):
 * `xmlns`, and `xmlns:xlink` when an `xlink:` attribute is used. Without them the file is
 * plain XML and SVG viewers show nothing.
 */
export function standaloneSvgMarkup(markup: string): string {
  const clean = sanitizeSvgMarkup(markup)
  // Attribute values are escaped, so the root's start tag ends at the first `>`.
  const root = /^<svg\b[^>]*/.exec(clean)?.[0] ?? ''
  let declarations = ''
  if (!/\sxmlns\s*=/.test(root)) declarations += ' xmlns="http://www.w3.org/2000/svg"'
  if (/\sxlink:[a-z]+\s*=/i.test(clean) && !/\sxmlns:xlink\s*=/.test(root))
    declarations += ' xmlns:xlink="http://www.w3.org/1999/xlink"'
  return `<svg${declarations}${clean.slice('<svg'.length)}`
}
