/**
 * "Continue in browser" (artboard 21): poll the device-code endpoint until the browser
 * approves. Unlike ApiClient.auth.waitForDevice, the wait between polls can be cut short —
 * the server's success page links to baren://auth/<userCode>, and desktop-shell delivers
 * that link so the app polls immediately instead of waiting out the interval.
 */
import type { AuthResponse, DevicePollResponse, DeviceStartResponse } from '@baren/sync-client/api'

export class DeviceFlowError extends Error {
  override readonly name = 'DeviceFlowError'
  constructor(
    readonly reason: 'denied' | 'expired' | 'aborted',
    message: string,
  ) {
    super(message)
  }
}

export interface Waker {
  /** Resolves after `ms`, or earlier when wake() is called; rejects when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  wake(): void
}

export function createWaker(): Waker {
  const pending = new Set<() => void>()
  return {
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        const done = () => {
          clearTimeout(timer)
          pending.delete(done)
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          clearTimeout(timer)
          pending.delete(done)
          reject(abortError())
        }
        const timer = setTimeout(done, ms)
        pending.add(done)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    wake() {
      for (const done of [...pending]) done()
    },
  }
}

function abortError(): DeviceFlowError {
  return new DeviceFlowError('aborted', 'Sign-in was cancelled.')
}

/** Shared waker for baren://auth/<code> deep links. */
export const deviceWaker: Waker = createWaker()

export interface PollDeviceOptions {
  poll: (deviceCode: string) => Promise<DevicePollResponse>
  waker?: Waker
  signal?: AbortSignal
  now?: () => number
  /** Overrides the server's interval (ms). */
  intervalMs?: number
  /** Decides whether a failed poll is transient (network, 5xx); those are retried. */
  isTransient?: (error: unknown) => boolean
}

export async function pollDevice(
  start: DeviceStartResponse,
  options: PollDeviceOptions,
): Promise<AuthResponse> {
  const waker = options.waker ?? deviceWaker
  const now = options.now ?? Date.now
  const interval = options.intervalMs ?? Math.max(1, start.interval) * 1000
  const deadline = now() + Math.max(1, start.expiresIn) * 1000
  for (;;) {
    if (options.signal?.aborted) throw abortError()
    let result: DevicePollResponse = { status: 'pending' }
    try {
      result = await options.poll(start.deviceCode)
    } catch (error) {
      if (!options.isTransient?.(error)) throw error
    }
    switch (result.status) {
      case 'ok':
        return { token: result.token, user: result.user }
      case 'denied':
        throw new DeviceFlowError('denied', 'Sign-in was denied in the browser.')
      case 'expired':
        throw new DeviceFlowError('expired', 'The sign-in request expired.')
      case 'pending':
        if (now() >= deadline) throw new DeviceFlowError('expired', 'The sign-in request expired.')
        await waker.sleep(interval, options.signal)
    }
  }
}
