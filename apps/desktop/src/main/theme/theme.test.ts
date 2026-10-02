import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { themeFromArgv } from '../../preload/theme'
import { createLogger } from '../log'
import {
  THEME_BACKGROUND,
  isThemePreference,
  parseThemeFile,
  resolveTheme,
  serializeThemeFile,
  themeArgument,
  type ThemePreference,
} from './theme'
import { ThemeController, loadThemePreference, type NativeThemeLike } from './themeController'

const silent = createLogger('test', { sink: () => {} })

/** Behaves like Electron's nativeTheme: themeSource overrides the OS, `updated` on any change. */
class FakeNativeTheme implements NativeThemeLike {
  private source: ThemePreference = 'system'
  private readonly listeners: (() => void)[] = []
  constructor(public systemDark = false) {}
  get themeSource(): ThemePreference {
    return this.source
  }
  set themeSource(value: ThemePreference) {
    this.source = value
    this.emit()
  }
  get shouldUseDarkColors(): boolean {
    return this.source === 'system' ? this.systemDark : this.source === 'dark'
  }
  on(_event: 'updated', listener: () => void): void {
    this.listeners.push(listener)
  }
  setSystemDark(dark: boolean): void {
    this.systemDark = dark
    this.emit()
  }
  private emit(): void {
    for (const l of this.listeners) l()
  }
}

describe('theme resolution', () => {
  it('resolves system against the OS and keeps explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('validates preferences and parses the saved file defensively', () => {
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('Dark')).toBe(false)
    expect(isThemePreference(1)).toBe(false)
    expect(parseThemeFile({ preference: 'dark' })).toBe('dark')
    for (const bad of [null, 'dark', [], { preference: 'blue' }, { preference: 1 }]) {
      expect(parseThemeFile(bad)).toBe('system')
    }
    expect(JSON.parse(serializeThemeFile('light'))).toEqual({ preference: 'light' })
  })

  it('uses the surface colour of each theme as the window background', () => {
    expect(THEME_BACKGROUND).toEqual({ light: '#F7F7F7', dark: '#202020' })
  })

  it('passes the resolved theme to the preload as an argument it can read back', () => {
    expect(themeArgument('dark')).toBe('--baren-theme=dark')
    expect(themeFromArgv(['electron', themeArgument('light')])).toBe('light')
  })
})

describe('ThemeController', () => {
  const setup = (preference: ThemePreference, systemDark = false) => {
    const native = new FakeNativeTheme(systemDark)
    const changes: string[] = []
    const writes: [string, string][] = []
    const controller = new ThemeController(
      {
        file: '/x/theme.json',
        nativeTheme: native,
        log: silent,
        onChange: (resolved) => changes.push(resolved),
        write: async (file, data) => {
          writes.push([file, data])
        },
      },
      preference,
    )
    return { native, changes, writes, controller }
  }

  it('applies the saved preference to nativeTheme before any window exists', () => {
    const { native, controller, changes } = setup('dark')
    expect(native.themeSource).toBe('dark')
    expect(controller.resolved).toBe('dark')
    expect(controller.background).toBe('#202020')
    expect(changes).toEqual([])
  })

  it('persists a new preference and reports only actual light/dark switches', async () => {
    const { controller, changes, writes } = setup('system', true)
    expect(controller.resolved).toBe('dark')
    await controller.setPreference('dark') // still dark: nothing to repaint
    expect(changes).toEqual([])
    await controller.setPreference('light')
    expect(changes).toEqual(['light'])
    expect(controller.preference).toBe('light')
    expect(writes.map(([, d]) => JSON.parse(d).preference)).toEqual(['dark', 'light'])
  })

  it('follows the OS while the preference is system, and ignores it otherwise', async () => {
    const { native, controller, changes } = setup('system', false)
    native.setSystemDark(true)
    native.setSystemDark(true)
    expect(changes).toEqual(['dark'])
    await controller.setPreference('light')
    native.setSystemDark(false)
    native.setSystemDark(true)
    expect(changes).toEqual(['dark', 'light'])
    expect(controller.resolved).toBe('light')
  })

  it('keeps the preference for the session when saving fails', async () => {
    const native = new FakeNativeTheme()
    const controller = new ThemeController(
      {
        file: '/x/theme.json',
        nativeTheme: native,
        log: silent,
        onChange: () => {},
        write: async () => {
          throw new Error('disk full')
        },
      },
      'light',
    )
    await expect(controller.setPreference('dark')).resolves.toBeUndefined()
    expect(controller.resolved).toBe('dark')
  })

  it('round-trips the preference through theme.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baren-theme-'))
    try {
      const file = join(dir, 'theme.json')
      expect(await loadThemePreference(file, silent)).toBe('system')
      const controller = new ThemeController(
        { file, nativeTheme: new FakeNativeTheme(), log: silent, onChange: () => {} },
        'system',
      )
      await controller.setPreference('dark')
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ preference: 'dark' })
      expect(await loadThemePreference(file, silent)).toBe('dark')
      await writeFile(file, '{not json')
      expect(await loadThemePreference(file, silent)).toBe('system')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
