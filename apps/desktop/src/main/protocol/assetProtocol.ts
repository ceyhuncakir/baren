/**
 * `baren-asset://<hash>`: image bytes from the active core backend (native or JS), for
 * `<img src>` and CSS `url()` in the renderer (image layers and image fills). Registered for
 * every session that renders the app, in development too. Nothing is added to the bridge.
 */
import type { CustomScheme, Session } from 'electron'
import type { Logger } from '../log'
import { ASSET_SCHEME, assetResponse, type AssetLookup } from './assetRequest'

export { ASSET_SCHEME } from './assetRequest'

export const ASSET_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: ASSET_SCHEME,
  privileges: {
    // A host (the hash) and relative-URL resolution like http; also required for fetch().
    standard: true,
    // A secure context, so app:// pages load it without mixed-content blocking.
    secure: true,
    supportFetchAPI: true,
    // Cross-origin fetch()/crossOrigin images from app:// (answered with CORS `*`).
    corsEnabled: true,
    // Streamed bodies and range requests for media elements.
    stream: true,
  },
}

export function serveAssets(session: Session, lookup: AssetLookup, log: Logger): void {
  session.protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      return await assetResponse(
        { method: request.method, url: request.url, range: request.headers.get('range') },
        lookup,
      )
    } catch (error) {
      log.warn('asset request failed', String(error))
      return new Response('Internal error', {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  })
}
