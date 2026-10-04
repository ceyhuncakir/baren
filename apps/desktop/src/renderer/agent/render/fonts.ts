/**
 * get_font_family_info's body (contract §6.17), computed in the render window: the bundled
 * families and Google Fonts (the catalog; the app downloads them for every collaborator) are
 * known exactly; other families are detected locally by comparing canvas text metrics against
 * three generic fallbacks.
 */
import { findGoogleFont, weightList } from '../../lib/googleFonts'

export interface FontFamilyInfo {
  familyName: string
  available: boolean
  source: 'bundled' | 'google' | 'local' | null
  weights: number[] | null
  styles: ('normal' | 'italic')[] | null
  isVariable: boolean
  note?: string
}

const INTER_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

const BUNDLED: Record<string, Omit<FontFamilyInfo, 'familyName'>> = {
  inter: {
    available: true,
    source: 'bundled',
    weights: INTER_WEIGHTS,
    styles: ['normal'],
    isVariable: true,
    note: 'Bundled: renders the same for every collaborator. Italic is synthesised.',
  },
  'inter variable': {
    available: true,
    source: 'bundled',
    weights: INTER_WEIGHTS,
    styles: ['normal'],
    isVariable: true,
    note: 'Bundled: renders the same for every collaborator. Italic is synthesised.',
  },
  'jetbrains mono': {
    available: true,
    source: 'bundled',
    weights: [400, 500, 600],
    styles: ['normal'],
    isVariable: false,
    note: 'Bundled: renders the same for every collaborator.',
  },
}

const GENERIC = new Set([
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'cursive',
  'fantasy',
])

const GOOGLE_NOTE =
  'Google Fonts: Baren downloads it, so it renders the same for every collaborator.'
const LOCAL_NOTE =
  'Installed on this computer only and not on Google Fonts; collaborators without it see a fallback.'
const MISSING_NOTE = 'Not installed and not on Google Fonts.'

/** Normalise a requested family (quotes, whitespace). */
export function cleanFamily(name: string): string {
  return name
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()
}

/** Text-metrics probe: does `family` render differently from every generic fallback? */
export type FontDetector = (family: string) => boolean

export function canvasFontDetector(): FontDetector {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const sample = 'mmmmmmmmmmlli1WQ@#&ÆÉ%'
  const widthOf = (font: string): number => {
    if (!ctx) return 0
    ctx.font = font
    return ctx.measureText(sample).width
  }
  const fallbacks = ['monospace', 'serif', 'sans-serif']
  const base = fallbacks.map((f) => widthOf(`72px ${f}`))
  return (family) => {
    const quoted = `"${family.replace(/["\\]/g, '')}"`
    return fallbacks.some((f, i) => widthOf(`72px ${quoted}, ${f}`) !== base[i])
  }
}

export function fontFamilyInfo(names: readonly string[], detect: FontDetector): FontFamilyInfo[] {
  return names.map((raw) => {
    const familyName = cleanFamily(raw)
    const key = familyName.toLowerCase()
    const bundled = BUNDLED[key]
    if (bundled) return { familyName, ...bundled }
    const google = findGoogleFont(familyName)
    if (google) {
      const weights = weightList(google.weights)
      const italics = google.italic === null ? [] : weightList(google.italic)
      return {
        familyName: google.family,
        available: true,
        source: 'google' as const,
        weights: [...new Set([...weights, ...italics])].sort((a, b) => a - b),
        styles: italics.length > 0 ? ['normal' as const, 'italic' as const] : ['normal' as const],
        isVariable: !Array.isArray(google.weights),
        note: GOOGLE_NOTE,
      }
    }
    if (GENERIC.has(key)) {
      return {
        familyName,
        available: true,
        source: 'local',
        weights: null,
        styles: null,
        isVariable: false,
        note: 'A generic family: each computer picks its own font.',
      }
    }
    if (familyName !== '' && detect(familyName)) {
      return {
        familyName,
        available: true,
        source: 'local',
        weights: null,
        styles: null,
        isVariable: false,
        note: LOCAL_NOTE,
      }
    }
    return {
      familyName,
      available: false,
      source: null,
      weights: null,
      styles: null,
      isVariable: false,
      note: MISSING_NOTE,
    }
  })
}
