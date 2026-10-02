/**
 * Update feed URL (electron-updater generic provider). Fixed at build time:
 * `VITE_UPDATE_URL`, else `<VITE_SERVER_URL>/updates/` (the server serves `UPDATES_DIR` there),
 * else the default local server. `BAREN_UPDATE_URL` overrides it at run time (staging, tests).
 */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787'

export interface FeedSources {
  /** `BAREN_UPDATE_URL` (run time). */
  override?: string | null | undefined
  /** `VITE_UPDATE_URL` (build time). */
  updateUrl?: string | null | undefined
  /** `VITE_SERVER_URL` (build time). */
  serverUrl?: string | null | undefined
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function parseHttpUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || url.username || url.password) return null
  return url
}

/**
 * The feed as a directory URL: the generic provider resolves `latest-linux.yml` and the
 * artifacts relative to it, so it must end with `/` (otherwise the last segment is replaced).
 */
export function asFeedBase(value: string): string | null {
  const url = parseHttpUrl(value)
  if (!url) return null
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.toString()
}

/** The update feed, or null when the configured value is not a usable http(s) URL. */
export function resolveFeedUrl(sources: FeedSources): string | null {
  const explicit = nonEmpty(sources.override) ?? nonEmpty(sources.updateUrl)
  if (explicit !== null) return asFeedBase(explicit)
  const server = parseHttpUrl(nonEmpty(sources.serverUrl) ?? DEFAULT_SERVER_URL)
  if (!server) return null
  server.search = ''
  server.hash = ''
  server.pathname = `${server.pathname.replace(/\/+$/, '')}/updates/`
  return server.toString()
}
