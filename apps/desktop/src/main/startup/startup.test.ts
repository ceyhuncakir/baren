import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chromiumSwitches } from './chromium'
import { parseRuntimeFlags } from './flags'
import { SmokeRun, coldStartMs, type SmokeOutcome, type TimerFn } from './smoke'
import { createSmokeUserDataDir, removeStaleSmokeDirs } from './smokeDirs'
import { StartupTimeline } from './timeline'

describe('parseRuntimeFlags', () => {
  it('has safe defaults', () => {
    expect(parseRuntimeFlags({})).toEqual({
      smoke: false,
      smokeTimeoutMs: 20_000,
      smokeReadyGraceMs: 1_500,
      userDataDir: null,
      coreMode: 'auto',
      nativeModulePath: null,
      disableGpu: false,
      ignoreGpuBlocklist: false,
      registerProtocolInDev: false,
      forceUpdates: false,
      updateUrl: null,
      smokeUpdates: null,
      smokeInstall: false,
      mcp: null,
      mcpPort: null,
      mcpAllowedOrigins: [],
      exportDir: null,
      mcpToolTimeoutMs: null,
    })
  })

  it('reads every switch', () => {
    const flags = parseRuntimeFlags({
      BAREN_SMOKE: '1',
      BAREN_SMOKE_TIMEOUT_MS: '5000',
      BAREN_SMOKE_READY_GRACE_MS: '0',
      BAREN_USER_DATA_DIR: ' /tmp/x ',
      BAREN_CORE: 'JS',
      BAREN_NATIVE_PATH: '/a/b.node',
      BAREN_DISABLE_GPU: 'true',
      BAREN_IGNORE_GPU_BLOCKLIST: 'yes',
      BAREN_REGISTER_PROTOCOL: 'on',
      BAREN_FORCE_UPDATES: '1',
      BAREN_UPDATE_URL: ' http://127.0.0.1:9000/feed/ ',
      BAREN_SMOKE_UPDATES: '1',
      BAREN_SMOKE_INSTALL: '1',
      BAREN_MCP: '1',
      BAREN_MCP_PORT: '0',
      BAREN_MCP_ALLOWED_ORIGINS: 'http://localhost:6274, http://127.0.0.1:6274',
      BAREN_EXPORT_DIR: ' /tmp/exports ',
      BAREN_MCP_TOOL_TIMEOUT_MS: '2500',
    })
    expect(flags).toEqual({
      smoke: true,
      smokeTimeoutMs: 5000,
      smokeReadyGraceMs: 0,
      userDataDir: '/tmp/x',
      coreMode: 'js',
      nativeModulePath: '/a/b.node',
      disableGpu: true,
      ignoreGpuBlocklist: true,
      registerProtocolInDev: true,
      forceUpdates: true,
      updateUrl: 'http://127.0.0.1:9000/feed/',
      smokeUpdates: 'ready',
      smokeInstall: true,
      mcp: true,
      mcpPort: 0,
      mcpAllowedOrigins: ['http://localhost:6274', 'http://127.0.0.1:6274'],
      exportDir: '/tmp/exports',
      mcpToolTimeoutMs: 2500,
    })
  })

  it('reads the MCP switches (contract §3.4)', () => {
    expect(parseRuntimeFlags({ BAREN_MCP: '0' }).mcp).toBe(false)
    expect(parseRuntimeFlags({ BAREN_MCP: 'off' }).mcp).toBe(false)
    expect(parseRuntimeFlags({ BAREN_MCP: 'maybe' }).mcp).toBeNull()
    expect(parseRuntimeFlags({ BAREN_MCP_PORT: '29175' }).mcpPort).toBe(29_175)
    expect(parseRuntimeFlags({ BAREN_MCP_PORT: '70000' }).mcpPort).toBeNull()
    expect(parseRuntimeFlags({ BAREN_MCP_PORT: 'x' }).mcpPort).toBeNull()
    expect(parseRuntimeFlags({ BAREN_MCP_TOOL_TIMEOUT_MS: '0' }).mcpToolTimeoutMs).toBeNull()
  })

  it('reads the expected end state of a smoke update check', () => {
    expect(parseRuntimeFlags({ BAREN_SMOKE_UPDATES: 'none' }).smokeUpdates).toBe('none')
    expect(parseRuntimeFlags({ BAREN_SMOKE_UPDATES: 'ERROR' }).smokeUpdates).toBe('error')
    expect(parseRuntimeFlags({ BAREN_SMOKE_UPDATES: '0' }).smokeUpdates).toBeNull()
    expect(parseRuntimeFlags({ BAREN_SMOKE_UPDATES: 'downloading' }).smokeUpdates).toBeNull()
  })

  it('ignores invalid values', () => {
    const flags = parseRuntimeFlags({
      BAREN_SMOKE: '0',
      BAREN_SMOKE_TIMEOUT_MS: '-5',
      BAREN_CORE: 'rust',
    })
    expect(flags.smoke).toBe(false)
    expect(flags.smokeTimeoutMs).toBe(20_000)
    expect(flags.coreMode).toBe('auto')
  })
})

describe('chromiumSwitches', () => {
  it('enables GPU rasterization by default', () => {
    expect(
      chromiumSwitches({ smoke: false, disableGpu: false, ignoreGpuBlocklist: false }),
    ).toEqual([{ name: 'enable-gpu-rasterization' }])
  })

  it('skips GPU switches when the GPU is disabled and isolates smoke runs from the keyring', () => {
    expect(chromiumSwitches({ smoke: true, disableGpu: true, ignoreGpuBlocklist: true })).toEqual([
      { name: 'password-store', value: 'basic' },
    ])
  })

  it('only ignores the GPU blocklist when asked', () => {
    const names = chromiumSwitches({
      smoke: false,
      disableGpu: false,
      ignoreGpuBlocklist: true,
    }).map((s) => s.name)
    expect(names).toContain('ignore-gpu-blocklist')
  })
})

describe('StartupTimeline', () => {
  it('records each milestone once, rounded, sorted by time', () => {
    let now = 0
    const t = new StartupTimeline(() => now, 1_000_000)
    now = 12.345
    t.mark('b')
    now = 50
    t.mark('b')
    t.mark('a', 5)
    t.markEpoch('renderer', 1_000_100.04)
    t.markEpoch('bad', Number.NaN)
    expect(t.toJSON()).toEqual({ a: 5, b: 12.3, renderer: 100 })
    expect(Object.keys(t.toJSON())).toEqual(['a', 'b', 'renderer'])
  })
})

function fakeTimers(): { setTimer: TimerFn; fire(ms: number): void; pending: () => number } {
  let now = 0
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  return {
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    fire(ms) {
      now += ms
      for (const t of timers.splice(0)) {
        if (t.cancelled) continue
        if (t.at <= now) t.fn()
        else timers.push(t)
      }
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
  }
}

describe('SmokeRun', () => {
  const setup = (readyGraceMs = 100) => {
    const timers = fakeTimers()
    const outcomes: SmokeOutcome[] = []
    const run = new SmokeRun({
      timeoutMs: 1000,
      readyGraceMs,
      setTimer: timers.setTimer,
      onFinish: (o) => outcomes.push(o),
    })
    run.start()
    return { run, timers, outcomes }
  }

  it('finishes immediately on baren:ready', () => {
    const { run, outcomes, timers } = setup()
    run.milestone('readyToShow')
    run.milestone('appReady')
    expect(outcomes).toEqual([{ ok: true, reason: 'app-ready', rendererErrors: [] }])
    expect(timers.pending()).toBe(0)
  })

  it('falls back to first paint plus a grace period', () => {
    const { run, outcomes, timers } = setup()
    run.milestone('domContentLoaded')
    run.milestone('readyToShow')
    timers.fire(50)
    run.milestone('firstContentfulPaint') // does not re-arm the grace timer
    expect(outcomes).toEqual([])
    timers.fire(60)
    expect(outcomes).toEqual([{ ok: true, reason: 'first-paint', rendererErrors: [] }])
  })

  it('times out when the renderer never paints', () => {
    const { outcomes, timers } = setup()
    timers.fire(1000)
    expect(outcomes[0]).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('fails on renderer crashes and reports console errors, exactly once', () => {
    const { run, outcomes } = setup()
    run.rendererError('Uncaught TypeError: x')
    run.fail('render process gone: crashed')
    run.milestone('appReady')
    expect(outcomes).toEqual([
      {
        ok: false,
        reason: 'renderer-failed',
        error: 'render process gone: crashed',
        rendererErrors: ['Uncaught TypeError: x'],
      },
    ])
    expect(run.isFinished).toBe(true)
  })
})

describe('coldStartMs', () => {
  it('prefers app-ready, then first paint, then ready-to-show, then load', () => {
    expect(coldStartMs({ rendererAppReady: 400, rendererFirstContentfulPaint: 300 })).toBe(400)
    expect(coldStartMs({ rendererFirstContentfulPaint: 300, readyToShow: 310 })).toBe(300)
    expect(coldStartMs({ readyToShow: 310, rendererLoad: 290 })).toBe(310)
    expect(coldStartMs({ rendererLoad: 290 })).toBe(290)
    expect(coldStartMs({})).toBeNull()
  })
})

describe('smoke userData directories', () => {
  it('creates run directories and removes only stale ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baren-smoke-test-'))
    try {
      const old = createSmokeUserDataDir(root)
      const fresh = createSmokeUserDataDir(root)
      const current = createSmokeUserDataDir(root)
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
      await utimes(old, hourAgo, hourAgo)
      await utimes(current, hourAgo, hourAgo)
      expect(await removeStaleSmokeDirs(current, root)).toEqual([old])
      expect((await readdir(root)).sort()).toEqual(
        [fresh, current].map((d) => d.slice(root.length + 1)).sort(),
      )
      expect(await removeStaleSmokeDirs(current, join(root, 'missing'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
