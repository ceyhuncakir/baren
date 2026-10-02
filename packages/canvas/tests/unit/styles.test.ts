import { describe, expect, it } from 'vitest'
import {
  clipsContent,
  cssPropertyName,
  cssValue,
  flexDirectionOf,
  isAbsolutelyPositioned,
  pxValue,
  stylesToCssText,
} from '../../src/render/styles.ts'

describe('style conversion', () => {
  it('converts camelCase keys to CSS property names', () => {
    expect(cssPropertyName('backgroundColor')).toBe('background-color')
    expect(cssPropertyName('WebkitFontSmoothing')).toBe('-webkit-font-smoothing')
    expect(cssPropertyName('MozOsxFontSmoothing')).toBe('-moz-osx-font-smoothing')
    expect(cssPropertyName('msTransform')).toBe('-ms-transform')
    expect(cssPropertyName('objectFit')).toBe('object-fit')
    expect(cssPropertyName('--color-primary')).toBe('--color-primary')
    expect(cssPropertyName('color; position: fixed')).toBeNull()
    expect(cssPropertyName('--bad name')).toBeNull()
  })

  it('adds px to numbers except unitless properties', () => {
    expect(cssValue('width', 120)).toBe('120px')
    expect(cssValue('left', 0)).toBe('0')
    expect(cssValue('opacity', 0.5)).toBe('0.5')
    expect(cssValue('flexGrow', 1)).toBe('1')
    expect(cssValue('fontWeight', 500)).toBe('500')
    expect(cssValue('gap', '12px')).toBe('12px')
  })

  it('builds cssText and refuses values that could inject declarations', () => {
    expect(stylesToCssText({ display: 'flex', gap: '12px', left: 10 }, new Set(['left']))).toBe(
      'display:flex;gap:12px;',
    )
    expect(stylesToCssText({ color: 'red; position: fixed' })).toBeNull()
    expect(stylesToCssText({ color: 'red}body{display:none' })).toBeNull()
  })

  it('parses px values and layout facts', () => {
    expect(pxValue(12)).toBe(12)
    expect(pxValue('12.5px')).toBe(12.5)
    expect(pxValue(' -4 ')).toBe(-4)
    expect(pxValue('50%')).toBeNull()
    expect(pxValue(undefined)).toBeNull()
    expect(flexDirectionOf({ display: 'flex' })).toBe('row')
    expect(flexDirectionOf({ display: 'flex', flexDirection: 'column' })).toBe('column')
    expect(flexDirectionOf({ display: 'block' })).toBeNull()
    expect(isAbsolutelyPositioned({ position: 'absolute' })).toBe(true)
    expect(isAbsolutelyPositioned({ position: 'relative' })).toBe(false)
    expect(clipsContent({ overflow: 'clip' })).toBe(true)
    expect(clipsContent({})).toBe(false)
  })
})
