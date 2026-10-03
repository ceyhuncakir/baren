/**
 * `baren://` links delivered by the bridge (bridge.onDeepLink):
 *   baren://invite/<token> — team invite (from the server's /i/<token> page)
 *   baren://file/<file id>[/<page id>][?node=<layer id>] — a file, and a page or layer in it.
 *     The id is a team file's server id ("Copy link", via its /f/<id> page) or a local file's
 *     id (the `url` of files and pages in MCP results).
 */

export type DeepLink =
  | { kind: 'invite'; token: string }
  | { kind: 'file'; fileId: string; pageId: string | null; node: string | null }

const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/
const NODE_RE = /^[A-Za-z0-9@._~-]{1,128}$/

export function parseDeepLink(url: string): DeepLink | null {
  const match = /^baren:\/\/([a-z]+)\/([^?#]*)(?:\?([^#]*))?/i.exec(url.trim())
  if (!match) return null
  const [, host = '', rawPath = '', query = ''] = match
  let segments: string[]
  try {
    segments = rawPath
      .replace(/\/+$/, '')
      .split('/')
      .map((s) => decodeURIComponent(s))
  } catch {
    return null
  }
  const [value = '', page] = segments
  if (!TOKEN_RE.test(value)) return null
  switch (host.toLowerCase()) {
    case 'invite':
      return segments.length === 1 ? { kind: 'invite', token: value } : null
    case 'file': {
      if (segments.length > 2 || (page !== undefined && !NODE_RE.test(page))) return null
      const node = new URLSearchParams(query).get('node')
      return {
        kind: 'file',
        fileId: value,
        pageId: page ?? null,
        node: node && NODE_RE.test(node) ? node : null,
      }
    }
    default:
      return null
  }
}
