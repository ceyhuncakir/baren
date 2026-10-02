/**
 * Image sources of write tools (contract §4.8, §7.8): main pre-resolves files and URLs into core
 * assets (`AgentRequest.assets`); the host decodes `data:` URIs (stored with
 * `bridge.assets.put`), checks `baren-asset://<hash>` sources, and reads natural sizes, all
 * before the call's single transaction. The renderer never reads disk or network for agents.
 */
import { ASSET_URL_PREFIX, assetCssUrl, isAssetHash, MAX_ASSET_BYTES } from '@baren/schema'
import { sniffImageMime } from '../lib/assets'
import type { ResolvedSource } from '../types/bridge'
import type { ToolCall } from './context'
import type { HtmlWarning, ResolvedImage } from './html'

export type ImageEntry = ResolvedImage | { error: string }

const DATA_RE = /^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,([\s\S]*)$/i

/** Decode a `data:` URI into bytes and its declared mime. */
export function decodeDataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
  const m = DATA_RE.exec(uri.trim())
  if (!m) return null
  const mime = (m[1] || 'text/plain').toLowerCase()
  const payload = m[4] ?? ''
  try {
    if (m[3]) {
      const bin = atob(payload.replace(/\s+/g, ''))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return { mime, bytes }
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) }
  } catch {
    return null
  }
}

function svgMarkupOf(bytes: Uint8Array): string | null {
  const text = new TextDecoder().decode(bytes)
  return /<svg[\s>]/i.test(text) ? text : null
}

function nameOfSource(src: string): string {
  if (src.startsWith('data:') || src.startsWith(ASSET_URL_PREFIX)) return 'Image'
  const last = src.split(/[?#]/)[0]?.split('/').pop() ?? ''
  const base = decodeURIComponent(last).replace(/\.[A-Za-z0-9]+$/, '')
  return base || 'Image'
}

/**
 * Resolve every source (`<img src>` and CSS `url()` values) the call uses. `withSize` lists the
 * sources whose natural size is needed (images without an explicit size).
 */
export async function resolveImageSources(
  call: ToolCall,
  sources: Iterable<string>,
  withSize: ReadonlySet<string> = new Set(),
): Promise<Map<string, ImageEntry>> {
  const out = new Map<string, ImageEntry>()
  const { env } = call
  const size = async (hash: string, src: string) => {
    if (!withSize.has(src) || !env.assets.naturalSize) return null
    try {
      return await env.assets.naturalSize(hash)
    } catch {
      return null
    }
  }
  for (const src of new Set(sources)) {
    if (call.signal.aborted) break
    const pre: ResolvedSource | undefined = call.assets[src]
    if (pre) {
      if ('error' in pre) out.set(src, { error: pre.message || pre.error })
      else if (pre.kind === 'svg') out.set(src, { kind: 'svg', markup: pre.markup, name: pre.name })
      else {
        const s = await size(pre.hash, src)
        out.set(src, {
          kind: 'raster',
          hash: pre.hash,
          mime: pre.mime,
          name: pre.name,
          width: s?.width ?? null,
          height: s?.height ?? null,
        })
      }
      continue
    }
    const trimmed = src.trim()
    if (trimmed.startsWith('data:')) {
      const data = decodeDataUri(trimmed)
      if (!data) {
        out.set(src, { error: 'The data: URI could not be decoded.' })
        continue
      }
      if (data.bytes.length > MAX_ASSET_BYTES) {
        out.set(src, { error: 'The image is larger than 20 MB.' })
        continue
      }
      const sniffed = sniffImageMime(data.bytes)
      if (sniffed === 'image/svg+xml' || data.mime === 'image/svg+xml') {
        const markup = svgMarkupOf(data.bytes)
        out.set(src, markup ? { kind: 'svg', markup, name: 'SVG' } : { error: 'Not an SVG image.' })
        continue
      }
      if (!sniffed) {
        out.set(src, { error: 'Unsupported image type (use PNG, JPEG, WebP, GIF, AVIF or SVG).' })
        continue
      }
      const hash = await env.assets.put(data.bytes, sniffed)
      const s = await size(hash, src)
      out.set(src, {
        kind: 'raster',
        hash,
        mime: sniffed,
        name: 'Image',
        width: s?.width ?? null,
        height: s?.height ?? null,
      })
      continue
    }
    if (trimmed.startsWith(ASSET_URL_PREFIX)) {
      const hash = trimmed.slice(ASSET_URL_PREFIX.length).replace(/\/+$/, '').toLowerCase()
      const bytes = isAssetHash(hash) ? await env.assets.get(hash).catch(() => null) : null
      if (!bytes) {
        out.set(src, { error: `Asset ${hash} is not on this computer.` })
        continue
      }
      const mime = sniffImageMime(bytes)
      if (mime === 'image/svg+xml') {
        const markup = svgMarkupOf(bytes)
        out.set(src, markup ? { kind: 'svg', markup, name: 'SVG' } : { error: 'Not an SVG image.' })
        continue
      }
      const s = await size(hash, src)
      out.set(src, {
        kind: 'raster',
        hash,
        mime: mime ?? 'application/octet-stream',
        name: nameOfSource(src),
        width: s?.width ?? null,
        height: s?.height ?? null,
      })
      continue
    }
    // Anything else is unknown here (the applier reports it as unresolved).
  }
  return out
}

const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi

/** The sources of `url()` references in a CSS value. */
export function cssUrls(value: string): string[] {
  const out: string[] = []
  URL_RE.lastIndex = 0
  for (let m = URL_RE.exec(value); m !== null; m = URL_RE.exec(value)) {
    const src = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (src) out.push(src)
  }
  return out
}

/**
 * Rewrite `url()` sources in a style record to stored assets (`url("baren-asset://<hash>")`);
 * properties with an unresolvable (or SVG) source are removed with an `image-unresolved`
 * warning (contract §7.6 rule 7).
 */
export function rewriteStyleUrls(
  styles: Record<string, unknown>,
  images: ReadonlyMap<string, ImageEntry>,
): { styles: Record<string, string | number | null>; warnings: HtmlWarning[] } {
  const out: Record<string, string | number | null> = {}
  const warnings: HtmlWarning[] = []
  for (const [key, raw] of Object.entries(styles)) {
    if (raw === null || raw === undefined) {
      out[key] = null
      continue
    }
    if (typeof raw === 'number') {
      out[key] = raw
      continue
    }
    if (typeof raw !== 'string') continue
    if (!/url\(/i.test(raw)) {
      out[key] = raw
      continue
    }
    const state: { failed: string | null } = { failed: null }
    const value = raw.replace(URL_RE, (whole, a?: string, b?: string, c?: string) => {
      const src = (a ?? b ?? c ?? '').trim()
      if (src.startsWith(ASSET_URL_PREFIX)) {
        const hash = src.slice(ASSET_URL_PREFIX.length).replace(/\/+$/, '').toLowerCase()
        if (isAssetHash(hash)) return assetCssUrl(hash)
      }
      const entry = images.get(src)
      if (entry && 'kind' in entry && entry.kind === 'raster') return assetCssUrl(entry.hash)
      state.failed =
        entry && 'error' in entry
          ? entry.error
          : entry
            ? 'SVG images cannot be used as fills; use an <svg> or <img> layer.'
            : `The image ${JSON.stringify(src.slice(0, 120))} could not be loaded.`
      return whole
    })
    if (state.failed !== null) {
      warnings.push({
        code: 'image-unresolved',
        message: `${key} was dropped: ${state.failed}`,
        property: key,
      })
      continue
    }
    out[key] = value
  }
  return { styles: out, warnings }
}
