/**
 * Which renderer hosts which file (contract §4.5): visible editor windows that announce
 * `agent:host`, and a pool of hidden headless host windows (`#/agent-host/<fileId>`) for files
 * no window has open.
 *
 * - Default file (no `fileId`): the focused window's file, else the most recently focused
 *   visible window that hosts one.
 * - Host for a request: (1) a visible window with the file (most recently focused first);
 *   (2) a headless host holding it; (3) a visible `files:open` in flight → wait ≤ 10 s for that
 *   window's `opened`; (4) start a headless host and wait ≤ 20 s for its `opened`.
 * - At most 4 headless hosts (the least recently used idle one makes room); one is released after
 *   120 s without requests and without working sets on its file.
 * - Handoff: before a visible window opens a file a headless host holds, the host flushes and
 *   closes (`release`), so only one renderer ever writes a file.
 *
 * Electron-free: windows come in through the injected factory and providers.
 */
import type { AgentHostState } from '../../renderer/types/bridge'
import type { Logger } from '../log'
import { ToolError } from './format'
import type { RpcTarget } from './ipc'

const HOME_ROUTE = /^\/?(?:$|recents\b|files\b|archive\b|team\b)/

/** The window shows a sign-in/registration step (`#/auth/...`), e.g. after a signed-out redirect. */
export function isAuthUrl(url: string): boolean {
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : ''
  return /^\/auth(\/|$|\?)/.test(hash)
}

/** Whether a window's URL shows a home screen (Recents, Files, Archive, Team): open_file may navigate it. */
export function isHomeUrl(url: string): boolean {
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : ''
  return HOME_ROUTE.test(hash)
}

export interface HeadlessWindow extends RpcTarget {
  destroy(): void
}

export interface VisibleWindowInfo {
  target: RpcTarget
  /** Last focus (creation counts), epoch ms. */
  focusedAt: number
  focused: boolean
}

export interface HostRegistryOptions {
  /** The app's visible windows (WindowManager). */
  visibleWindows(): VisibleWindowInfo[]
  /** Create a hidden window loading `#/agent-host/<fileId>`. */
  createHeadless(fileId: string): HeadlessWindow
  /** Ask a host to flush and close its session (the `release` request); resolves either way. */
  release(target: RpcTarget, fileId: string, timeoutMs: number): Promise<void>
  /** Agents still show working indicators in this file (keeps its headless host alive). */
  hasWorkingSet(fileId: string): boolean
  /** Requests in flight to this window. */
  inFlight(webContentsId: number): number
  /** A host announced a file (push the current presence to it). */
  onOpened?(fileId: string, target: RpcTarget): void
  log?: Logger
  now?: () => number
  maxHeadless?: number
  idleMs?: number
  startTimeoutMs?: number
  pendingOpenMs?: number
  releaseTimeoutMs?: number
}

interface HostEntry {
  target: RpcTarget
  headless: boolean
  openedAt: number
}

interface HeadlessEntry {
  fileId: string
  window: HeadlessWindow
  state: 'starting' | 'ready' | 'releasing'
  lastUsedAt: number
  /** Requests routed to this host that have not finished (`lease()` … `done()`). */
  leases: number
  /** A liveness probe is running (`probe()`): new requests wait for its verdict. */
  probing?: Promise<void> | undefined
  ready: Promise<void>
  resolveReady(): void
  rejectReady(error: ToolError): void
  released: Promise<void> | null
}

interface Waiter {
  resolve(): void
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(e: ToolError): void } {
  let resolve!: () => void
  let reject!: (e: ToolError) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new ToolError('cancelled', 'The request was cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ToolError('cancelled', 'The request was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

export class HostRegistry {
  private readonly byFile = new Map<string, Map<number, HostEntry>>()
  private readonly headless = new Map<string, HeadlessEntry>()
  private readonly headlessIds = new Map<number, string>()
  private readonly pendingOpens = new Map<string, { webContentsId: number; until: number }>()
  private readonly waiters = new Map<string, Set<Waiter>>()
  /** Woken whenever a headless host's last lease ends. */
  private leaseWaiters = new Set<() => void>()

  constructor(private readonly options: HostRegistryOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private get log(): Logger | undefined {
    return this.options.log
  }

  // ---- registry ---------------------------------------------------------------------------

  /** `agent:host` from a renderer. */
  hostState(target: RpcTarget, state: AgentHostState): void {
    const headlessFile = this.headlessIds.get(target.webContentsId)
    const headless = headlessFile !== undefined
    if (headless && headlessFile !== state.fileId) {
      this.log?.warn('a headless host announced another file; ignored')
      return
    }
    if (state.state === 'opened') {
      let hosts = this.byFile.get(state.fileId)
      if (!hosts) {
        hosts = new Map()
        this.byFile.set(state.fileId, hosts)
      }
      hosts.set(target.webContentsId, { target, headless, openedAt: this.now() })
      if (headless) {
        const entry = this.headless.get(state.fileId)
        if (entry && entry.state === 'starting') {
          entry.state = 'ready'
          entry.lastUsedAt = this.now()
          entry.resolveReady()
        }
      } else {
        const pending = this.pendingOpens.get(state.fileId)
        if (pending && pending.webContentsId === target.webContentsId) {
          this.pendingOpens.delete(state.fileId)
        }
      }
      this.wake(state.fileId)
      this.options.onOpened?.(state.fileId, target)
    } else {
      this.unregister(target.webContentsId, state.fileId)
      if (headless) {
        const entry = this.headless.get(state.fileId)
        if (entry && entry.state === 'starting') {
          entry.rejectReady(
            new ToolError('host_unavailable', 'The file could not be opened in the background'),
          )
        } else if (entry && entry.state === 'ready') {
          // The host closed its session on its own: the window is useless now.
          this.headless.delete(state.fileId)
          this.headlessIds.delete(entry.window.webContentsId)
          if (!entry.window.isDestroyed()) entry.window.destroy()
        }
      }
    }
  }

  private unregister(webContentsId: number, fileId: string): void {
    const hosts = this.byFile.get(fileId)
    if (!hosts) return
    hosts.delete(webContentsId)
    if (hosts.size === 0) this.byFile.delete(fileId)
  }

  /** A webContents was destroyed or navigated away: it hosts nothing any more. */
  webContentsGone(webContentsId: number): void {
    for (const fileId of [...this.byFile.keys()]) this.unregister(webContentsId, fileId)
    const headlessFile = this.headlessIds.get(webContentsId)
    if (headlessFile !== undefined) {
      this.headlessIds.delete(webContentsId)
      const entry = this.headless.get(headlessFile)
      if (entry && entry.window.webContentsId === webContentsId) {
        this.headless.delete(headlessFile)
        entry.rejectReady(new ToolError('host_unavailable', 'The background window closed'))
        if (entry.state !== 'releasing') this.log?.warn('headless host went away')
      }
    }
    for (const [fileId, pending] of [...this.pendingOpens]) {
      if (pending.webContentsId === webContentsId) {
        this.pendingOpens.delete(fileId)
        this.wake(fileId)
      }
    }
  }

  isHeadless(webContentsId: number): boolean {
    return this.headlessIds.has(webContentsId)
  }

  /** A headless host holds `fileId`. */
  isHeadlessFile(fileId: string): boolean {
    return this.headless.has(fileId)
  }

  /** Every renderer hosting `fileId` (presence goes to all of them). */
  targetsFor(fileId: string): RpcTarget[] {
    return [...(this.byFile.get(fileId)?.values() ?? [])]
      .filter((h) => !h.target.isDestroyed())
      .map((h) => h.target)
  }

  private focusInfo(): Map<number, VisibleWindowInfo> {
    return new Map(this.options.visibleWindows().map((w) => [w.target.webContentsId, w]))
  }

  /** The visible host of `fileId`, most recently focused first. */
  visibleHost(fileId: string): RpcTarget | null {
    const hosts = this.byFile.get(fileId)
    if (!hosts) return null
    const focus = this.focusInfo()
    let best: { target: RpcTarget; at: number } | null = null
    for (const h of hosts.values()) {
      if (h.headless || h.target.isDestroyed()) continue
      const info = focus.get(h.target.webContentsId)
      if (!info) continue
      const at = info.focused ? Number.POSITIVE_INFINITY : info.focusedAt
      if (best === null || at > best.at) best = { target: h.target, at }
    }
    return best?.target ?? null
  }

  /** Files open in visible windows, most recently focused window first. */
  visibleFileIds(): string[] {
    const focus = this.focusInfo()
    const rows: { fileId: string; at: number }[] = []
    for (const [fileId, hosts] of this.byFile) {
      let at = -1
      for (const h of hosts.values()) {
        if (h.headless) continue
        const info = focus.get(h.target.webContentsId)
        if (!info) continue
        at = Math.max(at, info.focused ? Number.POSITIVE_INFINITY : info.focusedAt)
      }
      if (at >= 0) rows.push({ fileId, at })
    }
    return rows.sort((a, b) => b.at - a.at).map((r) => r.fileId)
  }

  /** The file a tool without `fileId` works on, or null (`no_file_open`). */
  defaultFileId(): string | null {
    return this.visibleFileIds()[0] ?? null
  }

  /** The file a visible window hosts (most recently opened), if any. */
  fileOf(webContentsId: number): string | null {
    let best: { fileId: string; at: number } | null = null
    for (const [fileId, hosts] of this.byFile) {
      const h = hosts.get(webContentsId)
      if (h && (best === null || h.openedAt > best.at)) best = { fileId, at: h.openedAt }
    }
    return best?.fileId ?? null
  }

  // ---- routing ----------------------------------------------------------------------------

  private wake(fileId: string): void {
    const set = this.waiters.get(fileId)
    if (!set) return
    this.waiters.delete(fileId)
    for (const w of set) w.resolve()
  }

  /** Resolves on the next host change for `fileId`, or after `ms`. */
  private waitForChange(fileId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return abortable(
      new Promise<void>((resolve) => {
        let set = this.waiters.get(fileId)
        if (!set) {
          set = new Set()
          this.waiters.set(fileId, set)
        }
        const waiter: Waiter = {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
        }
        const timer = setTimeout(
          () => {
            this.waiters.get(fileId)?.delete(waiter)
            resolve()
          },
          Math.max(0, ms),
        )
        timer.unref?.()
        set.add(waiter)
      }),
      signal,
    )
  }

  /** The renderer a request for `fileId` goes to (starting a headless host when needed). */
  async acquire(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ target: RpcTarget; headless: boolean }> {
    const { target, headless } = await this.route(fileId, signal, false)
    return { target, headless }
  }

  /**
   * `acquire` for one request: a headless host is not released (to make room, when idle, or for
   * a handoff) until `done()` — otherwise a request routed to it could be cancelled by another
   * file's request taking its slot.
   */
  lease(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ target: RpcTarget; headless: boolean; done(): void }> {
    return this.route(fileId, signal, true)
  }

  private async route(
    fileId: string,
    signal: AbortSignal | undefined,
    leased: boolean,
  ): Promise<{ target: RpcTarget; headless: boolean; done(): void }> {
    const none = (): void => undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      if (signal?.aborted) throw new ToolError('cancelled', 'The request was cancelled')
      const visible = this.visibleHost(fileId)
      if (visible) return { target: visible, headless: false, done: none }

      const entry = this.headless.get(fileId)
      if (entry?.state === 'ready' && entry.probing) {
        await abortable(entry.probing, signal)
        continue
      }
      if (entry?.state === 'ready' && !entry.window.isDestroyed()) {
        entry.lastUsedAt = this.now()
        if (!leased) return { target: entry.window, headless: true, done: none }
        // Taken synchronously with the routing decision: nothing can release it in between.
        entry.leases++
        let ended = false
        return {
          target: entry.window,
          headless: true,
          done: () => {
            if (ended) return
            ended = true
            entry.leases = Math.max(0, entry.leases - 1)
            entry.lastUsedAt = this.now()
            if (entry.leases === 0) this.leaseEnded()
          },
        }
      }
      if (entry?.state === 'starting') {
        await abortable(entry.ready, signal)
        continue
      }
      if (entry?.state === 'releasing') {
        await abortable(entry.released ?? Promise.resolve(), signal)
        continue
      }

      const pending = this.pendingOpens.get(fileId)
      if (pending) {
        const left = pending.until - this.now()
        if (left > 0) {
          await this.waitForChange(fileId, left, signal)
          continue
        }
        this.pendingOpens.delete(fileId)
      }

      await abortable(this.startHeadless(fileId), signal)
    }
    throw new ToolError('host_unavailable', 'Could not find a window for this file; try again')
  }

  /** Wait until a visible window hosts `fileId` (open_file), at most `ms`. */
  async waitVisible(fileId: string, ms: number, signal?: AbortSignal): Promise<RpcTarget> {
    const until = this.now() + ms
    for (;;) {
      const visible = this.visibleHost(fileId)
      if (visible) return visible
      const left = until - this.now()
      if (left <= 0) {
        throw new ToolError(
          'host_unavailable',
          `The file did not open in the app within ${Math.round(ms / 1000)} s`,
        )
      }
      await this.waitForChange(fileId, left, signal)
    }
  }

  /**
   * A request to a headless host missed its deadline: `ping` it, and when that times out too,
   * the host is hung — destroy it (its pending requests fail with `host_unavailable`) so the
   * next request opens the file in a new one. A visible window is never touched.
   */
  async probe(target: RpcTarget, ping: () => Promise<unknown>): Promise<void> {
    const fileId = this.headlessIds.get(target.webContentsId)
    if (fileId === undefined) return
    const entry = this.headless.get(fileId)
    if (!entry || entry.window.webContentsId !== target.webContentsId || entry.probing) return
    entry.probing = (async () => {
      try {
        await ping()
      } catch (error) {
        if (!(error instanceof ToolError) || error.code !== 'timeout') return
        if (this.headless.get(fileId) !== entry) return
        this.log?.warn('headless host stopped responding; discarding it')
        this.headless.delete(fileId)
        this.headlessIds.delete(entry.window.webContentsId)
        this.unregister(entry.window.webContentsId, fileId)
        if (!entry.window.isDestroyed()) entry.window.destroy()
        this.wake(fileId)
      }
    })()
    try {
      await entry.probing
    } finally {
      entry.probing = undefined
    }
  }

  /** Mark a request on `fileId` (idle tracking of its headless host). */
  noteUse(fileId: string): void {
    const entry = this.headless.get(fileId)
    if (entry) entry.lastUsedAt = this.now()
  }

  private async startHeadless(fileId: string): Promise<void> {
    const existing = this.headless.get(fileId)
    if (existing)
      return existing.state === 'releasing' ? (existing.released ?? undefined) : existing.ready
    await this.makeRoom()
    if (this.headless.has(fileId)) return this.headless.get(fileId)!.ready
    const d = deferred()
    let window: HeadlessWindow
    try {
      window = this.options.createHeadless(fileId)
    } catch (error) {
      throw new ToolError(
        'host_unavailable',
        `Could not open the file in the background: ${String(error)}`,
      )
    }
    const entry: HeadlessEntry = {
      fileId,
      window,
      state: 'starting',
      lastUsedAt: this.now(),
      leases: 0,
      ready: d.promise,
      resolveReady: d.resolve,
      rejectReady: d.reject,
      released: null,
    }
    this.headless.set(fileId, entry)
    this.headlessIds.set(window.webContentsId, fileId)
    this.log?.info('headless host started')
    const timeout = this.options.startTimeoutMs ?? 20_000
    const timer = setTimeout(() => {
      if (entry.state !== 'starting') return
      entry.rejectReady(
        new ToolError(
          'host_unavailable',
          `The file did not open in the background within ${Math.round(timeout / 1000)} s`,
        ),
      )
    }, timeout)
    timer.unref?.()
    try {
      await entry.ready
    } catch (error) {
      if (this.headless.get(fileId) === entry) this.headless.delete(fileId)
      this.headlessIds.delete(window.webContentsId)
      if (!window.isDestroyed()) window.destroy()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** At the headless limit: release the least recently used one (idle ones first). */
  private async makeRoom(): Promise<void> {
    const max = this.options.maxHeadless ?? 4
    while (this.headless.size >= max) {
      const ready = [...this.headless.values()].filter((e) => e.state === 'ready')
      if (ready.length === 0) {
        // Every slot is starting or releasing: wait for one of them.
        await Promise.race(
          [...this.headless.values()].map((e) =>
            (e.state === 'releasing' ? (e.released ?? Promise.resolve()) : e.ready).catch(
              () => undefined,
            ),
          ),
        )
        continue
      }
      // Only a host nobody is using: releasing a busy one would cancel its requests.
      const idle = ready.filter((e) => this.isIdle(e))
      if (idle.length === 0) {
        await this.nextLeaseEnd(250)
        continue
      }
      const lru = idle.reduce((a, b) => (b.lastUsedAt < a.lastUsedAt ? b : a))
      await this.releaseHeadless(lru.fileId)
    }
  }

  private isIdle(entry: HeadlessEntry): boolean {
    return entry.leases === 0 && this.options.inFlight(entry.window.webContentsId) === 0
  }

  private leaseEnded(): void {
    const waiters = this.leaseWaiters
    this.leaseWaiters = new Set()
    for (const w of waiters) w()
  }

  /** Resolves when some lease ends, or after `ms` (in-flight counts are polled). */
  private nextLeaseEnd(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.leaseWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      this.leaseWaiters.add(done)
    })
  }

  /**
   * Flush and close a headless host (idle, LRU, quit, handoff). With `drainMs`, requests already
   * routed to it finish first (at most that long); new ones wait for the release.
   */
  releaseHeadless(fileId: string, timeoutMs?: number, drainMs = 0): Promise<void> {
    const entry = this.headless.get(fileId)
    if (!entry) return Promise.resolve()
    if (entry.released) return entry.released
    entry.state = 'releasing'
    const { window } = entry
    entry.released = (async () => {
      try {
        const until = this.now() + drainMs
        while (!this.isIdle(entry) && !window.isDestroyed() && this.now() < until) {
          await this.nextLeaseEnd(Math.min(250, Math.max(1, until - this.now())))
        }
        if (!window.isDestroyed()) {
          await this.options.release(
            window,
            fileId,
            timeoutMs ?? this.options.releaseTimeoutMs ?? 5_000,
          )
        }
      } catch (error) {
        this.log?.warn('headless host did not release cleanly', String(error))
      } finally {
        this.unregister(window.webContentsId, fileId)
        this.headlessIds.delete(window.webContentsId)
        if (this.headless.get(fileId) === entry) this.headless.delete(fileId)
        if (!window.isDestroyed()) window.destroy()
        this.log?.info('headless host released')
        this.wake(fileId)
      }
    })()
    return entry.released
  }

  /**
   * `files:open` from a window (ipc/handlers.ts hook): when it is a visible window and a headless
   * host holds the file, that host flushes and closes first. Requests meanwhile wait for the
   * visible window's `opened` (≤ 10 s).
   */
  async beforeVisibleOpen(fileId: string, senderId: number): Promise<void> {
    if (this.headlessIds.has(senderId)) return
    this.pendingOpens.set(fileId, {
      webContentsId: senderId,
      until: this.now() + (this.options.pendingOpenMs ?? 10_000),
    })
    // Reads already on their way to the headless host finish first (writes are excluded by
    // the caller holding the file's write lock).
    if (this.headless.has(fileId)) await this.releaseHeadless(fileId, undefined, 10_000)
  }

  /** Release idle headless hosts (no requests for 120 s and no working sets). */
  async sweep(): Promise<void> {
    const idleMs = this.options.idleMs ?? 120_000
    const now = this.now()
    const idle = [...this.headless.values()].filter(
      (e) =>
        e.state === 'ready' &&
        now - e.lastUsedAt >= idleMs &&
        !this.options.hasWorkingSet(e.fileId) &&
        this.isIdle(e),
    )
    await Promise.all(idle.map((e) => this.releaseHeadless(e.fileId)))
    for (const [fileId, pending] of [...this.pendingOpens]) {
      if (pending.until <= now) this.pendingOpens.delete(fileId)
    }
  }

  get headlessCount(): number {
    return this.headless.size
  }

  headlessFiles(): string[] {
    return [...this.headless.keys()]
  }

  /** Quit: every headless host flushes (bounded) and closes. */
  async releaseAll(timeoutMs = 3_000): Promise<void> {
    await Promise.all([...this.headless.keys()].map((id) => this.releaseHeadless(id, timeoutMs)))
  }
}
