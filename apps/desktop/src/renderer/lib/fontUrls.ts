/**
 * `baren-font://google/…` URLs (Google Fonts files served by main, `main/protocol/fontProtocol.ts`)
 * and the face descriptors renderers register. Separate from the catalog so main's protocol
 * handler does not load it at startup.
 */
/** One `@font-face` of a family, its file served by main over `baren-font://`. */
export interface FontFaceSpec {
  style: 'normal' | 'italic'
  /** "400" or "100 900". */
  weight: string
  /** Absent when the face covers every character. */
  unicodeRange?: string
  /** `baren-font://google/s/<family>/<version>/<file>`. */
  url: string
}

export const FONT_SCHEME = 'baren-font'
const FILE_HOST = 'https://fonts.gstatic.com'
/** gstatic paths main may download (and the shape of every `baren-font://google` path). */
const FILE_PATH_RE = /^\/s\/[a-z0-9_-]+\/v\d+\/[A-Za-z0-9_-]+\.(?:woff2|woff|ttf)$/

/** `https://fonts.gstatic.com/s/…` → `baren-font://google/s/…`, or null for any other URL. */
export function fontUrlOf(fileUrl: string): string | null {
  if (!fileUrl.startsWith(`${FILE_HOST}/`)) return null
  const path = fileUrl.slice(FILE_HOST.length)
  return FILE_PATH_RE.test(path) ? `${FONT_SCHEME}://google${path}` : null
}

/** `baren-font://google/s/…` → the gstatic path (`/s/…`), or null when it is not one. */
export function fontPathOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${FONT_SCHEME}:` || parsed.hostname !== 'google') return null
  if (parsed.username || parsed.password || parsed.port) return null
  return FILE_PATH_RE.test(parsed.pathname) ? parsed.pathname : null
}

/** Where a gstatic path is downloaded from. */
export function fontFileSource(path: string): string {
  return `${FILE_HOST}${path}`
}
