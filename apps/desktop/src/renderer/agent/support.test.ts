/**
 * Supporting pieces of the runtime: image sources (data URIs, pre-resolved assets, CSS url()
 * rewriting), font family names, the font probe's body, the render stage's scale rule, and
 * create_tokens / set_tokens per-entry semantics.
 */
import { createEmptyDoc, getTokens, setTokens } from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { tokenOrders } from '../editor/model/tokenOps'
import type { ToolCall } from './context'
import { cssUrls, decodeDataUri, resolveImageSources, rewriteStyleUrls } from './images'
import { fontFamilyInfo } from './render/fonts'
import { effectiveScale } from './render/stage'
import { ok, testEnv } from './testing'
import { fontFamilyName, splitTopLevel } from './tools/read'

const HASH = 'b'.repeat(64)
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='

function callFor(assets: ToolCall['assets'] = {}): ToolCall {
  const env = testEnv(createEmptyDoc('x'))
  return {
    tool: 'write_html',
    env,
    args: {},
    agent: null,
    assets,
    signal: new AbortController().signal,
  }
}

describe('image sources (contract §4.8, §7.8)', () => {
  it('decodes base64 and percent-encoded data URIs', () => {
    expect(decodeDataUri('data:text/plain,a%20b')?.bytes).toEqual(new TextEncoder().encode('a b'))
    const png = decodeDataUri(PNG)
    expect(png?.mime).toBe('image/png')
    expect(png?.bytes[1]).toBe(0x50)
    expect(decodeDataUri('nope')).toBeNull()
  })

  it('stores data: rasters, keeps svg markup, maps main pre-resolved sources and errors', async () => {
    const call = callFor({
      '/abs/photo.png': { kind: 'raster', hash: HASH, mime: 'image/png', name: 'photo' },
      'https://x/icon.svg': { kind: 'svg', markup: '<svg></svg>', name: 'icon' },
      '/missing.png': { error: 'not_found', message: 'No such file: /missing.png' },
    })
    const svgData = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`
    const map = await resolveImageSources(
      call,
      ['/abs/photo.png', 'https://x/icon.svg', '/missing.png', PNG, svgData, 'relative.png'],
      new Set(['/abs/photo.png', PNG]),
    )
    expect(map.get('/abs/photo.png')).toEqual({
      kind: 'raster',
      hash: HASH,
      mime: 'image/png',
      name: 'photo',
      width: 64,
      height: 32,
    })
    expect(map.get('https://x/icon.svg')).toEqual({
      kind: 'svg',
      markup: '<svg></svg>',
      name: 'icon',
    })
    expect(map.get('/missing.png')).toEqual({ error: 'No such file: /missing.png' })
    const stored = map.get(PNG)
    expect(stored && 'kind' in stored && stored.kind).toBe('raster')
    expect(await call.env.assets.has((stored as { hash: string }).hash)).toBe(true)
    expect(map.get(svgData)).toMatchObject({ kind: 'svg' })
    expect(map.has('relative.png')).toBe(false)
  })

  it('rewrites CSS url()s to stored assets and drops unresolvable ones with a warning', () => {
    expect(cssUrls('url("a.png"), linear-gradient(red, blue), url(b.png)')).toEqual([
      'a.png',
      'b.png',
    ])
    const images = new Map([
      [
        '/a.png',
        {
          kind: 'raster' as const,
          hash: HASH,
          mime: 'image/png',
          name: 'a',
          width: null,
          height: null,
        },
      ],
    ])
    const out = rewriteStyleUrls(
      {
        backgroundImage: 'url("/a.png")',
        background: 'url(/nope.png) center / cover',
        maskImage: `url(baren-asset://${HASH})`,
        color: 'red',
        width: 10,
        height: null,
      },
      images,
    )
    expect(out.styles).toEqual({
      backgroundImage: `url("baren-asset://${HASH}")`,
      maskImage: `url("baren-asset://${HASH}")`,
      color: 'red',
      width: 10,
      height: null,
    })
    expect(out.warnings).toEqual([
      expect.objectContaining({ code: 'image-unresolved', property: 'background' }),
    ])
  })
})

describe('fonts', () => {
  it('names the first family of a stack, through tokens, generics as System …', () => {
    const tokens = { '--font-mono': { type: 'fontFamily', value: "'JetBrains Mono', monospace" } }
    expect(fontFamilyName('var(--font-mono)', tokens)).toBe('JetBrains Mono')
    expect(fontFamilyName('"Inter Variable", Inter, sans-serif', {})).toBe('Inter Variable')
    expect(fontFamilyName('system-ui, sans-serif', {})).toBe('System Sans-Serif')
    expect(fontFamilyName('var(--missing, Georgia), serif', {})).toBe('Georgia')
    expect(splitTopLevel('a, "b, c", fn(d, e)')).toEqual(['a', ' "b, c"', ' fn(d, e)'])
  })

  it('reports bundled, generic, local and missing families (contract §6.17)', () => {
    const body = fontFamilyInfo(
      ['Inter', "'JetBrains Mono'", 'serif', 'Helvetica', 'Nope'],
      (f) => f === 'Helvetica',
    )
    expect(body.map((f) => [f.familyName, f.available, f.source])).toEqual([
      ['Inter', true, 'bundled'],
      ['JetBrains Mono', true, 'bundled'],
      ['serif', true, 'local'],
      ['Helvetica', true, 'local'],
      ['Nope', false, null],
    ])
    expect(body[0]?.isVariable).toBe(true)
    expect(body[0]?.weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900])
    expect(body[1]?.weights).toEqual([400, 500, 600])
    expect(body[4]?.note).toBe('Not installed. Baren does not download web fonts.')
  })
})

describe('render stage scale (contract §4.7 step 2)', () => {
  it('caps by the long side and the pixel budget, never below one pixel', () => {
    expect(effectiveScale(1440, 900, 1, 1568, 1_150_000)).toBeCloseTo(
      Math.sqrt(1_150_000 / (1440 * 900)),
    )
    expect(effectiveScale(400, 300, 2, 1568, 1_150_000)).toBe(2)
    expect(effectiveScale(4000, 100, 1, 1568, null)).toBeCloseTo(1568 / 4000)
    expect(effectiveScale(100, 100, 4, 8192, null)).toBe(4)
    expect(effectiveScale(1_000_000, 1, 1, 8192, 1)).toBeCloseTo(0.001, 6)
    expect(effectiveScale(1_000_000, 1, 1, 0.5, null)).toBe(1e-6)
  })
})

describe('token tools (contract §6.19, §6.20)', () => {
  it('create_tokens appends in order; existing names are per-entry errors', async () => {
    const doc = createEmptyDoc('t')
    setTokens(doc, { '--a': { type: 'color', value: '#000' } })
    const env = testEnv(doc)
    const body = await ok(env, 'create_tokens', {
      tokens: [
        { type: 'color', name: '--b', value: '#111', description: 'B' },
        { type: 'color', name: '--a', value: '#222' },
        { type: 'spacing', name: '--c', value: 4 },
        { type: 'color', name: 'bad name', value: '#333' },
      ],
    })
    expect(body['results']).toEqual([
      { name: '--b', result: 'created' },
      {
        name: '--a',
        result: 'error',
        message: 'Token --a already exists; change it with set_tokens.',
      },
      { name: '--c', result: 'created' },
      expect.objectContaining({ name: 'bad name', result: 'error' }),
    ])
    expect(getTokens(doc)['--b']).toEqual({ type: 'color', value: '#111', description: 'B' })
    const orders = tokenOrders(doc)
    expect(orders['--b']).toBeLessThan(orders['--c'] as number)
    const none = await ok(env, 'create_tokens', {
      tokens: [{ type: 'color', name: '--a', value: '#1' }],
    })
    expect(none['results']).toEqual([
      {
        name: '--a',
        result: 'error',
        message: 'Token --a already exists; change it with set_tokens.',
      },
    ])
  })

  it('set_tokens updates, clears descriptions and deletes in order', async () => {
    const doc = createEmptyDoc('t')
    setTokens(doc, {
      '--a': { type: 'color', value: '#000', description: 'A' },
      '--b': { type: 'color', value: '#111' },
    })
    const env = testEnv(doc)
    const body = await ok(env, 'set_tokens', {
      tokens: [
        { name: '--a', value: '#fff', description: '' },
        { name: '--b', delete: true },
        { name: '--b', value: '#222' },
      ],
    })
    expect(body['results']).toEqual([
      { name: '--a', result: 'updated' },
      { name: '--b', result: 'deleted' },
      expect.objectContaining({ name: '--b', result: 'error' }),
    ])
    expect(getTokens(doc)).toEqual({ '--a': { type: 'color', value: '#fff' } })
  })
})
