import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  collectCssUrls,
  collectImageSources,
  parseHtml,
  type IrNode,
  type ParsedHtml,
} from '../src/index.ts'

const GUIDE = readFileSync(new URL('../../../docs/phase4/guide.md', import.meta.url), 'utf8')

/** IR without paths, for compact assertions. */
function shape(n: IrNode): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: n.kind, name: n.name }
  if (Object.keys(n.styles).length > 0) out['styles'] = n.styles
  if (n.hidden) out['hidden'] = true
  if (n.kind === 'text') out['text'] = n.text
  if (n.kind === 'frame' && n.children.length > 0) out['children'] = n.children.map(shape)
  if (n.kind === 'image')
    Object.assign(out, { src: n.src, alt: n.alt, attrWidth: n.attrWidth, attrHeight: n.attrHeight })
  if (n.kind === 'clone') out['nodeId'] = n.nodeId
  if (n.kind === 'svg') out['markup'] = n.markup
  return out
}
const roots = (html: string): Record<string, unknown>[] => parseHtml(html).roots.map(shape)
const codes = (p: ParsedHtml): string[] => p.warnings.map((w) => w.code)
const values = (styles: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(styles).filter(([, v]) => v !== null))

describe('element mapping (§7.3)', () => {
  test('text-only elements of any tag become text', () => {
    for (const tag of ['div', 'p', 'h1', 'button', 'li', 'a', 'span', 'label']) {
      expect(parseHtml(`<${tag}>Hello</${tag}>`).roots[0]?.kind).toBe('text')
    }
  })
  test('other elements (including empty ones) become frames', () => {
    expect(roots('<div></div><section><div>x</div></section>')).toEqual([
      { kind: 'frame', name: 'Frame' },
      { kind: 'frame', name: 'Frame', children: [{ kind: 'text', name: 'x', text: 'x' }] },
    ])
  })
  test('<svg> anywhere → sanitised svg; width/height attributes → styles', () => {
    const [svg] = roots(
      '<svg width="24" height="20" viewBox="0 0 24 24" onclick="x()"><script>alert(1)</script><path d="M0 0h24" stroke="red"/></svg>',
    )
    expect(svg).toEqual({
      kind: 'svg',
      name: 'SVG',
      styles: { width: '24px', height: '20px' },
      markup:
        '<svg width="24" height="20" viewBox="0 0 24 24"><path d="M0 0h24" stroke="red"></path></svg>',
    })
  })
  test('svg size: style wins over attributes; viewBox fallback; root style/layer-name not in markup', () => {
    const [a, b] = parseHtml(
      '<svg layer-name="Logo" width="10" style="width: 32px; fill: var(--c)" viewBox="0 0 4 2"><rect width="4" height="2"/></svg><svg viewBox="0 0 40 20"></svg>',
    ).roots
    expect(a).toMatchObject({
      kind: 'svg',
      name: 'Logo',
      styles: { width: '32px', fill: 'var(--c)' },
    })
    expect((a as { markup: string }).markup).not.toMatch(/style=|layer-name/)
    expect(b?.styles).toEqual({ width: '40px', height: '20px' })
  })
  test('<img> → image with src, alt, attribute sizes', () => {
    expect(
      roots('<img src=" /Users/ana/logo.png " alt="Brand logo" width="120" height="40px">'),
    ).toEqual([
      {
        kind: 'image',
        name: 'Brand logo',
        src: '/Users/ana/logo.png',
        alt: 'Brand logo',
        attrWidth: 120,
        attrHeight: 40,
      },
    ])
    expect(parseHtml('<img src="x" width="50%">').roots[0]).toMatchObject({
      name: null,
      attrWidth: null,
    })
  })
  test('<hr> → 1px frame coloured from its border colour (default #E5E5E5)', () => {
    const p = parseHtml(
      '<hr><hr style="border: none; border-top: 2px solid #ddd"><hr style="height: 4px; background: red">',
    )
    expect(p.roots.map((r) => values(r.styles))).toEqual([
      { backgroundColor: '#E5E5E5', height: '1px' },
      { backgroundColor: '#ddd', height: '2px' },
      { backgroundColor: 'red', height: '4px' },
    ])
    expect(p.roots.every((r) => r.kind === 'frame' && r.children.length === 0)).toBe(true)
  })
  test('<input>, <textarea>, <select> → frame with a text child', () => {
    const p = parseHtml(
      '<input style="padding: 8px" placeholder="Email"><input value="ana@x.io"><textarea>Line 1\n  Line 2</textarea><select><option>One</option><option selected>Two</option></select><input type="hidden" value="x"><input type="checkbox">',
    )
    expect(p.roots.map(shape)).toEqual([
      {
        kind: 'frame',
        name: 'Frame',
        styles: { padding: '8px' },
        children: [{ kind: 'text', name: 'Email', styles: { opacity: '0.5' }, text: 'Email' }],
      },
      {
        kind: 'frame',
        name: 'Frame',
        children: [{ kind: 'text', name: 'ana@x.io', text: 'ana@x.io' }],
      },
      {
        kind: 'frame',
        name: 'Frame',
        children: [{ kind: 'text', name: 'Line 1', text: 'Line 1\n  Line 2' }],
      },
      { kind: 'frame', name: 'Frame', children: [{ kind: 'text', name: 'Two', text: 'Two' }] },
      { kind: 'frame', name: 'Frame' },
    ])
    expect(p.nodeCount).toBe(9)
  })
  test('tables → flex frames, warning once', () => {
    const p = parseHtml(
      '<table><tbody><tr><td>A</td><th>B</th></tr><tr><td>C</td><td>D</td></tr></tbody></table>',
    )
    const table = p.roots[0] as Extract<IrNode, { kind: 'frame' }>
    expect(table.styles).toEqual({ display: 'flex', flexDirection: 'column' })
    const tbody = table.children[0] as Extract<IrNode, { kind: 'frame' }>
    expect(tbody.styles).toEqual({ display: 'flex', flexDirection: 'column' })
    const tr = tbody.children[0] as Extract<IrNode, { kind: 'frame' }>
    expect(tr.styles).toEqual({ display: 'flex' })
    expect(tr.children.map(shape)).toEqual([
      { kind: 'text', name: 'A', text: 'A' },
      { kind: 'text', name: 'B', styles: { fontWeight: 700 }, text: 'B' },
    ])
    expect(codes(p)).toEqual(['table-as-flex'])
  })
  test('dropped elements', () => {
    const p = parseHtml(
      '<script>x()</script><style>.a{}</style><link rel="x"><meta charset="utf-8"><iframe src="x"></iframe><video></video><audio></audio><canvas></canvas><noscript>x</noscript><object></object><embed><slot></slot><dialog>x</dialog><template><div>x</div></template><div>kept</div>',
    )
    expect(p.roots.map(shape)).toEqual([{ kind: 'text', name: 'kept', text: 'kept' }])
    expect(codes(p).filter((c) => c === 'unsupported-element')).toHaveLength(13)
    expect(codes(p)).toContain('stylesheet-ignored')
  })
  test('ul/ol → frames, list-markers-dropped once', () => {
    const p = parseHtml(
      '<ul style="display:flex;flex-direction:column"><li>a</li><li>b</li></ul><ol><li>c</li></ol>',
    )
    expect(p.roots.map((r) => r.kind)).toEqual(['frame', 'frame'])
    expect(codes(p).filter((c) => c === 'list-markers-dropped')).toHaveLength(1)
  })
  test('comments, doctype and html/head/body wrappers are dropped', () => {
    expect(
      roots('<!DOCTYPE html><html><head></head><body><!-- hi --><p>x</p></body></html>'),
    ).toEqual([{ kind: 'text', name: 'x', text: 'x' }])
  })
})

describe('clones (§7.5)', () => {
  test('styles, layer-name, trimmed node-id; children ignored with a warning', () => {
    const p = parseHtml(
      '<x-baren-clone node-id="1@2" style="width: 100px" layer-name="Copy"></x-baren-clone><x-baren-clone node-id=" 3@4 "><span>x</span></x-baren-clone>',
    )
    expect(p.roots.map(shape)).toEqual([
      { kind: 'clone', name: 'Copy', styles: { width: '100px' }, nodeId: '1@2' },
      { kind: 'clone', name: null, nodeId: '3@4' },
    ])
    expect(codes(p)).toEqual(['clone-children-ignored'])
  })
  test('self-closing clones (and divs) do not swallow their siblings', () => {
    const p = parseHtml(
      '<div style="display:flex"><x-baren-clone node-id="a" /><x-baren-clone node-id="b" /><div style="width:4px;height:4px" /><p>after</p></div>',
    )
    const frame = p.roots[0] as Extract<IrNode, { kind: 'frame' }>
    expect(frame.children.map((c) => c.kind)).toEqual(['clone', 'clone', 'frame', 'text'])
    expect(codes(p)).toEqual([])
  })
  test('missing node-id', () => {
    const p = parseHtml('<x-baren-clone></x-baren-clone>')
    expect(p.roots).toEqual([])
    expect(codes(p)).toEqual(['clone-not-found'])
  })
})

describe('text (§7.4)', () => {
  test('whitespace collapses and trims; <br> newlines stay', () => {
    expect(parseHtml('<p>\n   Hello\t\t world  \n</p>').roots[0]).toMatchObject({
      text: 'Hello world',
    })
    expect(parseHtml('<p>Line one <br>\n   Line two<br/><br>end</p>').roots[0]).toMatchObject({
      text: 'Line one\nLine two\n\nend',
    })
  })
  test('pre / pre-wrap / break-spaces keep whitespace; pre-line keeps newlines only', () => {
    expect(parseHtml('<p style="white-space: pre-wrap">  a  b\n c </p>').roots[0]).toMatchObject({
      text: '  a  b\n c ',
    })
    expect(
      parseHtml('<p style="white-space: pre-line">  a   b\n   c  </p>').roots[0],
    ).toMatchObject({ text: 'a b\nc' })
    expect(parseHtml('<div style="white-space: pre"><p>  x  </p></div>').roots[0]).toMatchObject({
      children: [{ text: '  x  ' }],
    })
  })
  test('<pre>: leading newline removed, whiteSpace pre and JetBrains Mono added', () => {
    const [pre] = parseHtml('<pre>\nconst a = 1\n  return a\n</pre>').roots
    expect(pre).toMatchObject({
      kind: 'text',
      text: 'const a = 1\n  return a\n',
      styles: { fontFamily: 'JetBrains Mono', whiteSpace: 'pre' },
    })
    expect(
      parseHtml('<pre style="white-space: pre-wrap; font-family: Menlo">x</pre>').roots[0]?.styles,
    ).toEqual({
      whiteSpace: 'pre-wrap',
      fontFamily: 'Menlo',
    })
  })
  test('entities are decoded', () => {
    expect(parseHtml('<p>Tom &amp; Jerry &lt;3 &nbsp;&#x2014; &copy;</p>').roots[0]).toMatchObject({
      text: 'Tom & Jerry <3  — ©',
    })
  })
  test('UA defaults only when not set inline; b/strong only as the text element itself', () => {
    const p = parseHtml(
      '<h1>T</h1><h3 style="font-weight: 500">U</h3><strong>S</strong><em>E</em><u>U</u><del>D</del><code>c</code><p>Hi <b>you</b></p>',
    )
    expect(p.roots.map((r) => r.styles)).toEqual([
      { fontWeight: 700 },
      { fontWeight: 500 },
      { fontWeight: 700 },
      { fontStyle: 'italic' },
      { textDecoration: 'underline' },
      { textDecoration: 'line-through' },
      { fontFamily: 'JetBrains Mono' },
      {},
    ])
    expect(p.roots[7]).toMatchObject({ text: 'Hi you' })
    expect(p.warnings.map((w) => [w.code, w.path])).toEqual([['rich-text-flattened', 'p[8]']])
  })
  test('rich text: styled spans are flattened with a warning; plain spans and links are not', () => {
    expect(codes(parseHtml('<p>Read <a href="/x">the docs</a> or <span>this</span></p>'))).toEqual(
      [],
    )
    expect(codes(parseHtml('<p>Read <span style="color:red">this</span></p>'))).toEqual([
      'rich-text-flattened',
    ])
  })
  test('text elements never store display: block; display: flex is kept', () => {
    expect(parseHtml('<p style="display:block;color:red">x</p>').roots[0]?.styles).toEqual({
      color: 'red',
    })
    expect(
      parseHtml('<div style="display:flex;align-items:center">x</div>').roots[0],
    ).toMatchObject({
      kind: 'text',
      styles: { display: 'flex', alignItems: 'center' },
    })
  })
  test('mixed content in flex: bare text runs become text children named after their content', () => {
    const [f] = parseHtml(
      '<button style="display:flex;gap:8px"><svg width="16" height="16"></svg> Save   changes <span style="opacity:.5">⌘S</span></button>',
    ).roots
    expect(shape(f as IrNode)).toMatchObject({
      kind: 'frame',
      children: [
        { kind: 'svg' },
        { kind: 'text', name: 'Save changes', text: 'Save changes' },
        { kind: 'text', name: '⌘S', styles: { opacity: '.5' }, text: '⌘S' },
      ],
    })
  })
  test('mixed content outside flex warns block-flow', () => {
    const p = parseHtml('<div>Intro <img src="a.png"> outro</div>')
    expect((p.roots[0] as Extract<IrNode, { kind: 'frame' }>).children.map((c) => c.kind)).toEqual([
      'text',
      'image',
      'text',
    ])
    expect(codes(p)).toEqual(['block-flow'])
    expect(codes(parseHtml('<div><p>a</p><p style="position:absolute">b</p></div>'))).toEqual([])
  })
  test('hidden descendants of a text element are left out', () => {
    expect(parseHtml('<p>Visible<span hidden> secret</span></p>').roots[0]).toMatchObject({
      text: 'Visible',
    })
  })
})

describe('attributes and names', () => {
  test('layer-name / data-layer-name, hidden, class warns once, unknown attributes warn', () => {
    const p = parseHtml(
      '<div layer-name="Hero" class="a" hidden style="display:flex"><p data-layer-name="Title" class="b">x</p><div align="center" id="x" aria-label="y" data-x="1" onclick="z"></div></div>',
    )
    const hero = p.roots[0] as Extract<IrNode, { kind: 'frame' }>
    expect(hero.name).toBe('Hero')
    expect(hero.hidden).toBe(true)
    expect(hero.children[0]?.name).toBe('Title')
    expect(p.warnings.map((w) => [w.code, w.property ?? null])).toEqual([
      ['class-ignored', null],
      ['attribute-ignored', 'align'],
    ])
  })
  test('names: text first line ≤ 50 chars; frame/svg/image defaults; truncation', () => {
    const long = 'x'.repeat(80)
    const p = parseHtml(
      `<p>\n  ${long}<br>second</p><div layer-name="${'n'.repeat(60)}"></div><svg></svg><img src="a.png"><img src="b.png" alt="Alt">`,
    )
    expect(p.roots.map((r) => r.name)).toEqual(['x'.repeat(50), 'n'.repeat(50), 'SVG', null, 'Alt'])
  })
  test('paths are 1-based among element siblings', () => {
    const p = parseHtml(
      '<div style="display:flex"><p>a</p><div style="display:flex"><img src="x" style="colour: red"></div></div><p style="bogus: 1">c</p>',
    )
    expect(p.warnings.map((w) => w.path)).toEqual(['div[1] > div[2] > img[1]', 'p[2]'])
  })
})

describe('tokens', () => {
  test('custom properties declared anywhere in the call are not unknown tokens', () => {
    const p = parseHtml(
      '<div style="--a: red; display: flex"><p style="color: var(--a)">x</p><p style="color: var(--b); background: var(--c)">y</p></div><div style="--b: 1px"></div>',
      { tokens: { '--known': { type: 'color', value: '#000' } } },
    )
    expect(p.warnings.map((w) => [w.code, w.property])).toEqual([['unknown-token', 'background']])
    expect(p.warnings[0]?.message).toContain('--c')
  })
  test('without file tokens no unknown-token warnings', () => {
    expect(parseHtml('<p style="color: var(--x)">x</p>').warnings).toEqual([])
  })
})

describe('limits', () => {
  test('nesting deeper than 64 levels is dropped with one warning', () => {
    const html = '<div style="display:flex">'.repeat(80) + 'x' + '</div>'.repeat(80)
    const p = parseHtml(html)
    expect(codes(p)).toEqual(['depth-limit'])
    let depth = 0
    let n: IrNode | undefined = p.roots[0]
    while (n && n.kind === 'frame') {
      depth++
      n = n.children[0]
    }
    expect(depth).toBe(64)
  })
  test('nodeCount counts every created node; maxNodes stops conversion', () => {
    const html = '<div>' + '<p>x</p>'.repeat(30) + '</div>'
    expect(parseHtml(html).nodeCount).toBe(31)
    const capped = parseHtml(html, { maxNodes: 10 })
    expect(capped.nodeCount).toBeGreaterThan(10)
  })
})

describe('guide.md HTML', () => {
  const blocks = [...GUIDE.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1] as string)
  test('the guide has the status bar and home indicator blocks', () => {
    expect(blocks).toHaveLength(2)
  })
  test.each(blocks.map((b, i) => [i, b]))('block %i parses with zero warnings', (_i, html) => {
    const p = parseHtml(html as string)
    expect(p.warnings).toEqual([])
    expect(p.roots).toHaveLength(1)
  })
  test('status bar structure', () => {
    const [bar] = parseHtml(blocks[0] as string).roots
    expect(shape(bar as IrNode)).toMatchObject({
      kind: 'frame',
      name: 'Status bar',
      styles: {
        display: 'flex',
        height: '54px',
        paddingTop: '0',
        paddingRight: '28px',
        paddingBottom: '0',
        paddingLeft: '36px',
        flexShrink: '0',
        color: '#000000',
      },
      children: [
        {
          kind: 'text',
          name: 'Time',
          text: '9:41',
          styles: {
            fontFamily: 'Inter',
            fontSize: '17px',
            fontWeight: 600,
            lineHeight: '22px',
            letterSpacing: '-0.02em',
          },
        },
        {
          kind: 'frame',
          name: 'Indicators',
          children: [
            { kind: 'svg', name: 'Signal', styles: { width: '18px', height: '12px' } },
            { kind: 'svg', name: 'Wi-Fi' },
            { kind: 'svg', name: 'Battery' },
          ],
        },
      ],
    })
  })
})

describe('collectImageSources / collectCssUrls (§4.8)', () => {
  test('img src and url() in style attributes, deduped, in document order', () => {
    const html = `<div style="background: url('/a.png') center/cover"><img src="/b.png"><span style="background-image: url(/a.png), url(&quot;https://x.io/c.jpg&quot;)">t</span><x-baren-clone node-id="1" style="background-image:url(data:image/png;base64,AAAA)"/><img src="file:///Users/ana/d.png"><svg><image href="data:image/png;base64,BBBB"/></svg><img src=""></div>`
    expect(collectImageSources(html)).toEqual([
      '/a.png',
      '/b.png',
      'https://x.io/c.jpg',
      'data:image/png;base64,AAAA',
      'file:///Users/ana/d.png',
    ])
  })
  test('collectCssUrls', () => {
    expect(
      collectCssUrls({
        backgroundImage: 'url("/a.png"), url(/b.png)',
        background: "url('/a.png')",
        maskImage: null,
        clipPath: 'url(#c)',
        width: 4,
      }),
    ).toEqual(['/a.png', '/b.png'])
  })
})
