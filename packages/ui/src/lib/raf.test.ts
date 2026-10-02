import { describe, expect, it } from 'vitest'
import { rafThrottle, type FrameScheduler } from './raf'

function manualScheduler() {
  const queue = new Map<number, () => void>()
  let id = 0
  const scheduler: FrameScheduler = {
    request(cb) {
      queue.set(++id, cb)
      return id
    },
    cancel(h) {
      queue.delete(h)
    },
  }
  const tick = () => {
    const cbs = [...queue.values()]
    queue.clear()
    cbs.forEach((cb) => cb())
  }
  return { scheduler, tick, size: () => queue.size }
}

describe('rafThrottle', () => {
  it('calls once per frame with the latest arguments', () => {
    const { scheduler, tick, size } = manualScheduler()
    const calls: number[] = []
    const t = rafThrottle((n: number) => calls.push(n), scheduler)
    t(1)
    t(2)
    t(3)
    expect(size()).toBe(1)
    expect(calls).toEqual([])
    tick()
    expect(calls).toEqual([3])
    t(4)
    tick()
    expect(calls).toEqual([3, 4])
  })

  it('flushes the pending call synchronously', () => {
    const { scheduler, size } = manualScheduler()
    const calls: number[] = []
    const t = rafThrottle((n: number) => calls.push(n), scheduler)
    t(7)
    t.flush()
    expect(calls).toEqual([7])
    expect(size()).toBe(0)
    t.flush()
    expect(calls).toEqual([7])
  })

  it('cancels', () => {
    const { scheduler, tick } = manualScheduler()
    const calls: number[] = []
    const t = rafThrottle((n: number) => calls.push(n), scheduler)
    t(1)
    t.cancel()
    tick()
    expect(calls).toEqual([])
  })
})
