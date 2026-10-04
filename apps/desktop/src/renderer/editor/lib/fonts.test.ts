import {
  createEmptyDoc,
  createNode,
  getChildIds,
  setStyles,
  setTokens,
  subscribeNodes,
  type NodeChangeBatch,
} from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { stageFontFamilies } from '../../agent/render/stage'
import { batchFontFamilies, docFontFamilies } from './fonts'

function setup() {
  const doc = createEmptyDoc('fonts', { peerId: 1 })
  const page = getChildIds(doc, null)[0] as string
  const board = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Board',
    styles: { left: 0, top: 0, width: 400, height: 300 },
  })
  return { doc, board }
}

describe('design font families', () => {
  it('collects families from text styles and font tokens, not from var() references', () => {
    const { doc, board } = setup()
    createNode(doc, {
      type: 'text',
      parentId: board,
      name: 'Title',
      text: 'Hello',
      styles: { fontFamily: `"Geist Mono", ui-monospace, monospace` },
    })
    createNode(doc, {
      type: 'text',
      parentId: board,
      name: 'Body',
      text: 'World',
      styles: { fontFamily: 'var(--font-sans)' },
    })
    setTokens(doc, { '--font-sans': { type: 'fontFamily', value: 'Geist' } })
    setTokens(doc, { '--color-ink': { type: 'color', value: '#111111' } })
    expect([...docFontFamilies(doc)].sort()).toEqual([
      'Geist',
      'Geist Mono',
      'monospace',
      'ui-monospace',
    ])
  })

  it('reports the families a change batch introduces', async () => {
    const { doc, board } = setup()
    // Read when the batch is delivered, like the session's listener.
    const families: string[][] = []
    subscribeNodes(doc, (b: NodeChangeBatch) => families.push([...batchFontFamilies(doc, b)]))
    const text = createNode(doc, {
      type: 'text',
      parentId: board,
      name: 'T',
      text: 'x',
      styles: { fontFamily: 'Lobster' },
    })
    doc.commit()
    setStyles(doc, text, { fontFamily: 'Playfair Display, serif' })
    setStyles(doc, text, { fontSize: 20 })
    setTokens(doc, { '--font-mono': { type: 'fontFamily', value: 'Fira Code' } })
    await Promise.resolve()
    expect(families).toEqual([['Lobster'], ['Playfair Display', 'serif'], [], ['Fira Code']])
  })

  it('finds the families of a render stage (declarations and token values)', () => {
    expect(
      [
        ...stageFontFamilies({
          css: ':host { --font-sans: Geist; --space: 4px } .a { font-family: "Inter" }',
          html: '<div style="font-family: &quot;Geist Mono&quot;, monospace; color: red">x</div>',
          assetUrls: [],
        }),
      ].sort(),
    ).toEqual(['4px', 'Geist', 'Geist Mono', 'Inter', 'monospace'])
  })
})
