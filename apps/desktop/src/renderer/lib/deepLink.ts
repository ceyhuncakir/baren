/**
 * `baren://` links delivered by the bridge (bridge.onDeepLink):
 *   baren://invite/<token>   — team invite (from the server's /i/<token> page)
 *   baren://auth/<userCode>  — "continue in browser" finished; poll right away
 */

export type DeepLink = { kind: 'invite'; token: string } | { kind: 'auth'; code: string }

const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/
const CODE_RE = /^[A-Za-z0-9-]{1,32}$/

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
    case 'auth':
      return CODE_RE.test(value) ? { kind: 'auth', code: value.toUpperCase() } : null
    default:
      return null
  }
}
