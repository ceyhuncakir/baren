/**
 * The write_html corpus (`tests/fixtures/html/*.html`): each fixture is one or more
 * write_html calls. `<!-- target: page -->` on the first line targets the page instead of a
 * 1440 × 900 artboard; `<!-- next -->` starts another call into the artboard and
 * `<!-- next: $N -->` one into the N-th root created so far; `{{$N}}` inside the HTML is
 * replaced by that root's id (clone sources).
 */
import { readFileSync, readdirSync } from 'node:fs'
import type { LoroDoc } from 'loro-crdt'
import { createNode, type Token } from '@baren/schema'
import type { ApplyResult, HtmlWarning } from '../src/index.ts'
import { setup, write } from './helpers.ts'

export const FIXTURES = new URL('./fixtures/html/', import.meta.url)

export const TOKENS: Record<string, Token> = {
  '--color-background': { type: 'color', value: '#FFFFFF' },
  '--color-surface': { type: 'color', value: '#F7F7F7' },
  '--color-muted': { type: 'color', value: '#EBEBEB' },
  '--color-border': { type: 'color', value: '#E5E5E5' },
  '--color-foreground': { type: 'color', value: '#1A1A1A' },
  '--color-foreground-muted': { type: 'color', value: '#666666' },
  '--color-foreground-subtle': { type: 'color', value: '#999999' },
  '--color-primary': { type: 'color', value: '#141414' },
  '--color-primary-foreground': { type: 'color', value: '#FFFFFF' },
  '--font-sans': { type: 'fontFamily', value: 'Inter' },
  '--font-mono': { type: 'fontFamily', value: 'JetBrains Mono' },
  '--text-sm': { type: 'fontSize', value: '12px' },
  '--text-base': { type: 'fontSize', value: '13px' },
  '--leading-sm': { type: 'lineHeight', value: '16px' },
  '--font-weight-semibold': { type: 'fontWeight', value: '600' },
  '--spacing-3': { type: 'spacing', value: '12px' },
  '--spacing-4': { type: 'spacing', value: '16px' },
  '--radius-md': { type: 'radius', value: '6px' },
  '--radius-lg': { type: 'radius', value: '8px' },
  '--radius-full': { type: 'radius', value: '9999px' },
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => f.slice(0, -5))
}

export function readFixture(name: string): string {
  return readFileSync(new URL(`${name}.html`, FIXTURES), 'utf8')
}

export interface FixtureRun {
  doc: LoroDoc
  pageId: string
  boardId: string | null
  /** Roots of the calls, in order. */
  roots: string[]
  /** Roots of the last call (what a fixture "produces"). */
  results: ApplyResult[]
  warnings: HtmlWarning[]
}

/** Run a fixture into a fresh document (or into `into` = { doc, parentId } for round trips). */
export function runFixture(
  source: string,
  into?: { doc: LoroDoc; pageId: string; parentId: string },
): FixtureRun {
  const env =
    into ??
    (() => {
      const s = setup(TOKENS)
      return { ...s, parentId: '' }
    })()
  const { doc, pageId } = env
  const toPage = /^\s*<!--\s*target:\s*page\s*-->/.test(source)
  let boardId: string | null = null
  if (into) boardId = into.parentId
  else if (!toPage) {
    boardId = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Board',
      styles: {
        left: 0,
        top: 0,
        width: '1440px',
        height: '900px',
        display: 'flex',
        flexDirection: 'column',
      },
    })
  }
  const steps = source.split(/<!--\s*next(?::\s*\$(\d+))?\s*-->/)
  const roots: string[] = []
  const results: ApplyResult[] = []
  const warnings: HtmlWarning[] = []
  const first = steps[0] as string
  const calls: { html: string; ref: number | null }[] = [{ html: first, ref: null }]
  for (let i = 1; i < steps.length; i += 2) {
    const ref = steps[i]
    calls.push({ html: steps[i + 1] as string, ref: ref === undefined ? null : Number(ref) })
  }
  for (const call of calls) {
    const html = call.html.replace(
      /\{\{\$(\d+)\}\}/g,
      (_m, n: string) => roots[Number(n)] ?? 'missing',
    )
    const target = call.ref !== null ? (roots[call.ref] as string) : (boardId ?? pageId)
    const r = write(doc, html, target)
    results.push(r)
    roots.push(...r.created)
    warnings.push(...r.warnings)
  }
  return { doc, pageId, boardId, roots, results, warnings }
}
