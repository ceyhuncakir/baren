import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Desktop file id of unpackaged (dev) runs on Linux. GNOME/KDE take the dock and taskbar icon
 * from the .desktop file whose id matches the window's app id (Wayland ignores the window
 * icon), and Electron derives that app id from this name. Dev runs use their own id so the
 * entry never shadows an installed `baren.desktop` (deb/rpm).
 */
export const DEV_DESKTOP_ID = 'baren-dev.desktop'

export interface DevDesktopEntryInput {
  /** The Electron binary. */
  execPath: string
  /** The app directory passed to it (`app.getAppPath()`). */
  appPath: string
  /** Absolute path of the 1024px app icon. */
  iconPath: string
}

/** Quote one Exec argument (Desktop Entry spec: double quotes, escape `"` `` ` `` `$` `\`). */
function quoteExecArg(arg: string): string {
  return /^[\w./-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, '\\$1')}"`
}

/** Hidden entry: it only gives dev windows their icon, it is not a launcher in the app grid. */
export function renderDevDesktopEntry(input: DevDesktopEntryInput): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Baren (dev)',
    'Comment=Baren development build',
    `Exec=${quoteExecArg(input.execPath)} ${quoteExecArg(input.appPath)}`,
    `Icon=${input.iconPath}`,
    `StartupWMClass=${DEV_DESKTOP_ID.replace(/\.desktop$/, '')}`,
    'Terminal=false',
    'NoDisplay=true',
    '',
  ].join('\n')
}

/**
 * Write `~/.local/share/applications/baren-dev.desktop` when it is missing or stale. Returns
 * the path when the file changed, `null` when it was already current.
 */
export function ensureDevDesktopEntry(
  input: DevDesktopEntryInput,
  dataHome = process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'),
): string | null {
  const dir = join(dataHome, 'applications')
  const file = join(dir, DEV_DESKTOP_ID)
  const content = renderDevDesktopEntry(input)
  try {
    if (readFileSync(file, 'utf8') === content) return null
  } catch {
    // Missing: written below.
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, content)
  return file
}
