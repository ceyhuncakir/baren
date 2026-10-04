import { describe, expect, it } from 'vitest'
import { fontFamilyValue, fontRows, sameFamily } from './fontRows'

describe('font family picker rows', () => {
  it('lists the bundled families, then Google Fonts without the bundled ones', () => {
    const rows = fontRows('')
    expect(rows.slice(0, 4)).toEqual([
      { kind: 'label', text: 'Bundled' },
      { kind: 'font', value: 'Inter', label: 'Inter', detail: null },
      { kind: 'font', value: 'JetBrains Mono', label: 'JetBrains Mono', detail: null },
      { kind: 'font', value: 'system-ui, sans-serif', label: 'System Sans-Serif', detail: null },
    ])
    expect(rows[4]).toEqual({ kind: 'label', text: 'Google Fonts' })
    const google = rows.slice(5).map((r) => (r.kind === 'font' ? r.label : null))
    expect(google.length).toBeGreaterThan(1500)
    expect(google).not.toContain('Inter')
    expect(google).toContain('Geist')
  })

  it('filters by a case-insensitive substring', () => {
    expect(fontRows('geist m')).toEqual([
      { kind: 'label', text: 'Google Fonts' },
      { kind: 'font', value: 'Geist Mono', label: 'Geist Mono', detail: 'Monospace' },
    ])
    expect(fontRows('zzzz-no-font')).toEqual([])
  })

  it('quotes names that are not plain identifiers and compares families loosely', () => {
    expect(fontFamilyValue('Geist Mono')).toBe('Geist Mono')
    expect(fontFamilyValue('M PLUS 1p')).toBe('"M PLUS 1p"')
    expect(sameFamily('"Geist Mono", monospace', 'geist mono')).toBe(true)
    expect(sameFamily('Inter Variable', 'Inter')).toBe(true)
    expect(sameFamily('Geist', 'Geist Mono')).toBe(false)
  })
})
