/**
 * `baren://` links delivered by the bridge (bridge.onDeepLink):
 *   baren://invite/<token>   — team invite (from the server's /i/<token> page)
 */

export type DeepLink = { kind: 'invite'; token: string }

const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/

export function parseDeepLink(url: string): DeepLink | null {
  const match = /^baren:\/\/([a-z]+)\/([^?#]*)/i.exec(url.trim())
  if (!match) return null
  const [, host = '', rawPath = ''] = match
  let value: string
  try {
    value = decodeURIComponent(rawPath.replace(/\/+$/, ''))
  } catch {
    return null
  }
  switch (host.toLowerCase()) {
    case 'invite':
      return TOKEN_RE.test(value) ? { kind: 'invite', token: value } : null
    default:
      return null
  }
}
