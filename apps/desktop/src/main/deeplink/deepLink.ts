/**
 * baren:// deep links: `baren://invite/<token>` (the server's /i/<token> page) and
 * `baren://file/<file id>[/<page id>][?node=<layer id>]`: a team file's server id (its /f/<id>
 * page, from "Copy link") or a local file's id (the `url` in MCP results, with a page).
 *
 * Links arrive from the OS (argv on Linux/Windows, `open-url` on macOS) and are
 * untrusted. Only known kinds with a single URL-safe value (plus a page id for files) are
 * accepted; they are forwarded to the renderer in canonical form.
 */
export const DEEP_LINK_SCHEME = 'baren'
export const DEEP_LINK_KINDS = ['invite', 'file'] as const
export type DeepLinkKind = (typeof DEEP_LINK_KINDS)[number]

export interface DeepLink {
  kind: DeepLinkKind
  /** The invite token, or the file's id (server or local). */
  value: string
  /** File links: the page in the file, if the link names one. */
  page?: string
  /** Canonical URL handed to the renderer, e.g. `baren://invite/abc123`. */
  url: string
}

const MAX_URL_LENGTH = 4096
const VALUE_RE = /^[A-Za-z0-9._~-]{1,1024}$/
const PARAM_RE = /^[A-Za-z0-9._~-]{1,64}$/
/** A page id (Loro TreeID, `<counter>@<peer>`). */
const PAGE_RE = /^[A-Za-z0-9@._~-]{1,128}$/

function isKind(value: string): value is DeepLinkKind {
  return (DEEP_LINK_KINDS as readonly string[]).includes(value)
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string') return null
  const input = raw.trim()
  if (input.length === 0 || input.length > MAX_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  if (url.username || url.password || url.port) return null

  // `baren://invite/abc` parses with host "invite"; `baren:invite/abc` without one.
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  const kindRaw = (url.host || segments.shift() || '').toLowerCase()
  if (!isKind(kindRaw) || segments.length < 1 || segments.length > (kindRaw === 'file' ? 2 : 1))
    return null

  const value = safeDecode(segments[0] ?? '')
  if (value === null || !VALUE_RE.test(value)) return null
  const page = segments[1] === undefined ? undefined : safeDecode(segments[1])
  if (page === null || (page !== undefined && !PAGE_RE.test(page))) return null

  // Keep simple query parameters (e.g. a `state` value), re-encoded canonically.
  const params = new URLSearchParams()
  for (const [key, val] of url.searchParams) {
    if (!PARAM_RE.test(key) || val.length > 1024) return null
    params.append(key, val)
  }
  const query = params.toString()
  const path = page === undefined ? value : `${value}/${encodeURIComponent(page)}`
  return {
    kind: kindRaw,
    value,
    ...(page !== undefined ? { page } : {}),
    url: `${DEEP_LINK_SCHEME}://${kindRaw}/${path}${query ? `?${query}` : ''}`,
  }
}

/**
 * The deep link passed on a command line (cold start, or `second-instance` on
 * Linux/Windows). Chromium may insert its own switches, so every argument is
 * scanned; the last valid link wins.
 */
export function findDeepLinkInArgv(argv: readonly string[]): DeepLink | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]
    if (arg === undefined || !arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) continue
    const link = parseDeepLink(arg)
    if (link) return link
  }
  return null
}

/**
 * Whether a Windows dev run may make itself the baren:// handler, given the app that handles
 * the links now (`app.getApplicationNameForProtocol`): nobody, or another dev run ("Electron",
 * e.g. from a moved checkout). An installed build keeps them unless `force`
 * (BAREN_REGISTER_PROTOCOL=1).
 */
export function devMayClaimScheme(owner: string, force: boolean): boolean {
  return force || owner === '' || owner === 'Electron'
}
