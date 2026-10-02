import { describe, expect, it } from 'vitest'
import { formatShortcut, parseShortcut } from '../lib/shortcuts'
import { APP_MENUS, SHORTCUTS, scopeOf } from './menuModel'

const rows = (label: string) =>
  APP_MENUS.find((m) => m.label === label)?.entries.map((e) =>
    e.kind === 'separator'
      ? '—'
      : `${e.label}${e.shortcut ? ` ${formatShortcut(e.shortcut, 'linux')}` : ''}`,
  )

describe('menu model', () => {
  it('matches artboards 09–13 exactly', () => {
    expect(APP_MENUS.map((m) => [m.label, m.width])).toEqual([
      ['File', 248],
      ['Edit', 248],
      ['View', 300],
      ['Window', 200],
      ['Help', 220],
    ])
    expect(rows('File')).toEqual(['New Window Ctrl+Shift+N', '—', 'Quit Ctrl+Q'])
    expect(rows('Edit')).toEqual([
      'Undo Ctrl+Z',
      'Redo Ctrl+Shift+Z',
      '—',
      'Cut Ctrl+X',
      'Copy Ctrl+C',
      'Paste Ctrl+V',
      'Delete Del',
      '—',
      'Select All Ctrl+A',
    ])
    expect(rows('View')).toEqual([
      'Reload Ctrl+R',
      'Force Reload Ctrl+Shift+R',
      'Toggle Developer Tools Ctrl+Shift+I',
      '—',
      'Toggle Full Screen F11',
    ])
    expect(rows('Window')).toEqual(['Minimize Ctrl+M', 'Zoom', 'Close Ctrl+W'])
    expect(rows('Help')).toEqual([
      'Check for Updates…',
      '—',
      'Documentation',
      'Video Tutorials',
      'Release Notes',
      '—',
      'Discord',
      'Slack Community',
      'Reddit',
      'X / Twitter',
    ])
  })

  it('has one action per key chord and routes scopes correctly', () => {
    const chords = SHORTCUTS.map((s) => JSON.stringify(parseShortcut(s.shortcut)))
    expect(new Set(chords).size).toBe(chords.length)
    expect(scopeOf('edit.copy')).toBe('edit')
    expect(scopeOf('app.quit')).toBe('main')
    expect(scopeOf('window.close')).toBe('main')
    expect(scopeOf('ui.focusSearch')).toBe('app')
  })
})
