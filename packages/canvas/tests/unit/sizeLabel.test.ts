import { describe, expect, it } from 'vitest'
import { plainSizeLabel, sizeLabel, sizeMode } from '../../src/math/sizeLabel.ts'

describe('size label', () => {
  it('shows "1440 × Fit" for an artboard with fit-content height (artboard 06)', () => {
    expect(
      sizeLabel(
        { width: 1440, height: 'fit-content' },
        { width: 1440, height: 2400 },
        { type: 'frame', isTop: true },
      ),
    ).toBe('1440 × Fit')
  })

  it('shows "Hug × 16" for an auto-width text (artboard 14)', () => {
    expect(
      sizeLabel(
        { fontSize: '13px', lineHeight: '16px' },
        { width: 37.4, height: 16 },
        { type: 'text', isTop: false, parentFlexDirection: 'column' },
      ),
    ).toBe('Hug × 16')
  })

  it('reports Fill for 100% and flex-grow along the main axis', () => {
    expect(sizeMode({ width: '100%' }, 'width', { type: 'frame', isTop: false })).toBe('fill')
    expect(
      sizeMode({ flexGrow: 1 }, 'width', {
        type: 'frame',
        isTop: false,
        parentFlexDirection: 'row',
      }),
    ).toBe('fill')
    expect(
      sizeMode({ flexGrow: 1 }, 'height', {
        type: 'frame',
        isTop: false,
        parentFlexDirection: 'row',
      }),
    ).toBe('hug')
  })

  it('fixed values show measured numbers (rounded to 0.1)', () => {
    expect(
      sizeLabel(
        { width: 120, height: '30px' },
        { width: 120, height: 30.04 },
        { type: 'rect', isTop: false },
      ),
    ).toBe('120 × 30')
    expect(plainSizeLabel({ width: 10.25, height: 3 })).toBe('10.3 × 3')
  })
})
