/** Small string helpers shared by display components. */

/**
 * Initials for avatars. The default is one uppercase letter ("ceyhun cakir" → "C"); pass
 * `max = 2` for two-letter initials.
 */
export function getInitials(name: string, max = 1): string {
  const words = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  return words
    .slice(0, max)
    .map((w) => (w[0] ?? '').toLocaleUpperCase())
    .join('')
}

/**
 * One-time codes: keep digits/letters only, uppercase, cut to `length`. Codes are
 * numeric by default (artboard 20); pass `alphanumeric` for device codes like "KQ7-4XM".
 */
export function sanitizeCode(raw: string, length: number, alphanumeric = false): string {
  const re = alphanumeric ? /[^0-9A-Z]/g : /[^0-9]/g
  return raw.toUpperCase().replace(re, '').slice(0, length)
}

/**
 * The code after an edit of a code field whose value was `previous`. Like `sanitizeCode`,
 * except that a whole new code pasted (or autofilled) after a complete one — the caret sits
 * at the end of a full field — replaces it instead of being cut off behind the old code.
 */
export function nextCode(
  raw: string,
  previous: string,
  length: number,
  alphanumeric = false,
): string {
  const all = sanitizeCode(raw, Number.MAX_SAFE_INTEGER, alphanumeric)
  if (all.length > length && previous.length === length && all.startsWith(previous)) {
    const added = all.slice(previous.length)
    if (added.length >= length) return added.slice(0, length)
  }
  return all.slice(0, length)
}

/** Splits "482703" into ["482", "703"] for grouped display. */
export function groupCode(code: string, groupSize: number): string[] {
  if (groupSize <= 0) return [code]
  const out: string[] = []
  for (let i = 0; i < code.length; i += groupSize) out.push(code.slice(i, i + groupSize))
  return out
}

/** Stable color for a user from their id/name, drawn from the artboard palette. */
const AVATAR_COLORS = ['#F04E1E', '#1A1A1A', '#2F80FF', '#16833F', '#7C3AED', '#CA8A04', '#D7263D']

export function avatarColorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? '#F04E1E'
}
