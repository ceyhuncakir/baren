/**
 * Image sources of write_html / update_styles / create_artboard, resolved by main before the
 * request goes to the host (contract §4.8): the renderer never reads local files or the network
 * for agents.
 *
 * | Source                                            | Resolution                                       |
 * | ------------------------------------------------- | ------------------------------------------------ |
 * | `/abs/path`, `C:\abs`, `file://`, `baren-file://` | regular file ≤ 20 MB → read                      |
 * | `http://…`, `https://…`                           | fetch, 15 s, ≤ 3 redirects, no cookies, ≤ 20 MB  |
 * | `data:…`, `baren-asset://<hash>`                  | left to the renderer (not in the map)            |
 * | relative paths, other schemes                     | `{ error: 'unsupported_source' }`                |
 *
 * Bytes are sniffed: PNG/JPEG/WebP/GIF/AVIF → `putAsset` → `raster`; SVG (≤ 1 MB) → `svg`;
 * anything else → `unsupported_type`. Budget per call: 45 s and 64 MB.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedSource } from '../../renderer/types/bridge'

export const ASSET_LIMITS = {
  sourceBytes: 20 * 1024 * 1024,
  svgBytes: 1024 * 1024,
  callBytes: 64 * 1024 * 1024,
  callMs: 45_000,
  fetchMs: 15_000,
  redirects: 3,
} as const

type ErrorCode = Extract<ResolvedSource, { error: string }>['error']

export class SourceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type SourceKind =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'renderer' }
  | { kind: 'unsupported'; reason: string }

const FILE_SCHEMES = new Set(['file:', 'baren-file:'])

/** How a source string is resolved (pure). */
export function classifySource(source: string): SourceKind {
  const src = source.trim()
  if (src === '') return { kind: 'unsupported', reason: 'empty source' }
  if (/^data:/i.test(src) || /^baren-asset:\/\//i.test(src)) return { kind: 'renderer' }
  if (/^[a-zA-Z]:[\\/]/.test(src) || (src.startsWith('/') && !src.startsWith('//'))) {
    return isAbsolute(src) || /^[a-zA-Z]:[\\/]/.test(src)
      ? { kind: 'file', path: src }
      : { kind: 'unsupported', reason: 'not an absolute path' }
  }
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return { kind: 'unsupported', reason: 'relative paths are not supported; use an absolute path' }
  }
  const scheme = url.protocol.toLowerCase()
  if (scheme === 'http:' || scheme === 'https:') return { kind: 'url', url: url.href }
  if (FILE_SCHEMES.has(scheme)) {
    try {
      const asFile = new URL(`file:${src.slice(scheme.length)}`)
      return { kind: 'file', path: fileURLToPath(asFile) }
    } catch {
      return { kind: 'unsupported', reason: 'not an absolute file URL' }
    }
  }
  return { kind: 'unsupported', reason: `unsupported scheme ${scheme}` }
}

/** File name without extension (URLs: the last path segment); "Image" when empty. */
export function sourceName(source: string, kind: SourceKind): string {
  let raw = ''
  if (kind.kind === 'file') raw = basename(kind.path)
  else if (kind.kind === 'url') {
    try {
      const segment = new URL(kind.url).pathname.split('/').filter(Boolean).at(-1) ?? ''
      raw = decodeURIComponent(segment)
    } catch {
      raw = ''
    }
  } else raw = basename(source)
  const name = raw.slice(0, raw.length - extname(raw).length).trim()
  return (name || raw || 'Image').slice(0, 200)
}

const RASTER_SIGNATURES: readonly { mime: string; test(b: Uint8Array): boolean }[] = [
  {
    mime: 'image/png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/gif',
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: 'image/webp',
    test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  },
  {
    mime: 'image/avif',
    test: (b) => ascii(b, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(b, 8, 12)),
  },
]

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0)
  return out
}

/** `<svg` after an optional BOM, XML prolog, comments and doctype. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096))
  let text = head.replace(/^\uFEFF/, '')
  for (;;) {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('<?')) {
      const end = trimmed.indexOf('?>')
      if (end < 0) return false
      text = trimmed.slice(end + 2)
    } else if (trimmed.startsWith('<!--')) {
      const end = trimmed.indexOf('-->')
      if (end < 0) return false
      text = trimmed.slice(end + 3)
    } else if (/^<!doctype/i.test(trimmed)) {
      const end = trimmed.indexOf('>')
      if (end < 0) return false
      text = trimmed.slice(end + 1)
    } else {
      return /^<svg[\s>/]/i.test(trimmed)
    }
  }
}

export type Sniffed = { kind: 'raster'; mime: string } | { kind: 'svg' } | null

export function sniffImage(bytes: Uint8Array): Sniffed {
  const raster = RASTER_SIGNATURES.find((s) => s.test(bytes))
  if (raster) return { kind: 'raster', mime: raster.mime }
  return looksLikeSvg(bytes) ? { kind: 'svg' } : null
}

/** Natural size of PNG/GIF/JPEG/WebP bytes (header parsing only), else null. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sniffed = sniffImage(bytes)
  if (!sniffed || sniffed.kind !== 'raster') return null
  try {
    switch (sniffed.mime) {
      case 'image/png':
        return { width: view.getUint32(16), height: view.getUint32(20) }
      case 'image/gif':
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
      case 'image/webp': {
        const chunk = ascii(bytes, 12, 16)
        if (chunk === 'VP8X') {
          const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
          const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
          return { width: w, height: h }
        }
        if (chunk === 'VP8L') {
          const b = view.getUint32(21, true)
          return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
        }
        if (chunk === 'VP8 ') {
          return {
            width: view.getUint16(26, true) & 0x3fff,
            height: view.getUint16(28, true) & 0x3fff,
          }
        }
        return null
      }
      case 'image/jpeg': {
        let offset = 2
        while (offset + 9 < bytes.length) {
          if (bytes[offset] !== 0xff) return null
          const marker = bytes[offset + 1]!
          const length = view.getUint16(offset + 2)
          const isSof =
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc
          if (isSof)
            return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
          offset += 2 + length
        }
        return null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** A PNG with an alpha channel or transparency (JPEG would turn it black). */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  const colorType = bytes[25]
  if (colorType === 4 || colorType === 6) return true
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 65_536))).toString('latin1')
  const trns = text.indexOf('tRNS')
  const idat = text.indexOf('IDAT')
  return trns >= 0 && (idat < 0 || trns < idat)
}

export interface FetchLike {
  (
    url: string,
    init: {
      redirect: 'manual' | 'follow'
      credentials: 'omit'
      signal: AbortSignal
      headers: Record<string, string>
    },
  ): Promise<Response>
}

export interface AssetResolverDeps {
  putAsset(bytes: Uint8Array, mime: string): Promise<string>
  fetch: FetchLike
  readFile?: (path: string) => Promise<Uint8Array>
  stat?: (path: string) => Promise<{ isFile(): boolean; size: number }>
  now?: () => number
  limits?: Partial<typeof ASSET_LIMITS>
}

/** Read a response body, aborting beyond `max` bytes. */
async function readBody(res: Response, max: number, abort: () => void): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    abort()
    throw new SourceError('too_large', `larger than ${Math.round(max / 1024 / 1024)} MB`)
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      abort()
      await reader.cancel().catch(() => undefined)
      throw new SourceError('too_large', `larger than ${Math.round(max / 1024 / 1024)} MB`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function fetchBytes(
  url: string,
  deps: AssetResolverDeps,
  limits: typeof ASSET_LIMITS,
  outer: AbortSignal,
): Promise<Uint8Array> {
  const controller = new AbortController()
  const onOuter = (): void => controller.abort()
  outer.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => controller.abort(), limits.fetchMs)
  try {
    let current = url
    for (let hop = 0; ; hop++) {
      let res: Response
      try {
        res = await deps.fetch(current, {
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
          headers: { accept: 'image/*,*/*;q=0.8' },
        })
      } catch (error) {
        throw new SourceError(
          'fetch_failed',
          controller.signal.aborted ? 'timed out' : `request failed (${String(error)})`,
        )
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location)
          throw new SourceError('fetch_failed', `HTTP ${res.status} without a location`)
        if (hop >= limits.redirects) throw new SourceError('fetch_failed', 'too many redirects')
        const next = new URL(location, current)
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new SourceError('fetch_failed', 'redirected to a non-http URL')
        }
        current = next.href
        continue
      }
      if (res.type === 'opaqueredirect' || res.status === 0) {
        throw new SourceError('fetch_failed', 'redirect could not be followed')
      }
      if (res.status === 404 || res.status === 410) {
        throw new SourceError('not_found', `HTTP ${res.status}`)
      }
      if (!res.ok) throw new SourceError('fetch_failed', `HTTP ${res.status}`)
      return await readBody(res, limits.sourceBytes, () => controller.abort())
    }
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', onOuter)
  }
}

async function readLocal(
  path: string,
  deps: AssetResolverDeps,
  limits: typeof ASSET_LIMITS,
): Promise<Uint8Array> {
  let info: { isFile(): boolean; size: number }
  try {
    info = await (deps.stat ?? stat)(path)
  } catch {
    throw new SourceError('not_found', 'no such file')
  }
  if (!info.isFile()) throw new SourceError('not_found', 'not a regular file')
  if (info.size > limits.sourceBytes) {
    throw new SourceError(
      'too_large',
      `larger than ${Math.round(limits.sourceBytes / 1024 / 1024)} MB`,
    )
  }
  try {
    return await (deps.readFile ?? ((p: string) => readFile(p)))(path)
  } catch (error) {
    throw new SourceError('not_found', `could not read the file (${String(error)})`)
  }
}

/**
 * Resolve every distinct source that main handles (sources left to the renderer are not in the
 * result). Never throws: failures are `{ error, message }` entries.
 */
export async function resolveImageSources(
  sources: readonly string[],
  deps: AssetResolverDeps,
  signal?: AbortSignal,
): Promise<Record<string, ResolvedSource>> {
  const limits = { ...ASSET_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const started = now()
  const out: Record<string, ResolvedSource> = {}
  let budgetBytes = 0
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const budgetTimer = setTimeout(() => controller.abort(), limits.callMs)
  try {
    for (const source of [...new Set(sources)]) {
      const kind = classifySource(source)
      if (kind.kind === 'renderer') continue
      if (kind.kind === 'unsupported') {
        out[source] = { error: 'unsupported_source', message: kind.reason }
        continue
      }
      if (
        controller.signal.aborted ||
        now() - started > limits.callMs ||
        budgetBytes > limits.callBytes
      ) {
        out[source] = {
          error: 'budget',
          message: 'image budget for this call used up (45 s / 64 MB); add it in another call',
        }
        continue
      }
      try {
        const bytes =
          kind.kind === 'file'
            ? await readLocal(kind.path, deps, limits)
            : await fetchBytes(kind.url, deps, limits, controller.signal)
        budgetBytes += bytes.byteLength
        if (budgetBytes > limits.callBytes) {
          throw new SourceError('budget', 'image budget for this call used up (64 MB)')
        }
        const sniffed = sniffImage(bytes)
        const name = sourceName(source, kind)
        if (sniffed === null) {
          throw new SourceError('unsupported_type', 'not a PNG, JPEG, WebP, GIF, AVIF or SVG image')
        }
        if (sniffed.kind === 'svg') {
          if (bytes.byteLength > limits.svgBytes) {
            throw new SourceError('too_large', 'SVG larger than 1 MB')
          }
          out[source] = { kind: 'svg', markup: new TextDecoder().decode(bytes), name }
        } else {
          const hash = await deps.putAsset(bytes, sniffed.mime)
          out[source] = { kind: 'raster', hash, mime: sniffed.mime, name }
        }
      } catch (error) {
        out[source] =
          error instanceof SourceError
            ? { error: error.code, message: error.message }
            : { error: 'fetch_failed', message: String(error) }
      }
    }
  } finally {
    clearTimeout(budgetTimer)
    signal?.removeEventListener('abort', onAbort)
  }
  return out
}

// ---------------------------------------------------------------------------
// Source collection (fallbacks when @baren/html is not available yet)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const URL_IN_CSS = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi

export function cssUrls(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(URL_IN_CSS)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (url) out.push(url)
  }
  return out
}

/** `<img src>` and `url()` in style attributes, deduped, in order (regex fallback). */
export function collectImageSourcesFallback(html: string): string[] {
  const out: string[] = []
  const tag = /<(img|[a-z][a-z0-9-]*)\b([^>]*)>/gi
  for (const m of html.matchAll(tag)) {
    const name = (m[1] ?? '').toLowerCase()
    const attrs = m[2] ?? ''
    for (const a of attrs.matchAll(
      /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
    )) {
      const attr = (a[1] ?? '').toLowerCase()
      const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')
      if (name === 'img' && attr === 'src' && value.trim()) out.push(value.trim())
      if (attr === 'style') out.push(...cssUrls(value))
    }
  }
  return [...new Set(out)]
}

export function collectCssUrlsFallback(styles: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const value of Object.values(styles)) {
    if (typeof value === 'string') out.push(...cssUrls(value))
  }
  return [...new Set(out)]
}
