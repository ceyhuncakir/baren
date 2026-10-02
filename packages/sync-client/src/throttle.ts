export interface Throttled<T> {
  /** Offer a new value; it is sent now or at the next slot, replacing any pending value. */
  push(value: T): void
  /** Send the pending value immediately, if any. */
  flush(): void
  /** Drop the pending value and stop the timer. */
  cancel(): void
}

/**
 * Leading + trailing throttle that only ever keeps the latest value (ideal for cursors):
 * at most one call per `intervalMs`, and the final value is never lost.
 */
export function throttleLatest<T>(
  send: (value: T) => void,
  intervalMs: number,
  now: () => number = Date.now,
): Throttled<T> {
  let lastSent = Number.NEGATIVE_INFINITY
  let pending: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const fire = () => {
    timer = null
    if (!pending) return
    const { value } = pending
    pending = null
    lastSent = now()
    send(value)
  }

  return {
    push(value) {
      pending = { value }
      if (timer) return
      const wait = lastSent + intervalMs - now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    flush() {
      if (timer) clearTimeout(timer)
      fire()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}
