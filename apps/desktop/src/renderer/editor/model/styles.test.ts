import { describe, expect, it } from 'vitest'
import {
  MIXED,
  alignmentPatch,
  common,
  letterSpacingPatch,
  opacityPatch,
  paddingPatch,
  parseShorthand,
  pxValue,
  radiusPatch,
  readAlignment,
  readOpacity,
  readPadding,
  readRadius,
  readRotation,
  readTypography,
  rotationPatch,
  sizeMode,
  sizeModePatch,
  toPx,
  type SizeContext,
} from './styles'

const nested: SizeContext = { type: 'frame', isTop: false, parentFlexDirection: 'column' }
const top: SizeContext = { type: 'frame', isTop: true, parentFlexDirection: null }

describe('px values', () => {
  it('parses numbers and px strings only', () => {
    expect(toPx(12)).toBe(12)
    expect(toPx('12px')).toBe(12)
    expect(toPx(' -4.5px ')).toBe(-4.5)
    expect(toPx('12')).toBe(12)
    expect(toPx('50%')).toBeNull()
    expect(toPx('auto')).toBeNull()
    expect(toPx(undefined)).toBeNull()
  })

  it('keeps the existing number/string format when writing', () => {
    expect(pxValue(10, 12)).toBe(12)
    expect(pxValue('10px', 12)).toBe('12px')
    expect(pxValue(undefined, 12.3456)).toBe('12.35px')
  })
})

describe('common', () => {
  it('returns the shared value, MIXED, or undefined', () => {
    expect(common([1, 1, 1])).toBe(1)
    expect(common([1, 2])).toBe(MIXED)
    expect(common([])).toBeUndefined()
  })
})

describe('size modes (mirror @baren/canvas)', () => {
  it('classifies fixed, hug, fit and fill', () => {
    expect(sizeMode({ width: 1440 }, 'width', top)).toBe('fixed')
    expect(sizeMode({}, 'height', top)).toBe('fit')
    expect(sizeMode({}, 'width', nested)).toBe('hug')
    expect(sizeMode({ width: '100%' }, 'width', nested)).toBe('fill')
    expect(sizeMode({ flexGrow: 1 }, 'height', nested)).toBe('fill')
    expect(sizeMode({}, 'height', { type: 'text', isTop: false, parentFlexDirection: 'row' })).toBe(
      'fixed',
    )
  })

  it('switches modes with minimal patches', () => {
    expect(sizeModePatch({}, 'width', 'fixed', nested, 132.4)).toEqual({ width: '132px' })
    expect(sizeModePatch({ height: 40, flexGrow: 1 }, 'height', 'hug', nested, null)).toEqual({
      height: null,
      flexGrow: null,
      flexBasis: null,
    })
    // Fill on the parent's main axis grows; on the cross axis it stretches.
    expect(sizeModePatch({ height: 40 }, 'height', 'fill', nested, null)).toEqual({
      height: null,
      flexGrow: 1,
      flexBasis: '0%',
    })
    expect(sizeModePatch({ width: 40 }, 'width', 'fill', nested, null)).toEqual({ width: '100%' })
  })
})

describe('rotation', () => {
  it('reads rotate and transform', () => {
    expect(readRotation({ rotate: '15deg' })).toBe(15)
    expect(readRotation({ transform: 'translateX(2px) rotate(-30deg)' })).toBe(-30)
    expect(readRotation({})).toBe(0)
  })

  it('normalizes into (-180, 180] and drops zero', () => {
    expect(rotationPatch(270)).toEqual({ rotate: '-90deg' })
    expect(rotationPatch(180)).toEqual({ rotate: '180deg' })
    expect(rotationPatch(360)).toEqual({ rotate: null })
  })
})

describe('flex alignment', () => {
  it('maps the grid to justify/align by direction', () => {
    expect(
      readAlignment({ flexDirection: 'column', justifyContent: 'center', alignItems: 'end' }),
    ).toEqual({
      x: 'end',
      y: 'center',
      distribution: 'packed',
    })
    expect(readAlignment({ justifyContent: 'space-between', alignItems: 'center' })).toEqual({
      x: 'start',
      y: 'center',
      distribution: 'space-between',
    })
    expect(alignmentPatch({ flexDirection: 'column' }, { x: 'center', y: 'end' }, false)).toEqual({
      justifyContent: 'end',
      alignItems: 'center',
    })
    expect(alignmentPatch({}, { x: 'start', y: 'center' }, false)).toEqual({
      justifyContent: null,
      alignItems: 'center',
    })
  })
})

describe('padding', () => {
  it('parses shorthands', () => {
    expect(parseShorthand('4px 8px')).toEqual({ top: 4, right: 8, bottom: 4, left: 8 })
    expect(parseShorthand('1px 2px 3px')).toEqual({ top: 1, right: 2, bottom: 3, left: 2 })
    expect(parseShorthand(6)).toEqual({ top: 6, right: 6, bottom: 6, left: 6 })
  })

  it('merges shorthand, block/inline and longhands (later wins)', () => {
    expect(readPadding({ paddingBlock: '40px', paddingInline: '48px' })).toEqual({
      top: 40,
      right: 48,
      bottom: 40,
      left: 48,
    })
    expect(readPadding({ padding: '10px', paddingLeft: '2px' })).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 2,
    })
  })

  it('writes longhands and removes shorthands', () => {
    const styles = { paddingBlock: '40px', paddingInline: '48px' }
    expect(paddingPatch(styles, { top: 40, right: 48, bottom: 40, left: 10 })).toEqual({
      paddingBlock: null,
      paddingInline: null,
      paddingTop: '40px',
      paddingRight: '48px',
      paddingBottom: '40px',
      paddingLeft: '10px',
    })
  })
})

describe('radius, opacity, typography', () => {
  it('reads uniform and mixed corner radii', () => {
    expect(readRadius({ borderRadius: '6px' })).toBe(6)
    expect(readRadius({ borderRadius: 4, borderTopLeftRadius: 8 })).toBe(MIXED)
    expect(radiusPatch({ borderTopLeftRadius: 8 }, 0)).toEqual({
      borderRadius: null,
      borderTopLeftRadius: null,
    })
  })

  it('reads opacity as percent', () => {
    expect(readOpacity({ opacity: 0.5 })).toBe(50)
    expect(readOpacity({ opacity: '40%' })).toBe(40)
    expect(readOpacity({})).toBe(100)
    expect(opacityPatch(100)).toEqual({ opacity: null })
    expect(opacityPatch(25)).toEqual({ opacity: 0.25 })
  })

  it('reads typography with string units', () => {
    const t = readTypography({
      fontFamily: 'Inter',
      fontSize: '26px',
      fontWeight: 600,
      lineHeight: '32px',
      letterSpacing: '-0.02em',
    })
    expect(t).toMatchObject({
      family: 'Inter',
      size: 26,
      weight: 600,
      lineHeight: 32,
      letterSpacing: -2,
    })
    expect(readTypography({ fontSize: 10, lineHeight: 1.5 }).lineHeight).toBe(15)
    expect(readTypography({}).lineHeight).toBeNull()
    expect(letterSpacingPatch(0)).toEqual({ letterSpacing: null })
    expect(letterSpacingPatch(20)).toEqual({ letterSpacing: '0.2em' })
  })
})
