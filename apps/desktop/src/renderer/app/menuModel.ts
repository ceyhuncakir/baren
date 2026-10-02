/**
 * The HTML menu bar (artboards 09–13) and every app keyboard shortcut, as data.
 * Shortcuts are canonical ("Mod+Shift+N"); lib/shortcuts formats them per platform.
 */
import type { CommandId } from '../lib/commands'

export type AppAction =
  | 'app.newWindow'
  | 'app.quit'
  | 'app.reload'
  | 'app.forceReload'
  | 'app.toggleDevTools'
  | 'app.toggleFullScreen'
  | 'app.checkForUpdates'
  | 'window.minimize'
  | 'window.zoom'
  | 'window.close'
  | 'ui.focusSearch'
  | 'ui.preferences'
  | 'ui.keyboardShortcuts'
  | CommandId

export type MenuEntry =
  { kind: 'item'; label: string; action: AppAction; shortcut?: string } | { kind: 'separator' }

export interface MenuDef {
  label: 'File' | 'Edit' | 'View' | 'Window' | 'Help'
  /** Panel widths: File/Edit 248, View 300, Window 200, Help 220. */
  width: number
  entries: readonly MenuEntry[]
}

const item = (label: string, action: AppAction, shortcut?: string): MenuEntry =>
  shortcut === undefined
    ? { kind: 'item', label, action }
    : { kind: 'item', label, action, shortcut }
const separator: MenuEntry = { kind: 'separator' }

export const APP_MENUS: readonly MenuDef[] = [
  {
    label: 'File',
    width: 248,
    entries: [
      item('New Window', 'app.newWindow', 'Mod+Shift+N'),
      separator,
      item('Quit', 'app.quit', 'Mod+Q'),
    ],
  },
  {
    label: 'Edit',
    width: 248,
    entries: [
      item('Undo', 'edit.undo', 'Mod+Z'),
      item('Redo', 'edit.redo', 'Mod+Shift+Z'),
      separator,
      item('Cut', 'edit.cut', 'Mod+X'),
      item('Copy', 'edit.copy', 'Mod+C'),
      item('Paste', 'edit.paste', 'Mod+V'),
      item('Delete', 'edit.delete', 'Delete'),
      separator,
      item('Select All', 'edit.selectAll', 'Mod+A'),
    ],
  },
  {
    label: 'View',
    width: 300,
    entries: [
      item('Reload', 'app.reload', 'Mod+R'),
      item('Force Reload', 'app.forceReload', 'Mod+Shift+R'),
      item('Toggle Developer Tools', 'app.toggleDevTools', 'Mod+Shift+I'),
      separator,
      item('Toggle Full Screen', 'app.toggleFullScreen', 'F11'),
    ],
  },
  {
    label: 'Window',
    width: 200,
    entries: [
      item('Minimize', 'window.minimize', 'Mod+M'),
      item('Zoom', 'window.zoom'),
      item('Close', 'window.close', 'Mod+W'),
    ],
  },
  {
    label: 'Help',
    width: 220,
    entries: [
      item('Check for Updates…', 'app.checkForUpdates'),
      separator,
      item('Documentation', 'help.documentation'),
      item('Video Tutorials', 'help.videoTutorials'),
      item('Release Notes', 'help.releaseNotes'),
      separator,
      item('Discord', 'help.discord'),
      item('Slack Community', 'help.slack'),
      item('Reddit', 'help.reddit'),
      item('X / Twitter', 'help.twitter'),
    ],
  },
]

/**
 * Who handles a shortcut:
 *  - 'main': app/window commands. Inside Electron the main process owns these keys
 *    (before-input-event on Linux/Windows, native menu accelerators on macOS) and the page
 *    never sees them; the renderer binds them only in the browser mock.
 *  - 'edit': routed to the command registry, unless a text field has focus (native editing).
 *  - 'app': renderer-only actions (search, account menu items).
 */
export type ShortcutScope = 'main' | 'edit' | 'app'

export interface ShortcutBinding {
  shortcut: string
  action: AppAction
  scope: ShortcutScope
  /** Shown in the keyboard shortcuts dialog. */
  label: string
}

const EDIT_ACTIONS = new Set<AppAction>([
  'edit.undo',
  'edit.redo',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  'edit.delete',
  'edit.selectAll',
])

export function scopeOf(action: AppAction): ShortcutScope {
  if (EDIT_ACTIONS.has(action)) return 'edit'
  if (action.startsWith('ui.')) return 'app'
  return 'main'
}

function menuBindings(): ShortcutBinding[] {
  const out: ShortcutBinding[] = []
  for (const menu of APP_MENUS)
    for (const entry of menu.entries)
      if (entry.kind === 'item' && entry.shortcut)
        out.push({
          shortcut: entry.shortcut,
          action: entry.action,
          scope: scopeOf(entry.action),
          label: entry.label,
        })
  return out
}

export const SHORTCUTS: readonly ShortcutBinding[] = [
  ...menuBindings(),
  // Redo's other common chord, and Backspace for delete (canvas convention).
  { shortcut: 'Mod+Y', action: 'edit.redo', scope: 'edit', label: 'Redo' },
  { shortcut: 'Backspace', action: 'edit.delete', scope: 'edit', label: 'Delete' },
  { shortcut: 'Mod+F', action: 'ui.focusSearch', scope: 'app', label: 'Search files' },
  { shortcut: 'Mod+,', action: 'ui.preferences', scope: 'app', label: 'Preferences' },
  { shortcut: 'Mod+/', action: 'ui.keyboardShortcuts', scope: 'app', label: 'Keyboard shortcuts' },
]
