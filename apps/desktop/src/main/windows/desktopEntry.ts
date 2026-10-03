import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DEEP_LINK_SCHEME } from '../deeplink/deepLink'

/**
 * Desktop file id of unpackaged (dev) runs on Linux. GNOME/KDE take the dock and taskbar icon
 * from the .desktop file whose id matches the window's app id (Wayland ignores the window
 * icon), and Electron derives that app id from this name. Dev runs use their own id so the
 * entry never shadows an installed `baren.desktop` (deb/rpm).
 */
export const DEV_DESKTOP_ID = 'baren-dev.desktop'

/** What xdg-open and GIO (so browsers) look up to open `baren://` links. */
export const SCHEME_MIME_TYPE = `x-scheme-handler/${DEEP_LINK_SCHEME}`

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

/**
 * Hidden entry: not a launcher in the app grid. It gives dev windows their icon and can take
 * `baren://` links (the URL reaches the running dev instance through `second-instance`).
 */
export function renderDevDesktopEntry(input: DevDesktopEntryInput): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Baren (dev)',
    'Comment=Baren development build',
    `Exec=${quoteExecArg(input.execPath)} ${quoteExecArg(input.appPath)} %U`,
    `Icon=${input.iconPath}`,
    `StartupWMClass=${DEV_DESKTOP_ID.replace(/\.desktop$/, '')}`,
    'Terminal=false',
    'NoDisplay=true',
    `MimeType=${SCHEME_MIME_TYPE};`,
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

export type RunCommand = (file: string, args: readonly string[]) => Promise<{ stdout: string }>

const execFileAsync: RunCommand = promisify(execFile)

/**
 * Make the dev entry the `baren://` handler, so invite links opened in the browser reach the
 * dev build. An installed build (deb/rpm `baren.desktop`) that already handles them keeps
 * them unless `force` (BAREN_REGISTER_PROTOCOL=1). Returns whether the default changed.
 */
export async function claimDevSchemeHandler(
  force: boolean,
  run: RunCommand = execFileAsync,
): Promise<boolean> {
  const { stdout } = await run('xdg-mime', ['query', 'default', SCHEME_MIME_TYPE])
  const current = stdout.trim()
  if (current !== '' && current !== DEV_DESKTOP_ID && !force) return false
  // Written even when the query already names the dev entry: xdg-mime falls back to any entry
  // listing the type, but GIO (so the browser) only follows an explicit default.
  await run('xdg-mime', ['default', DEV_DESKTOP_ID, SCHEME_MIME_TYPE])
  return current !== DEV_DESKTOP_ID
}
