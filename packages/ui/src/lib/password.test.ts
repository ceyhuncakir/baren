import { describe, expect, it } from 'vitest'
import { isAcceptablePassword, scorePassword, STRENGTH_LABELS } from './password'

describe('scorePassword', () => {
  it('scores empty as 0', () => {
    expect(scorePassword('')).toBe(0)
    expect(STRENGTH_LABELS[0]).toBe('')
  })

  it('requires 8 characters and a number', () => {
    expect(scorePassword('short1')).toBe(1)
    expect(scorePassword('longenoughbutnodigits')).toBe(1)
    expect(scorePassword('aaaaaaaaa1')).toBe(1)
  })

  it('grades by length and character classes', () => {
    expect(scorePassword('barenpad1')).toBe(2)
    expect(scorePassword('barenpad12')).toBe(3) // the artboard 19 example is 11 chars → Good
    expect(scorePassword('Baren-design-1')).toBe(4)
    expect(scorePassword('Interop!t1Ab')).toBe(4)
  })

  it('accepts from Fair upwards', () => {
    expect(isAcceptablePassword('barenpad1')).toBe(true)
    expect(isAcceptablePassword('barenpad')).toBe(false)
  })
})
