/**
 * Google Fonts for designs: the faces of a family (`fonts:faces`) and its font files
 * (`baren-font://google/…`), downloaded once and cached in `<userData>/fonts/google/` so they
 * keep working offline. Renderers register the faces with `FontFace`; Chromium then fetches only
 * the files (unicode-range subsets, styles) that text on screen needs.
 *
 * Only families in the bundled catalog are requested, and only gstatic font paths are
 * downloaded (`renderer/lib/googleFonts.ts` validates both).
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from '../log'
import {
  css2Url,
  findGoogleFont,
  fontFileSource,
  parseFontFaces,
  type FontFaceSpec,
} from '../../renderer/lib/googleFonts'
import { readJsonOrNull, writeFileAtomic } from '../util/fs'

/**
 * The CSS2 API picks the font format from the User-Agent: a current Chrome gets woff2 split into
 * unicode-range subsets (what renderers load lazily).
 */
const CSS_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAX_CSS_BYTES = 1024 * 1024
const MAX_FONT_BYTES = 20 * 1024 * 1024
const CSS_CACHE_VERSION = 1

export interface GoogleFontServiceOptions {
  /** `<userData>/fonts/google`. */
  dir: string
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>
  log?: Logger
}

export class GoogleFontService {
  private readonly faceCache = new Map<string, Promise<FontFaceSpec[] | null>>()
  private readonly downloads = new Map<string, Promise<Uint8Array | null>>()

  constructor(private readonly options: GoogleFontServiceOptions) {}

  /** The faces of a Google Fonts family, or null when it is not one (or cannot be fetched). */
  faces(name: string): Promise<FontFaceSpec[] | null> {
    const font = findGoogleFont(name)
    if (!font) return Promise.resolve(null)
    let pending = this.faceCache.get(font.family)
    if (!pending) {
      pending = this.loadFaces(font.family, css2Url(font))
      this.faceCache.set(font.family, pending)
      // A failure (offline on first use) is retried on the next request.
      void pending.then((faces) => {
        if (faces === null) this.faceCache.delete(font.family)
      })
    }
    return pending
  }

  private async loadFaces(family: string, url: string): Promise<FontFaceSpec[] | null> {
    const file = join(this.options.dir, 'css', `${encodeURIComponent(family)}.json`)
    try {
      const cached = (await readJsonOrNull(file)) as {
        version?: number
        url?: string
        faces?: FontFaceSpec[]
      } | null
      if (cached?.version === CSS_CACHE_VERSION && cached.url === url && cached.faces) {
        return cached.faces
      }
    } catch {
      // Unreadable cache: fetch again.
    }
    try {
      const res = await this.options.fetch(url, { headers: { 'User-Agent': CSS_USER_AGENT } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const css = await res.text()
      if (css.length > MAX_CSS_BYTES) throw new Error('response too large')
      const faces = parseFontFaces(css)
      if (faces.length === 0) throw new Error('no font faces in the response')
      await mkdir(dirname(file), { recursive: true })
      await writeFileAtomic(
        file,
        `${JSON.stringify({ version: CSS_CACHE_VERSION, url, faces })}\n`,
      ).catch((error: unknown) =>
        this.options.log?.warn('could not cache font faces', String(error)),
      )
      return faces
    } catch (error) {
      this.options.log?.warn(`could not load Google Fonts family ${family}`, String(error))
      return null
    }
  }

  /** A font file by gstatic path (`/s/…`, already validated), from the cache or downloaded. */
  file(path: string): Promise<Uint8Array | null> {
    let pending = this.downloads.get(path)
    if (!pending) {
      pending = this.loadFile(path).finally(() => this.downloads.delete(path))
      this.downloads.set(path, pending)
    }
    return pending
  }

  private async loadFile(path: string): Promise<Uint8Array | null> {
    const file = join(this.options.dir, 'files', ...path.split('/').filter(Boolean))
    try {
      return new Uint8Array(await readFile(file))
    } catch {
      // Not cached yet.
    }
    try {
      const res = await this.options.fetch(fontFileSource(path))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_FONT_BYTES) throw new Error('bad size')
      await mkdir(dirname(file), { recursive: true })
      await writeFileAtomic(file, bytes).catch((error: unknown) =>
        this.options.log?.warn('could not cache a font file', String(error)),
      )
      return bytes
    } catch (error) {
      this.options.log?.warn(`could not download font ${path}`, String(error))
      return null
    }
  }
}
