import { describe, expect, it } from 'vitest'
import {
  assetCssUrl,
  assetRefsInValue,
  assetUrlOf,
  collectAssetRefs,
  createNode,
  deleteNode,
  docAssetRefs,
  isAssetHash,
  nodeAssetRefs,
  rewriteAssetUrls,
  setStyles,
  toSnapshot,
} from '../src/index.ts'
import { docWithPage } from './helpers.ts'

const A = 'a'.repeat(64)
const B = '0123456789abcdef'.repeat(4)
const C = 'c'.repeat(64)

describe('asset references', () => {
  it('recognises content hashes', () => {
    expect(isAssetHash(A)).toBe(true)
    expect(isAssetHash(A.toUpperCase())).toBe(false)
    expect(isAssetHash('abc')).toBe(false)
    expect(isAssetHash(undefined)).toBe(false)
    expect(assetUrlOf(A)).toBe(`baren-asset://${A}`)
    expect(assetCssUrl(A)).toBe(`url("baren-asset://${A}")`)
  })

  it('finds url tokens with any quoting, once per hash', () => {
    expect(assetRefsInValue(`url("baren-asset://${A}")`)).toEqual([A])
    expect(assetRefsInValue(`url('baren-asset://${A}'), url(baren-asset://${B})`)).toEqual([A, B])
    expect(
      assetRefsInValue(
        `linear-gradient(red, blue), url( "baren-asset://${A}" ), url(baren-asset://${A})`,
      ),
    ).toEqual([A])
    expect(assetRefsInValue('url("https://example.com/x.png")')).toEqual([])
    expect(assetRefsInValue(`url("baren-asset://${A.slice(1)}")`)).toEqual([])
    expect(assetRefsInValue(12)).toEqual([])
  })

  it('rewrites whole url tokens and leaves other values alone', () => {
    const value = `linear-gradient(red, blue), url("baren-asset://${A}"), url(baren-asset://${B})`
    expect(rewriteAssetUrls(value, (h) => (h === A ? 'url("blob:http://x/1")' : 'none'))).toBe(
      'linear-gradient(red, blue), url("blob:http://x/1"), none',
    )
    const plain = 'url("https://example.com/a.png")'
    expect(rewriteAssetUrls(plain, () => 'none')).toBe(plain)
  })

  it('collects image layer and fill references from nodes', () => {
    expect(nodeAssetRefs({ type: 'image', assetId: A, styles: {} })).toEqual([A])
    expect(nodeAssetRefs({ type: 'rect', assetId: A, styles: {} })).toEqual([])
    expect(
      nodeAssetRefs({
        type: 'frame',
        styles: {
          backgroundImage: assetCssUrl(B),
          '--hidden-backgroundImage': assetCssUrl(C),
          width: 10,
        },
      }),
    ).toEqual([B, C])
  })

  it('collects references from a whole document, skipping deleted nodes', () => {
    const { doc, pageId } = docWithPage()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { backgroundImage: assetCssUrl(A), backgroundSize: 'cover' },
    })
    createNode(doc, { type: 'image', parentId: board, assetId: B })
    const gone = createNode(doc, { type: 'image', parentId: board, assetId: C })
    expect([...docAssetRefs(doc)].sort()).toEqual([A, B, C].sort())
    deleteNode(doc, gone)
    expect([...docAssetRefs(doc)].sort()).toEqual([A, B].sort())
    setStyles(doc, board, { backgroundImage: null })
    expect([...docAssetRefs(doc)]).toEqual([B])
    expect([...collectAssetRefs(toSnapshot(doc).nodes)]).toEqual([B])
  })
})
