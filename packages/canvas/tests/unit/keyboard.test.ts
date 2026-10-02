import { describe, expect, it } from 'vitest'
import { keyToCommand, type KeyLike } from '../../src/interaction/keyboard.ts'

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return {
    key: k,
    code: mods.code ?? '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  }
}

describe('keyboard shortcuts', () => {
  it('maps tool keys', () => {
    expect(keyToCommand(key('v'), 'all')).toEqual({ kind: 'tool', tool: 'select' })
    expect(keyToCommand(key('H'), 'all')).toEqual({ kind: 'tool', tool: 'hand' })
    expect(keyToCommand(key('a'), 'all')).toEqual({ kind: 'tool', tool: 'artboard' })
    expect(keyToCommand(key('f'), 'all')).toEqual({ kind: 'tool', tool: 'artboard' })
    expect(keyToCommand(key('r'), 'all')).toEqual({ kind: 'tool', tool: 'rectangle' })
    expect(keyToCommand(key('t'), 'all')).toEqual({ kind: 'tool', tool: 'text' })
  })

  it('nudges by 1 or 10 with Shift', () => {
    expect(keyToCommand(key('ArrowLeft'), 'all')).toEqual({ kind: 'nudge', dx: -1, dy: 0 })
    expect(keyToCommand(key('ArrowDown', { shiftKey: true }), 'all')).toEqual({
      kind: 'nudge',
      dx: 0,
      dy: 10,
    })
  })

  it('maps edit and zoom shortcuts with Ctrl or Meta', () => {
    expect(keyToCommand(key('z', { ctrlKey: true }), 'all')).toEqual({ kind: 'undo' })
    expect(keyToCommand(key('Z', { metaKey: true, shiftKey: true }), 'all')).toEqual({
      kind: 'redo',
    })
    expect(keyToCommand(key('y', { ctrlKey: true }), 'all')).toEqual({ kind: 'redo' })
    expect(keyToCommand(key('d', { ctrlKey: true }), 'all')).toEqual({ kind: 'duplicate' })
    expect(keyToCommand(key('=', { ctrlKey: true, code: 'Equal' }), 'all')).toEqual({
      kind: 'zoomIn',
    })
    expect(keyToCommand(key('-', { ctrlKey: true, code: 'Minus' }), 'all')).toEqual({
      kind: 'zoomOut',
    })
    expect(keyToCommand(key('0', { ctrlKey: true, code: 'Digit0' }), 'all')).toEqual({
      kind: 'zoom100',
    })
    expect(keyToCommand(key('!', { shiftKey: true, code: 'Digit1' }), 'all')).toEqual({
      kind: 'zoomFit',
    })
    expect(keyToCommand(key('@', { shiftKey: true, code: 'Digit2' }), 'all')).toEqual({
      kind: 'zoomSelection',
    })
  })

  it('maps delete, escape and enter', () => {
    expect(keyToCommand(key('Delete'), 'all')).toEqual({ kind: 'delete' })
    expect(keyToCommand(key('Backspace'), 'all')).toEqual({ kind: 'delete' })
    expect(keyToCommand(key('Escape'), 'all')).toEqual({ kind: 'escape' })
    expect(keyToCommand(key('Enter'), 'all')).toEqual({ kind: 'enter' })
    expect(keyToCommand(key('Enter', { shiftKey: true }), 'all')).toEqual({ kind: 'selectParent' })
  })

  it('leaves host commands to the host in "canvas" mode and ignores everything in "none"', () => {
    expect(keyToCommand(key('z', { ctrlKey: true }), 'canvas')).toBeNull()
    expect(keyToCommand(key('=', { ctrlKey: true, code: 'Equal' }), 'canvas')).toBeNull()
    expect(keyToCommand(key('d', { ctrlKey: true }), 'canvas')).toEqual({ kind: 'duplicate' })
    expect(keyToCommand(key('v'), 'none')).toBeNull()
  })

  it('ignores unrelated combos', () => {
    expect(keyToCommand(key('q'), 'all')).toBeNull()
    expect(keyToCommand(key('v', { altKey: true }), 'all')).toBeNull()
    expect(keyToCommand(key('z', { ctrlKey: true, altKey: true }), 'all')).toBeNull()
  })
})
