/**
 * Package rules (contract §12): no DOM globals anywhere (the package is bundled into Electron
 * main), and the `@baren/html/sources` entry main imports stays free of the document model.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map(
    (m) => m[1] as string,
  )
}

describe('package boundaries', () => {
  test('no DOM globals in src', () => {
    const banned =
      /\b(document|window|navigator|DOMParser|HTMLElement|Element\.prototype|CSSStyleDeclaration|getComputedStyle|localStorage)\b(?!\s*:)/
    for (const f of files(SRC)) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(banned.exec(code)?.[0] ?? null, f).toBeNull()
    }
  })
  test('the sources entry imports only parse5 and local modules without schema or Loro', () => {
    const seen = new Set<string>()
    const external = new Set<string>()
    const visit = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      for (const spec of imports(file)) {
        if (spec.startsWith('.')) visit(join(file, '..', spec))
        else external.add(spec)
      }
    }
    visit(join(SRC, 'sources.ts'))
    expect([...external]).toEqual(['parse5'])
  })
})
