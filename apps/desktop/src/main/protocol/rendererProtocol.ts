/**
 * The production renderer is served from a privileged custom scheme instead
 * of file:// so that fetch() works (streaming WASM compile for loro-crdt), the
 * page has a stable secure origin, V8 can code-cache our scripts, and HTML
 * responses can carry a real CSP header.
 */
import { normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, type CustomScheme, type Session } from 'electron'
import { RENDERER_SCHEME, resolveRendererFile } from './rendererPaths'

export { RENDERER_ENTRY_URL, RENDERER_ORIGIN } from './rendererPaths'

/** Registered (with the other privileged schemes) in `schemes.ts`, before `app.ready`. */
export const RENDERER_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true,
  },
}

export function serveRenderer(session: Session, root: string, csp: string): void {
  const rootDir = normalize(root.endsWith(sep) ? root.slice(0, -1) : root)
  session.protocol.handle(RENDERER_SCHEME, async (request) => {
    const file = resolveRendererFile(rootDir, request.url)
    if (file === null) return new Response('Not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(file).toString())
    if (!file.endsWith('.html')) return response
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', csp)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, { status: response.status, headers })
  })
}
