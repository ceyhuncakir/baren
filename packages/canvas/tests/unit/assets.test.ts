import { describe, expect, it, vi } from 'vitest'
import { AssetUrlCache, MISSING_FILL_CSS } from '../../src/render/assets.ts'
import { backgroundTiles, fitImage, parsePosition } from '../../src/render/imageFit.ts'
import { renderValue, stylesToCssText } from '../../src/render/styles.ts'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('asset URL rewriting', () => {
  it('passes sync resolver URLs through and marks unknown assets missing', () => {
    const cache = new AssetUrlCache((id) => (id === A ? `baren-asset://${A}` : null))
    expect(cache.rewriteCss(`url("baren-asset://${A}")`)).toBe(`url("baren-asset://${A}")`)
    expect(cache.rewriteCss(`url(baren-asset://${B})`)).toBe(MISSING_FILL_CSS)
    expect(cache.isMissing(B)).toBe(true)
  })

  it('shows nothing while an async resolver runs, then reports the change', async () => {
    let resolveUrl!: (url: string | null) => void
    const onChange = vi.fn()
    const cache = new AssetUrlCache(
      () => new Promise<string | null>((r) => (resolveUrl = r)),
      onChange,
    )
    const value = `linear-gradient(red, red), url("baren-asset://${A}")`
    expect(cache.rewriteCss(value)).toBe('linear-gradient(red, red), none')
    expect(cache.pending).toBe(1)
    resolveUrl('blob:http://x/1')
    await tick()
    expect(cache.pending).toBe(0)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect([...(onChange.mock.calls[0]?.[0] as Set<string>)]).toEqual([A])
    expect(cache.rewriteCss(value)).toBe('linear-gradient(red, red), url("blob:http://x/1")')
  })

  it('resolves each id once and re-resolves after invalidate', async () => {
    const resolver = vi.fn((id: string) => `blob:${id}`)
    const onChange = vi.fn()
    const cache = new AssetUrlCache(resolver, onChange)
    const seen: (string | null)[] = []
    cache.resolve(A, (u) => seen.push(u))
    cache.resolve(A, (u) => seen.push(u))
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([`blob:${A}`, `blob:${A}`])
    cache.markFailed(A)
    expect(cache.isMissing(A)).toBe(true)
    cache.resolve(A, (u) => seen.push(u))
    expect(seen[2]).toBeNull()
    cache.invalidate([A])
    await tick()
    expect(onChange).toHaveBeenCalled()
    expect(cache.isMissing(A)).toBe(false)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('only rewrites image properties that mention assets', () => {
    const rewrite = vi.fn(() => 'none')
    expect(renderValue('backgroundColor', 'red', rewrite)).toBe('red')
    expect(renderValue('backgroundImage', 'linear-gradient(red, blue)', rewrite)).toBe(
      'linear-gradient(red, blue)',
    )
    expect(rewrite).not.toHaveBeenCalled()
    expect(renderValue('backgroundImage', `url("baren-asset://${A}")`, rewrite)).toBe('none')
    expect(
      stylesToCssText(
        { width: 10, background: `url(baren-asset://${A}) center / cover`, color: 'red' },
        undefined,
        () => 'url("blob:x")',
      ),
    ).toBe('width:10px;background:url("blob:x");color:red;')
  })
})

describe('image placement (thumbnails)', () => {
  const box = { x: 0, y: 0, width: 200, height: 100 }

  it('parses computed positions', () => {
    expect(parsePosition('50% 50%')).toEqual({ x: { frac: 0.5, px: 0 }, y: { frac: 0.5, px: 0 } })
    expect(parsePosition('10px 0%')).toEqual({ x: { frac: 0, px: 10 }, y: { frac: 0, px: 0 } })
    expect(parsePosition('right bottom').x.frac).toBe(1)
  })

  it('implements object-fit', () => {
    expect(fitImage(100, 100, box, 'fill', '50% 50%')).toEqual(box)
    expect(fitImage(100, 100, box, 'contain', '50% 50%')).toEqual({
      x: 50,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(fitImage(100, 100, box, 'cover', '50% 50%')).toEqual({
      x: 0,
      y: -50,
      width: 200,
      height: 200,
    })
    expect(fitImage(50, 20, box, 'none', '0% 0%')).toEqual({ x: 0, y: 0, width: 50, height: 20 })
    expect(fitImage(400, 400, box, 'scale-down', '50% 50%').width).toBe(100)
  })

  it('implements background-size / position / repeat', () => {
    expect(backgroundTiles(100, 100, box, 'cover', '50% 50%', 'no-repeat', 99)).toEqual([
      { x: 0, y: -50, width: 200, height: 200 },
    ])
    expect(backgroundTiles(100, 50, box, 'contain', '0% 0%', 'no-repeat', 99)).toEqual([
      { x: 0, y: 0, width: 200, height: 100 },
    ])
    const tiles = backgroundTiles(10, 10, box, '50px 50px', '0% 0%', 'repeat', 99)
    expect(tiles).toHaveLength(8)
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 50, height: 50 })
    // Centered tiles start before the box edge so the box is covered.
    const centered = backgroundTiles(10, 10, box, '80px auto', '50% 50%', 'repeat', 99)
    expect(centered[0]?.x).toBeLessThanOrEqual(0)
    expect(centered[0]?.y).toBeLessThanOrEqual(0)
    expect(backgroundTiles(10, 10, box, '50px 50px', '0% 0%', 'repeat', 3)).toHaveLength(3)
    expect(backgroundTiles(10, 10, box, 'auto', '0% 0%', 'repeat-x', 99)).toHaveLength(20)
  })
})
