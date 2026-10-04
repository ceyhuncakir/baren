/**
 * Fonts available to designs. The app bundles Inter (variable, wght + opsz) and
 * JetBrains Mono. @fontsource registers Inter as "Inter Variable", but design documents
 * (and the canvas defaults) say `fontFamily: 'Inter'`, so the editor registers the same
 * files under "Inter" too — otherwise design text silently falls back to a system font.
 *
 * Every other family a document uses that is on Google Fonts is registered from the files main
 * downloads (`bridge.fonts`, `baren-font://`), so it renders the same on every collaborator's
 * machine whether or not they have it installed. Registering is cheap: Chromium fetches a face
 * (one unicode-range subset of one style) only when text on screen needs it, and the canvas
 * re-measures text when it arrives.
 */
import interLatinExt from '@fontsource-variable/inter/files/inter-latin-ext-opsz-normal.woff2?url'
import interLatin from '@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url'
import {
  NODE_KEY,
  getNode,
  getTokens,
  nodesTree,
  type NodeChangeBatch,
  type Token,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { bridge } from '../../lib/bridge'
import { familyList, findGoogleFont } from '../../lib/googleFonts'

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

/** Families the app bundles: never replaced by their Google Fonts version. */
const BUNDLED_FAMILIES = new Set(['inter', 'inter variable', 'jetbrains mono'])

/** Google Fonts families registered in this window (lowercase name → registered). */
const googleFamilies = new Map<string, Promise<boolean>>()

/**
 * Register the Google Fonts faces of these families in this window (once each). Families that
 * are bundled, generic, local-only or unknown are skipped. Resolves once the faces are
 * registered (not loaded); a family that could not be fetched is retried on the next call.
 */
export function ensureFontFamilies(names: Iterable<string>): Promise<void> {
  const waits: Promise<boolean>[] = []
  for (const name of names) {
    const font = findGoogleFont(name)
    if (!font) continue
    const key = font.family.toLowerCase()
    if (BUNDLED_FAMILIES.has(key)) continue
    let pending = googleFamilies.get(key)
    if (!pending) {
      pending = registerGoogleFamily(font.family)
      googleFamilies.set(key, pending)
      void pending.then((ok) => {
        if (!ok) googleFamilies.delete(key)
      })
    }
    waits.push(pending)
  }
  return Promise.all(waits).then(() => undefined)
}

async function registerGoogleFamily(family: string): Promise<boolean> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return true
  const faces = await bridge.fonts.faces(family).catch(() => null)
  if (!faces) return false
  for (const face of faces) {
    const descriptors: FontFaceDescriptors = {
      style: face.style,
      weight: face.weight,
      display: 'swap',
    }
    if (face.unicodeRange) descriptors.unicodeRange = face.unicodeRange
    document.fonts.add(new FontFace(family, `url("${face.url}") format('woff2')`, descriptors))
  }
  return true
}

function addFamilies(value: unknown, out: Set<string>): void {
  if (typeof value === 'string' && !value.includes('var(')) {
    for (const family of familyList(value)) out.add(family)
  }
}

function addOverrideFamilies(overrides: unknown, out: Set<string>): void {
  if (typeof overrides !== 'object' || overrides === null) return
  for (const entry of Object.values(overrides as Record<string, unknown>)) {
    const styles = (entry as { styles?: Record<string, unknown> } | null)?.styles
    addFamilies(styles?.['fontFamily'], out)
  }
}

function addTokenFamilies(tokens: Record<string, Token>, out: Set<string>): void {
  for (const token of Object.values(tokens)) {
    if (token.type === 'fontFamily') addFamilies(token.value, out)
  }
}

/**
 * Every font family `doc` uses: text styles, instance overrides and font-family tokens (what
 * `var(--font-…)` resolves to). One wasm→JS call for the tree (`toJSON`).
 */
export function docFontFamilies(doc: LoroDoc): Set<string> {
  const out = new Set<string>()
  addTokenFamilies(getTokens(doc), out)
  const roots = nodesTree(doc).toJSON() as unknown
  const stack: unknown[] = Array.isArray(roots) ? [...roots] : []
  for (let raw = stack.pop(); raw !== undefined; raw = stack.pop()) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as { meta?: Record<string, unknown>; children?: unknown }
    const styles = r.meta?.[NODE_KEY.styles] as Record<string, unknown> | undefined
    addFamilies(styles?.['fontFamily'], out)
    addOverrideFamilies(r.meta?.[NODE_KEY.overrides], out)
    if (Array.isArray(r.children)) for (const c of r.children) stack.push(c)
  }
  return out
}

/** Families a change batch introduced (new nodes, font changes, overrides, font tokens). */
export function batchFontFamilies(doc: LoroDoc, batch: NodeChangeBatch): Set<string> {
  const out = new Set<string>()
  for (const change of batch.changes) {
    const relevant =
      change.kind === 'created' ||
      change.kind === 'overrides' ||
      (change.kind === 'styles' && change.keys.includes('fontFamily'))
    if (!relevant) continue
    const node = getNode(doc, change.id)
    if (!node) continue
    addFamilies(node.styles['fontFamily'], out)
    addOverrideFamilies(node.overrides, out)
  }
  if (batch.tokens.length > 0) {
    const tokens = getTokens(doc)
    const changed: Record<string, Token> = {}
    for (const name of batch.tokens) {
      const token = tokens[name]
      if (token) changed[name] = token
    }
    addTokenFamilies(changed, out)
  }
  return out
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
