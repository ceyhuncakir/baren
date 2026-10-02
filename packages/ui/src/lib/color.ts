/**
 * Color math for the inspector and color picker. Hex strings are uppercase without '#'
 * (that is how the inspector shows them: "2F80FF"); alpha is 0..1.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** h: 0..360, s/v: 0..1, a: 0..1 */
export interface Hsva {
  h: number
  s: number
  v: number
  a: number
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Normalizes user input into a 6-digit uppercase hex ("2f8" → "22FF88"). Returns null for
 * anything that is not a hex color. Alpha digits, when present, are dropped (opacity is a
 * separate field in the inspector).
 */
export function normalizeHex(input: string): string | null {
  const match = HEX_RE.exec(input.trim())
  if (!match) return null
  let hex = (match[1] ?? '').toUpperCase()
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return hex.slice(0, 6)
}

export function hexToRgb(hex: string): Rgb | null {
  const n = normalizeHex(hex)
  if (!n) return null
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  }
}

function channelHex(v: number): string {
  return Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return channelHex(r) + channelHex(g) + channelHex(b)
}

export function rgbToHsv({ r, g, b }: Rgb, hueFallback = 0): Omit<Hsva, 'a'> {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = hueFallback
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6)
    else if (max === gn) h = 60 * ((bn - rn) / d + 2)
    else h = 60 * ((rn - gn) / d + 4)
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60
  const c = v * s
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (hh < 1) [r, g, b] = [c, x, 0]
  else if (hh < 2) [r, g, b] = [x, c, 0]
  else if (hh < 3) [r, g, b] = [0, c, x]
  else if (hh < 4) [r, g, b] = [0, x, c]
  else if (hh < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

/**
 * Hex → HSVA. Grays have no hue; pass the previous hue so dragging through gray does not
 * snap the hue slider back to red.
 */
export function hexToHsva(hex: string, alpha = 1, hueFallback = 0): Hsva | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  return { ...rgbToHsv(rgb, hueFallback), a: clamp01(alpha) }
}

export function hsvaToHex({ h, s, v }: Hsva): string {
  return rgbToHex(hsvToRgb(h, s, v))
}

/** CSS color for an HSVA value (used for gradients and swatches). */
export function hsvaToCss(c: Hsva): string {
  const { r, g, b } = hsvToRgb(c.h, c.s, c.v)
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${Math.round(c.a * 1000) / 1000})`
}

/** Pure hue color (s = v = 1) as CSS, for the saturation square background. */
export function hueToCss(h: number): string {
  return `#${hsvaToHex({ h, s: 1, v: 1, a: 1 })}`
}

/** Relative luminance (WCAG) of a hex color, 0..1. */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

/**
 * Light swatches get an inset hairline so white-on-white stays visible (the designs use
 * `#00000024 0 0 0 1px inset` on background/surface/canvas swatches).
 */
export function needsSwatchBorder(hex: string): boolean {
  return luminance(hex) > 0.8
}

/** Foreground color (dark or white) that reads on top of `hex`. */
export function readableOn(hex: string): '#1A1A1A' | '#FFFFFF' {
  return luminance(hex) > 0.45 ? '#1A1A1A' : '#FFFFFF'
}

/** 0..1 → "100%" */
export function formatAlpha(a: number): string {
  return `${Math.round(clamp01(a) * 100)}%`
}

/** "50", "50%", " 50 % " → 0.5; null when not a number. Clamped to 0..1. */
export function parseAlpha(input: string): number | null {
  const n = Number.parseFloat(input.replace('%', '').trim())
  if (!Number.isFinite(n)) return null
  return clamp01(n / 100)
}
