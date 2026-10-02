/**
 * Pure parts of the `baren-asset://<hash>` scheme (unit-tested without Electron): URL and
 * hash validation, the served content type, range requests and the response itself.
 *
 * Assets are content-addressed (blake3 hex), so a response never changes: it is cached as
 * immutable. Unknown hashes are 404 and never cached (the bytes may arrive later from a
 * collaborator). Responses carry CORS `*` so `crossOrigin` images do not taint canvases.
 */
export const ASSET_SCHEME = 'baren-asset'

const HASH_RE = /^[0-9a-f]{64}$/

export interface AssetEntry {
  bytes: Uint8Array
  /** The mime type stored with the asset. */
  mime: string
}

export type AssetLookup = (hash: string) => Promise<AssetEntry | null>

export function isAssetHash(value: string): boolean {
  return HASH_RE.test(value)
}

/**
 * `baren-asset://<hash>` (Chromium normalises it to `…/<hash>/`) → the hash, or null.
 * The hash is the host; any path other than `/`, credentials or a port are rejected.
 * Query strings and fragments are ignored (cache busting).
 */
export function parseAssetUrl(requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${ASSET_SCHEME}:`) return null
  if (url.username || url.password || url.port) return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  const hash = url.hostname.toLowerCase()
  return isAssetHash(hash) ? hash : null
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/
const SERVABLE_TYPES = new Set(['image', 'video', 'audio', 'font'])
export const FALLBACK_MIME = 'application/octet-stream'

/**
 * The Content-Type to serve: the stored mime when it is a well-formed image/video/audio/font
 * type (parameters dropped), else `application/octet-stream` — never a document type.
 */
export function servableMime(mime: string | null | undefined): string {
  const essence = (mime ?? '').split(';')[0]!.trim().toLowerCase()
  if (!MIME_RE.test(essence)) return FALLBACK_MIME
  return SERVABLE_TYPES.has(essence.slice(0, essence.indexOf('/'))) ? essence : FALLBACK_MIME
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((b, i) => bytes[offset + i] === b)
}

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))

/** Image type from magic bytes, for assets stored without a usable mime type. */
export function sniffMime(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(bytes, ascii('ftypavif'), 4) || startsWith(bytes, ascii('ftypavis'), 4)) {
    return 'image/avif'
  }
  if (startsWith(bytes, ascii('BM'))) return 'image/bmp'
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^﻿/, '')
    .trimStart()
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) {
    return 'image/svg+xml'
  }
  return FALLBACK_MIME
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null

/**
 * A single `Range: bytes=…` (inclusive end), `'unsatisfiable'` (→ 416), or null to serve the
 * whole body (no header, multiple ranges or a malformed one — servers may ignore those).
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange {
  if (!header) return null
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!match) return null
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return null
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (start >= size) return 'unsatisfiable'
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (end < start) return null
  return { start, end }
}

export interface AssetRequest {
  method: string
  url: string
  /** The `Range` request header. */
  range?: string | null
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

function baseHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    // Should an asset ever be opened as a document (e.g. an SVG), it runs nothing.
    'Content-Security-Policy':
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  }
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: {
      ...baseHeaders(),
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  })
}

/** Answer one `baren-asset://` request from the core. */
export async function assetResponse(request: AssetRequest, lookup: AssetLookup): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' })
  }
  const hash = parseAssetUrl(request.url)
  if (hash === null) return plain(404, 'Not found')

  let entry: AssetEntry | null
  try {
    entry = await lookup(hash)
  } catch {
    return plain(503, 'Asset store unavailable')
  }
  if (entry === null) return plain(404, 'Not found')

  const { bytes } = entry
  const size = bytes.byteLength
  const mime = servableMime(entry.mime)
  const headers: Record<string, string> = {
    ...baseHeaders(),
    'Content-Type': mime === FALLBACK_MIME ? servableMime(sniffMime(bytes)) : mime,
    'Cache-Control': IMMUTABLE,
    ETag: `"${hash}"`,
    'Accept-Ranges': 'bytes',
  }

  const range = parseRange(request.range, size)
  if (range === 'unsatisfiable') {
    return plain(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` })
  }
  const body = range === null ? bytes : bytes.subarray(range.start, range.end + 1)
  headers['Content-Length'] = String(body.byteLength)
  if (range !== null) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
  const status = range === null ? 200 : 206
  // Copy into a standalone ArrayBuffer: the core may hand out views of pooled memory.
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), { status, headers })
}
