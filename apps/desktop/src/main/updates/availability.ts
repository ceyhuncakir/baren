/**
 * Whether auto-update runs in this process, and how.
 *
 * Linux: electron-updater picks its installer from how the app was installed — an AppImage
 * (`$APPIMAGE` is set by the AppImage runtime) replaces its own file, no privileges needed;
 * a deb/rpm/pacman install (electron-builder writes `resources/package-type`) installs the
 * downloaded package through the system package manager, which asks for the admin password
 * via `pkexec` (polkit) when the user clicks "Restart to update". Anything else (an unpacked
 * directory, a tarball) cannot update itself.
 *
 * Windows: the per-user NSIS install replaces itself. macOS only installs an update signed with
 * the same Developer ID as the running app, and our Mac builds are signed ad hoc, so they do not
 * update (download a new zip instead).
 */
export type InstallKind = 'appimage' | 'deb' | 'rpm' | 'pacman' | 'darwin' | 'win32' | 'dev'

export interface AvailabilityInput {
  platform: string
  isPackaged: boolean
  /** `BAREN_FORCE_UPDATES=1`: run in dev builds and smoke runs too. */
  forced: boolean
  smoke: boolean
  feedUrl: string | null
  /** `$APPIMAGE`. */
  appImagePath: string | null
  /** Contents of `<resources>/package-type`, or null when absent. */
  packageType: string | null
}

export type Availability =
  | {
      enabled: true
      kind: InstallKind
      /**
       * Install a downloaded update when the app quits normally. Only for AppImage (and
       * macOS/Windows): a deb/rpm install would pop a pkexec password prompt on every quit.
       */
      installOnQuit: boolean
    }
  | { enabled: false; reason: string }

const PACKAGE_KINDS: Readonly<Record<string, InstallKind>> = {
  deb: 'deb',
  rpm: 'rpm',
  pacman: 'pacman',
}

export function updateAvailability(input: AvailabilityInput): Availability {
  if (input.feedUrl === null) return { enabled: false, reason: 'no valid update feed URL' }
  if (input.smoke && !input.forced) return { enabled: false, reason: 'smoke run' }
  if (!input.isPackaged) {
    return input.forced
      ? { enabled: true, kind: 'dev', installOnQuit: false }
      : { enabled: false, reason: 'development build' }
  }
  const installOnQuit = !input.smoke
  if (input.platform === 'win32') return { enabled: true, kind: 'win32', installOnQuit }
  if (input.platform === 'darwin') {
    return { enabled: false, reason: 'macOS builds without a Developer ID signature' }
  }
  if (input.appImagePath) return { enabled: true, kind: 'appimage', installOnQuit }
  const kind = PACKAGE_KINDS[input.packageType?.trim() ?? '']
  if (kind) return { enabled: true, kind, installOnQuit: false }
  return { enabled: false, reason: 'not installed from an AppImage, deb or rpm package' }
}
