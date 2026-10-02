/**
 * App theme (ARCHITECTURE.md "Dark theme"). The main process owns the Light / Dark / System
 * preference and resolves it; the renderer mirrors the resolved theme on
 * `<html data-theme="light|dark">` (the tokens switch on it) and shows the preference in the
 * Account menu. Design content never follows this: the canvas scopes document tokens itself.
 */
import { create } from 'zustand'
import { bridge } from '../lib/bridge'
import type { ResolvedTheme, ThemePreference } from '../types/bridge'

export interface ThemeState {
  /** null until the main process answered (the control shows nothing selected meanwhile). */
  preference: ThemePreference | null
  resolved: ResolvedTheme
  setPreference(preference: ThemePreference): Promise<void>
}

function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset['theme'] = theme
}

export const useTheme = create<ThemeState>()((set, get) => ({
  preference: null,
  resolved: bridge.theme.initial,
  async setPreference(preference) {
    const previous = get().preference
    set({ preference })
    try {
      await bridge.theme.setPreference(preference)
    } catch {
      set({ preference: previous })
    }
  },
}))

let installed = false

/**
 * Called first thing in the renderer entry, before React renders: sets `data-theme` from
 * `bridge.theme.initial` (synchronous, so the first paint already has the right tokens),
 * then follows changes from any window and the OS.
 */
export function installTheme(): void {
  if (installed) return
  installed = true
  applyResolvedTheme(bridge.theme.initial)
  bridge.theme.onChange((resolved) => {
    applyResolvedTheme(resolved)
    useTheme.setState({ resolved })
    // Another window (or the OS, on 'system') may have changed it: re-read the preference.
    void refreshThemePreference()
  })
  void refreshThemePreference()
}

/** Re-reads the stored preference (another window may have changed it). */
export async function refreshThemePreference(): Promise<void> {
  try {
    useTheme.setState({ preference: await bridge.theme.preference() })
  } catch {
    // Keep the last known value.
  }
}
