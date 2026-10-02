import { describe, expect, it } from 'vitest'
import {
  createComponent,
  createInstance,
  createNode,
  docGeometry,
  formatCssNumber,
  getNode,
  renderHtml,
  renderSubtreeHtml,
  sanitizeSvgMarkup,
  setPropsAt,
  setTextAt,
  setTokens,
  toRenderSubtree,
} from '../src/index.ts'
import { docWithPage, seeded } from './helpers.ts'

describe('renderHtml', () => {
  it('renders groups, vectors, rotation and resolved instances like the Rust exporter', () => {
    const { doc, pageId } = docWithPage('Doc', 1)
    setTokens(doc, { '--ink': { type: 'color', value: '#141414', description: 'Ink */ </x>' } })
    const card = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Card',
      styles: { left: 0, top: 0, width: 100, height: 50, backgroundColor: 'var(--ink)' },
    })
    const title = createNode(doc, {
      type: 'text',
      parentId: card,
      text: 'Title <1>',
      styles: { fontSize: '24px' },
    })
    const badge = createNode(doc, { type: 'rect', parentId: card, styles: { width: 4, height: 4 } })
    const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(1) })!
    const key = getNode(doc, main)!.componentKey!
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Board',
      styles: { left: 500, top: 100, width: 400, height: 300, rotate: 15 },
    })
    const g = createNode(doc, {
      type: 'group',
      parentId: board,
      styles: { position: 'absolute', left: 10, top: 10, width: 20, height: 20, rotate: '45deg' },
    })
    createNode(doc, {
      type: 'vector',
      parentId: g,
      styles: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 20,
        height: 20,
        fill: 'none',
        stroke: '#000000',
        strokeWidth: 1,
      },
      vector: {
        fillRule: 'evenodd',
        subpaths: [
          {
            id: 'aaaaaaaa',
            closed: true,
            points: [
              { x: 0, y: 0 },
              { x: 20, y: 0 },
              { x: 10, y: 20, in: [5, 0] },
            ],
          },
        ],
      },
    })
    const flowGroup = createNode(doc, {
      type: 'group',
      parentId: board,
      styles: { width: 1, height: 1 },
    })
    createNode(doc, {
      type: 'rect',
      parentId: flowGroup,
      styles: { position: 'absolute', left: 0, top: 0, width: 1, height: 1 },
    })
    const inst = createInstance(doc, {
      componentKey: key,
      parentId: board,
      styles: { position: 'absolute', left: 50, top: 60 },
    })
    setTextAt(doc, `${inst}/${getNode(doc, title)!.nodeKey!}`, 'Hi & bye')
    setPropsAt(doc, `${inst}/${getNode(doc, badge)!.nodeKey!}`, { hidden: true })
    const html = renderHtml(doc, [board], { includeIds: true })
    const kTitle = getNode(doc, title)!.nodeKey!
    expect(html).toBe(
      [
        '<style>',
        ':root {',
        '  --ink: #141414; /* Ink * / /x */',
        '}',
        '</style>',
        `<section data-node-id="${board}" style="position: relative; width: 400px; height: 300px; rotate: 15deg">`,
        `  <div data-node-id="${g}" style="position: absolute; top: 10px; left: 10px; width: 20px; height: 20px; rotate: 45deg">`,
        `    <svg data-node-id="${getNode(doc, g)!.children[0]}" width="20" height="20" viewBox="0 0 20 20" overflow="visible" style="position: absolute; top: 0px; left: 0px; width: 20px; height: 20px; fill: none; stroke: #000000; stroke-width: 1"><path d="M 0 0 L 20 0 C 20 0 15 20 10 20 Z" fill-rule="evenodd"/></svg>`,
        '  </div>',
        `  <div data-node-id="${flowGroup}" style="position: relative; width: 1px; height: 1px">`,
        `    <div data-node-id="${getNode(doc, flowGroup)!.children[0]}" style="position: absolute; top: 0px; left: 0px; width: 1px; height: 1px"></div>`,
        '  </div>',
        `  <div data-node-id="${inst}" style="position: absolute; top: 60px; left: 50px; width: 100px; height: 50px; background-color: var(--ink)">`,
        `    <h2 data-node-id="${inst}/${kTitle}" style="margin: 0; font-weight: inherit; font-size: 24px">Hi &amp; bye</h2>`,
        '  </div>',
        '</section>',
        '',
      ].join('\n'),
    )
  })

  it('renders pages, virtual roots and drops images with a null asset URL', () => {
    const { doc, pageId } = docWithPage('Doc', 1)
    createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 100, top: 50, width: 10, height: 10 },
    })
    const img = createNode(doc, {
      type: 'image',
      parentId: pageId,
      assetId: 'a'.repeat(64),
      styles: {
        left: 0,
        top: 0,
        width: 5,
        height: 5,
        backgroundImage: `url("baren-asset://${'b'.repeat(64)}")`,
      },
    })
    const page = renderHtml(doc, [pageId])
    expect(page).toContain(
      '<main style="position: relative; background-color: #EEEEEE; width: 110px; height: 60px">',
    )
    expect(page).toContain(
      `<img src="baren-asset://${'a'.repeat(64)}" alt="Image" style="position: absolute; left: 0px; top: 0px; width: 5px; height: 5px; background-image: url(&quot;baren-asset://${'b'.repeat(64)}&quot;)">`,
    )
    expect(renderHtml(doc, [img], { assetUrl: () => null })).toBe('')
    const sub = toRenderSubtree(doc, pageId)!
    expect(renderSubtreeHtml(sub.nodes, pageId)).toBe(page)
  })

  it('formats numbers like Rust and sanitises SVG like the Rust core', () => {
    expect(formatCssNumber(1e21)).toBe('1000000000000000000000')
    expect(formatCssNumber(1.5e-7)).toBe('0.00000015')
    expect(formatCssNumber(-0)).toBe('0')
    expect(formatCssNumber(2 ** 60)).toBe('1152921504606847000')
    const clean =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="url(#g)"/></svg>'
    expect(sanitizeSvgMarkup(clean)).toBe(clean)
    expect(
      sanitizeSvgMarkup(
        '<?xml version="1.0"?><!DOCTYPE svg><svg onload="alert(1)"><script>alert(2)</script><g><foreignObject><div onclick="x">hi</div></foreignObject><path d="M0 0" onmouseover="alert(3)"/></g><style>@import url(evil.css);</style><!-- c --></svg>',
      ),
    ).toBe('<svg><g><path d="M0 0"/></g></svg>')
    expect(
      sanitizeSvgMarkup(
        '<svg><a href="javascript:alert(1)"><text>x</text></a><use href="#icon"/><use xlink:href="https://evil/x.svg#a"/><image href="data:image/png;base64,AAAA"/><image href="data:image/svg+xml;base64,PHN2Zz4="/><rect fill="url(https://evil/x)" style="fill: url(#ok)"/><rect style="background: url(javas&#99;ript:alert(1))"/></svg>',
      ),
    ).toBe(
      '<svg><use href="#icon"/><use/><image href="data:image/png;base64,AAAA"/><image/><rect style="fill: url(#ok)"/><rect/></svg>',
    )
    expect(
      sanitizeSvgMarkup(
        '<svg><text x="1" font-family="&quot;Inter&quot;">a &lt; b &amp; <![CDATA[<c>]]></text></svg>',
      ),
    ).toBe('<svg><text x="1" font-family="&quot;Inter&quot;">a &lt; b &amp; &lt;c&gt;</text></svg>')
    expect(sanitizeSvgMarkup("<svg><g><path d='M1 1'>")).toBe(
      '<svg><g><path d="M1 1"></path></g></svg>',
    )
    expect(sanitizeSvgMarkup('<svg></svg><script>x</script><svg/>')).toBe('<svg></svg>')
    expect(sanitizeSvgMarkup('<svg><rect width="1"')).toBe('<svg></svg>')
    expect(sanitizeSvgMarkup('<div>hi</div>', 'width: 16px')).toBe(
      '<svg style="width: 16px"></svg>',
    )
    expect(sanitizeSvgMarkup('<svg style="color: red;"><g/></svg>', 'width: 16px')).toBe(
      '<svg style="color: red; width: 16px"><g/></svg>',
    )
    expect(sanitizeSvgMarkup("<SVG VIEWBOX='0 0 1 1'></SVG>")).toBe('<svg viewBox="0 0 1 1"></svg>')
    expect(sanitizeSvgMarkup('<svg><text>1 < 2</text></svg>')).toBe(
      '<svg><text>1 &lt; 2</text></svg>',
    )
  })
})
