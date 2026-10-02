/**
 * The resolved theme the preload exposes as `theme.initial`, known synchronously so the
 * renderer can set `<html data-theme>` before its first paint.
 *
 * Main passes the theme in `webPreferences.additionalArguments` when it creates a window
 * (free: no IPC on the cold-start path). That value is fixed for the window's lifetime, so a
 * reload after a theme change would see a stale one: reloads ask main synchronously instead.
 */
import type { ResolvedTheme } from '../renderer/types/bridge'
import { RESOLVED_THEMES, THEME_ARGUMENT_PREFIX } from './channels'

export function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return typeof value === 'string' && (RESOLVED_THEMES as readonly string[]).includes(value)
}

/** The theme from `--baren-theme=<light|dark>` (the last one wins), or null. */
export function themeFromArgv(argv: readonly string[]): ResolvedTheme | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith(THEME_ARGUMENT_PREFIX)) continue
    const value = arg.slice(THEME_ARGUMENT_PREFIX.length)
    return isResolvedTheme(value) ? value : null
  }
  return null
}

export interface InitialThemeSources {
  /** `process.argv` of the renderer (main appends `--baren-theme=…`). */
  argv: readonly string[]
  /** `PerformanceNavigationTiming.type` of this document (`navigate`, `reload`, …), if known. */
  navigationType: string | null
  /** Ask main for the current resolved theme (synchronous IPC). */
  queryMain(): unknown
  /** `prefers-color-scheme: dark` (main sets `nativeTheme.themeSource`, so it mirrors the app theme). */
  prefersDark(): boolean
}

export function initialTheme(sources: InitialThemeSources): ResolvedTheme {
  const fromArgv = themeFromArgv(sources.argv)
  if (fromArgv !== null && sources.navigationType !== 'reload') return fromArgv
  try {
    const fromMain = sources.queryMain()
    if (isResolvedTheme(fromMain)) return fromMain
  } catch {
    // Main refused or is unavailable: fall through.
  }
  if (fromArgv !== null) return fromArgv
  try {
    return sources.prefersDark() ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}
