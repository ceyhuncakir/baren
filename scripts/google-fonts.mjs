#!/usr/bin/env node
/**
 * Regenerates the Google Fonts catalog the app ships
 * (apps/desktop/src/renderer/lib/googleFonts.json): every family with its category and the
 * weights and italics the CSS2 API serves. The font files themselves are downloaded by the app
 * when a design uses them (src/main/fonts), never bundled.
 *
 *   node scripts/google-fonts.mjs
 *
 * Entry: [family, category, normal, italic]
 *   category  "sans" | "serif" | "display" | "hand" | "mono"
 *   normal    "100..900" (variable wght axis) or a list of static weights
 *   italic    the same for italics, or 0 when the family has none
 */
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/src/renderer/lib/googleFonts.json',
)
const CATEGORIES = {
  'Sans Serif': 'sans',
  Serif: 'serif',
  Display: 'display',
  Handwriting: 'hand',
  Monospace: 'mono',
}

const res = await fetch('https://fonts.google.com/metadata/fonts')
if (!res.ok) throw new Error(`metadata: HTTP ${res.status}`)
const text = await res.text()
const { familyMetadataList } = JSON.parse(text.slice(text.indexOf('{')))

const families = familyMetadataList
  .map((f) => {
    const keys = Object.keys(f.fonts)
    const weights = (italic) =>
      keys
        .filter((k) => k.endsWith('i') === italic)
        .map((k) => Number.parseInt(k, 10))
        .sort((a, b) => a - b)
    const wght = f.axes.find((a) => a.tag === 'wght')
    const range = wght ? `${wght.min}..${wght.max}` : null
    const normal = weights(false)
    const italic = weights(true)
    return [
      f.family,
      CATEGORIES[f.category] ?? 'sans',
      range ?? normal,
      italic.length === 0 ? 0 : (range ?? italic),
    ]
  })
  .filter(([, , normal, italic]) => normal.length > 0 || italic !== 0)
  .sort((a, b) => a[0].localeCompare(b[0]))

const body = families.map((f) => `    ${JSON.stringify(f)}`).join(',\n')
await writeFile(OUT, `{\n  "version": 1,\n  "families": [\n${body}\n  ]\n}\n`)
console.log(`${families.length} families → ${OUT}`)
