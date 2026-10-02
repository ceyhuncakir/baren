import { describe, expect, test } from 'vitest'
import {
  colorsEqual,
  parseCssColor,
  rewriteTokenRefs,
  tokensHash,
  tokensToCss,
  wildcardMatch,
} from '../src/index.ts'

describe('tokensHash', () => {
  test('8 lowercase hex chars, independent of key order', () => {
    const a = {
      '--b': { type: 'color', value: '#fff' },
      '--a': { type: 'spacing', value: 4, description: 'x' },
    }
    const b = {
      '--a': { type: 'spacing', value: 4, description: 'x' },
      '--b': { type: 'color', value: '#fff' },
    }
    expect(tokensHash(a)).toMatch(/^[0-9a-f]{8}$/)
    expect(tokensHash(a)).toBe(tokensHash(b))
  })
  test('FNV-1a over the documented line format', () => {
    expect(tokensHash({})).toBe('811c9dc5')
    // FNV-1a("--a\tcolor\tred\t\n") computed independently.
    let h = 0x811c9dc5
    for (const byte of Buffer.from('--a\tcolor\tred\t\n', 'utf8')) {
      h ^= byte
      h = Math.imul(h, 0x01000193) >>> 0
    }
    expect(tokensHash({ '--a': { type: 'color', value: 'red' } })).toBe(
      h.toString(16).padStart(8, '0'),
    )
  })
  test('changes with any field; UTF-8 descriptions', () => {
    const base = { '--a': { type: 'color', value: 'red', description: 'Café' } }
    const h = tokensHash(base)
    expect(tokensHash({ '--a': { type: 'color', value: 'red', description: 'Cafe' } })).not.toBe(h)
    expect(tokensHash({ '--a': { type: 'color', value: 'blue', description: 'Café' } })).not.toBe(h)
    expect(tokensHash({ '--a': { type: 'text', value: 'red', description: 'Café' } })).not.toBe(h)
  })
})

describe('rewriteTokenRefs', () => {
  test('renames whole token names only', () => {
    expect(
      rewriteTokenRefs(
        'var(--color-a) var(--color-ab) var( --color-a, red)',
        '--color-a',
        '--color-z',
      ),
    ).toBe('var(--color-z) var(--color-ab) var( --color-z, red)')
    expect(
      rewriteTokenRefs('color-mix(in srgb, var(--color-a) 40%, transparent)', 'color-a', 'color-b'),
    ).toBe('color-mix(in srgb, var(--color-b) 40%, transparent)')
    expect(rewriteTokenRefs(12, '--a', '--b')).toBe(12)
    expect(rewriteTokenRefs('--color-a', '--color-a', '--x')).toBe('--color-a')
  })
})

describe('tokensToCss', () => {
  const tokens = {
    '--spacing-1': { type: 'spacing', value: '4px' },
    '--radius-sm': { type: 'radius', value: 4 },
    '--zz': { type: 'color', value: '#000' },
  }
  test('css / tailwind texts', () => {
    expect(tokensToCss(tokens, ['--radius-sm', '--spacing-1'], 'css')).toBe(
      ':root {\n  --radius-sm: 4;\n  --spacing-1: 4px;\n  --zz: #000;\n}\n',
    )
    expect(
      tokensToCss(
        { '--spacing-1': tokens['--spacing-1'], '--radius-sm': { type: 'radius', value: '4px' } },
        ['--spacing-1', '--radius-sm'],
        'tailwind',
      ),
    ).toBe('@theme {\n  --spacing-1: 4px;\n  --radius-sm: 4px;\n}\n')
    expect(tokensToCss({}, [], 'css')).toBe(':root {\n}\n')
  })
})

describe('wildcardMatch', () => {
  test.each([
    ['--color-*', '--color-primary', true],
    ['--color-*', '--spacing-1', false],
    ['*-500', '--color-blue-500', true],
    ['*brand*', '--color-brand-dark', true],
    ['Submit', 'Submit', true],
    ['Submit', 'Submit form', false],
    ['Get *', 'Get started', true],
    ['*started*', 'Get started now', true],
    ['*', '', true],
    ['a*b*c', 'aXXbYYc', true],
    ['a*b*c', 'aXXbYY', false],
    ['a.b', 'axb', false],
    ['(x)+', '(x)+', true],
  ])('%s ~ %s → %s', (pattern, value, expected) => {
    expect(wildcardMatch(pattern, value)).toBe(expected)
  })
  test('case-insensitive option', () => {
    expect(wildcardMatch('get *', 'Get Started', { caseInsensitive: true })).toBe(true)
    expect(wildcardMatch('get *', 'Get Started')).toBe(false)
  })
  test('pathological patterns stay fast', () => {
    const t0 = performance.now()
    expect(wildcardMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false)
    expect(performance.now() - t0).toBeLessThan(200)
  })
})

describe('colours', () => {
  test.each([
    ['#ccc', 'rgb(204, 204, 204)'],
    ['#CCCCCC', 'rgb(204 204 204)'],
    ['#00000014', 'rgba(0, 0, 0, 0.08)'],
    ['red', '#ff0000'],
    ['transparent', 'rgba(255, 0, 0, 0)'],
    ['hsl(0, 100%, 50%)', '#f00'],
    ['hsl(120deg 100% 25% / 50%)', 'rgba(0, 128, 0, .5)'],
    ['hwb(0 0% 0%)', 'red'],
    ['oklch(62.8% 0.2577 29.23)', '#ff0000'],
    ['oklab(1 0 0)', 'white'],
    ['lab(54.29% 80.82 69.88)', '#ff0000'],
    ['lch(54.29% 106.84 40.85)', '#ff0000'],
    ['color(srgb 1 0 0)', 'red'],
    ['#F3F3F3', '#f3f3f3'],
  ])('%s ≡ %s', (a, b) => {
    expect(colorsEqual(a, b)).toBe(true)
  })
  test('non-colours and different colours', () => {
    expect(colorsEqual('#ccc', '#cdcdcd')).toBe(false)
    expect(colorsEqual('var(--x)', 'var(--x)')).toBe(false)
    expect(parseCssColor('currentColor')).toBeNull()
    expect(parseCssColor('color-mix(in srgb, red, blue)')).toBeNull()
    expect(parseCssColor('#12')).toBeNull()
    expect(parseCssColor('rgb(1, 2)')).toBeNull()
    expect(parseCssColor('#0f08')).toEqual({ r: 0, g: 255, b: 0, a: 0.533 })
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
  })
})
