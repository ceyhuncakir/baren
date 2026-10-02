/**
 * Small CSS syntax helpers: declaration splitting that respects strings, parentheses and
 * `url()`, top-level value tokenising, key case conversion and `rem` → px.
 */

/** Remove `/* … *\/` comments outside strings. */
export function stripComments(text: string): string {
  if (!text.includes('/*')) return text
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote !== null) {
      out += c
      if (c === '\\' && i + 1 < text.length) out += text[++i] as string
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
      continue
    }
    out += c
  }
  return out
}

/**
 * Split `text` at top-level occurrences of `sep` (outside strings and parentheses). Empty
 * pieces are kept; callers trim and filter.
 */
export function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote !== null) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/** Declarations of a `style` attribute as `[name, value]` pairs (names as written). */
export function parseDeclarations(text: string): [string, string][] {
  const src = stripComments(text)
  const out: [string, string][] = []
  // One pass: split at top-level `;`, remember the first top-level `:` of each declaration.
  let depth = 0
  let quote: string | null = null
  let start = 0
  let colon = -1
  const flush = (end: number): void => {
    if (colon > start) {
      const name = src.slice(start, colon).trim()
      if (name !== '') out.push([name, src.slice(colon + 1, end).trim()])
    }
  }
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i)
    if (quote !== null) {
      if (c === 92 /* \ */) i++
      else if (src[i] === quote) quote = null
      continue
    }
    if (c === 34 /* " */ || c === 39 /* ' */) quote = src[i] as string
    else if (c === 40 /* ( */) depth++
    else if (c === 41 /* ) */) depth = depth > 0 ? depth - 1 : 0
    else if (depth === 0) {
      if (c === 58 /* : */ && colon === -1) colon = i
      else if (c === 59 /* ; */) {
        flush(i)
        start = i + 1
        colon = -1
      }
    }
  }
  flush(src.length)
  return out
}

/** Index of the first top-level `ch`, or -1. */
export function topLevelIndex(text: string, ch: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote !== null) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ch && depth === 0) return i
  }
  return -1
}

/** Top-level whitespace-separated tokens (`calc(1px + 2px)` and strings stay whole). */
export function splitValues(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string
    if (quote !== null) {
      cur += c
      if (c === '\\' && i + 1 < value.length) cur += value[++i] as string
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '(') {
      depth++
      cur += c
    } else if (c === ')') {
      depth = Math.max(0, depth - 1)
      cur += c
    } else if (depth === 0 && /\s/.test(c)) {
      if (cur !== '') out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur !== '') out.push(cur)
  return out
}

/** `!important` (any spacing/case) stripped from the end of a value. */
export function stripImportant(value: string): string {
  if (!value.includes('!')) return value.trim()
  return value.replace(/\s*!\s*important\s*$/i, '').trim()
}

const CAMEL_CACHE = new Map<string, string>()

/** CSS property name (as written) → camelCase key; custom properties stay verbatim. */
export function toCamelKey(name: string): string {
  if (name.startsWith('--')) return name
  const hit = CAMEL_CACHE.get(name)
  if (hit !== undefined) return hit
  const out = camelize(name)
  if (CAMEL_CACHE.size < 4096) CAMEL_CACHE.set(name, out)
  return out
}

function camelize(name: string): string {
  let n = name.trim().toLowerCase()
  let prefix = ''
  if (n.startsWith('-webkit-')) {
    prefix = 'Webkit'
    n = n.slice(8)
  } else if (n.startsWith('-moz-')) {
    prefix = 'Moz'
    n = n.slice(5)
  } else if (n.startsWith('-ms-')) {
    prefix = 'ms'
    n = n.slice(4)
  } else if (n.startsWith('-o-')) {
    prefix = 'O'
    n = n.slice(3)
  }
  const camel = n.replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase())
  if (prefix === '') return camel
  return prefix + camel.charAt(0).toUpperCase() + camel.slice(1)
}

/** Record keys: camelCase stays, kebab-case is converted. */
export function recordKey(key: string): string {
  if (key.startsWith('--')) return key
  if (key.includes('-')) return toCamelKey(key)
  return key
}

/**
 * Apply `fn` to the parts of `value` outside quoted strings and `url(…)` tokens (so data URIs
 * and file names are never rewritten).
 */
export function mapOutsideStrings(value: string, fn: (part: string) => string): string {
  let out = ''
  let plain = ''
  let i = 0
  const flush = (): void => {
    if (plain !== '') out += fn(plain)
    plain = ''
  }
  while (i < value.length) {
    const c = value[i] as string
    if (c === '"' || c === "'") {
      flush()
      let j = i + 1
      while (j < value.length && value[j] !== c) j += value[j] === '\\' ? 2 : 1
      out += value.slice(i, j + 1)
      i = j + 1
      continue
    }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(value.slice(i, i + 4))) {
      flush()
      const end = urlEnd(value, i + 4)
      out += value.slice(i, end)
      i = end
      continue
    }
    plain += c
    i++
  }
  flush()
  return out
}

/** Index just past the `)` that closes a `url(` whose content starts at `from`. */
function urlEnd(value: string, from: number): number {
  let i = from
  while (i < value.length && /\s/.test(value[i] as string)) i++
  const q = value[i]
  if (q === '"' || q === "'") {
    let j = i + 1
    while (j < value.length && value[j] !== q) j += value[j] === '\\' ? 2 : 1
    const close = value.indexOf(')', j + 1)
    return close === -1 ? value.length : close + 1
  }
  const close = value.indexOf(')', i)
  return close === -1 ? value.length : close + 1
}

/** Round to 2 decimals, never `-0`. */
export function round2(n: number): number {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

const REM_RE = /(^|[\s(,/*+])(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)rem(?![\w-])/gi

/** `1.5rem` → `24px` (×16, 2 decimals) wherever it appears outside strings and urls. */
export function remToPx(value: string): string {
  if (!/rem/i.test(value)) return value
  return mapOutsideStrings(value, (part) =>
    part.replace(
      REM_RE,
      (_m, pre: string, num: string) => `${pre}${String(round2(Number(num) * 16))}px`,
    ),
  )
}

const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)"']*?))\s*\)/gi

/** Sources of the `url(…)` tokens in a CSS value, in order (unescaped, trimmed). */
export function cssUrls(value: string): string[] {
  if (!/url\(/i.test(value)) return []
  const out: string[] = []
  for (const m of value.matchAll(URL_RE)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? ''
    out.push(raw.replace(/\\(.)/g, '$1').trim())
  }
  return out
}

/** Replace each `url(…)` token with `map(source)`; `null` from `map` keeps the token. */
export function replaceCssUrls(value: string, map: (src: string) => string | null): string {
  if (!/url\(/i.test(value)) return value
  return value.replace(URL_RE, (whole, a?: string, b?: string, c?: string) => {
    const src = (a ?? b ?? c ?? '').replace(/\\(.)/g, '$1').trim()
    const next = map(src)
    return next === null ? whole : next
  })
}

/** `var(--name` references in a value, in order (names include the `--`). */
export function varNames(value: string): string[] {
  if (!value.includes('var(')) return []
  const out: string[] = []
  for (const m of value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) out.push(m[1] as string)
  return out
}
