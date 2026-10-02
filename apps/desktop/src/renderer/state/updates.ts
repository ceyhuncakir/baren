/**
 * Auto-update status for the UI (ARCHITECTURE.md "Auto-update"). The main process checks
 * 10 s after start and every 4 h and downloads in the background; this store mirrors its
 * status and decides what the update card (artboard 25) shows:
 *
 *  - `ready` always shows "Version x is ready" until the user picks Later (then it stays
 *    hidden until the next launch, or until an even newer version is ready);
 *  - checking / downloading / up to date / error are only announced after the user asked
 *    (Help → Check for Updates…), so a failed background check while offline stays quiet.
 */
import { create } from 'zustand'
import { bridge } from '../lib/bridge'
import type { UpdateStatus } from '../types/bridge'

export type UpdateNotice =
  | { kind: 'ready'; version: string }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string | null; progress: number }
  | { kind: 'upToDate'; version: string | null }
  | { kind: 'error'; version: string | null; message: string }
  | { kind: 'disabled' }

export interface UpdatesState {
  status: UpdateStatus
  /** This build's version (Help menu, "You're up to date"). */
  appVersion: string | null
  /** The user started a check: report its progress and outcome. */
  userCheck: boolean
  /** "Later" was picked for this version (until the next launch). */
  laterVersion: string | null
  check(): Promise<void>
  install(): void
  /** Later (ready) or close (feedback). */
  dismiss(): void
}

const AUTO_HIDE_MS = 5000
let autoHide: ReturnType<typeof setTimeout> | null = null

function clearAutoHide(): void {
  if (autoHide) clearTimeout(autoHide)
  autoHide = null
}

export const useUpdates = create<UpdatesState>()((set, get) => ({
  status: { state: 'idle' },
  appVersion: null,
  userCheck: false,
  laterVersion: null,

  async check() {
    clearAutoHide()
    set({ userCheck: true })
    const { state } = get().status
    // Nothing to check while a download is ready: the card offers the restart again.
    if (state === 'ready') {
      set({ laterVersion: null })
      return
    }
    try {
      receive(await bridge.updates.check())
    } catch (error) {
      receive({
        state: 'error',
        error: error instanceof Error && error.message ? error.message : 'Could not check',
      })
    }
  },

  install() {
    if (get().status.state === 'ready') bridge.updates.install()
  },

  dismiss() {
    clearAutoHide()
    const { status } = get()
    if (status.state === 'ready') set({ laterVersion: status.version ?? '', userCheck: false })
    else set({ userCheck: false })
  },
}))

/** Applies a status from the main process (or a check result). */
function receive(status: UpdateStatus): void {
  const prev = useUpdates.getState().status
  const same =
    prev.state === status.state &&
    prev.version === status.version &&
    prev.progress === status.progress &&
    prev.error === status.error
  if (!same) useUpdates.setState({ status: { ...status } })
  // "Up to date" and "not available here" are short answers: let them go by themselves
  // (also when the answer did not change, e.g. a second check in a build without updates).
  if (status.state === 'none' || status.state === 'disabled') {
    clearAutoHide()
    autoHide = setTimeout(() => {
      autoHide = null
      const s = useUpdates.getState().status.state
      if (s === 'none' || s === 'disabled') useUpdates.setState({ userCheck: false })
    }, AUTO_HIDE_MS)
  }
}

/** What the update card shows now, or null. Pure (unit-tested). */
export function updateNotice(
  state: Pick<UpdatesState, 'status' | 'appVersion' | 'userCheck' | 'laterVersion'>,
): UpdateNotice | null {
  const { status } = state
  const version = status.version ?? null
  if (status.state === 'ready') {
    const v = version ?? ''
    return state.laterVersion === v && !state.userCheck ? null : { kind: 'ready', version: v }
  }
  if (!state.userCheck) return null
  switch (status.state) {
    case 'idle':
    case 'checking':
      return { kind: 'checking' }
    case 'available':
      return { kind: 'downloading', version, progress: 0 }
    case 'downloading':
      return { kind: 'downloading', version, progress: clampPercent(status.progress) }
    case 'none':
      return { kind: 'upToDate', version: state.appVersion }
    case 'error':
      return { kind: 'error', version, message: status.error || 'Something went wrong.' }
    case 'disabled':
      return { kind: 'disabled' }
  }
}

function clampPercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** The Help menu's update item: label, whether it installs, and whether it is enabled. */
export function updateMenuItem(status: UpdateStatus): {
  label: string
  installs: boolean
  enabled: boolean
} {
  switch (status.state) {
    case 'ready':
      return {
        label: status.version ? `Restart to Update (${status.version})…` : 'Restart to Update…',
        installs: true,
        enabled: true,
      }
    case 'checking':
      return { label: 'Checking for Updates…', installs: false, enabled: false }
    case 'available':
    case 'downloading':
      return {
        label: `Downloading Update… ${clampPercent(status.progress)}%`,
        installs: false,
        enabled: false,
      }
    default:
      return { label: 'Check for Updates…', installs: false, enabled: true }
  }
}

let installed = false

/** Subscribes once per window to the main process's update status and reads the version. */
export function installUpdates(): void {
  if (installed) return
  installed = true
  bridge.updates.onStatus(receive)
  void bridge.updates
    .status()
    .then(receive)
    .catch(() => undefined)
  void bridge.app
    .version()
    .then((appVersion) => useUpdates.setState({ appVersion }))
    .catch(() => undefined)
}
