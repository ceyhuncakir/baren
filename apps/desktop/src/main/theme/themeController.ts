/**
 * App theme: the persisted Light / Dark / System preference (`<userData>/theme.json`) applied
 * through `nativeTheme.themeSource`, so native UI and `prefers-color-scheme` follow it too.
 * `nativeTheme.shouldUseDarkColors` is then the resolved theme; changes (a new preference, or
 * the OS theme while on 'system') are reported once per actual light ↔ dark switch.
 */
import type { Logger } from '../log'
import { readJsonOrNull, writeFileAtomic } from '../util/fs'
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_BACKGROUND,
  parseThemeFile,
  serializeThemeFile,
  type ResolvedTheme,
  type ThemePreference,
} from './theme'

/** The slice of Electron's `nativeTheme` used here (fake-able in tests). */
export interface NativeThemeLike {
  themeSource: ThemePreference
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
}

export interface ThemeControllerOptions {
  file: string
  nativeTheme: NativeThemeLike
  log: Logger
  /** The resolved theme switched: repaint window backgrounds and notify renderers. */
  onChange(resolved: ResolvedTheme): void
  write?(file: string, data: string): Promise<void>
}

/** Read the saved preference (missing or unreadable file → 'system'). Safe before `app.ready`. */
export async function loadThemePreference(file: string, log: Logger): Promise<ThemePreference> {
  try {
    return parseThemeFile(await readJsonOrNull(file))
  } catch (error) {
    log.warn('ignoring unreadable theme preference', { file, error: String(error) })
    return DEFAULT_THEME_PREFERENCE
  }
}

export class ThemeController {
  private current: ThemePreference
  private resolvedTheme: ResolvedTheme
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: ThemeControllerOptions,
    preference: ThemePreference,
  ) {
    this.current = preference
    options.nativeTheme.themeSource = preference
    this.resolvedTheme = this.readResolved()
    options.nativeTheme.on('updated', () => this.refresh())
  }

  get preference(): ThemePreference {
    return this.current
  }

  get resolved(): ResolvedTheme {
    return this.resolvedTheme
  }

  /** Window background for the resolved theme. */
  get background(): string {
    return THEME_BACKGROUND[this.resolvedTheme]
  }

  /** Apply now, then persist. A failed write is logged; the preference still holds this session. */
  async setPreference(preference: ThemePreference): Promise<void> {
    if (preference !== this.current) {
      this.current = preference
      this.options.nativeTheme.themeSource = preference
      this.refresh()
    }
    const write = this.options.write ?? writeFileAtomic
    const data = serializeThemeFile(preference)
    this.writing = this.writing
      .then(() => write(this.options.file, data))
      .catch((error: unknown) => {
        this.options.log.warn('could not save the theme preference', String(error))
      })
    await this.writing
  }

  private readResolved(): ResolvedTheme {
    return this.options.nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  /** Re-read the resolved theme; report it when it switched. */
  private refresh(): void {
    const resolved = this.readResolved()
    if (resolved === this.resolvedTheme) return
    this.resolvedTheme = resolved
    try {
      this.options.onChange(resolved)
    } catch (error) {
      this.options.log.warn('theme change handler failed', String(error))
    }
  }
}
