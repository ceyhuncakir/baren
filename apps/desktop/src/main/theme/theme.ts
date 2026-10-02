/** Pure parts of the app theme (unit-tested without Electron). */
import { THEME_ARGUMENT_PREFIX, THEME_PREFERENCES } from '../../preload/channels'
import type { ResolvedTheme, ThemePreference } from '../../renderer/types/bridge'

export type { ResolvedTheme, ThemePreference }

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

/**
 * `--color-surface` of each theme (packages/ui tokens; dark per the Phase 2 contract): the
 * window paints it before the renderer's first frame, so there is no flash.
 */
export const THEME_BACKGROUND: Readonly<Record<ResolvedTheme, string>> = {
  light: '#F7F7F7',
  dark: '#202020',
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

/** `theme.json` contents → preference; anything unexpected falls back to the default. */
export function parseThemeFile(json: unknown): ThemePreference {
  if (typeof json === 'object' && json !== null) {
    const preference = (json as { preference?: unknown }).preference
    if (isThemePreference(preference)) return preference
  }
  return DEFAULT_THEME_PREFERENCE
}

export function serializeThemeFile(preference: ThemePreference): string {
  return `${JSON.stringify({ preference })}\n`
}

/** The `webPreferences.additionalArguments` entry the preload reads (`preload/theme.ts`). */
export function themeArgument(resolved: ResolvedTheme): string {
  return `${THEME_ARGUMENT_PREFIX}${resolved}`
}
