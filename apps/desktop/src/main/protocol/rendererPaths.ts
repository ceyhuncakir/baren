/** Pure parts of the app:// renderer scheme (unit-tested without Electron). */
import { isAbsolute, join, normalize, relative } from 'node:path'

export const RENDERER_SCHEME = 'app'
export const RENDERER_HOST = 'renderer'
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`
export const RENDERER_ENTRY_URL = `${RENDERER_ORIGIN}/index.html`

/**
 * Map an app:// request URL to a file under `root`, or null if it points
 * elsewhere (other host, path traversal, malformed escapes).
 */
export function resolveRendererFile(root: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== RENDERER_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  const file = normalize(join(root, pathname === '/' ? '/index.html' : pathname))
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return file
}
