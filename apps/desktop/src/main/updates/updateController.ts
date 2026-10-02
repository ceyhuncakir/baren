/**
 * Auto-update driver over electron-updater (generic provider): owns the `UpdateStatus`, checks
 * 10 s after start and every 4 h, downloads in the background and installs on request.
 *
 * electron-updater is loaded lazily (first check), so it costs nothing at cold start;
 * `status()` never loads it. Every status change is pushed through `onStatus`.
 */
import type { Logger } from '../log'
import {
  DISABLED,
  IDLE,
  errorMessage,
  isBusy,
  isSettled,
  nextStatus,
  sameStatus,
  type UpdateStatus,
  type UpdaterEvent,
} from './updateStatus'

export type UpdaterEventName =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error'

export interface UpdaterLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
  debug?(message: string): void
}

/** The slice of electron-updater's `AppUpdater` used here (fake-able in tests). */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: UpdaterLogger | null
  /** Dev builds: allow checks although the app is not packaged. */
  forceDevUpdateConfig?: boolean
  /** Where app-update.yml is read from (setter on electron-updater's AppUpdater). */
  updateConfigPath?: string | null
  setFeedURL(options: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  // electron-updater's listeners take event-specific arguments (UpdateInfo, ProgressInfo, Error).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: UpdaterEventName, listener: (...args: any[]) => void): unknown
}

export interface UpdateControllerOptions {
  /** null: updates run. Otherwise why they do not (status stays `disabled`). */
  disabledReason: string | null
  feedUrl: string
  /** Install a downloaded update on a normal quit (AppImage, macOS, Windows). */
  installOnQuit: boolean
  loadUpdater(): Promise<UpdaterLike>
  /** Extra setup after loading, before the first check (dev config path, …). */
  configure?(updater: UpdaterLike): Promise<void> | void
  initialDelayMs?: number
  intervalMs?: number
  onStatus(status: UpdateStatus): void
  /** Release what the next instance needs (core database, single-instance lock) before installing. */
  prepareInstall(): Promise<void>
  /** The install did not happen after `prepareInstall`: take those resources back. */
  installFailed(): void
  /** Whether the app has started quitting (set by `before-quit`). */
  isQuitting(): boolean
  /** How long to wait for the quit that follows a successful install. */
  installWatchdogMs?: number
  log: Logger
}

export interface StatusRecord extends UpdateStatus {
  /** Milliseconds since the controller was created. */
  atMs: number
}

export const INITIAL_CHECK_DELAY_MS = 10_000
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const MAX_HISTORY = 200

function versionOf(info: unknown): string {
  const version = (info as { version?: unknown } | null)?.version
  return typeof version === 'string' ? version : ''
}

function percentOf(progress: unknown): number {
  const percent = (progress as { percent?: unknown } | null)?.percent
  return typeof percent === 'number' ? percent : 0
}

export class UpdateController {
  private current: UpdateStatus
  private readonly records: StatusRecord[] = []
  private readonly createdAt = Date.now()
  private updaterPromise: Promise<UpdaterLike> | null = null
  private checking: Promise<UpdateStatus> | null = null
  private installing = false
  private errorCount = 0
  private timers: ReturnType<typeof setTimeout>[] = []
  private readonly settledWaiters = new Set<(status: UpdateStatus) => void>()

  constructor(private readonly options: UpdateControllerOptions) {
    this.current = options.disabledReason === null ? IDLE : DISABLED
    this.record(this.current)
  }

  status(): UpdateStatus {
    return this.current
  }

  /** Every status since start, oldest first (smoke runs report it). */
  history(): readonly StatusRecord[] {
    return this.records
  }

  /** Schedule the first check and the periodic ones. */
  start(): void {
    if (this.current.state === 'disabled') {
      this.options.log.info(`auto-update disabled: ${this.options.disabledReason ?? 'unknown'}`)
      return
    }
    const first = setTimeout(
      () => void this.check(),
      this.options.initialDelayMs ?? INITIAL_CHECK_DELAY_MS,
    )
    const periodic = setInterval(
      () => void this.check(),
      this.options.intervalMs ?? CHECK_INTERVAL_MS,
    )
    first.unref?.()
    periodic.unref?.()
    this.timers.push(first, periodic)
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /** Check now; resolves with the status once the check itself is over. */
  check(): Promise<UpdateStatus> {
    // A check in flight: share its result.
    if (this.checking !== null) return this.checking
    if (this.current.state === 'disabled' || isBusy(this.current)) {
      return Promise.resolve(this.current)
    }
    this.checking = this.runCheck().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /** Resolves with the next settled status (ready, none, error, disabled), or the current one at the timeout. */
  whenSettled(timeoutMs: number): Promise<UpdateStatus> {
    if (isSettled(this.current) && this.checking === null && this.current.state !== 'idle') {
      return Promise.resolve(this.current)
    }
    return new Promise((resolve) => {
      const done = (status: UpdateStatus): void => {
        clearTimeout(timer)
        this.settledWaiters.delete(done)
        resolve(status)
      }
      const timer = setTimeout(() => done(this.current), timeoutMs)
      this.settledWaiters.add(done)
    })
  }

  /** Quit and install the downloaded update. Ignored unless the state is `ready`. */
  async install(): Promise<void> {
    if (this.current.state !== 'ready' || this.installing) return
    this.installing = true
    const { log } = this.options
    let updater: UpdaterLike
    try {
      updater = await this.updater()
    } catch (error) {
      this.installing = false
      this.apply({ type: 'error', message: errorMessage(error) })
      return
    }
    try {
      await this.options.prepareInstall()
    } catch (error) {
      log.warn('preparing the update install failed', String(error))
    }
    const errorsBefore = this.errorCount
    log.info(`installing update ${this.current.version ?? ''}`)
    try {
      // Not silent: deb/rpm show the pkexec prompt. Relaunch the new version afterwards.
      updater.quitAndInstall(false, true)
    } catch (error) {
      this.apply({ type: 'error', message: errorMessage(error) })
    }
    if (this.errorCount !== errorsBefore) {
      this.recoverFromInstall()
      return
    }
    // Success quits on the next tick; electron-updater can also decline silently.
    const watchdog = setTimeout(() => {
      if (this.options.isQuitting()) return
      this.apply({ type: 'error', message: 'The update could not be installed' })
      this.recoverFromInstall()
    }, this.options.installWatchdogMs ?? 5000)
    watchdog.unref?.()
  }

  private recoverFromInstall(): void {
    this.installing = false
    try {
      this.options.installFailed()
    } catch (error) {
      this.options.log.warn('recovering from a failed update install failed', String(error))
    }
  }

  private async runCheck(): Promise<UpdateStatus> {
    let updater: UpdaterLike
    try {
      updater = await this.updater()
    } catch (error) {
      this.apply({ type: 'error', message: `Updater unavailable: ${errorMessage(error)}` })
      return this.current
    }
    // Report `checking` right away; electron-updater's own event follows (deduplicated).
    this.apply({ type: 'checking' })
    try {
      const result = await updater.checkForUpdates()
      if (result === null) {
        this.set(DISABLED)
        this.options.log.warn('auto-update: the updater is inactive for this install')
      } else {
        // Download failures arrive as 'error' events; never leave the promise unhandled.
        result.downloadPromise?.catch(() => {})
      }
    } catch (error) {
      this.apply({ type: 'error', message: errorMessage(error) })
    }
    return this.current
  }

  private updater(): Promise<UpdaterLike> {
    this.updaterPromise ??= this.createUpdater().catch((error: unknown) => {
      this.updaterPromise = null
      throw error
    })
    return this.updaterPromise
  }

  private async createUpdater(): Promise<UpdaterLike> {
    const { log } = this.options
    const updater = await this.options.loadUpdater()
    const updaterLog = log.child('electron-updater')
    updater.logger = {
      info: (m) => updaterLog.info(String(m)),
      warn: (m) => updaterLog.warn(String(m)),
      error: (m) => updaterLog.error(String(m)),
      debug: (m) => updaterLog.debug(String(m)),
    }
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = this.options.installOnQuit
    updater.setFeedURL({ provider: 'generic', url: this.options.feedUrl })
    await this.options.configure?.(updater)

    const on = (name: UpdaterEventName, fn: (arg: unknown) => void): void => {
      updater.on(name, fn)
    }
    on('checking-for-update', () => this.apply({ type: 'checking' }))
    on('update-available', (info) => this.apply({ type: 'available', version: versionOf(info) }))
    on('update-not-available', () => this.apply({ type: 'not-available' }))
    on('download-progress', (progress) =>
      this.apply({ type: 'progress', percent: percentOf(progress) }),
    )
    on('update-downloaded', (info) => this.apply({ type: 'downloaded', version: versionOf(info) }))
    on('error', (error) => this.apply({ type: 'error', message: errorMessage(error) }))
    log.info(`auto-update feed: ${this.options.feedUrl}`)
    return updater
  }

  private apply(event: UpdaterEvent): void {
    if (event.type === 'error') this.errorCount++
    this.set(nextStatus(this.current, event))
  }

  private set(status: UpdateStatus): void {
    if (sameStatus(status, this.current)) return
    this.current = status
    this.record(status)
    if (status.state === 'error') this.options.log.warn(`auto-update error: ${status.error ?? ''}`)
    try {
      this.options.onStatus(status)
    } catch (error) {
      this.options.log.warn('update status listener failed', String(error))
    }
    if (isSettled(status)) for (const waiter of [...this.settledWaiters]) waiter(status)
  }

  private record(status: UpdateStatus): void {
    this.records.push({ ...status, atMs: Date.now() - this.createdAt })
    if (this.records.length > MAX_HISTORY) this.records.splice(1, this.records.length - MAX_HISTORY)
  }
}
