import { describe, expect, it } from 'vitest'
import {
  css2Url,
  familyList,
  findGoogleFont,
  fontPathOf,
  fontUrlOf,
  googleFonts,
  parseFontFaces,
  weightList,
} from './googleFonts'

describe('Google Fonts catalog', () => {
  it('finds families case-insensitively, with quotes and spaces trimmed', () => {
    expect(googleFonts().length).toBeGreaterThan(1500)
    expect(findGoogleFont('Geist')).toMatchObject({
      family: 'Geist',
      category: 'sans',
      weights: '100..900',
      italic: '100..900',
    })
    expect(findGoogleFont(` "geist mono" `)?.family).toBe('Geist Mono')
    expect(findGoogleFont('Not A Real Font')).toBeNull()
    expect(familyList(`"Geist Mono", ui-monospace , monospace`)).toEqual([
      'Geist Mono',
      'ui-monospace',
      'monospace',
    ])
  })

  it('builds CSS2 requests for variable, static and italic-less families', () => {
    const variable = findGoogleFont('Geist')!
    expect(css2Url(variable)).toBe(
      'https://fonts.googleapis.com/css2?family=Geist:ital,wght@0,100..900;1,100..900&display=swap',
    )
    expect(
      css2Url({ family: 'Cardo', category: 'serif', weights: [400, 700], italic: [400] }),
    ).toBe(
      'https://fonts.googleapis.com/css2?family=Cardo:ital,wght@0,400;0,700;1,400&display=swap',
    )
    expect(
      css2Url({ family: 'Open Sans', category: 'sans', weights: [300, 800], italic: null }),
    ).toBe('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;800&display=swap')
    expect(css2Url({ family: 'Lobster', category: 'display', weights: [400], italic: null })).toBe(
      'https://fonts.googleapis.com/css2?family=Lobster&display=swap',
    )
    expect(weightList('100..900')).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900])
    expect(weightList('300..700')).toEqual([300, 400, 500, 600, 700])
    expect(weightList([400, 700])).toEqual([400, 700])
  })

  it('parses @font-face rules and keeps only gstatic woff2 files', () => {
    const css = `/* latin */
@font-face {
  font-family: 'Geist';
  font-style: italic;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/geist/v5/gyB8hwUxId8gMEwZKFqHP7Tc.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+2000-206F;
}
@font-face {
  font-family: 'Geist';
  font-style: normal;
  font-weight: 400;
  src: url(https://evil.example/s/geist/v5/x.woff2) format('woff2');
}
@font-face {
  font-family: 'Lobster';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/lobster/v30/neILzCirqoswsqX9zoKmMw.woff2) format('woff2');
}`
    expect(parseFontFaces(css)).toEqual([
      {
        style: 'italic',
        weight: '100 900',
        unicodeRange: 'U+0000-00FF, U+0131, U+2000-206F',
        url: 'baren-font://google/s/geist/v5/gyB8hwUxId8gMEwZKFqHP7Tc.woff2',
      },
      {
        style: 'normal',
        weight: '400',
        url: 'baren-font://google/s/lobster/v30/neILzCirqoswsqX9zoKmMw.woff2',
      },
    ])
  })

  it('maps font URLs both ways and rejects anything else', () => {
    expect(fontUrlOf('https://fonts.gstatic.com/s/geist/v5/abc_D-1.woff2')).toBe(
      'baren-font://google/s/geist/v5/abc_D-1.woff2',
    )
    expect(fontUrlOf('https://fonts.gstatic.com/s/geist/v5/../../etc/passwd')).toBeNull()
    expect(fontUrlOf('https://fonts.gstatic.com.evil/s/geist/v5/a.woff2')).toBeNull()
    expect(fontPathOf('baren-font://google/s/geist/v5/abc.woff2')).toBe('/s/geist/v5/abc.woff2')
    expect(fontPathOf('baren-font://google/s/geist/v5/%2e%2e/abc.woff2')).toBeNull()
    expect(fontPathOf('baren-font://other/s/geist/v5/abc.woff2')).toBeNull()
    expect(fontPathOf('baren-font://google/s/geist/v5/abc.exe')).toBeNull()
    expect(fontPathOf('not a url')).toBeNull()
  })
})
