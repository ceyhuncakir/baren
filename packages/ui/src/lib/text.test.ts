import { describe, expect, it } from 'vitest'
import { avatarColorFor, getInitials, groupCode, nextCode, sanitizeCode } from './text'

describe('getInitials', () => {
  it('matches the artboards (single letter)', () => {
    expect(getInitials('ceyhun cakir')).toBe('C')
    expect(getInitials('Defne Aydın')).toBe('D')
    expect(getInitials('Acme Labs')).toBe('A')
  })

  it('supports two letters and emails', () => {
    expect(getInitials('ceyhun cakir', 2)).toBe('CC')
    expect(getInitials('mert@example.com', 2)).toBe('ME')
    expect(getInitials('   ')).toBe('?')
  })
})

describe('codes', () => {
  it('sanitizes numeric codes', () => {
    expect(sanitizeCode('482-703', 6)).toBe('482703')
    expect(sanitizeCode('48a2 7039', 6)).toBe('482703')
  })

  it('sanitizes alphanumeric device codes', () => {
    expect(sanitizeCode('kq7-4xm', 6, true)).toBe('KQ74XM')
  })

  it('replaces a full code when a whole new one is pasted after it', () => {
    expect(nextCode('000000103023', '000000', 6)).toBe('103023')
    expect(nextCode('000000 103-023', '000000', 6)).toBe('103023')
    expect(nextCode('kq74xmab12cd', 'KQ74XM', 6, true)).toBe('AB12CD')
    // Typing into a full field keeps it (a partial addition is not a new code).
    expect(nextCode('0000001', '000000', 6)).toBe('000000')
    // Ordinary edits behave like sanitizeCode.
    expect(nextCode('48270', '4827', 6)).toBe('48270')
    expect(nextCode('482 703', '', 6)).toBe('482703')
    expect(nextCode('48270', '482703', 6)).toBe('48270')
  })

  it('groups codes', () => {
    expect(groupCode('482703', 3)).toEqual(['482', '703'])
    expect(groupCode('4827', 3)).toEqual(['482', '7'])
    expect(groupCode('', 3)).toEqual([])
  })
})

describe('avatarColorFor', () => {
  it('is stable', () => {
    expect(avatarColorFor('defne')).toBe(avatarColorFor('defne'))
    expect(avatarColorFor('x')).toMatch(/^#[0-9A-F]{6}$/)
  })
})
