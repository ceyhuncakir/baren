import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../log'
import { updateAvailability, type AvailabilityInput } from './availability'
import { asFeedBase, resolveFeedUrl } from './feed'
import {
  CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  UpdateController,
  type UpdateControllerOptions,
  type UpdaterLike,
} from './updateController'
import {
  IDLE,
  errorMessage,
  isBusy,
  nextStatus,
  sameStatus,
  type UpdateStatus,
} from './updateStatus'

const silent = createLogger('test', { sink: () => {} })

describe('update feed URL', () => {
  it('defaults to <server>/updates/ (build-time VITE_SERVER_URL, else the local server)', () => {
    expect(resolveFeedUrl({})).toBe('http://127.0.0.1:8787/updates/')
    expect(resolveFeedUrl({ serverUrl: 'https://api.baren.dev' })).toBe(
      'https://api.baren.dev/updates/',
    )
    expect(resolveFeedUrl({ serverUrl: 'https://x.example/base/?q=1#h' })).toBe(
      'https://x.example/base/updates/',
    )
    expect(resolveFeedUrl({ serverUrl: 'https://x.example/base//' })).toBe(
      'https://x.example/base/updates/',
    )
  })

  it('prefers BAREN_UPDATE_URL, then VITE_UPDATE_URL, as a directory URL', () => {
    expect(
      resolveFeedUrl({
        override: 'http://127.0.0.1:9999/feed',
        updateUrl: 'https://cdn.example/u/',
        serverUrl: 'https://api.example',
      }),
    ).toBe('http://127.0.0.1:9999/feed/')
    expect(resolveFeedUrl({ override: '  ', updateUrl: 'https://cdn.example/u' })).toBe(
      'https://cdn.example/u/',
    )
    expect(asFeedBase('https://cdn.example/releases/linux/')).toBe(
      'https://cdn.example/releases/linux/',
    )
  })

  it('rejects anything but plain http(s) URLs', () => {
    expect(resolveFeedUrl({ updateUrl: 'file:///srv/updates' })).toBeNull()
    expect(resolveFeedUrl({ updateUrl: 'not a url' })).toBeNull()
    expect(resolveFeedUrl({ updateUrl: 'https://user:pw@cdn.example/' })).toBeNull()
    expect(resolveFeedUrl({ serverUrl: 'ws://x' })).toBeNull()
  })
})

describe('update availability', () => {
  const packaged: AvailabilityInput = {
    platform: 'linux',
    isPackaged: true,
    forced: false,
    smoke: false,
    feedUrl: 'https://x/updates/',
    appImagePath: null,
    packageType: null,
  }

  it('runs for AppImages (installing on quit) and deb/rpm installs (only on request)', () => {
    expect(updateAvailability({ ...packaged, appImagePath: '/home/u/baren.AppImage' })).toEqual({
      enabled: true,
      kind: 'appimage',
      installOnQuit: true,
    })
    expect(updateAvailability({ ...packaged, packageType: 'deb\n' })).toEqual({
      enabled: true,
      kind: 'deb',
      installOnQuit: false,
    })
    expect(updateAvailability({ ...packaged, packageType: 'rpm' })).toMatchObject({ kind: 'rpm' })
  })

  it('is disabled in dev, smoke runs, unpacked builds and without a feed', () => {
    expect(updateAvailability({ ...packaged, isPackaged: false })).toEqual({
      enabled: false,
      reason: 'development build',
    })
    expect(updateAvailability({ ...packaged, smoke: true, appImagePath: '/a.AppImage' })).toEqual({
      enabled: false,
      reason: 'smoke run',
    })
    expect(updateAvailability(packaged)).toMatchObject({ enabled: false })
    expect(updateAvailability({ ...packaged, packageType: 'snap' })).toMatchObject({
      enabled: false,
    })
    expect(updateAvailability({ ...packaged, feedUrl: null, appImagePath: '/a' })).toMatchObject({
      enabled: false,
      reason: 'no valid update feed URL',
    })
  })

  it('BAREN_FORCE_UPDATES enables dev builds and smoke runs, never installing on quit', () => {
    expect(updateAvailability({ ...packaged, isPackaged: false, forced: true })).toEqual({
      enabled: true,
      kind: 'dev',
      installOnQuit: false,
    })
    expect(
      updateAvailability({ ...packaged, smoke: true, forced: true, appImagePath: '/a.AppImage' }),
    ).toEqual({ enabled: true, kind: 'appimage', installOnQuit: false })
  })
})

describe('update status machine', () => {
  const run = (...events: Parameters<typeof nextStatus>[1][]): UpdateStatus =>
    events.reduce(nextStatus, IDLE)

  it('walks checking → available → downloading → ready', () => {
    let s = nextStatus(IDLE, { type: 'checking' })
    expect(s).toEqual({ state: 'checking' })
    s = nextStatus(s, { type: 'available', version: '1.2.0' })
    expect(s).toEqual({ state: 'available', version: '1.2.0' })
    s = nextStatus(s, { type: 'progress', percent: 41.7 })
    expect(s).toEqual({ state: 'downloading', version: '1.2.0', progress: 41 })
    s = nextStatus(s, { type: 'progress', percent: 140 })
    expect(s.progress).toBe(100)
    s = nextStatus(s, { type: 'downloaded', version: '1.2.0' })
    expect(s).toEqual({ state: 'ready', version: '1.2.0' })
  })

  it('reports none and errors, keeping the version when it was known', () => {
    expect(run({ type: 'checking' }, { type: 'not-available' })).toEqual({ state: 'none' })
    expect(run({ type: 'checking' }, { type: 'error', message: 'offline' })).toEqual({
      state: 'error',
      error: 'offline',
    })
    expect(
      run({ type: 'available', version: '2.0.0' }, { type: 'error', message: 'sha512 mismatch' }),
    ).toEqual({ state: 'error', version: '2.0.0', error: 'sha512 mismatch' })
    // A new check after an error starts clean.
    expect(run({ type: 'error', message: 'x' }, { type: 'checking' })).toEqual({
      state: 'checking',
    })
  })

  it('keeps a downloaded update ready through later check noise, but reports errors', () => {
    const ready: UpdateStatus = { state: 'ready', version: '1.2.0' }
    for (const event of [
      { type: 'checking' },
      { type: 'not-available' },
      { type: 'available', version: '1.2.0' },
      { type: 'progress', percent: 3 },
    ] as const) {
      expect(nextStatus(ready, event)).toBe(ready)
    }
    expect(nextStatus(ready, { type: 'downloaded', version: '1.3.0' })).toEqual({
      state: 'ready',
      version: '1.3.0',
    })
    expect(nextStatus(ready, { type: 'error', message: 'pkexec dismissed' }).state).toBe('error')
  })

  it('never leaves disabled', () => {
    const disabled: UpdateStatus = { state: 'disabled' }
    expect(nextStatus(disabled, { type: 'downloaded', version: '9.9.9' })).toBe(disabled)
  })

  it('compares statuses and knows when a check would be redundant', () => {
    expect(sameStatus({ state: 'none' }, { state: 'none' })).toBe(true)
    expect(
      sameStatus({ state: 'downloading', progress: 1 }, { state: 'downloading', progress: 2 }),
    ).toBe(false)
    expect(
      ['checking', 'available', 'downloading', 'ready'].every((state) =>
        isBusy({ state } as UpdateStatus),
      ),
    ).toBe(true)
    expect(
      ['idle', 'none', 'error', 'disabled'].some((state) => isBusy({ state } as UpdateStatus)),
    ).toBe(false)
  })

  it('turns updater errors into one readable line', () => {
    expect(errorMessage(new Error('net::ERR_CONNECTION_REFUSED\n    at x (y.js:1)'))).toBe(
      'net::ERR_CONNECTION_REFUSED',
    )
    expect(errorMessage('x'.repeat(1000))).toHaveLength(300)
    expect(errorMessage(new Error('\n'))).toBe('Unknown error')
  })
})

/** An electron-updater stand-in: tests drive its events and check results. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = true
  logger: UpdaterLike['logger'] = null
  feed: string | null = null
  checks = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  /** What the next checkForUpdates does. */
  onCheck: (u: FakeUpdater) => Promise<{ downloadPromise?: Promise<unknown> | null } | null> =
    async (u) => {
      u.emit('checking-for-update')
      u.emit('update-not-available', { version: '0.1.0' })
      return { downloadPromise: null }
    }
  onInstall: (u: FakeUpdater) => void = () => {}

  setFeedURL(options: { provider: 'generic'; url: string }): void {
    this.feed = options.url
  }
  checkForUpdates() {
    this.checks++
    return this.onCheck(this)
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
    this.onInstall(this)
  }
}

describe('UpdateController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const setup = (over: Partial<UpdateControllerOptions> = {}) => {
    const updater = new FakeUpdater()
    const pushed: UpdateStatus[] = []
    const calls: string[] = []
    let quitting = false
    const controller = new UpdateController({
      disabledReason: null,
      feedUrl: 'http://127.0.0.1:8787/updates/',
      installOnQuit: true,
      loadUpdater: async () => {
        calls.push('load')
        return updater
      },
      onStatus: (s) => pushed.push(s),
      prepareInstall: async () => {
        calls.push('prepare')
      },
      installFailed: () => calls.push('recover'),
      isQuitting: () => quitting,
      log: silent,
      ...over,
    })
    return { updater, pushed, calls, controller, quit: () => (quitting = true) }
  }

  it('starts idle and does not load electron-updater for status()', () => {
    const { controller, calls } = setup()
    expect(controller.status()).toEqual({ state: 'idle' })
    expect(calls).toEqual([])
  })

  it('stays disabled (no timers, no loading) when updates do not run here', async () => {
    const { controller, calls, pushed } = setup({ disabledReason: 'development build' })
    controller.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(await controller.check()).toEqual({ state: 'disabled' })
    expect(calls).toEqual([])
    expect(pushed).toEqual([])
  })

  it('checks 10 s after start and then every 4 hours', async () => {
    const { controller, updater } = setup()
    controller.start()
    await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS - 1)
    expect(updater.checks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checks).toBe(1)
    expect(controller.status()).toEqual({ state: 'none' })
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(updater.checks).toBe(2)
    controller.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(updater.checks).toBe(2)
  })

  it('configures electron-updater: generic feed, background download, install-on-quit policy', async () => {
    const { controller, updater } = setup({ installOnQuit: false })
    await controller.check()
    expect(updater.feed).toBe('http://127.0.0.1:8787/updates/')
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.logger).not.toBeNull()
  })

  it('pushes every transition of a background download up to ready', async () => {
    const { controller, updater, pushed } = setup()
    let finishDownload!: () => void
    updater.onCheck = async (u) => {
      u.emit('checking-for-update')
      u.emit('update-available', { version: '0.2.0' })
      const downloadPromise = new Promise<void>((resolve) => {
        finishDownload = () => {
          u.emit('download-progress', { percent: 12.5 })
          u.emit('download-progress', { percent: 12.9 }) // same integer: not pushed again
          u.emit('download-progress', { percent: 100 })
          u.emit('update-downloaded', { version: '0.2.0' })
          resolve()
        }
      })
      return { downloadPromise }
    }
    // check() resolves when the check is over; the download continues.
    expect(await controller.check()).toEqual({ state: 'available', version: '0.2.0' })
    const settled = controller.whenSettled(60_000)
    finishDownload()
    expect(await settled).toEqual({ state: 'ready', version: '0.2.0' })
    expect(pushed).toEqual([
      { state: 'checking' },
      { state: 'available', version: '0.2.0' },
      { state: 'downloading', version: '0.2.0', progress: 12 },
      { state: 'downloading', version: '0.2.0', progress: 100 },
      { state: 'ready', version: '0.2.0' },
    ])
    expect(controller.history().map((r) => r.state)).toEqual([
      'idle',
      'checking',
      'available',
      'downloading',
      'downloading',
      'ready',
    ])
    // Ready: further checks are no-ops.
    expect(await controller.check()).toEqual({ state: 'ready', version: '0.2.0' })
    expect(updater.checks).toBe(1)
  })

  it('runs one check at a time', async () => {
    const { controller, updater } = setup()
    let release!: () => void
    updater.onCheck = (u) =>
      new Promise((resolve) => {
        u.emit('checking-for-update')
        release = () => {
          u.emit('update-not-available', {})
          resolve({ downloadPromise: null })
        }
      })
    const a = controller.check()
    await vi.advanceTimersByTimeAsync(0)
    const b = controller.check()
    release()
    expect(await a).toEqual({ state: 'none' })
    expect(await b).toEqual({ state: 'none' })
    expect(updater.checks).toBe(1)
  })

  it('reports check failures as error (once) and recovers on the next check', async () => {
    const { controller, updater, pushed } = setup()
    updater.onCheck = async (u) => {
      u.emit('checking-for-update')
      const error = new Error('net::ERR_CONNECTION_REFUSED')
      u.emit('error', error)
      throw error
    }
    expect(await controller.check()).toEqual({
      state: 'error',
      error: 'net::ERR_CONNECTION_REFUSED',
    })
    expect(pushed.filter((s) => s.state === 'error')).toHaveLength(1)
    updater.onCheck = new FakeUpdater().onCheck
    expect(await controller.check()).toEqual({ state: 'none' })
  })

  it('becomes disabled when electron-updater says it is inactive for this install', async () => {
    const { controller, updater } = setup()
    updater.onCheck = async () => null
    expect(await controller.check()).toEqual({ state: 'disabled' })
  })

  it('reports an updater that cannot load as an error', async () => {
    const { controller } = setup({
      loadUpdater: async () => {
        throw new Error('Cannot find module electron-updater')
      },
    })
    expect((await controller.check()).state).toBe('error')
  })

  const makeReady = async (ctx: ReturnType<typeof setup>) => {
    ctx.updater.onCheck = async (u) => {
      u.emit('update-available', { version: '0.2.0' })
      u.emit('update-downloaded', { version: '0.2.0' })
      return { downloadPromise: Promise.resolve() }
    }
    await ctx.controller.check()
    expect(ctx.controller.status().state).toBe('ready')
  }

  it('install() is ignored unless an update is ready', async () => {
    const ctx = setup()
    await ctx.controller.install()
    expect(ctx.updater.installs).toEqual([])
    expect(ctx.calls).toEqual([])
  })

  it('installs: releases resources first, then quit-and-install with relaunch', async () => {
    const ctx = setup()
    await makeReady(ctx)
    ctx.updater.onInstall = () => ctx.quit()
    await ctx.controller.install()
    expect(ctx.calls).toEqual(['load', 'prepare'])
    expect(ctx.updater.installs).toEqual([[false, true]])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.calls).toEqual(['load', 'prepare'])
    expect(ctx.controller.status().state).toBe('ready')
  })

  it('recovers when the install fails (e.g. the pkexec prompt was dismissed)', async () => {
    const ctx = setup()
    await makeReady(ctx)
    ctx.updater.onInstall = (u) => u.emit('error', new Error('Command pkexec exited with code 126'))
    await ctx.controller.install()
    expect(ctx.calls).toEqual(['load', 'prepare', 'recover'])
    expect(ctx.controller.status()).toEqual({
      state: 'error',
      version: '0.2.0',
      error: 'Command pkexec exited with code 126',
    })
  })

  it('recovers when electron-updater silently declines to quit', async () => {
    const ctx = setup({ installWatchdogMs: 1000 })
    await makeReady(ctx)
    await ctx.controller.install()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.calls).toEqual(['load', 'prepare', 'recover'])
    expect(ctx.controller.status().state).toBe('error')
  })

  it('whenSettled resolves with the current status at its timeout', async () => {
    const { controller } = setup()
    const settled = controller.whenSettled(500)
    await vi.advanceTimersByTimeAsync(500)
    expect(await settled).toEqual({ state: 'idle' })
  })
})
