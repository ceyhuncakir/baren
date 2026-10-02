import { describe, expect, it } from 'vitest'
import {
  formatAlpha,
  hexToHsva,
  hexToRgb,
  hsvaToHex,
  needsSwatchBorder,
  normalizeHex,
  parseAlpha,
  readableOn,
  rgbToHex,
} from './color'

describe('normalizeHex', () => {
  it('accepts 3/4/6/8 digit forms with or without #', () => {
    expect(normalizeHex('2f80ff')).toBe('2F80FF')
    expect(normalizeHex('#2F80FF')).toBe('2F80FF')
    expect(normalizeHex('fff')).toBe('FFFFFF')
    expect(normalizeHex('#2F80FF80')).toBe('2F80FF')
    expect(normalizeHex(' abc ')).toBe('AABBCC')
  })

  it('rejects junk', () => {
    expect(normalizeHex('blue')).toBeNull()
    expect(normalizeHex('12345')).toBeNull()
    expect(normalizeHex('')).toBeNull()
  })
})

describe('rgb/hsv round trips', () => {
  it('converts the selection token both ways', () => {
    expect(hexToRgb('2F80FF')).toEqual({ r: 47, g: 128, b: 255 })
    expect(rgbToHex({ r: 47, g: 128, b: 255 })).toBe('2F80FF')
    const hsva = hexToHsva('2F80FF')
    expect(hsva).not.toBeNull()
    expect(hsva!.h).toBeCloseTo(216.6, 1)
    expect(hsvaToHex(hsva!)).toBe('2F80FF')
  })

  it('round-trips every token color', () => {
    for (const hex of [
      'FFFFFF',
      'F7F7F7',
      'EEEEEE',
      '1A1A1A',
      '141414',
      'F04E1E',
      'C8F230',
      '000000',
    ]) {
      expect(hsvaToHex(hexToHsva(hex)!)).toBe(hex)
    }
  })

  it('keeps the previous hue for grays', () => {
    expect(hexToHsva('808080', 1, 200)!.h).toBe(200)
  })
})

describe('swatch helpers', () => {
  it('borders light swatches only', () => {
    expect(needsSwatchBorder('FFFFFF')).toBe(true)
    expect(needsSwatchBorder('EEEEEE')).toBe(true)
    expect(needsSwatchBorder('2F80FF')).toBe(false)
  })

  it('picks a readable text color', () => {
    expect(readableOn('C8F230')).toBe('#1A1A1A')
    expect(readableOn('F04E1E')).toBe('#FFFFFF')
    expect(readableOn('1A1A1A')).toBe('#FFFFFF')
  })

  it('formats and parses opacity', () => {
    expect(formatAlpha(1)).toBe('100%')
    expect(formatAlpha(0.333)).toBe('33%')
    expect(parseAlpha('50%')).toBe(0.5)
    expect(parseAlpha('150')).toBe(1)
    expect(parseAlpha('x')).toBeNull()
  })
})
