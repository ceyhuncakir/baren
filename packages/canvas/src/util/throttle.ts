export interface Throttled<T> {
  /** Emit now if the interval passed since the last emit, else schedule the latest value. */
  call(value: T): void
  /** Emit a pending value immediately. */
  flush(): void
  cancel(): void
}

export interface ThrottleClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const defaultClock: ThrottleClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
}

/** Leading + trailing throttle that always delivers the latest value. */
export function throttle<T>(
  fn: (value: T) => void,
  intervalMs: number,
  clock: ThrottleClock = defaultClock,
): Throttled<T> {
  let last = -Infinity
  let timer: unknown = null
  let pending: { value: T } | null = null

  const emit = (): void => {
    timer = null
    if (!pending) return
    const { value } = pending
    pending = null
    last = clock.now()
    fn(value)
  }

  return {
    call(value: T): void {
      pending = { value }
      const wait = intervalMs - (clock.now() - last)
      if (wait <= 0) {
        if (timer !== null) {
          clock.clearTimeout(timer)
          timer = null
        }
        emit()
      } else if (timer === null) {
        timer = clock.setTimeout(emit, wait)
      }
    },
    flush(): void {
      if (timer !== null) {
        clock.clearTimeout(timer)
        timer = null
      }
      emit()
    },
    cancel(): void {
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}
