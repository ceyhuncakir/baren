/**
 * Token helpers: the content hash in every result header (§4.10), `var()` renames
 * (set_tokens), the css / Tailwind v4 theme texts (§8.3) and glob matching (find_nodes,
 * get_tokens namePattern).
 */
import { formatCssNumber } from '@baren/schema'
import type { StyleValue, Token } from '@baren/schema'

function utf8(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    let c = ch.codePointAt(0) as number
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

const tokenValue = (v: StyleValue): string => (typeof v === 'number' ? formatCssNumber(v) : v)

/**
 * FNV-1a 32-bit (lowercase hex, 8 chars) over the UTF-8 bytes of the tokens sorted by name,
 * each as `name\ttype\tvalue\tdescription\n`.
 */
export function tokensHash(tokens: Record<string, Token>): string {
  let h = 0x811c9dc5
  const names = Object.keys(tokens).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names) {
    const t = tokens[name] as Token
    const line = `${name}\t${t.type}\t${tokenValue(t.value)}\t${t.description ?? ''}\n`
    for (const byte of utf8(line)) {
      h ^= byte
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Rename `var(--from…)` references to `var(--to…)`; numbers and other names unchanged. */
export function rewriteTokenRefs(value: StyleValue, from: string, to: string): StyleValue {
  if (typeof value !== 'string' || !value.includes('var(')) return value
  const f = from.startsWith('--') ? from : `--${from}`
  const t = to.startsWith('--') ? to : `--${to}`
  const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(`(var\\(\\s*)${escaped}(?![A-Za-z0-9_-])`, 'g'), `$1${t}`)
}

/**
 * `:root { … }` (css) or `@theme { … }` (Tailwind v4): one `  name: value;` line per token in
 * `order`, then any remaining tokens by name. Values verbatim.
 */
export function tokensToCss(
  tokens: Record<string, Token>,
  order: readonly string[],
  format: 'css' | 'tailwind',
): string {
  const seen = new Set<string>()
  const names: string[] = []
  for (const name of order) {
    if (tokens[name] === undefined || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  for (const name of Object.keys(tokens).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!seen.has(name)) names.push(name)
  }
  let out = format === 'css' ? ':root {\n' : '@theme {\n'
  for (const name of names) out += `  ${name}: ${tokenValue((tokens[name] as Token).value)};\n`
  return `${out}}\n`
}

/**
 * Glob match anchored to the whole value: `*` matches any run of characters (also empty).
 * Linear-time two-pointer matcher (no regular expressions, no backtracking blow-up).
 */
export function wildcardMatch(
  pattern: string,
  value: string,
  opts: { caseInsensitive?: boolean } = {},
): boolean {
  const p = opts.caseInsensitive ? pattern.toLowerCase() : pattern
  const v = opts.caseInsensitive ? value.toLowerCase() : value
  let pi = 0
  let vi = 0
  let star = -1
  let mark = 0
  while (vi < v.length) {
    if (pi < p.length && p[pi] !== '*' && p[pi] === v[vi]) {
      pi++
      vi++
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++
      mark = vi
    } else if (star !== -1) {
      pi = star + 1
      vi = ++mark
    } else return false
  }
  while (pi < p.length && p[pi] === '*') pi++
  return pi === p.length
}
