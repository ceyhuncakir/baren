import { describe, expect, it } from 'vitest'
import { nextEnabledIndex, rovingKeyFor } from './roving'

describe('nextEnabledIndex', () => {
  const disabled = new Set([1]) // e.g. Edit menu: "Redo" disabled
  const isDisabled = (i: number) => disabled.has(i)

  it('moves forward and backward skipping disabled', () => {
    expect(nextEnabledIndex(0, 5, 'next', isDisabled)).toBe(2)
    expect(nextEnabledIndex(2, 5, 'prev', isDisabled)).toBe(0)
  })

  it('wraps around', () => {
    expect(nextEnabledIndex(4, 5, 'next', isDisabled)).toBe(0)
    expect(nextEnabledIndex(0, 5, 'prev', isDisabled)).toBe(4)
  })

  it('does not wrap when asked', () => {
    expect(nextEnabledIndex(4, 5, 'next', isDisabled, false)).toBe(4)
  })

  it('handles first/last and the no-focus state', () => {
    expect(nextEnabledIndex(-1, 5, 'next', isDisabled)).toBe(0)
    expect(nextEnabledIndex(-1, 5, 'first', () => false)).toBe(0)
    expect(nextEnabledIndex(-1, 5, 'last', (i) => i === 4)).toBe(3)
    expect(nextEnabledIndex(-1, 0, 'next')).toBe(-1)
    expect(nextEnabledIndex(0, 3, 'next', () => true)).toBe(-1)
  })
})

describe('rovingKeyFor', () => {
  it('maps keys per orientation', () => {
    expect(rovingKeyFor('ArrowDown', 'vertical')).toBe('next')
    expect(rovingKeyFor('ArrowDown', 'horizontal')).toBeNull()
    expect(rovingKeyFor('ArrowLeft', 'horizontal')).toBe('prev')
    expect(rovingKeyFor('Home', 'horizontal')).toBe('first')
  })
})
