/**
 * Creates and tracks app windows: geometry restore/persist, flash-free
 * showing, maximize notifications, app shortcuts (Linux/Windows) and
 * per-window security guards.
 */
import { BrowserWindow, screen } from 'electron'
import type { EventChannels } from '../../preload/channels'
import type { Logger } from '../log'
import { guardWebContents } from '../security/guards'
import { matchAppShortcut, type AppShortcut } from './shortcuts'
import { windowOptions } from './windowOptions'
import { cascadeBounds, restoreWindowState, type WindowState } from './windowState'
import type { WindowStateStore } from './windowStateStore'

export interface WindowManagerOptions {
  platform: string
  preloadPath: string
  rendererUrl: string
  appOrigins: readonly string[]
  stateStore: WindowStateStore
  /** Geometry persisted by the previous session (loaded before `app.ready`). */
  savedState: WindowState | null
  /** false in BAREN_SMOKE: windows render but are never shown. */
  showWindows: boolean
  icon?: string
  /** Theme-dependent window setup, read at each window's creation. */
  appearance?(): { backgroundColor: string; additionalArguments: string[] }
  log: Logger
  openExternal(url: string): void
  /** App shortcut pressed in `win` (Linux/Windows; macOS uses its native menu). */
  onShortcut(shortcut: AppShortcut, win: BrowserWindow): void
  /**
   * The last app window closed. Hidden MCP host windows keep `window-all-closed` from firing, so
   * main quits from here on Linux/Windows (contract docs/phase4/contract.md §4.5).
   */
  onLastWindowClosed?(): void
}

export interface CreateWindowOptions {
  cascadeFrom?: BrowserWindow | null
  /** Hash route to open (e.g. `/file/<id>`); default: the renderer restores the last route. */
  route?: string
  /** Show without taking focus (an agent opened a file while the user is elsewhere). */
  inactive?: boolean
}

function captureState(win: BrowserWindow): WindowState {
  return { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
}

export class WindowManager {
  private readonly windows = new Set<BrowserWindow>()
  /** Last focus per window (creation counts), for the MCP default file. */
  private readonly focusedAt = new Map<BrowserWindow, number>()
  private focusSeq = 0
  private lastState: WindowState | null

  constructor(private readonly options: WindowManagerOptions) {
    this.lastState = options.savedState
  }

  get all(): BrowserWindow[] {
    return [...this.windows].filter((w) => !w.isDestroyed())
  }

  /** Focused app window, else the most recently created live one. */
  current(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && this.windows.has(focused)) return focused
    return this.all.at(-1) ?? null
  }

  focus(win: BrowserWindow): void {
    if (!this.options.showWindows) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  }

  /** Live app windows, most recently focused first. */
  focusOrder(): { win: BrowserWindow; focusedAt: number }[] {
    return this.all
      .map((win) => ({ win, focusedAt: this.focusedAt.get(win) ?? 0 }))
      .sort((a, b) => b.focusedAt - a.focusedAt)
  }

  /** Whether `id` is the webContents of one of the app windows. */
  isAppWebContents(id: number): boolean {
    return this.all.some((w) => !w.webContents.isDestroyed() && w.webContents.id === id)
  }

  private noteFocus(win: BrowserWindow): void {
    // Monotonic: two focus events in the same millisecond keep their order.
    this.focusSeq = Math.max(this.focusSeq + 1, Date.now())
    this.focusedAt.set(win, this.focusSeq)
  }

  create(options: CreateWindowOptions = {}): BrowserWindow {
    const { log } = this.options
    const from = options.cascadeFrom ?? (this.windows.size > 0 ? this.current() : null)
    const state = from && !from.isDestroyed() ? this.cascadeState(from) : this.restoredState()

    const win = new BrowserWindow(
      windowOptions({
        platform: this.options.platform,
        bounds: state.bounds,
        preloadPath: this.options.preloadPath,
        ...(this.options.icon ? { icon: this.options.icon } : {}),
        ...this.options.appearance?.(),
      }),
    )
    this.windows.add(win)
    this.noteFocus(win)
    win.on('focus', () => this.noteFocus(win))

    guardWebContents(win.webContents, this.options.appOrigins, this.options.openExternal, log)

    if (this.options.platform !== 'darwin') {
      win.webContents.on('before-input-event', (event, input) => {
        const shortcut = matchAppShortcut(input)
        if (shortcut === null) return
        event.preventDefault()
        this.options.onShortcut(shortcut, win)
      })
    }

    win.once('ready-to-show', () => {
      if (!this.options.showWindows) return
      if (options.inactive) {
        win.showInactive()
        return
      }
      if (state.maximized) win.maximize()
      win.show()
    })

    const notifyMaximized = (maximized: boolean): void => {
      if (!win.webContents.isDestroyed())
        win.webContents.send('window:maximized-changed', maximized)
    }
    win.on('maximize', () => notifyMaximized(true))
    win.on('unmaximize', () => notifyMaximized(false))

    const persist = (): void => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
      this.lastState = captureState(win)
      this.options.stateStore.save(this.lastState)
    }
    win.on('resize', persist)
    win.on('move', persist)
    win.on('maximize', persist)
    win.on('unmaximize', persist)
    win.on('close', () => {
      persist()
      void this.options.stateStore.flush()
    })
    win.on('closed', () => {
      this.windows.delete(win)
      this.focusedAt.delete(win)
      if (this.windows.size === 0) this.options.onLastWindowClosed?.()
    })

    const url = options.route
      ? `${this.options.rendererUrl}#${options.route}`
      : this.options.rendererUrl
    win.loadURL(url).catch((error: unknown) => {
      log.error('failed to load renderer', { url: this.options.rendererUrl, error: String(error) })
    })
    return win
  }

  /** Push an event to every live window's renderer. */
  broadcast<K extends keyof EventChannels>(channel: K, ...args: EventChannels[K]): void {
    for (const win of this.all) {
      if (!win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
    }
  }

  /** Repaint every window's native background (theme change). */
  setBackgroundColor(color: string): void {
    for (const win of this.all) win.setBackgroundColor(color)
  }

  private restoredState(): WindowState {
    const displays = screen.getAllDisplays().map((d) => d.workArea)
    return restoreWindowState(this.lastState, displays, screen.getPrimaryDisplay().workArea)
  }

  private cascadeState(from: BrowserWindow): WindowState {
    const bounds = from.getNormalBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    return { bounds: cascadeBounds(bounds, workArea), maximized: false }
  }
}
