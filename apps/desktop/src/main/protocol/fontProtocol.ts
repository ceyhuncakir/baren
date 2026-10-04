/**
 * `baren-font://google/s/<family>/<version>/<file>`: Google Fonts files for `FontFace` sources
 * in every renderer (editor, headless hosts, the agent render window), downloaded once and then
 * served from `<userData>/fonts/google/` (`fonts/googleFonts.ts`). Paths are versioned by Google,
 * so responses are immutable.
 */
import type { CustomScheme, Session } from 'electron'
import type { Logger } from '../log'
import { FONT_SCHEME, fontPathOf } from '../../renderer/lib/fontUrls'

export const FONT_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: FONT_SCHEME,
  privileges: {
    standard: true,
    // A secure context, so app:// pages load it without mixed-content blocking.
    secure: true,
    supportFetchAPI: true,
    // Fonts are always fetched in CORS mode (answered with CORS `*`).
    corsEnabled: true,
  },
}

const FONT_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
}

export function serveFonts(
  session: Session,
  file: (path: string) => Promise<Uint8Array | null>,
  log: Logger,
): void {
  session.protocol.handle(FONT_SCHEME, async (request) => {
    const path = fontPathOf(request.url)
    if (path === null || request.method !== 'GET') {
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
    try {
      const bytes = await file(path)
      if (bytes === null) {
        return new Response('Not available', {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
        })
      }
      const ext = path.slice(path.lastIndexOf('.') + 1)
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': FONT_TYPES[ext] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      log.warn('font request failed', String(error))
      return new Response('Internal error', {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  })
}
