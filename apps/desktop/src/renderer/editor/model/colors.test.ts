import { describe, expect, it } from 'vitest'
import {
  colorKey,
  findColors,
  formatColor,
  parseColor,
  replaceColor,
  resolveColor,
  tokenShortName,
} from './colors'
import {
  borderPatch,
  fillKindPatch,
  formatFilters,
  formatShadows,
  parseFilters,
  parseShadows,
  parseStroke,
  readBorder,
  readFill,
  readOutline,
  toggleFillPatch,
} from './effects'
import { aggregateColors, replaceColorPatch } from './selectionColors'

describe('colors', () => {
  it('parses hex, rgb, tokens and transparent', () => {
    expect(parseColor('#2f80ff')).toEqual({ kind: 'literal', hex: '2F80FF', alpha: 1 })
    expect(parseColor('#fff')).toEqual({ kind: 'literal', hex: 'FFFFFF', alpha: 1 })
    expect(parseColor('#C8F2308C')).toEqual({ kind: 'literal', hex: 'C8F230', alpha: 0.549 })
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ kind: 'literal', hex: '000000', alpha: 0.5 })
    expect(parseColor('rgb(255 128 0 / 25%)')).toEqual({
      kind: 'literal',
      hex: 'FF8000',
      alpha: 0.25,
    })
    expect(parseColor('var(--color-selection)')).toEqual({
      kind: 'token',
      token: '--color-selection',
      fallback: null,
    })
    expect(parseColor('transparent')).toEqual({ kind: 'literal', hex: '000000', alpha: 0 })
    expect(parseColor('hsl(0 0% 0%)')).toBeNull()
  })

  it('formats with alpha only when needed', () => {
    expect(formatColor('2f80ff')).toBe('#2F80FF')
    expect(formatColor('000000', 0.5)).toBe('#00000080')
  })

  it('resolves tokens and names them', () => {
    const tokens = { '--color-background': { value: '#FFFFFF' } }
    expect(
      resolveColor({ kind: 'token', token: '--color-background', fallback: null }, tokens),
    ).toEqual({
      kind: 'literal',
      hex: 'FFFFFF',
      alpha: 1,
    })
    expect(tokenShortName('--color-gray-400')).toBe('gray-400')
    expect(tokenShortName('--font-sans')).toBe('font-sans')
  })

  it('finds and replaces colors inside composite values', () => {
    const shadow = 'var(--color-selection) 0px 0px 0px 1px, #2F80FF2E 0px 0px 0px 4px'
    expect(findColors(shadow).map((f) => f.text)).toEqual(['var(--color-selection)', '#2F80FF2E'])
    const key = colorKey({ kind: 'token', token: '--color-selection', fallback: null })
    expect(replaceColor(shadow, key, '#FF0000')).toBe(
      '#FF0000 0px 0px 0px 1px, #2F80FF2E 0px 0px 0px 4px',
    )
    expect(replaceColor('1px solid red', 'hex:000000@1', '#fff')).toBe('1px solid red')
  })
})

describe('fills', () => {
  it('reads background and text fills, including hidden ones', () => {
    expect(readFill({ backgroundColor: 'var(--color-background)' }, 'frame')).toMatchObject({
      kind: 'solid',
      prop: 'backgroundColor',
      color: { kind: 'token', token: '--color-background' },
      hidden: false,
    })
    expect(readFill({ color: '#111111' }, 'text')).toMatchObject({ kind: 'solid', prop: 'color' })
    expect(readFill({ backgroundImage: 'linear-gradient(#FFF, #000)' }, 'frame')?.kind).toBe(
      'gradient',
    )
    expect(readFill({ '--hidden-backgroundColor': '#FFFFFF' }, 'rect')).toMatchObject({
      hidden: true,
    })
    expect(readFill({}, 'frame')).toBeNull()
  })

  it('toggles visibility through a custom property', () => {
    const fill = readFill({ backgroundColor: '#FFF' }, 'frame')
    expect(fill && toggleFillPatch(fill)).toEqual({
      backgroundColor: null,
      '--hidden-backgroundColor': '#FFF',
    })
  })

  it('switches fill kinds from the current color', () => {
    const fill = readFill({ backgroundColor: '#FF0000' }, 'frame')
    expect(fillKindPatch(fill, 'frame', 'gradient')).toEqual({
      backgroundColor: null,
      background: null,
      backgroundImage: 'linear-gradient(180deg, #FF0000 0%, #FFFFFF00 100%)',
    })
  })
})

describe('strokes, shadows, filters', () => {
  it('parses outlines and borders in any order', () => {
    expect(parseStroke('1.5px solid var(--color-selection)')).toMatchObject({
      width: 1.5,
      style: 'solid',
      colorText: 'var(--color-selection)',
    })
    expect(readOutline({ outline: 'dashed #000 2px' })).toMatchObject({ width: 2, style: 'dashed' })
    expect(
      readBorder({ borderColor: '#DADADA', borderStyle: 'solid', borderWidth: '1px' }),
    ).toMatchObject({
      width: 1,
      sides: ['top', 'right', 'bottom', 'left'],
    })
    expect(
      readBorder({ borderTopColor: '#EDEDED', borderTopStyle: 'solid', borderTopWidth: '1px' }),
    ).toMatchObject({ sides: ['top'] })
    const patch = borderPatch({ width: 2, style: 'solid', color: null, colorText: '#000' })
    expect(patch['borderWidth']).toBe('2px')
    expect(patch['borderTopColor']).toBeNull()
  })

  it('round-trips box shadows (outer and inset)', () => {
    const list = parseShadows('#C8F2308C 0px 0px 0px 3px, inset 0 1px 2px rgba(0,0,0,0.1)')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      inset: false,
      x: 0,
      y: 0,
      blur: 0,
      spread: 3,
      colorText: '#C8F2308C',
    })
    expect(list[1]).toMatchObject({ inset: true, y: 1, blur: 2 })
    expect(formatShadows(list)).toBe(
      '0px 0px 0px 3px #C8F2308C, inset 0px 1px 2px 0px rgba(0,0,0,0.1)',
    )
    expect(formatShadows([])).toBeNull()
  })

  it('round-trips filters', () => {
    const list = parseFilters('blur(4px) brightness(1.2) grayscale(50%)')
    expect(list).toEqual([
      { fn: 'blur', amount: 4 },
      { fn: 'brightness', amount: 120 },
      { fn: 'grayscale', amount: 50 },
    ])
    expect(formatFilters(list)).toBe('blur(4px) brightness(120%) grayscale(50%)')
  })
})

describe('selection colors', () => {
  const node = (id: string, styles: Record<string, string>) => ({
    id,
    type: 'frame' as const,
    name: id,
    parentId: null,
    children: [],
    styles,
  })

  it('counts each layer once per color, most used first', () => {
    const colors = aggregateColors([
      node('a', { color: '#111111', borderColor: '#111111' }),
      node('b', { backgroundColor: 'var(--color-background)', color: '#111111' }),
      node('c', { backgroundColor: 'var(--color-background)' }),
      node('d', { boxShadow: '0 0 0 3px #C8F2308C' }),
      node('e', { backgroundColor: 'transparent' }),
    ])
    expect(colors.map((c) => [c.key, c.count])).toEqual([
      ['hex:111111@1', 2],
      ['token:--color-background', 2],
      ['hex:C8F230@0.549', 1],
    ])
  })

  it('rewrites every occurrence of a color', () => {
    expect(
      replaceColorPatch(
        { color: '#111111', border: '1px solid #111111', fill: 'none' },
        'hex:111111@1',
        '#222222',
      ),
    ).toEqual({ color: '#222222', border: '1px solid #222222' })
  })
})
