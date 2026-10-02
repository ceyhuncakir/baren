import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockControls } from '../lib/bridge'
import { installUpdates, updateMenuItem, updateNotice, useUpdates } from './updates'

const base = { appVersion: '0.1.0', userCheck: false, laterVersion: null }

describe('update notice', () => {
  it('always shows a ready update until "Later" for that version', () => {
    const ready = { ...base, status: { state: 'ready' as const, version: '0.2.0' } }
    expect(updateNotice(ready)).toEqual({ kind: 'ready', version: '0.2.0' })
    expect(updateNotice({ ...ready, laterVersion: '0.2.0' })).toBeNull()
    // A newer download is announced again.
    expect(updateNotice({ ...ready, laterVersion: '0.1.5' })).toEqual({
      kind: 'ready',
      version: '0.2.0',
    })
    // Asking again brings it back.
    expect(updateNotice({ ...ready, laterVersion: '0.2.0', userCheck: true })).toMatchObject({
      kind: 'ready',
    })
  })

  it('reports background states only after the user asked', () => {
    const quiet = (state: 'checking' | 'none' | 'error' | 'downloading' | 'disabled') =>
      updateNotice({ ...base, status: { state, error: 'offline' } })
    for (const state of ['checking', 'none', 'error', 'downloading', 'disabled'] as const)
      expect(quiet(state)).toBeNull()

    const asked = { ...base, userCheck: true }
    expect(updateNotice({ ...asked, status: { state: 'checking' } })).toEqual({ kind: 'checking' })
    expect(updateNotice({ ...asked, status: { state: 'none' } })).toEqual({
      kind: 'upToDate',
      version: '0.1.0',
    })
    expect(updateNotice({ ...asked, status: { state: 'available', version: '0.2.0' } })).toEqual({
      kind: 'downloading',
      version: '0.2.0',
      progress: 0,
    })
    expect(
      updateNotice({ ...asked, status: { state: 'downloading', version: '0.2.0', progress: 141 } }),
    ).toEqual({ kind: 'downloading', version: '0.2.0', progress: 100 })
    expect(updateNotice({ ...asked, status: { state: 'error', error: 'boom' } })).toEqual({
      kind: 'error',
      version: null,
      message: 'boom',
    })
    expect(updateNotice({ ...asked, status: { state: 'disabled' } })).toEqual({ kind: 'disabled' })
  })

  it('labels the Help menu item by state', () => {
    expect(updateMenuItem({ state: 'idle' })).toEqual({
      label: 'Check for Updates…',
      installs: false,
      enabled: true,
    })
    expect(updateMenuItem({ state: 'ready', version: '0.2.0' })).toEqual({
      label: 'Restart to Update (0.2.0)…',
      installs: true,
      enabled: true,
    })
    expect(updateMenuItem({ state: 'downloading', progress: 42 })).toMatchObject({
      label: 'Downloading Update… 42%',
      enabled: false,
    })
    expect(updateMenuItem({ state: 'checking' }).enabled).toBe(false)
    expect(updateMenuItem({ state: 'error', error: 'x' }).label).toBe('Check for Updates…')
  })
})

describe('updates store (mock bridge)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('follows the bridge, checks on request and installs only when ready', async () => {
    vi.useFakeTimers()
    installUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(useUpdates.getState().status.state).toBe('idle')

    const done = useUpdates.getState().check()
    await vi.advanceTimersByTimeAsync(0)
    expect(useUpdates.getState()).toMatchObject({ userCheck: true, status: { state: 'checking' } })
    await vi.advanceTimersByTimeAsync(500)
    await done
    expect(useUpdates.getState().status.state).toBe('none')
    // "Up to date" goes away on its own.
    await vi.advanceTimersByTimeAsync(5000)
    expect(useUpdates.getState().userCheck).toBe(false)

    useUpdates.getState().install()
    expect(mockControls?.updateInstalls()).toBe(0)
    mockControls?.setUpdateStatus('ready')
    expect(useUpdates.getState().status).toEqual({ state: 'ready', version: '0.2.0' })
    useUpdates.getState().dismiss()
    expect(useUpdates.getState().laterVersion).toBe('0.2.0')
    useUpdates.getState().install()
    expect(mockControls?.updateInstalls()).toBe(1)
  })

  it('lets a repeated "not available" answer go by itself', async () => {
    vi.useFakeTimers()
    installUpdates()
    mockControls?.setUpdateStatus('disabled')
    await useUpdates.getState().check()
    expect(useUpdates.getState()).toMatchObject({ userCheck: true, status: { state: 'disabled' } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(useUpdates.getState().userCheck).toBe(false)
  })
})
