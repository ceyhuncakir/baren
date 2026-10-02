/**
 * Round trip (contract §14.1): parseHtml(H) → applyHtml → toJsx(inline-styles) → JSX→HTML →
 * parseHtml → applyHtml into a second parent: both subtrees have identical canonical styles,
 * types, names and text (and svg markup / assets). Layer names are stripped from the input
 * first: JSX carries no layer names, so both sides use the default names.
 */
import { describe, expect, test } from 'vitest'
import { createNode, getNode } from '@baren/schema'
import { toJsx } from '../src/index.ts'
import { checkInvariants, resolved, tree, write } from './helpers.ts'
import { TOKENS, fixtureNames, readFixture, runFixture } from './corpus.ts'
import { jsxToHtml } from './jsxToHtml.ts'

describe('write → JSX → write', () => {
  test.each(fixtureNames())('%s', (name) => {
    const source = readFixture(name).replace(/\s(?:data-)?layer-name="[^"]*"/g, '')
    const first = runFixture(source)
    const { doc, pageId } = first
    const second = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Second',
      styles: {
        left: 2000,
        top: 0,
        width: '1440px',
        height: '900px',
        display: 'flex',
        flexDirection: 'column',
      },
    })
    const tops = first.roots.filter(
      (id) => getNode(doc, id)?.parentId === (first.boardId ?? pageId),
    )
    expect(tops.length).toBeGreaterThan(0)
    for (const id of tops) {
      const jsx = toJsx(resolved(doc, id), id, { format: 'inline-styles', tokens: TOKENS })
      const html = jsxToHtml(jsx)
      const r = write(doc, html, second)
      expect(r.created).toHaveLength(1)
      const a = tree(doc, id)
      const b = tree(doc, r.created[0] as string)
      if (first.boardId === null) {
        // Artboards lose their page position in JSX (top-level roots drop left/top).
        expect(b).toEqual({ ...a, styles: a.styles })
      } else expect(b).toEqual(a)
      // A second JSX pass is a fixed point.
      expect(
        toJsx(resolved(doc, r.created[0] as string), r.created[0] as string, {
          format: 'inline-styles',
          tokens: TOKENS,
        }),
      ).toBe(jsx)
    }
    expect(checkInvariants(doc)).toEqual([])
  })
})
