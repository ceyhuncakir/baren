/**
 * Theme tokens (ARCHITECTURE.md "Dark theme"): the light and dark sets stay paired, the dark
 * values are the design's (design/tokens.dark.css), design content gets the light set, and
 * stylesheets use tokens instead of literal colours.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = resolve(__dirname, '../../../..')
const TOKENS = resolve(__dirname, 'tokens.css')

interface Rule {
  selectors: string[]
  body: string
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Flat rules (`selector { body }`); at-rule wrappers are unwrapped. */
function rules(css: string): Rule[] {
  const out: Rule[] = []
  const src = stripComments(css)
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const head = (m[1] ?? '').replace(/^[\s\S]*@[^{]*\{/, '').trim()
    if (head.startsWith('@')) continue
    out.push({
      selectors: head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
      body: m[2] ?? '',
    })
  }
  return out
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of body.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    if (name)
      map.set(
        name,
        part
          .slice(i + 1)
          .trim()
          .replace(/\s+/g, ' '),
      )
  }
  return map
}

function block(all: Rule[], selector: string): Map<string, string> {
  const merged = new Map<string, string>()
  for (const r of all)
    if (r.selectors.length === 1 && r.selectors[0] === selector)
      for (const [k, v] of declarations(r.body)) merged.set(k, v)
  return merged
}

const tokenRules = rules(readFileSync(TOKENS, 'utf8'))
const lightRule = tokenRules.find((r) => r.selectors.includes(':root') && r.selectors.length > 1)
const light = declarations(lightRule?.body ?? '')
const dark = block(tokenRules, ":root[data-theme='dark']")
const chrome = block(tokenRules, ':root')
const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim()

describe('tokens.css', () => {
  it('declares light tokens on :root and on the document scope', () => {
    expect(lightRule?.selectors).toEqual([':root', '.ic-root', '[data-design-content]'])
    expect(light.get('--color-background')).toBe('#ffffff')
    const scope = tokenRules.find((r) => r.selectors.includes('.ic-root') && r !== lightRule)
    expect(declarations(scope?.body ?? '').get('color-scheme')).toBe('light')
  })

  it('keeps the base token values (design/tokens.css) in light', () => {
    const base = declarations(rules(readFileSync(join(REPO, 'design/tokens.css'), 'utf8'))[0]!.body)
    for (const [name, value] of base) {
      if (!name.startsWith('--color-')) continue
      expect(norm(light.get(name) ?? ''), name).toBe(norm(value))
    }
  })

  it('overrides only tokens that exist in light, and every colour token has a dark value', () => {
    for (const name of dark.keys()) {
      if (!name.startsWith('--')) continue
      expect(light.has(name) || chrome.has(name), `${name} has no light value`).toBe(true)
    }
    for (const [name, value] of light) {
      const themed = /^--(color|shadow)-/.test(name)
      // Theme-independent: they sit on document colours (swatches, colour areas), not chrome.
      const same = [
        '--color-checker',
        '--color-checker-alt',
        '--color-handle',
        '--shadow-handle',
        '--shadow-handle-subtle',
        '--shadow-swatch',
      ].includes(name)
      if (!themed || same) continue
      if (dark.has(name)) continue
      // Tokens that only reference other tokens follow them automatically.
      expect(/^[^#]*$/.test(value) && value.includes('var('), `${name} has no dark value`).toBe(
        true,
      )
    }
  })

  it('uses the contract core values and the design dark palette (design/tokens.dark.css)', () => {
    const core: Record<string, string> = {
      '--color-background': '#1a1a1a',
      '--color-surface': '#202020',
      '--color-canvas': '#141414',
      '--color-muted': '#2a2a2a',
      '--color-input': '#262626',
      '--color-border': '#2e2e2e',
      '--color-foreground': '#ededed',
      '--color-foreground-muted': '#a0a0a0',
      '--color-foreground-subtle': '#6b6b6b',
      '--color-primary': '#f2f2f2',
      '--color-primary-foreground': '#111111',
      '--color-selection': '#3b8cff',
      '--color-avatar': '#f04e1e',
    }
    for (const [name, value] of Object.entries(core)) expect(dark.get(name), name).toBe(value)
    expect(dark.get('color-scheme')).toBe('dark')

    const design = block(
      rules(readFileSync(join(REPO, 'design/tokens.dark.css'), 'utf8')),
      ':root[data-theme="dark"]',
    )
    expect(design.size).toBeGreaterThan(30)
    for (const [name, value] of design) expect(norm(dark.get(name) ?? ''), name).toBe(norm(value))
    // The design's two new derived tokens keep light mode unchanged (white).
    expect(light.get('--color-segment-active')).toBe('#ffffff')
    expect(light.get('--color-thumb')).toBe('#ffffff')
  })

  it('applies the dark set before data-theme exists when prefers-color-scheme is dark', () => {
    // Electron mirrors the app theme into prefers-color-scheme (nativeTheme.themeSource), so
    // the first frame is right even before the renderer sets data-theme.
    const css = stripComments(readFileSync(TOKENS, 'utf8'))
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{/)
    const early = block(tokenRules, ':root:not([data-theme])')
    expect([...early.entries()]).toEqual([...dark.entries()])
  })

  it('declares canvas chrome on :root only (inherited by the document scope, not reset)', () => {
    for (const name of [
      '--color-canvas-ground',
      '--color-overlay-selection',
      '--color-overlay-label',
      '--color-overlay-label-active',
      '--color-overlay-handle',
      '--color-overlay-snap',
      '--color-overlay-marquee',
      '--color-overlay-agent',
    ]) {
      expect(chrome.has(name), name).toBe(true)
      expect(light.has(name), `${name} must not be reset by the document scope`).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ stylesheets */

function cssFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...cssFiles(path))
    else if (entry.endsWith('.css')) out.push(path)
  }
  return out
}

const STYLESHEETS = [
  ...cssFiles(join(REPO, 'packages/ui/src')),
  ...cssFiles(join(REPO, 'packages/ui/playground')),
  ...cssFiles(join(REPO, 'apps/desktop/src/renderer')),
].filter((f) => f !== TOKENS)

/**
 * Rules allowed to hold literal colours: design content that must look the same in both
 * themes: the colour picker's gradients are colour-model math.
 */
const CONTENT_RULES: Record<string, RegExp> = {
  'packages/ui/src/components/editor/ColorPicker.module.css': /^\.(area|hue|alpha)(Handle)?$/,
}

const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![-\w])(white|black)(?![-\w])/i

describe('stylesheets', () => {
  it('found the app and ui stylesheets', () => {
    expect(STYLESHEETS.length).toBeGreaterThan(35)
  })

  it('use tokens instead of literal colours (except design content)', () => {
    const offenders: string[] = []
    for (const file of STYLESHEETS) {
      const rel = relative(REPO, file)
      const allowed = CONTENT_RULES[rel]
      for (const rule of rules(readFileSync(file, 'utf8'))) {
        if (!LITERAL.test(rule.body)) continue
        if (allowed && rule.selectors.every((s) => allowed.test(s))) continue
        offenders.push(`${rel}: ${rule.selectors.join(', ')} → ${rule.body.match(LITERAL)?.[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('only reference tokens that exist (or local custom properties)', () => {
    const declared = new Set([...light.keys(), ...chrome.keys(), ...dark.keys()])
    // Set per element (inline style from components or the stylesheet itself).
    for (const file of STYLESHEETS)
      for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(/(--[\w-]+)\s*:/g))
        declared.add(m[1] as string)
    const missing: string[] = []
    for (const file of STYLESHEETS) {
      const css = stripComments(readFileSync(file, 'utf8'))
      // var(--x) without a fallback must resolve.
      for (const m of css.matchAll(/var\((--[\w-]+)\s*\)/g)) {
        const name = m[1] as string
        if (!declared.has(name)) missing.push(`${relative(REPO, file)}: ${name}`)
      }
    }
    expect(missing).toEqual([])
  })
})
