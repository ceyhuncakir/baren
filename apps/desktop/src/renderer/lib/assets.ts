/**
 * Asset URLs for the renderer (ARCHITECTURE.md, "Images"). Asset bytes live in the core
 * (`bridge.assets.put/get`, content hash); documents reference them by hash.
 *
 *  - Inside Electron the main process serves `baren-asset://<hash>` (right mime,
 *    immutable caching), so `assetUrl(hash)` is that URL and nothing is copied.
 *  - In browser mode (mock bridge) there is no such scheme: bytes are read from the bridge
 *    once and exposed as blob URLs (cached; revoked when the asset is reloaded).
 *
 * The canvas takes `resolveCanvasAsset` as its injected resolver; React previews use
 * `assetUrl`/`assetCss` plus `subscribeAssets` to re-render when bytes arrive.
 */
import { ASSET_URL_PREFIX, isAssetHash, rewriteAssetUrls } from '@baren/schema'
import { bridge, isMockBridge } from './bridge'

/** Placeholder for image fills whose bytes are not available (previews). */
export const MISSING_ASSET_CSS = 'linear-gradient(#E3E3E3, #E3E3E3)'

/** Magic-byte sniffing for the image types the app accepts (plus SVG). */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes
  const at = (i: number, s: string) => {
    for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false
    return true
  }
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif'
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  if (b.length >= 12 && at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis') || at(8, 'mif1')))
    return 'image/avif'
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 512))).trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head))
    return 'image/svg+xml'
  return null
}

const blobUrls = new Map<string, string>()
const loading = new Map<string, Promise<string | null>>()
/** Hashes known to be stored locally (put or read in this window). */
const present = new Set<string>()
const listeners = new Set<(hashes: readonly string[]) => void>()

function emit(hashes: readonly string[]): void {
  for (const l of listeners) l(hashes)
}

/** Called with hashes whose bytes became available (or were replaced). */
export function subscribeAssets(listener: (hashes: readonly string[]) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function registerBlob(hash: string, bytes: Uint8Array, mime: string | null): string {
  const old = blobUrls.get(hash)
  if (old) URL.revokeObjectURL(old)
  const type = mime ?? sniffImageMime(bytes) ?? ''
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
  blobUrls.set(hash, url)
  return url
}

/**
 * URL of an asset for <img>/CSS. Electron: `baren-asset://<hash>`. Browser mode: the
 * cached blob URL, or '' until `loadAssetUrl` has read the bytes.
 */
export function assetUrl(hash: string): string {
  if (!isMockBridge) return `${ASSET_URL_PREFIX}${hash}`
  return blobUrls.get(hash) ?? ''
}

/** Like `assetUrl`, but reads the bytes first in browser mode; null when they are missing. */
export function loadAssetUrl(hash: string): Promise<string | null> {
  if (!isAssetHash(hash)) return Promise.resolve(null)
  if (!isMockBridge) return Promise.resolve(`${ASSET_URL_PREFIX}${hash}`)
  const cached = blobUrls.get(hash)
  if (cached) return Promise.resolve(cached)
  let pending = loading.get(hash)
  if (!pending) {
    const read: Promise<string | null> = bridge.assets
      .get(hash)
      .then((bytes) => {
        if (!bytes) return null
        present.add(hash)
        return blobUrls.get(hash) ?? registerBlob(hash, bytes, null)
      })
      .catch(() => null)
      .finally(() => {
        if (loading.get(hash) === read) loading.delete(hash)
      })
    pending = read
    loading.set(hash, read)
  }
  return pending
}

/**
 * The canvas' asset resolver: synchronous wherever possible (Electron, cached blobs), a
 * promise while browser-mode bytes are read. null = missing (placeholder).
 */
export function resolveCanvasAsset(hash: string): string | null | Promise<string | null> {
  if (!isAssetHash(hash)) return null
  if (!isMockBridge) return `${ASSET_URL_PREFIX}${hash}`
  return blobUrls.get(hash) ?? loadAssetUrl(hash)
}

/** CSS value with asset URLs resolved for a React preview (missing → neutral fill). */
export function assetCss(value: string): string {
  if (!isMockBridge || !value.includes(ASSET_URL_PREFIX)) return value
  return rewriteAssetUrls(value, (hash) => {
    const url = blobUrls.get(hash)
    if (url) return `url("${url}")`
    void loadAssetUrl(hash).then((u) => u && emit([hash]))
    return MISSING_ASSET_CSS
  })
}

/**
 * URLs whose pixels can be drawn into a canvas that is exported afterwards (PNG copies,
 * file thumbnails): `baren-asset://` is cross-origin to the app and would taint it, so
 * inside Electron the bytes are read once and wrapped in blob URLs. `release()` revokes
 * the URLs this helper created.
 */
export function drawableAssetUrls(): {
  assetUrl: (hash: string) => Promise<string | null>
  release(): void
} {
  if (isMockBridge) return { assetUrl: loadAssetUrl, release: () => undefined }
  const created = new Map<string, Promise<string | null>>()
  return {
    assetUrl(hash) {
      let url = created.get(hash)
      if (!url) {
        url = getAssetBytes(hash).then((bytes) =>
          bytes
            ? URL.createObjectURL(
                new Blob([new Uint8Array(bytes)], { type: sniffImageMime(bytes) ?? '' }),
              )
            : null,
        )
        created.set(hash, url)
      }
      return url
    },
    release() {
      for (const url of created.values()) void url.then((u) => u && URL.revokeObjectURL(u))
      created.clear()
    },
  }
}

/** Store bytes in the core; resolves to their hash (the URL is usable right away). */
export async function putAsset(bytes: Uint8Array, mime: string): Promise<string> {
  const hash = await bridge.assets.put(bytes, mime)
  present.add(hash)
  if (isMockBridge && !blobUrls.has(hash)) registerBlob(hash, bytes, mime)
  return hash
}

/** The stored bytes, or null. */
export async function getAssetBytes(hash: string): Promise<Uint8Array | null> {
  if (!isAssetHash(hash)) return null
  const bytes = await bridge.assets.get(hash).catch(() => null)
  if (bytes) present.add(hash)
  return bytes
}

/** Whether the core has this asset (cached after the first positive answer). */
export async function hasLocalAsset(hash: string): Promise<boolean> {
  if (present.has(hash)) return true
  return (await getAssetBytes(hash)) !== null
}

/**
 * Bytes for `hash` arrived from elsewhere (downloaded from the server) and were stored:
 * drop stale blob URLs and tell listeners (the canvas reloads through its own hook).
 */
export function assetsArrived(hashes: readonly string[]): void {
  for (const hash of hashes) {
    present.add(hash)
    // A read that started before the bytes arrived may have found nothing.
    loading.delete(hash)
    const old = blobUrls.get(hash)
    if (old) {
      URL.revokeObjectURL(old)
      blobUrls.delete(hash)
    }
  }
  if (hashes.length > 0) emit(hashes)
}

/** Test/teardown helper: forget cached URLs (revokes blob URLs). */
export function resetAssetCache(): void {
  for (const url of blobUrls.values()) URL.revokeObjectURL(url)
  blobUrls.clear()
  loading.clear()
  present.clear()
}
