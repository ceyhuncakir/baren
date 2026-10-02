/**
 * Code-split screens. Home (Recents/Files/Archive) ships in the entry chunk; everything else
 * loads on demand and is warmed while the app is idle, so first navigations do not wait.
 */
import { preloadable, whenIdle } from '../lib/preloadable'

export const AuthScreens = preloadable(() => import('../auth/AuthRoute').then((m) => m.default))

export const TeamScreens = preloadable(() => import('../team/TeamScreen').then((m) => m.default))

export const InviteDialogScreen = preloadable(() =>
  import('../team/InviteDialog').then((m) => m.default),
)

/** Preferences and Change password (Account menu, Ctrl+,). */
export const PreferencesDialogScreen = preloadable(() =>
  import('./PreferencesDialogs').then((m) => m.default),
)

/** The editor workstream's screen: canvas + Loro, the heaviest chunk. */
export const EditorScreens = preloadable(() => import('../editor').then((m) => m.EditorScreen))

let warmed = false

/** Called once the first screen is up: fetch the other chunks in the background. */
export function warmScreens(): void {
  if (warmed) return
  warmed = true
  whenIdle(() => {
    void AuthScreens.preload().catch(() => undefined)
    void TeamScreens.preload().catch(() => undefined)
    void InviteDialogScreen.preload().catch(() => undefined)
    void PreferencesDialogScreen.preload().catch(() => undefined)
    void EditorScreens.preload().catch(() => undefined)
  })
}
