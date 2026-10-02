const MAX_EXTERNAL_URL_LENGTH = 8192

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** `scheme://host[:port]`, also for custom schemes (where `URL.origin` is "null"). */
export function originOf(url: string): string | null {
  const u = parse(url)
  if (!u || !u.host) return null
  return `${u.protocol}//${u.host}`
}

/** Only plain web links may leave the app through `shell.openExternal`. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > MAX_EXTERNAL_URL_LENGTH) return false
  const u = parse(url)
  return u !== null && (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0
}

/** Whether `url` belongs to the app itself (the renderer origin in dev or production). */
export function isAppUrl(url: string, appOrigins: readonly string[]): boolean {
  const origin = originOf(url)
  return origin !== null && appOrigins.includes(origin)
}
