// Theme + auto-update parts of the mock bridge (platform workstream).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../types/bridge'
import { MOCK_UPDATE_VERSION, createMockBridge, mockUpdateStatus } from './mockBridge'

describe('mock bridge: theme', () => {
  it('resolves system against the OS and defaults to system', async () => {
    const dark = createMockBridge({ systemDark: true })
    expect(await dark.theme.preference()).toBe('system')
    expect(dark.theme.initial).toBe('dark')
    expect(createMockBridge({ theme: 'light', systemDark: true }).theme.initial).toBe('light')
  })

  it('reports resolved changes only (preference and OS switches)', async () => {
    const bridge = createMockBridge({ theme: 'system', systemDark: false })
    const seen: string[] = []
    const off = bridge.theme.onChange((t) => seen.push(t))
    await bridge.theme.setPreference('light') // still light
    await bridge.theme.setPreference('dark')
    await bridge.theme.setPreference('system')
    bridge.mock.setSystemDark(true)
    off()
    bridge.mock.setSystemDark(false)
    expect(seen).toEqual(['dark', 'light', 'dark'])
    expect(await bridge.theme.preference()).toBe('system')
  })
})

describe('mock bridge: updates', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('simulates statuses for visual tests', async () => {
    expect(await createMockBridge().updates.status()).toEqual({ state: 'idle' })
    expect(await createMockBridge({ updates: 'ready' }).updates.status()).toEqual({
      state: 'ready',
      version: MOCK_UPDATE_VERSION,
    })
    expect(mockUpdateStatus('downloading')).toEqual({
      state: 'downloading',
      version: MOCK_UPDATE_VERSION,
      progress: 42,
    })
    const custom: UpdateStatus = { state: 'error', error: 'boom' }
    expect(await createMockBridge({ updates: custom }).updates.status()).toEqual(custom)
  })

  it('check() goes checking → none; app.checkForUpdates() is the same check', async () => {
    vi.useFakeTimers()
    const bridge = createMockBridge({ updateCheckMs: 100 })
    const seen: string[] = []
    bridge.updates.onStatus((s) => seen.push(s.state))
    const check = bridge.updates.check()
    expect(bridge.app.checkForUpdates()).toBeInstanceOf(Promise)
    await vi.advanceTimersByTimeAsync(100)
    expect(await check).toEqual({ state: 'none' })
    expect(seen).toEqual(['checking', 'none'])
  })

  it('leaves a pending update alone on check and counts installs only when ready', async () => {
    const bridge = createMockBridge({ updates: 'downloading' })
    expect((await bridge.updates.check()).state).toBe('downloading')
    bridge.updates.install()
    expect(bridge.mock.updateInstalls()).toBe(0)
    const seen: UpdateStatus[] = []
    bridge.updates.onStatus((s) => seen.push(s))
    bridge.mock.setUpdateStatus('ready')
    bridge.updates.install()
    expect(bridge.mock.updateInstalls()).toBe(1)
    expect(seen).toEqual([{ state: 'ready', version: MOCK_UPDATE_VERSION }])
  })
})
