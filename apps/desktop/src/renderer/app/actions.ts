/**
 * Executes menu and shortcut actions. Edit/view/help actions go through the command
 * registry (so the editor, or whoever registered last, handles them); app and window
 * actions call the bridge.
 */
import { bridge } from '../lib/bridge'
import { isCommandEnabled, isCommandId, registerCommand, runCommand } from '../lib/commands'
import { HELP_LINKS, type HelpCommandId } from '../lib/links'
import { focusSearch, useUi } from '../state/ui'
import { useUpdates } from '../state/updates'
import type { AppAction } from './menuModel'

/**
 * Help → "Check for Updates…": restarts into a downloaded update, otherwise checks now and
 * reports checking / downloading / up to date / error in the update card (UpdateToast).
 */
function checkForUpdates(): void {
  const updates = useUpdates.getState()
  if (updates.status.state === 'ready') updates.install()
  else void updates.check()
}

/** Runs an action; returns false when nothing handled it (so the key event can pass on). */
export function runAppAction(action: AppAction): boolean {
  switch (action) {
    case 'app.newWindow':
      bridge.app.newWindow()
      return true
    case 'app.quit':
      bridge.app.quit()
      return true
    case 'app.reload':
      bridge.app.reload()
      return true
    case 'app.forceReload':
      bridge.app.forceReload()
      return true
    case 'app.toggleDevTools':
      bridge.app.toggleDevTools()
      return true
    case 'app.toggleFullScreen':
      bridge.app.toggleFullScreen()
      return true
    case 'app.checkForUpdates':
      checkForUpdates()
      return true
    case 'window.minimize':
      bridge.window.minimize()
      return true
    case 'window.zoom':
      bridge.window.toggleMaximize()
      return true
    case 'window.close':
      bridge.window.close()
      return true
    case 'ui.focusSearch':
      return focusSearch()
    case 'ui.preferences':
      useUi.getState().openDialog({ kind: 'preferences' })
      return true
    case 'ui.keyboardShortcuts':
      useUi.getState().openDialog({ kind: 'shortcuts' })
      return true
    default:
      return runCommand(action)
  }
}

/** Edit/view commands are enabled while someone (the editor) handles them; the rest always. */
export function isActionEnabled(action: AppAction): boolean {
  if (isCommandId(action) && !action.startsWith('help.')) return isCommandEnabled(action)
  return true
}

/** Registers the Help link commands (shared by the HTML Help menu and the macOS menu). */
export function registerHelpCommands(): () => void {
  const offs = (Object.keys(HELP_LINKS) as HelpCommandId[]).map((id) =>
    registerCommand(id, () => void bridge.shell.openExternal(HELP_LINKS[id])),
  )
  return () => offs.forEach((off) => off())
}
