import { describe, expect, it } from 'vitest'
import { throttle, type ThrottleClock } from '../../src/util/throttle.ts'

function fakeClock(): ThrottleClock & { advance(ms: number): void } {
  let t = 0
  let timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.push({ at: t + ms, fn, id })
      return id
    },
    clearTimeout: (id) => {
      timers = timers.filter((x) => x.id !== id)
    },
    advance(ms: number) {
      t += ms
      const due = timers.filter((x) => x.at <= t)
      timers = timers.filter((x) => x.at > t)
      for (const d of due) d.fn()
    },
  }
}

describe('throttle', () => {
  it('emits leading, then the latest value at most once per interval', () => {
    const clock = fakeClock()
    const out: number[] = []
    const th = throttle((v: number) => out.push(v), 33, clock)
    th.call(1)
    th.call(2)
    th.call(3)
    expect(out).toEqual([1])
    clock.advance(33)
    expect(out).toEqual([1, 3])
    clock.advance(100)
    th.call(4)
    expect(out).toEqual([1, 3, 4])
  })

  it('flushes and cancels pending values', () => {
    const clock = fakeClock()
    const out: string[] = []
    const th = throttle((v: string) => out.push(v), 100, clock)
    th.call('a')
    th.call('b')
    th.flush()
    expect(out).toEqual(['a', 'b'])
    th.call('c')
    th.cancel()
    clock.advance(500)
    expect(out).toEqual(['a', 'b'])
  })
})
