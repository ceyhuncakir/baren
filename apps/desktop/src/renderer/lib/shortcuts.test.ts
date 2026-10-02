import { describe, expect, it } from 'vitest'
import { formatShortcut, matchesShortcut, parseShortcut, type KeyEventLike } from './shortcuts'

const key = (over: Partial<KeyEventLike>): KeyEventLike => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

describe('shortcuts', () => {
  it('parses modifiers and keys', () => {
    expect(parseShortcut('Mod+Shift+N')).toEqual({
      mod: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: 'n',
    })
    expect(parseShortcut('F11')).toMatchObject({ mod: false, key: 'F11' })
    expect(parseShortcut('Mod+,').key).toBe(',')
  })

  it('formats like the HTML menus on Linux/Windows and with symbols on macOS', () => {
    expect(formatShortcut('Mod+Shift+N', 'linux')).toBe('Ctrl+Shift+N')
    expect(formatShortcut('Mod+Q', 'win32')).toBe('Ctrl+Q')
    expect(formatShortcut('Delete', 'linux')).toBe('Del')
    expect(formatShortcut('Mod+,', 'linux')).toBe('Ctrl+,')
    expect(formatShortcut('F11', 'linux')).toBe('F11')
    expect(formatShortcut('Mod+Shift+Z', 'darwin')).toBe('⇧⌘Z')
  })

  it('matches by physical key for letters, so Shift does not change the key', () => {
    const s = parseShortcut('Mod+Shift+Z')
    expect(
      matchesShortcut(key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), s, 'linux'),
    ).toBe(true)
    expect(matchesShortcut(key({ key: 'z', code: 'KeyZ', ctrlKey: true }), s, 'linux')).toBe(false)
    // Mod is ⌘ on macOS: Ctrl alone must not match.
    expect(
      matchesShortcut(key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), s, 'darwin'),
    ).toBe(false)
    expect(
      matchesShortcut(key({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true }), s, 'darwin'),
    ).toBe(true)
  })

  it('requires the exact modifier set', () => {
    const undo = parseShortcut('Mod+Z')
    expect(
      matchesShortcut(key({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true }), undo, 'linux'),
    ).toBe(false)
    expect(
      matchesShortcut(key({ key: 'Delete', code: 'Delete' }), parseShortcut('Delete'), 'linux'),
    ).toBe(true)
    expect(
      matchesShortcut(
        key({ key: '/', code: 'Slash', ctrlKey: true }),
        parseShortcut('Mod+/'),
        'linux',
      ),
    ).toBe(true)
  })
})
