import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  classifySource,
  collectCssUrlsFallback,
  collectImageSourcesFallback,
  imageSize,
  looksLikeSvg,
  resolveImageSources,
  sniffImage,
  sourceName,
  type FetchLike,
} from './assets'

// 1×1 PNG
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const SVG =
  '<?xml version="1.0"?>\n<!-- icon -->\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'baren-assets-'))
  await writeFile(join(dir, 'logo.png'), PNG)
  await writeFile(join(dir, 'icon.svg'), SVG)
  await writeFile(join(dir, 'notes.txt'), 'hello')
  await writeFile(join(dir, 'big.png'), Buffer.concat([Buffer.from(PNG), Buffer.alloc(2048)]))
  await mkdir(join(dir, 'folder'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function deps(fetch: FetchLike = async () => new Response(null, { status: 404 })) {
  const puts: { mime: string; size: number }[] = []
  return {
    puts,
    deps: {
      putAsset: async (bytes: Uint8Array, mime: string) => {
        puts.push({ mime, size: bytes.byteLength })
        return 'a'.repeat(64)
      },
      fetch,
    },
  }
}

describe('image sources (contract §4.8)', () => {
  it('classifies sources', () => {
    expect(classifySource('/home/u/a.png')).toEqual({ kind: 'file', path: '/home/u/a.png' })
    expect(classifySource('C:\\Users\\a.png')).toMatchObject({ kind: 'file' })
    expect(classifySource('file:///home/u/a%20b.png')).toEqual({
      kind: 'file',
      path: '/home/u/a b.png',
    })
    expect(classifySource('baren-file:///home/u/x.png')).toEqual({
      kind: 'file',
      path: '/home/u/x.png',
    })
    expect(classifySource('https://example.com/i.png')).toEqual({
      kind: 'url',
      url: 'https://example.com/i.png',
    })
    expect(classifySource('data:image/png;base64,AAAA')).toEqual({ kind: 'renderer' })
    expect(classifySource(`baren-asset://${'b'.repeat(64)}`)).toEqual({ kind: 'renderer' })
    expect(classifySource('images/a.png')).toMatchObject({ kind: 'unsupported' })
    expect(classifySource('ftp://x/y.png')).toEqual({
      kind: 'unsupported',
      reason: 'unsupported scheme ftp:',
    })
    expect(classifySource('//cdn.example/x.png')).toMatchObject({ kind: 'unsupported' })
  })

  it('names sources after the file or last URL segment', () => {
    expect(sourceName('/a/Hero Image.png', classifySource('/a/Hero Image.png'))).toBe('Hero Image')
    const url = 'https://cdn.example/img/team%20photo.jpg?w=2'
    expect(sourceName(url, classifySource(url))).toBe('team photo')
    expect(sourceName('https://cdn.example/', classifySource('https://cdn.example/'))).toBe('Image')
  })

  it('sniffs raster formats and SVG', () => {
    expect(sniffImage(PNG)).toEqual({ kind: 'raster', mime: 'image/png' })
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      kind: 'raster',
      mime: 'image/jpeg',
    })
    expect(sniffImage(new TextEncoder().encode('GIF89a...'))).toEqual({
      kind: 'raster',
      mime: 'image/gif',
    })
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toEqual({
      kind: 'raster',
      mime: 'image/webp',
    })
    expect(sniffImage(new TextEncoder().encode('\0\0\0\x1cftypavif'))).toEqual({
      kind: 'raster',
      mime: 'image/avif',
    })
    expect(looksLikeSvg(new TextEncoder().encode(SVG))).toBe(true)
    expect(looksLikeSvg(new TextEncoder().encode('\uFEFF<!DOCTYPE svg><svg/>'))).toBe(true)
    expect(looksLikeSvg(new TextEncoder().encode('<html><svg></svg></html>'))).toBe(false)
    expect(sniffImage(new TextEncoder().encode('hello'))).toBeNull()
    expect(imageSize(PNG)).toEqual({ width: 1, height: 1 })
  })

  it('reads local files into raster assets and SVG markup; reports errors per source', async () => {
    const { deps: d, puts } = deps()
    const sources = [
      join(dir, 'logo.png'),
      `file://${join(dir, 'icon.svg')}`,
      join(dir, 'missing.png'),
      join(dir, 'notes.txt'),
      join(dir, 'folder'),
      'data:image/png;base64,AAAA',
      'relative.png',
      'gopher://example.com/cat.png',
    ]
    const out = await resolveImageSources(sources, d)
    expect(out[join(dir, 'logo.png')]).toEqual({
      kind: 'raster',
      hash: 'a'.repeat(64),
      mime: 'image/png',
      name: 'logo',
    })
    expect(out[`file://${join(dir, 'icon.svg')}`]).toMatchObject({ kind: 'svg', name: 'icon' })
    expect(out[join(dir, 'missing.png')]).toMatchObject({ error: 'not_found' })
    expect(out[join(dir, 'notes.txt')]).toMatchObject({ error: 'unsupported_type' })
    expect(out[join(dir, 'folder')]).toMatchObject({ error: 'not_found' })
    expect(out['data:image/png;base64,AAAA']).toBeUndefined()
    expect(out['relative.png']).toMatchObject({ error: 'unsupported_source' })
    expect(out['gopher://example.com/cat.png']).toMatchObject({ error: 'unsupported_source' })
    expect(puts).toEqual([{ mime: 'image/png', size: PNG.byteLength }])
  })

  it('enforces the per-source size and per-call byte budget', async () => {
    const { deps: d } = deps()
    const tooBig = await resolveImageSources([join(dir, 'big.png')], {
      ...d,
      limits: { sourceBytes: 1024 },
    })
    expect(tooBig[join(dir, 'big.png')]).toMatchObject({ error: 'too_large' })
    const budget = await resolveImageSources([join(dir, 'logo.png'), join(dir, 'big.png')], {
      ...d,
      limits: { callBytes: 100 },
    })
    expect(budget[join(dir, 'logo.png')]).toMatchObject({ kind: 'raster' })
    expect(budget[join(dir, 'big.png')]).toMatchObject({ error: 'budget' })
  })

  it('fetches URLs with ≤ 3 redirects, no cookies and a size cap', async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/r0'))
        return new Response(null, { status: 302, headers: { location: '/r1' } })
      if (url.endsWith('/r1'))
        return new Response(null, {
          status: 301,
          headers: { location: 'https://cdn.example/final.png' },
        })
      if (url.endsWith('/final.png')) return new Response(PNG, { status: 200 })
      if (url.endsWith('/loop'))
        return new Response(null, { status: 302, headers: { location: '/loop' } })
      if (url.endsWith('/huge')) return new Response(new Uint8Array(4096), { status: 200 })
      if (url.endsWith('/boom')) throw new Error('ECONNREFUSED')
      return new Response('nope', { status: 404 })
    }
    const { deps: d } = deps(fetch)
    const out = await resolveImageSources(
      [
        'https://a.example/r0',
        'https://a.example/loop',
        'https://a.example/missing',
        'https://a.example/huge',
        'https://a.example/boom',
      ],
      { ...d, limits: { sourceBytes: 1024 } },
    )
    expect(out['https://a.example/r0']).toMatchObject({ kind: 'raster', name: 'r0' })
    expect(calls[0]!.init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
    expect(calls.map((c) => c.url).slice(0, 3)).toEqual([
      'https://a.example/r0',
      'https://a.example/r1',
      'https://cdn.example/final.png',
    ])
    expect(out['https://a.example/loop']).toMatchObject({
      error: 'fetch_failed',
      message: 'too many redirects',
    })
    expect(out['https://a.example/missing']).toMatchObject({ error: 'not_found' })
    expect(out['https://a.example/huge']).toMatchObject({ error: 'too_large' })
    expect(out['https://a.example/boom']).toMatchObject({ error: 'fetch_failed' })
  })

  it('collects <img src> and style url() sources (fallback collectors)', () => {
    expect(
      collectImageSourcesFallback(
        `<div style="background: url('/a/bg.png') center / cover"><img src="/a/x.png?x=1&amp;y=2" alt=""><img src='https://e.x/y.jpg'/><img src="/a/x.png?x=1&amp;y=2"></div>`,
      ),
    ).toEqual(['/a/bg.png', '/a/x.png?x=1&y=2', 'https://e.x/y.jpg'])
    expect(
      collectCssUrlsFallback({
        backgroundImage: 'url("/b.png"), linear-gradient(red, blue)',
        color: 'red',
        width: 3,
      }),
    ).toEqual(['/b.png'])
  })
})
