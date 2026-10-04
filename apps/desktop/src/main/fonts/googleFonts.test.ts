import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleFontService } from './googleFonts'

const CSS = `/* latin */
@font-face {
  font-family: 'Geist';
  font-style: normal;
  font-weight: 100 900;
  src: url(https://fonts.gstatic.com/s/geist/v5/abc.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`

describe('GoogleFontService', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baren-fonts-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('fetches a family once, caches it on disk and skips families not on Google Fonts', async () => {
    const fetch = vi.fn(async () => new Response(CSS))
    const service = new GoogleFontService({ dir, fetch })
    expect(await service.faces('Not A Google Font')).toBeNull()
    const faces = await service.faces(' geist ')
    expect(faces).toEqual([
      {
        style: 'normal',
        weight: '100 900',
        unicodeRange: 'U+0000-00FF',
        url: 'baren-font://google/s/geist/v5/abc.woff2',
      },
    ])
    expect(await service.faces('Geist')).toBe(faces)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toBe(
      'https://fonts.googleapis.com/css2?family=Geist:ital,wght@0,100..900;1,100..900&display=swap',
    )
    expect(init.headers['User-Agent']).toContain('Chrome/')

    // A new process reads the disk cache.
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await new GoogleFontService({ dir, fetch: offline }).faces('Geist')).toEqual(faces)
    expect(offline).not.toHaveBeenCalled()
  })

  it('returns null while offline and retries on the next request', async () => {
    let online = false
    const fetch = vi.fn(async () => {
      if (!online) throw new Error('offline')
      return new Response(CSS)
    })
    const service = new GoogleFontService({ dir, fetch })
    expect(await service.faces('Geist')).toBeNull()
    online = true
    expect(await service.faces('Geist')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('downloads a font file once (concurrent requests share it) and serves it from disk', async () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3])
    const fetch = vi.fn(async () => new Response(bytes))
    const service = new GoogleFontService({ dir, fetch })
    const [a, b] = await Promise.all([
      service.file('/s/geist/v5/abc.woff2'),
      service.file('/s/geist/v5/abc.woff2'),
    ])
    expect(a).toEqual(bytes)
    expect(b).toEqual(bytes)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('https://fonts.gstatic.com/s/geist/v5/abc.woff2')
    expect(
      new Uint8Array(await readFile(join(dir, 'files', 's', 'geist', 'v5', 'abc.woff2'))),
    ).toEqual(bytes)
    expect(await service.file('/s/geist/v5/abc.woff2')).toEqual(bytes)
    expect(fetch).toHaveBeenCalledTimes(1)
    const failing = new GoogleFontService({
      dir,
      fetch: async () => new Response('nope', { status: 404 }),
    })
    expect(await failing.file('/s/geist/v5/missing.woff2')).toBeNull()
  })
})
