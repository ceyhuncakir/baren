import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_MIME,
  assetResponse,
  isAssetHash,
  parseAssetUrl,
  parseRange,
  servableMime,
  sniffMime,
  type AssetEntry,
} from './assetRequest'

const HASH = 'a'.repeat(62) + '0f'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2])

describe('asset URLs', () => {
  it('accepts lowercase 64-hex hashes only', () => {
    expect(isAssetHash(HASH)).toBe(true)
    expect(isAssetHash(HASH.toUpperCase())).toBe(false)
    expect(isAssetHash(HASH.slice(1))).toBe(false)
    expect(isAssetHash(`${HASH}0`)).toBe(false)
    expect(isAssetHash('g'.repeat(64))).toBe(false)
  })

  it('reads the hash from the host (with or without the trailing slash)', () => {
    expect(parseAssetUrl(`baren-asset://${HASH}`)).toBe(HASH)
    expect(parseAssetUrl(`baren-asset://${HASH}/`)).toBe(HASH)
    expect(parseAssetUrl(`baren-asset://${HASH.toUpperCase()}/`)).toBe(HASH)
    expect(parseAssetUrl(`baren-asset://${HASH}/?v=2#x`)).toBe(HASH)
  })

  it.each([
    `baren-asset://${HASH}/other`,
    `baren-asset://${HASH}/../${HASH}/x`,
    `baren-asset://user@${HASH}/`,
    `baren-asset://${HASH}:80/`,
    `baren-asset://not-a-hash/`,
    `baren-asset:///${HASH}`,
    `app://${HASH}/`,
    `https://${HASH}/`,
    'nonsense',
  ])('rejects %s', (url) => {
    expect(parseAssetUrl(url)).toBeNull()
  })
})

describe('asset content types', () => {
  it('serves stored image/media/font types and nothing that could run as a document', () => {
    expect(servableMime('image/png')).toBe('image/png')
    expect(servableMime('Image/SVG+XML; charset=utf-8')).toBe('image/svg+xml')
    expect(servableMime('video/mp4')).toBe('video/mp4')
    expect(servableMime('font/woff2')).toBe('font/woff2')
    for (const bad of [
      'text/html',
      'application/javascript',
      'image/',
      'png',
      '',
      null,
      'image/p ng',
    ]) {
      expect(servableMime(bad)).toBe(FALLBACK_MIME)
    }
  })

  it('sniffs common image formats from magic bytes', () => {
    const bytes = (...parts: (number[] | string)[]) =>
      Uint8Array.from(
        parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
      )
    expect(sniffMime(PNG)).toBe('image/png')
    expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffMime(bytes('GIF89a', [1, 0]))).toBe('image/gif')
    expect(sniffMime(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp')
    expect(sniffMime(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBe('image/avif')
    expect(sniffMime(bytes('﻿  <svg xmlns="http://www.w3.org/2000/svg"/>'.replace('﻿', '')))).toBe(
      'image/svg+xml',
    )
    expect(sniffMime(bytes('<?xml version="1.0"?>\n<svg>'))).toBe('image/svg+xml')
    expect(sniffMime(bytes('<html><svg>'))).toBe(FALLBACK_MIME)
    expect(sniffMime(new Uint8Array())).toBe(FALLBACK_MIME)
  })
})

describe('range requests', () => {
  it('parses single byte ranges', () => {
    expect(parseRange(null, 10)).toBeNull()
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 })
    expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 })
  })

  it('reports unsatisfiable ranges and ignores ones it does not support', () => {
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=5-2', 10)).toBeNull()
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull()
    expect(parseRange('items=0-1', 10)).toBeNull()
    expect(parseRange('bytes=-', 10)).toBeNull()
  })
})

describe('assetResponse', () => {
  const store = new Map<string, AssetEntry>([[HASH, { bytes: PNG, mime: 'image/png' }]])
  const lookup = vi.fn(async (hash: string) => store.get(hash) ?? null)
  const get = (url: string, range?: string, method = 'GET') =>
    assetResponse({ method, url, range: range ?? null }, lookup)

  it('serves the stored bytes with their mime type, immutable caching and CORS', async () => {
    const res = await get(`baren-asset://${HASH}/`)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(PNG.length),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${HASH}"`,
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
    })
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
  })

  it('answers HEAD without a body and byte ranges with 206/416', async () => {
    const head = await get(`baren-asset://${HASH}/`, undefined, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(PNG.length))
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    const partial = await get(`baren-asset://${HASH}/`, 'bytes=1-3')
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 1-3/${PNG.length}`)
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(PNG.subarray(1, 4))

    const bad = await get(`baren-asset://${HASH}/`, 'bytes=999-')
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe(`bytes */${PNG.length}`)
  })

  it('404s unknown and malformed hashes without caching, and never asks the core for bad ones', async () => {
    lookup.mockClear()
    const unknown = await get(`baren-asset://${'b'.repeat(64)}/`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('cache-control')).toBe('no-store')
    expect(lookup).toHaveBeenCalledTimes(1)
    for (const url of ['baren-asset://nope/', `baren-asset://${HASH}/x`]) {
      expect((await get(url)).status).toBe(404)
    }
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('rejects other methods and reports a failing core as 503', async () => {
    expect((await get(`baren-asset://${HASH}/`, undefined, 'POST')).status).toBe(405)
    const failing = await assetResponse({ method: 'GET', url: `baren-asset://${HASH}/` }, () =>
      Promise.reject(new Error('[locked]')),
    )
    expect(failing.status).toBe(503)
  })

  it('sniffs the type of assets stored with an unusable mime', async () => {
    const res = await assetResponse({ method: 'GET', url: `baren-asset://${HASH}` }, async () => ({
      bytes: PNG,
      mime: 'text/html',
    }))
    expect(res.headers.get('content-type')).toBe('image/png')
    const opaque = await assetResponse(
      { method: 'GET', url: `baren-asset://${HASH}` },
      async () => ({ bytes: Uint8Array.of(1, 2, 3), mime: '' }),
    )
    expect(opaque.headers.get('content-type')).toBe(FALLBACK_MIME)
  })
})
