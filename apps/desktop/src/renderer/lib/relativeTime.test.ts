import { describe, expect, it } from 'vitest'
import { formatEdited, formatRelative } from './relativeTime'

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

describe('relative time', () => {
  it('reads like the artboards', () => {
    const now = 1_000_000_000_000
    expect(formatEdited(now - 5 * S, now)).toBe('Edited just now')
    expect(formatEdited(now - 4 * M - 5 * S, now)).toBe('Edited 4 minutes ago')
    expect(formatRelative(now - 2 * H - 5 * M, now)).toBe('2 hours ago')
    expect(formatEdited(now - 28 * D - H, now)).toBe('Edited 28 days ago')
    expect(formatEdited(now - 79 * D - H, now)).toBe('Edited 79 days ago')
  })

  it('uses singular units and never goes negative', () => {
    const now = 10 * 365 * D
    expect(formatRelative(now - M, now)).toBe('1 minute ago')
    expect(formatRelative(now - H, now)).toBe('1 hour ago')
    expect(formatRelative(now - D, now)).toBe('1 day ago')
    expect(formatRelative(now - 400 * D, now)).toBe('1 year ago')
    expect(formatRelative(now + 5 * M, now)).toBe('just now')
  })
})
