/**
 * Rows of the font family picker (`FontFamilyPicker.tsx`): the bundled families, then every
 * Google Fonts family, filtered by the search query.
 */
import { googleFonts, type GoogleFontCategory } from '../../lib/googleFonts'
import { FONT_FAMILIES, primaryFamily } from '../lib/fonts'

const CATEGORY_LABEL: Record<GoogleFontCategory, string> = {
  sans: 'Sans serif',
  serif: 'Serif',
  display: 'Display',
  hand: 'Handwriting',
  mono: 'Monospace',
}

export type FontRow =
  | { kind: 'label'; text: string }
  | { kind: 'font'; value: string; label: string; detail: string | null }

/** A family name as a `font-family` value: quoted when it is not a plain identifier list. */
export function fontFamilyValue(family: string): string {
  return family.split(' ').every((word) => /^[A-Za-z_-][\w-]*$/.test(word))
    ? family
    : `"${family.replace(/["\\]/g, '')}"`
}

/** The picker's rows for a search query: bundled families, then Google Fonts. */
export function fontRows(query: string): FontRow[] {
  const q = query.trim().toLowerCase()
  const match = (name: string) => q === '' || name.toLowerCase().includes(q)
  const bundled = FONT_FAMILIES.filter((f) => match(f.label))
  const bundledNames = new Set(FONT_FAMILIES.map((f) => primaryFamily(f.value).toLowerCase()))
  const google = googleFonts().filter(
    (f) => match(f.family) && !bundledNames.has(f.family.toLowerCase()),
  )
  const rows: FontRow[] = []
  if (bundled.length > 0) {
    rows.push({ kind: 'label', text: 'Bundled' })
    for (const f of bundled)
      rows.push({ kind: 'font', value: f.value, label: f.label, detail: null })
  }
  if (google.length > 0) {
    rows.push({ kind: 'label', text: 'Google Fonts' })
    for (const f of google) {
      rows.push({
        kind: 'font',
        value: fontFamilyValue(f.family),
        label: f.family,
        detail: CATEGORY_LABEL[f.category],
      })
    }
  }
  return rows
}

/** Same family, ignoring case, quotes, fallbacks and the "Inter Variable" alias. */
export function sameFamily(a: string, b: string): boolean {
  const x = primaryFamily(a).toLowerCase()
  const y = primaryFamily(b).toLowerCase()
  return (
    x === y ||
    (x === 'inter variable' && y === 'inter') ||
    (x === 'inter' && y === 'inter variable')
  )
}
