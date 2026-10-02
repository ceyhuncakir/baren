import type { DevicePollResponse, DeviceStartResponse } from '@baren/sync-client/api'
import { describe, expect, it, vi } from 'vitest'
import { createWaker, DeviceFlowError, pollDevice } from './devicePoll'

const user = { id: 'u', name: 'U', email: 'u@x.dev', createdAt: 0 }
const start: DeviceStartResponse = {
  deviceCode: 'dev',
  userCode: 'KQ7-4XM',
  verifyUrl: 'http://x/device',
  expiresIn: 600,
  interval: 2,
}

function scripted(responses: Array<DevicePollResponse | Error>) {
  const poll = vi.fn(async () => {
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next ?? { status: 'pending' as const }
  })
  return poll
}

describe('device flow polling', () => {
  it('polls until approved, sleeping between polls', async () => {
    const poll = scripted([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'ok', token: 't', user },
    ])
    const sleep = vi.fn(async () => undefined)
    const result = await pollDevice(start, { poll, waker: { sleep, wake: () => undefined } })
    expect(result).toEqual({ token: 't', user })
    expect(poll).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledWith(2000, undefined)
  })

  it('maps denied and expired, and expires on its own deadline', async () => {
    const instant = { sleep: async () => undefined, wake: () => undefined }
    await expect(
      pollDevice(start, { poll: scripted([{ status: 'denied' }]), waker: instant }),
    ).rejects.toMatchObject({ reason: 'denied' })
    await expect(
      pollDevice(start, { poll: scripted([{ status: 'expired' }]), waker: instant }),
    ).rejects.toBeInstanceOf(DeviceFlowError)
    let t = 0
    const now = () => (t += 300_000)
    await expect(
      pollDevice(start, { poll: scripted([]), waker: instant, now }),
    ).rejects.toMatchObject({ reason: 'expired' })
  })

  it('retries transient errors only', async () => {
    const instant = { sleep: async () => undefined, wake: () => undefined }
    const transient = new Error('offline')
    const poll = scripted([transient, { status: 'ok', token: 't', user }])
    await expect(
      pollDevice(start, { poll, waker: instant, isTransient: (e) => e === transient }),
    ).resolves.toMatchObject({ token: 't' })
    await expect(
      pollDevice(start, { poll: scripted([new Error('boom')]), waker: instant }),
    ).rejects.toThrow('boom')
  })

  it('wakes early from a deep link and stops on abort', async () => {
    vi.useFakeTimers()
    try {
      const waker = createWaker()
      const poll = scripted([{ status: 'pending' }, { status: 'ok', token: 't', user }])
      const done = pollDevice(start, { poll, waker })
      await vi.advanceTimersByTimeAsync(0)
      expect(poll).toHaveBeenCalledTimes(1)
      waker.wake()
      await expect(done).resolves.toMatchObject({ token: 't' })

      const controller = new AbortController()
      const aborted = pollDevice(start, { poll: scripted([]), waker, signal: controller.signal })
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await expect(aborted).rejects.toMatchObject({ reason: 'aborted' })
    } finally {
      vi.useRealTimers()
    }
  })
})
