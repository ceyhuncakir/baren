/**
 * Production Content-Security-Policy for the renderer (served from app://).
 *
 * - `'wasm-unsafe-eval'`: loro-crdt compiles WebAssembly; no JS eval is allowed.
 * - `style-src 'unsafe-inline'`: React/CSS-module runtime style attributes and
 *   injected <style> tags. Scripts stay strictly same-origin.
 * - `connect-src`: the sync server's HTTP and WebSocket origins only.
 * - `blob:`/`data:` for images, fonts and workers built from local data
 *   (thumbnails, image assets, canvas bitmap stand-ins).
 * - `baren-asset:` (main serves stored image assets by hash) for images, media and
 *   fetch(). Remote images from the server origin stay allowed in img-src.
 * - `baren-font:` (main serves cached Google Fonts files) for the fonts designs use.
 */
import { FONT_SCHEME } from '../../renderer/lib/fontUrls'
import { ASSET_SCHEME } from '../protocol/assetRequest'

const ASSET_SOURCE = `${ASSET_SCHEME}:`
const FONT_SOURCE = `${FONT_SCHEME}:`

export function serverOrigins(serverUrl: string): string[] {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return []
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
  const ws = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return [`${url.protocol}//${url.host}`, `${ws}//${url.host}`]
}

export function buildCsp(serverUrl: string): string {
  const server = serverOrigins(serverUrl)
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ASSET_SOURCE, ...server.slice(0, 1)],
    'font-src': ["'self'", 'data:', FONT_SOURCE],
    'connect-src': ["'self'", ASSET_SOURCE, ...server],
    'worker-src': ["'self'", 'blob:'],
    'media-src': ["'self'", 'data:', 'blob:', ASSET_SOURCE],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ')
}
