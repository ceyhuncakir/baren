/**
 * Coalesces high-frequency calls (pointermove during scrubbing, slider drags, color picking)
 * into at most one call per animation frame, always with the latest arguments.
 */

export interface FrameScheduler {
  request(cb: () => void): number
  cancel(handle: number): void
}

const defaultScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
}

export interface RafThrottled<A extends unknown[]> {
  (...args: A): void
  /** Runs the pending call now (e.g. on pointerup, so the final value is never lost). */
  flush(): void
  cancel(): void
}

export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  scheduler: FrameScheduler = defaultScheduler,
): RafThrottled<A> {
  let handle: number | null = null
  let pending: A | null = null

  const run = () => {
    handle = null
    const args = pending
    pending = null
    if (args) fn(...args)
  }

  const throttled = ((...args: A) => {
    pending = args
    if (handle === null) handle = scheduler.request(run)
  }) as RafThrottled<A>

  throttled.flush = () => {
    if (handle !== null) scheduler.cancel(handle)
    run()
  }
  throttled.cancel = () => {
    if (handle !== null) scheduler.cancel(handle)
    handle = null
    pending = null
  }
  return throttled
}
