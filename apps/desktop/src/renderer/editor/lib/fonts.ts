/**
 * Fonts available to designs. The app bundles Inter (variable, wght + opsz) and
 * JetBrains Mono. @fontsource registers Inter as "Inter Variable", but design documents
 * (and the canvas defaults) say `fontFamily: 'Inter'`, so the editor registers the same
 * files under "Inter" too — otherwise design text silently falls back to a system font.
 */
import interLatinExt from '@fontsource-variable/inter/files/inter-latin-ext-opsz-normal.woff2?url'
import interLatin from '@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url'

/** Families offered by the Typography section (bundled, so identical on every machine). */
export const FONT_FAMILIES: readonly { value: string; label: string }[] = [
  { value: 'Inter', label: 'Inter' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'system-ui, sans-serif', label: 'System Sans-Serif' },
]

export const FONT_WEIGHTS: readonly { value: number; label: string }[] = [
  { value: 100, label: 'Thin' },
  { value: 200, label: 'Extra Light' },
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' },
]

const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

let registered: Promise<void> | null = null

/** Register the "Inter" alias once per window. Resolves when the latin face is loaded. */
export function ensureDesignFonts(): Promise<void> {
  if (registered) return registered
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') {
    registered = Promise.resolve()
    return registered
  }
  const faces = [
    new FontFace('Inter', `url(${interLatin}) format('woff2')`, {
      weight: '100 900',
      style: 'normal',
      display: 'swap',
      unicodeRange: LATIN_RANGE,
    }),
    new FontFace('Inter', `url(${interLatinExt}) format('woff2')`, {
      weight: '100 900',
      style: 'normal',
      display: 'swap',
      unicodeRange: LATIN_EXT_RANGE,
    }),
  ]
  for (const face of faces) document.fonts.add(face)
  registered = Promise.all(faces.map((f) => f.load().catch(() => undefined))).then(() => undefined)
  return registered
}

/** First family of a CSS font-family list, unquoted ("'Inter Variable', Inter" → "Inter Variable"). */
export function primaryFamily(value: string): string {
  const first = value.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '')
}

/** Display name for a font-family value. */
export function familyLabel(value: string): string {
  const known = FONT_FAMILIES.find((f) => f.value === value)
  if (known) return known.label
  const first = primaryFamily(value)
  if (first === 'system-ui') return 'System Sans-Serif'
  if (first === 'Inter Variable') return 'Inter'
  return first || 'Inter'
}

export function weightLabel(weight: number): string {
  const exact = FONT_WEIGHTS.find((w) => w.value === weight)
  if (exact) return exact.label
  return String(weight)
}
