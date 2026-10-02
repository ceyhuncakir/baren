/**
 * Color values as the inspector sees them: a literal (hex + alpha) or a token reference
 * (`var(--color-x)`), plus helpers to find and replace colors inside composite values
 * (borders, outlines, shadows). Pure and unit-tested.
 */

export interface LiteralColor {
  kind: 'literal'
  /** Uppercase RRGGBB without '#'. */
  hex: string
  /** 0..1 */
  alpha: number
}

export interface TokenColor {
  kind: 'token'
  /** CSS variable name, e.g. `--color-background`. */
  token: string
  /** Fallback inside `var(--x, fallback)`, if any. */
  fallback: string | null
}

export type ColorValue = LiteralColor | TokenColor

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgba?\(\s*([^)]+)\)$/i
const VAR_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)$/

const NAMED: Record<string, string> = {
  white: 'FFFFFF',
  black: '000000',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  gray: '808080',
  grey: '808080',
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function hex2(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

/** Parse one CSS color. Unsupported syntax (hsl(), color-mix()) → null. */
export function parseColor(input: string): ColorValue | null {
  const s = input.trim()
  const v = VAR_RE.exec(s)
  if (v) return { kind: 'token', token: v[1] as string, fallback: v[2]?.trim() || null }
  if (s.toLowerCase() === 'transparent') return { kind: 'literal', hex: '000000', alpha: 0 }
  const named = NAMED[s.toLowerCase()]
  if (named) return { kind: 'literal', hex: named, alpha: 1 }
  const h = HEX_RE.exec(s)
  if (h) {
    let body = (h[1] as string).toUpperCase()
    if (body.length <= 4) body = [...body].map((c) => c + c).join('')
    const alpha = body.length === 8 ? parseInt(body.slice(6), 16) / 255 : 1
    return { kind: 'literal', hex: body.slice(0, 6), alpha: Math.round(alpha * 1000) / 1000 }
  }
  const r = RGB_RE.exec(s)
  if (r) {
    const parts = (r[1] as string).split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channel = (p: string): number =>
      p.endsWith('%') ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p)
    const [rr, gg, bb] = parts.slice(0, 3).map(channel)
    if ([rr, gg, bb].some((n) => n === undefined || !Number.isFinite(n))) return null
    let alpha = 1
    const a = parts[3]
    if (a !== undefined) alpha = a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a)
    if (!Number.isFinite(alpha)) return null
    return {
      kind: 'literal',
      hex: hex2(rr ?? 0) + hex2(gg ?? 0) + hex2(bb ?? 0),
      alpha: clamp01(alpha),
    }
  }
  return null
}

/** `#RRGGBB` or `#RRGGBBAA` (alpha < 1). */
export function formatColor(hex: string, alpha = 1): string {
  const a = clamp01(alpha)
  return a >= 1 ? `#${hex.toUpperCase()}` : `#${hex.toUpperCase()}${hex2(a * 255)}`
}

export function tokenRef(token: string): string {
  return `var(${token})`
}

/** Short name shown in chips: `--color-background` → `background`. */
export function tokenShortName(token: string): string {
  if (token.startsWith('--color-')) return token.slice('--color-'.length)
  return token.replace(/^--/, '')
}

/** Resolve a color against the document's tokens (one level of indirection is enough). */
export function resolveColor(
  value: ColorValue,
  tokens: Record<string, { value: string | number }>,
): LiteralColor | null {
  if (value.kind === 'literal') return value
  const t = tokens[value.token]
  const raw = t ? String(t.value) : value.fallback
  if (!raw) return null
  const parsed = parseColor(raw)
  return parsed?.kind === 'literal' ? parsed : null
}

// ---------------------------------------------------------------------------
// Colors inside composite values
// ---------------------------------------------------------------------------

/**
 * Matches the color-like fragments of a composite CSS value: hex, rgb()/rgba(),
 * var(--x[, fallback]) and the named colors above.
 */
const FRAGMENT_RE =
  /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)|\b(?:white|black|transparent)\b/g

export interface ColorFragment {
  /** Exact text in the value. */
  text: string
  index: number
  color: ColorValue
}

export function findColors(value: string): ColorFragment[] {
  const out: ColorFragment[] = []
  for (const m of value.matchAll(FRAGMENT_RE)) {
    const color = parseColor(m[0])
    if (color) out.push({ text: m[0], index: m.index ?? 0, color })
  }
  return out
}

/** Stable identity of a color for grouping ("token:--x" or "hex:RRGGBB@alpha"). */
export function colorKey(color: ColorValue): string {
  return color.kind === 'token' ? `token:${color.token}` : `hex:${color.hex}@${color.alpha}`
}

/** Replace every fragment equal to `from` (by key) with `to` (CSS text). */
export function replaceColor(value: string, fromKey: string, to: string): string {
  let out = ''
  let last = 0
  for (const f of findColors(value)) {
    if (colorKey(f.color) !== fromKey) continue
    out += value.slice(last, f.index) + to
    last = f.index + f.text.length
  }
  return last === 0 ? value : out + value.slice(last)
}
