/**
 * Robustness: malformed, hostile and random HTML never throws (except the documented
 * `HtmlApplyError`s), never stores unsafe CSS, external urls or unsanitised SVG, and always
 * leaves a document that passes the schema invariants.
 */
import { describe, expect, test } from 'vitest'
import type { LoroDoc } from 'loro-crdt'
import { createNode, sanitizeSvgMarkup, toSnapshot, type DesignNode } from '@baren/schema'
import { HtmlApplyError, normalizeStyles, parseHtml, toJsx } from '../src/index.ts'
import { isSafeCssValue } from '../src/css/safe.ts'
import { checkInvariants, resolved, seeded, setup, write } from './helpers.ts'
import { jsxToHtml } from './jsxToHtml.ts'

function board(doc: LoroDoc, pageId: string): string {
  return createNode(doc, {
    type: 'frame',
    parentId: pageId,
    styles: {
      left: 0,
      top: 0,
      width: '800px',
      height: '600px',
      display: 'flex',
      flexDirection: 'column',
    },
  })
}

/** Every stored node is safe to render. */
function assertSafe(doc: LoroDoc): void {
  expect(checkInvariants(doc)).toEqual([])
  for (const n of Object.values(toSnapshot(doc).nodes) as DesignNode[]) {
    expect(Array.from(n.name).length).toBeLessThanOrEqual(50)
    for (const [k, v] of Object.entries(n.styles)) {
      if (typeof v === 'number') {
        expect(Number.isFinite(v)).toBe(true)
        continue
      }
      expect(isSafeCssValue(v), `${k}: ${v}`).toBe(true)
      for (const m of v.matchAll(/url\(\s*["']?([^"')]*)/gi)) {
        const src = (m[1] as string).trim()
        expect(src.startsWith('baren-asset://') || src.startsWith('#'), `${k}: ${v}`).toBe(true)
      }
    }
    if (n.svg !== undefined) {
      expect(sanitizeSvgMarkup(n.svg)).toBe(n.svg)
      expect(n.svg).not.toMatch(/<script|\son\w+=|javascript:|<foreignObject|<style/i)
    }
    if (n.text !== undefined) expect(n.text).not.toContain('\u0000')
  }
}

function attempt(html: string): void {
  const { doc, pageId } = setup()
  const b = board(doc, pageId)
  try {
    const r = write(doc, html, b)
    for (const id of r.created) {
      const jsx = toJsx(resolved(doc, id), id, { format: 'inline-styles', tokens: {} })
      expect(() => parseHtml(jsxToHtml(jsx))).not.toThrow()
      toJsx(resolved(doc, id), id, { format: 'tailwind', tokens: {} })
    }
  } catch (e) {
    if (!(e instanceof HtmlApplyError)) throw e
    expect(e.code).toBe('too_large')
  }
  assertSafe(doc)
}

const MALFORMED = [
  '',
  '   ',
  '<',
  '<<<>>>',
  '<div',
  '<div style="color: red">unclosed',
  '<div><p>a</div></p><span>',
  '</div></div>text after closers',
  '<div style=color:red;width:10px>unquoted</div>',
  `<div style="color: 'red; width: 10px">quote soup</div>`,
  '<div style="background: url(">broken url</div>',
  '<div style="width: calc(100% - (4px">paren soup</div>',
  '<p>&notanentity; &#xZZ; &#99999999; &amp</p>',
  '<p>null\u0000byte</p>',
  '<!-- unclosed comment <div>',
  '<![CDATA[ x ]]><div>after cdata</div>',
  '<svg><path d="M0 0"><svg><g></svg>',
  '<svg onload="alert(1)"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(1)"><path/></a><image href="https://evil.example/x.png"/><use href="https://evil.example/s.svg#a"/></svg>',
  '<svg><style>@import url(https://evil.example)</style><rect style="fill: url(https://evil.example/p.svg#x)"/></svg>',
  '<img src="javascript:alert(1)"><img src=""><img><img src="data:text/html,<script>alert(1)</script>">',
  '<div style="background-image: url(javascript:alert(1)); behavior: url(x.htc); -moz-binding: url(x)"></div>',
  '<div style="width: expression(alert(1)); color: red !important; --x: };">x</div>',
  '<div style="background: url(https://example.com/a.png), url(&quot;/b.png&quot;)">x</div>',
  '<x-baren-clone node-id="1@1"><x-baren-clone node-id="2@2">',
  '<x-baren-clone node-id="<script>">',
  '<table><td>stray cell<tr><th>head</table>',
  '<select><option>a<option selected>b</select><textarea>  raw <b>text</b></textarea>',
  '<input value="a" placeholder="b"><input type="hidden">',
  '<pre>\n\n  two newlines</pre>',
  '<div style="display: flex">a<span>b</span>c<br>d</div>',
  '<p style="white-space: pre-line">a\n\n\n b</p>',
  `<div layer-name="${'x'.repeat(10_000)}" style="${'color: red;'.repeat(2000)}">big</div>`,
  `<p>${'🙂'.repeat(100)}</p>`,
  '<div hidden><p hidden>hidden</p></div>',
  '<math><mi>x</mi></math><svg><math></math></svg>',
  '<frameset><frame></frameset><body><p>x</p></body>',
  '<template><p>t</p></template><slot>s</slot>',
  '<div style="position: fixed; inset: 0; z-index: 99999">overlay</div>',
  '<div style="display: table-cell; list-style: none; grid-area: 1 / 2">x</div>',
  '<div style="font: 12px/; font: bold; font: menu">x</div>',
  '<div style="border: 1px solid; border-radius: 1px 2px 3px 4px 5px; padding: 1px 2px 3px 4px 5px">x</div>',
  '<div style="flex: 1 2 3 4; flex-flow: sideways; place-items: a b c">x</div>',
  '<div style="rotate: 1e309deg; width: 1e309px; opacity: NaN">x</div>',
]

describe('malformed and hostile HTML', () => {
  test.each(MALFORMED.map((h, i) => [i, h]))('case %i', (_i, html) => {
    attempt(html as string)
  })
  test('deep nesting (10,000 levels) is bounded', () => {
    const html = '<div>'.repeat(10_000) + 'x' + '</div>'.repeat(10_000)
    const t0 = performance.now()
    const p = parseHtml(html)
    expect(p.warnings.map((w) => w.code)).toContain('depth-limit')
    expect(performance.now() - t0).toBeLessThan(5000)
    attempt(html)
  })
  test('deeply nested phrasing inside a text element', () => {
    attempt('<p>' + '<span>'.repeat(5000) + 'deep' + '</span>'.repeat(5000) + '</p>')
  })
  test('very wide (6,000 siblings) is refused as too_large without writing', () => {
    attempt('<div style="display:flex">' + '<i></i>'.repeat(6000) + '</div>')
  })
  test('1 MB of text', () => {
    attempt(`<p>${'lorem ipsum '.repeat(90_000)}</p>`)
  })
})

describe('random tag soup (seeded)', () => {
  const TAGS = [
    'div',
    'p',
    'span',
    'b',
    'img',
    'svg',
    'path',
    'ul',
    'li',
    'table',
    'tr',
    'td',
    'button',
    'input',
    'x-baren-clone',
    'pre',
    'br',
    'hr',
    'a',
    'script',
    'style',
    'section',
    'h1',
    'select',
    'option',
    'textarea',
    'g',
    'text',
  ]
  const PROPS = [
    'color',
    'background',
    'padding',
    'margin',
    'display',
    'flex',
    'gap',
    'border',
    'border-radius',
    'width',
    'height',
    'position',
    'left',
    'top',
    'font',
    'font-size',
    'transform',
    'rotate',
    'white-space',
    'background-image',
    'inset',
    'outline',
    'overflow',
    'grid-template-columns',
    'cursor',
    'unknown-prop',
    '--var',
    'list-style',
  ]
  const VALUES = [
    'red',
    '#fff',
    '1px',
    '2rem',
    '1px solid red',
    'flex',
    'grid',
    'absolute',
    'fixed',
    '1 0 auto',
    'url(/a.png)',
    'url(javascript:x)',
    'var(--x)',
    'calc(1px + (2px',
    'none',
    '10px 20px 30px',
    'pre',
    'expression(1)',
    '"quoted;value"',
    'linear-gradient(red, blue)',
    '45deg',
    'inherit',
    '',
    '}',
    '<b>',
  ]
  const TEXT = [
    'hello',
    ' ',
    '\n',
    '&amp;',
    '&lt;',
    '<',
    '>',
    '{',
    '}',
    '"',
    "'",
    '🙂',
    'a  b',
    '\t',
  ]
  function soup(rand: () => number, budget: number): string {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
    let out = ''
    const open: string[] = []
    for (let i = 0; i < budget; i++) {
      const r = rand()
      if (r < 0.35) {
        const tag = pick(TAGS)
        let attrs = ''
        if (rand() < 0.6) {
          const n = 1 + Math.floor(rand() * 4)
          const decls = Array.from({ length: n }, () => `${pick(PROPS)}: ${pick(VALUES)}`).join(
            '; ',
          )
          attrs += ` style="${decls.replace(/"/g, '&quot;')}"`
        }
        if (rand() < 0.2) attrs += ` layer-name="${pick(TEXT)}"`
        if (rand() < 0.1) attrs += ' class="c" hidden'
        if (tag === 'img')
          attrs += ` src="${pick(['/Users/ana/brand/logo.png', 'nope.png', '', 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E'])}"`
        if (tag === 'x-baren-clone') attrs += ` node-id="${pick(['1@1', '', 'x'])}"`
        const self = rand() < 0.15
        out += `<${tag}${attrs}${self ? ' /' : ''}>`
        if (!self) open.push(tag)
      } else if (r < 0.6 && open.length > 0) {
        const tag = rand() < 0.85 ? (open.pop() as string) : pick(TAGS)
        out += `</${tag}>`
      } else out += pick(TEXT)
    }
    return out
  }
  test.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %i', (seed) => {
    const rand = seeded(seed * 7919)
    attempt(soup(rand, 40 + Math.floor(rand() * 300)))
  })
  test('random style strings never throw and never produce unsafe values', () => {
    const rand = seeded(42)
    const chars = 'abc-:;()"\' #/!{}<>\\\n,.0123456789pxremurl'
    for (let i = 0; i < 2000; i++) {
      let s = ''
      const len = Math.floor(rand() * 80)
      for (let j = 0; j < len; j++) s += chars[Math.floor(rand() * chars.length)]
      const r = normalizeStyles(s, { tokens: {} })
      for (const v of Object.values(r.styles)) {
        if (typeof v === 'string')
          expect(isSafeCssValue(v.replace(/url\([^)]*\)/g, 'url()'))).toBe(true)
      }
    }
  })
})
