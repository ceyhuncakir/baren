import { describe, expect, it } from 'vitest'
import {
  constrain,
  formatNumber,
  nudge,
  parseNumberInput,
  ratioFromValue,
  roundTo,
  scrubValue,
  valueFromRatio,
} from './number'

describe('parseNumberInput', () => {
  it('parses plain numbers and units', () => {
    expect(parseNumberInput('1440', 0)).toBe(1440)
    expect(parseNumberInput('24px', 0)).toBe(24)
    expect(parseNumberInput('45°', 0, '°')).toBe(45)
    expect(parseNumberInput(' -600 ', 0)).toBe(-600)
    expect(parseNumberInput('.5', 0)).toBe(0.5)
  })

  it('evaluates one binary operation', () => {
    expect(parseNumberInput('100+20', 0)).toBe(120)
    expect(parseNumberInput('96 / 2', 0)).toBe(48)
    expect(parseNumberInput('10*3', 0)).toBe(30)
    expect(parseNumberInput('10-30', 0)).toBe(-20)
  })

  it('applies leading operators to the current value', () => {
    expect(parseNumberInput('+10', 96)).toBe(106)
    expect(parseNumberInput('*2', 96)).toBe(192)
    expect(parseNumberInput('/4', 96)).toBe(24)
  })

  it('treats a leading minus as a negative number, not subtraction', () => {
    expect(parseNumberInput('-10', 96)).toBe(-10)
  })

  it('clamps and rejects invalid input', () => {
    expect(parseNumberInput('120', 0, '%', { min: 0, max: 100 })).toBe(100)
    expect(parseNumberInput('abc', 0)).toBeNull()
    expect(parseNumberInput('', 0)).toBeNull()
    expect(parseNumberInput('1/0', 0)).toBeNull()
  })
})

describe('rounding and formatting', () => {
  it('rounds without negative zero', () => {
    expect(roundTo(-0.0001, 2)).toBe(0)
    expect(Object.is(roundTo(-0.0001, 2), -0)).toBe(false)
    expect(roundTo(1.005, 1)).toBe(1)
    expect(constrain(3.14159, { precision: 3 })).toBe(3.142)
  })

  it('formats with units', () => {
    expect(formatNumber(0, '°')).toBe('0°')
    expect(formatNumber(12.345, 'px', 1)).toBe('12.3px')
  })
})

describe('nudge and scrub', () => {
  it('nudges by step, x10 with shift, /10 with alt', () => {
    expect(nudge(10, 1, 1, {})).toBe(11)
    expect(nudge(10, -1, 1, { shiftKey: true })).toBe(0)
    expect(nudge(10, 1, 1, { altKey: true })).toBe(10.1)
    expect(nudge(0, -1, 1, {}, { min: 0 })).toBe(0)
  })

  it('scrubs from the start value using total travel', () => {
    expect(scrubValue(96, 20, 1, {})).toBe(106)
    expect(scrubValue(96, -21, 1, {})).toBe(86)
    expect(scrubValue(96, 5, 1, { shiftKey: true })).toBe(116)
    expect(scrubValue(0, -100, 1, {}, { min: 0 })).toBe(0)
  })
})

describe('slider ratios', () => {
  it('maps ratios to stepped values', () => {
    expect(valueFromRatio(0.5, 0, 100, 1)).toBe(50)
    expect(valueFromRatio(0.333, 0, 100, 5)).toBe(35)
    expect(valueFromRatio(1.5, 0, 100, 1)).toBe(100)
    expect(valueFromRatio(0.25, 0, 1, 0.01)).toBe(0.25)
  })

  it('maps values back to ratios', () => {
    expect(ratioFromValue(25, 0, 100)).toBe(0.25)
    expect(ratioFromValue(5, 5, 5)).toBe(0)
  })
})
