/**
 * The two rules copied from `@baren/schema` (contract §7.6 rule 3) stay in sync with it.
 */
import { describe, expect, test } from 'vitest'
import { cssDeclarationValue } from '@baren/schema'
import { isSafeCssValue as schemaIsSafe } from '../../schema/src/svgSanitize.ts'
import { isSafeCssValue } from '../src/css/safe.ts'
import { KNOWN_CSS_PROPERTIES, UNITLESS, isUnitless } from '../src/css/known.ts'

describe('UNITLESS parity with the schema exporter', () => {
  const keys = new Set([...KNOWN_CSS_PROPERTIES, ...UNITLESS])
  for (const k of [...keys]) {
    keys.add(`Webkit${k[0]!.toUpperCase()}${k.slice(1)}`)
    keys.add(`ms${k[0]!.toUpperCase()}${k.slice(1)}`)
  }
  test.each([...keys].filter((k) => k !== 'rotate'))('%s', (key) => {
    expect(cssDeclarationValue(key, 1)).toBe(isUnitless(key) ? '1' : '1px')
  })
  test('custom properties are unitless', () => {
    expect(isUnitless('--x')).toBe(true)
    expect(cssDeclarationValue('--x', 1)).toBe('1')
  })
})

describe('isSafeCssValue parity with the schema sanitizer', () => {
  const cases = [
    'red',
    '#fff',
    'url("baren-asset://abc")',
    'expression(alert(1))',
    'EXPRESSION (1)',
    'javascript:alert(1)',
    'java\\script:alert(1)',
    'vbscript:x',
    '@import "x.css"',
    'behavior: url(x.htc)',
    '-moz-binding: url(x)',
    '<script>',
    'a{b}',
    'line\nbreak',
    'tab\there',
    '\u0085',
    'calc(100% - 4px)',
    'var(--color-primary, #000)',
    "font-family: 'a;b'",
    '',
    'JaVa\tScRiPt :x',
    'e x p r e s s i o n (1)',
    '@ \\import x',
    '- moz - binding',
    'BEHAVIOR\n:',
    'javascript',
    'expression',
    'vb script :',
    'url(java\\\nscript:alert(1))',
  ]
  test.each(cases)('%j', (value) => {
    expect(isSafeCssValue(value)).toBe(schemaIsSafe(value))
  })
  test('random strings over the banned words alphabet agree (seeded)', () => {
    let seed = 12345
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const parts = [
      'javascript:',
      'vbscript:',
      'expression(',
      '@import',
      'behavior:',
      '-moz-binding',
    ]
    const noise = [' ', '\\', '\t', 'a', 'X', ':', '(', '-', '@', 'J', 'S', '\u00a0', '\n']
    for (let i = 0; i < 20_000; i++) {
      let v = ''
      const word = parts[Math.floor(rand() * parts.length)] as string
      for (const ch of word) {
        v += rand() < 0.15 ? noise[Math.floor(rand() * noise.length)] : ''
        v += rand() < 0.5 ? ch.toUpperCase() : ch
        if (rand() < 0.03) break
      }
      expect(isSafeCssValue(v), JSON.stringify(v)).toBe(schemaIsSafe(v))
    }
  })
})
