import { describe, expect, it } from 'vitest'
import { DeepLinkRouter, type DeepLinkTarget } from './router'

function target(id: number): DeepLinkTarget & { received: string[]; destroyed: boolean } {
  const t = {
    id,
    received: [] as string[],
    destroyed: false,
    send(url: string) {
      t.received.push(url)
    },
    isDestroyed: () => t.destroyed,
  }
  return t
}

describe('DeepLinkRouter', () => {
  it('queues links until a renderer subscribes, then flushes them in order', () => {
    const router = new DeepLinkRouter()
    expect(router.push('baren://invite/a')).toBe('queued')
    expect(router.push('baren://auth/b')).toBe('queued')
    const t = target(1)
    router.subscribe(t)
    expect(t.received).toEqual(['baren://invite/a', 'baren://auth/b'])
    expect(router.pending).toEqual([])
  })

  it('delivers immediately while subscribed and queues again after unsubscribe', () => {
    const router = new DeepLinkRouter()
    const t = target(1)
    router.subscribe(t)
    expect(router.push('baren://invite/a')).toBe('delivered')
    router.unsubscribe(1)
    expect(router.push('baren://invite/b')).toBe('queued')
    expect(t.received).toEqual(['baren://invite/a'])
  })

  it('drops destroyed subscribers', () => {
    const router = new DeepLinkRouter()
    const t = target(1)
    router.subscribe(t)
    t.destroyed = true
    expect(router.push('baren://invite/a')).toBe('queued')
    expect(router.hasSubscribers).toBe(false)
  })

  it('uses pickTarget (focused window) and falls back to the latest subscriber', () => {
    const a = target(1)
    const b = target(2)
    let focused: number | null = 1
    const router = new DeepLinkRouter({ pickTarget: (subs) => subs.find((s) => s.id === focused) })
    router.subscribe(a)
    router.subscribe(b)
    router.push('baren://invite/x')
    focused = null
    router.push('baren://invite/y')
    expect(a.received).toEqual(['baren://invite/x'])
    expect(b.received).toEqual(['baren://invite/y'])
  })

  it('dedupes consecutive duplicates and bounds the queue', () => {
    const router = new DeepLinkRouter({ maxQueue: 2 })
    router.push('baren://invite/a')
    router.push('baren://invite/a')
    router.push('baren://invite/b')
    router.push('baren://invite/c')
    expect(router.pending).toEqual(['baren://invite/b', 'baren://invite/c'])
  })

  it('reports deliveries (to focus the window)', () => {
    const delivered: [number, string][] = []
    const router = new DeepLinkRouter({ onDelivered: (t, url) => delivered.push([t.id, url]) })
    router.push('baren://auth/q')
    router.subscribe(target(7))
    expect(delivered).toEqual([[7, 'baren://auth/q']])
  })
})
