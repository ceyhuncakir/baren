/**
 * Test helper: turn the JSX `toJsx` prints (inline-styles format) back into HTML, with React's
 * semantics (style objects with px for non-unitless numbers, JSX whitespace rules, `{'…'}`
 * string expressions, `className` / camelCase SVG attributes back to their HTML names).
 */
import { cssDeclarationValue, cssPropertyName } from '@baren/schema'

/** SVG attributes that are camelCase in SVG itself (everything else camelCase → kebab). */
const SVG_CAMEL = new Set([
  'viewBox', 'preserveAspectRatio', 'pathLength', 'gradientUnits', 'gradientTransform',
  'spreadMethod', 'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits',
  'maskUnits', 'maskContentUnits', 'filterUnits', 'primitiveUnits', 'markerWidth', 'markerHeight',
  'markerUnits', 'refX', 'refY', 'textLength', 'lengthAdjust', 'startOffset', 'stdDeviation',
  'tableValues', 'kernelMatrix', 'targetX', 'targetY', 'edgeMode', 'kernelUnitLength',
  'preserveAlpha', 'surfaceScale', 'diffuseConstant', 'specularConstant', 'specularExponent',
  'baseFrequency', 'numOctaves', 'stitchTiles', 'xChannelSelector', 'yChannelSelector',
  'pointsAtX', 'pointsAtY', 'pointsAtZ', 'limitingConeAngle',
]) // prettier-ignore

const escText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function htmlAttrName(name: string, svg: boolean): string {
  if (name === 'className') return 'class'
  if (name === 'xlinkHref') return 'xlink:href'
  if (name === 'xmlnsXlink') return 'xmlns:xlink'
  if (!svg || SVG_CAMEL.has(name) || name.startsWith('data-') || name.startsWith('aria-'))
    return name
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

class Reader {
  i = 0
  readonly s: string
  constructor(s: string) {
    this.s = s
  }
  peek(n = 1): string {
    return this.s.slice(this.i, this.i + n)
  }
  ws(): void {
    while (/\s/.test(this.s[this.i] ?? '')) this.i++
  }
  expect(t: string): void {
    if (!this.s.startsWith(t, this.i))
      throw new Error(`expected ${t} at ${this.i}: ${this.s.slice(this.i, this.i + 40)}`)
    this.i += t.length
  }
  name(): string {
    const m = /^[A-Za-z_$][\w$:.-]*/.exec(this.s.slice(this.i))
    if (!m) throw new Error(`name expected at ${this.i}`)
    this.i += m[0].length
    return m[0]
  }
  ident(): string {
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i))
    if (!m) throw new Error(`identifier expected at ${this.i}`)
    this.i += m[0].length
    return m[0]
  }
  /** A single-quoted JS string literal. */
  jsString(): string {
    this.expect("'")
    let out = ''
    for (;;) {
      const c = this.s[this.i++]
      if (c === undefined) throw new Error('unterminated string')
      if (c === "'") return out
      if (c === '\\') {
        const e = this.s[this.i++]
        out += e === 'n' ? '\n' : e === 'r' ? '\r' : (e as string)
      } else out += c
    }
  }
  /** `{{ key: 'v', key2: 12 }}` → CSS text. */
  styleObject(): string {
    this.expect('{{')
    const decls: string[] = []
    for (;;) {
      this.ws()
      if (this.peek(2) === '}}') {
        this.i += 2
        return decls.join('; ')
      }
      const key = this.peek() === "'" ? this.jsString() : this.ident()
      this.ws()
      this.expect(':')
      this.ws()
      let value: string | number
      if (this.peek() === "'") value = this.jsString()
      else {
        const m = /^-?[\d.]+(?:e[+-]?\d+)?/.exec(this.s.slice(this.i)) as RegExpExecArray
        this.i += m[0].length
        value = Number(m[0])
      }
      decls.push(`${cssPropertyName(key)}: ${cssDeclarationValue(key, value)}`)
      this.ws()
      if (this.peek() === ',') this.i++
    }
  }
}

function jsxTextToString(raw: string): string {
  // JSX: lines are trimmed (leading on all but the first, trailing on all but the last),
  // empty lines dropped, the rest joined with a space.
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  lines.forEach((line, i) => {
    let l = line
    if (i > 0) l = l.replace(/^\s+/, '')
    if (i < lines.length - 1) l = l.replace(/\s+$/, '')
    if (l !== '') out.push(l)
  })
  return out.join(' ')
}

function element(r: Reader, svg: boolean): string {
  r.expect('<')
  const tag = r.name()
  const inSvg = svg || tag === 'svg'
  let attrs = ''
  for (;;) {
    r.ws()
    if (r.peek(2) === '/>') {
      r.i += 2
      return tag === 'img' ? `<img${attrs}>` : `<${tag}${attrs}></${tag}>`
    }
    if (r.peek() === '>') {
      r.i++
      break
    }
    const name = r.name()
    r.expect('=')
    let value: string
    if (r.peek(2) === '{{' && name === 'style') value = r.styleObject()
    else if (r.peek(2) === "{'") {
      r.i++
      value = r.jsString()
      r.expect('}')
    } else {
      r.expect('"')
      const end = r.s.indexOf('"', r.i)
      value = r.s.slice(r.i, end)
      r.i = end + 1
    }
    attrs += ` ${htmlAttrName(name, inSvg)}="${escAttr(value)}"`
  }
  let inner = ''
  let text = ''
  const flush = (): void => {
    if (text !== '') inner += escText(jsxTextToString(text))
    text = ''
  }
  for (;;) {
    if (r.peek(2) === '</') {
      flush()
      r.i += 2
      r.expect(tag)
      r.expect('>')
      return `<${tag}${attrs}>${inner}</${tag}>`
    }
    if (r.peek(2) === "{'") {
      flush()
      r.i++
      inner += escText(r.jsString())
      r.expect('}')
      continue
    }
    if (r.peek(6) === '<br />') {
      flush()
      r.i += 6
      inner += '<br>'
      continue
    }
    if (r.peek() === '<') {
      flush()
      inner += element(r, inSvg)
      continue
    }
    text += r.s[r.i++]
  }
}

/** `(\n    <div …>…</div>\n  )` → HTML. */
export function jsxToHtml(jsx: string): string {
  const r = new Reader(jsx.trim())
  r.expect('(')
  r.ws()
  const html = element(r, false)
  r.ws()
  r.expect(')')
  return html
}
