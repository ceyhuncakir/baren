import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, Uint8Array>()
vi.mock('./bridge', () => ({
  isMockBridge: true,
  bridge: {
    assets: {
      put: async (bytes: Uint8Array) => {
        const hash = String(bytes[0]).padStart(64, '0')
        store.set(hash, bytes)
        return hash
      },
      get: async (hash: string) => store.get(hash) ?? null,
    },
  },
}))

const {
  MISSING_ASSET_CSS,
  assetCss,
  assetUrl,
  assetsArrived,
  loadAssetUrl,
  putAsset,
  resetAssetCache,
  resolveCanvasAsset,
  sniffImageMime,
  subscribeAssets,
} = await import('./assets')

const created: string[] = []
URL.createObjectURL = (() => {
  const url = `blob:test/${created.length}`
  created.push(url)
  return url
}) as typeof URL.createObjectURL
URL.revokeObjectURL = () => undefined

describe('asset URLs in browser mode', () => {
  beforeEach(() => {
    resetAssetCache()
    store.clear()
  })

  it('serves stored bytes as cached blob URLs', async () => {
    const hash = await putAsset(new Uint8Array([7, 1, 2]), 'image/png')
    const url = assetUrl(hash)
    expect(url).toMatch(/^blob:/)
    expect(resolveCanvasAsset(hash)).toBe(url)
    expect(await loadAssetUrl(hash)).toBe(url)
    expect(resolveCanvasAsset('nope')).toBeNull()
  })

  it('reads unknown hashes from the bridge once, null when missing', async () => {
    const hash = '9'.padStart(64, '0')
    store.set(hash, new Uint8Array([9]))
    const pending = resolveCanvasAsset(hash)
    expect(pending).toBeInstanceOf(Promise)
    const url = await pending
    expect(url).toMatch(/^blob:/)
    expect(resolveCanvasAsset(hash)).toBe(url)
    expect(await loadAssetUrl('8'.padStart(64, '0'))).toBeNull()
  })

  it('rewrites image fills for previews and reports late bytes', async () => {
    const hash = await putAsset(new Uint8Array([5]), 'image/png')
    const fill = `url("baren-asset://${hash}")`
    expect(assetCss(fill)).toBe(`url("${assetUrl(hash)}")`)
    expect(assetCss('linear-gradient(red, blue)')).toBe('linear-gradient(red, blue)')
    const late = '6'.padStart(64, '0')
    const seen: string[][] = []
    const off = subscribeAssets((h) => seen.push([...h]))
    expect(assetCss(`url(baren-asset://${late})`)).toBe(MISSING_ASSET_CSS)
    store.set(late, new Uint8Array([6]))
    assetsArrived([late])
    expect(seen).toEqual([[late]])
    expect(await loadAssetUrl(late)).toMatch(/^blob:/)
    off()
  })
})

describe('sniffImageMime', () => {
  const bytes = (s: string, ...head: number[]) =>
    new Uint8Array([...head, ...[...s].map((c) => c.charCodeAt(0))])

  it('recognises the accepted image types and SVG', () => {
    expect(sniffImageMime(bytes('PNG\r\n\x1a\n', 0x89))).toBe('image/png')
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(bytes('GIF89a'))).toBe('image/gif')
    expect(sniffImageMime(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageMime(bytes('\0\0\0\x1cftypavif'))).toBe('image/avif')
    expect(sniffImageMime(bytes('<?xml version="1.0"?>\n<svg xmlns="x"/>'))).toBe('image/svg+xml')
    expect(sniffImageMime(bytes('<svg viewBox="0 0 1 1"></svg>'))).toBe('image/svg+xml')
    expect(sniffImageMime(bytes('<html><svg/></html>'))).toBeNull()
    expect(sniffImageMime(bytes('hello'))).toBeNull()
  })
})
