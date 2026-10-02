/**
 * Routes deep links to renderers. Links that arrive before any renderer has
 * subscribed (cold start, all windows closed on macOS, a reload in progress)
 * are queued and flushed to the first subscriber.
 */
export interface DeepLinkTarget {
  readonly id: number
  send(url: string): void
  isDestroyed(): boolean
}

export interface DeepLinkRouterOptions {
  /** Choose a recipient among live subscribers (e.g. the focused window). */
  pickTarget?: (subscribers: readonly DeepLinkTarget[]) => DeepLinkTarget | undefined
  /** Called when a link was delivered, e.g. to focus the window. */
  onDelivered?: (target: DeepLinkTarget, url: string) => void
  maxQueue?: number
}

export class DeepLinkRouter {
  private readonly queue: string[] = []
  private readonly subscribers = new Map<number, DeepLinkTarget>()
  private readonly maxQueue: number

  constructor(private readonly options: DeepLinkRouterOptions = {}) {
    this.maxQueue = options.maxQueue ?? 16
  }

  /** Deliver now if a renderer is listening, otherwise queue. */
  push(url: string): 'delivered' | 'queued' {
    const target = this.pickTarget()
    if (target) {
      this.deliver(target, url)
      return 'delivered'
    }
    if (this.queue[this.queue.length - 1] !== url) {
      this.queue.push(url)
      if (this.queue.length > this.maxQueue) this.queue.shift()
    }
    return 'queued'
  }

  subscribe(target: DeepLinkTarget): void {
    this.subscribers.set(target.id, target)
    const pending = this.queue.splice(0)
    for (const url of pending) this.deliver(target, url)
  }

  unsubscribe(id: number): void {
    this.subscribers.delete(id)
  }

  get pending(): readonly string[] {
    return this.queue
  }

  get hasSubscribers(): boolean {
    return this.live().length > 0
  }

  private live(): DeepLinkTarget[] {
    for (const [id, target] of this.subscribers) {
      if (target.isDestroyed()) this.subscribers.delete(id)
    }
    return [...this.subscribers.values()]
  }

  private pickTarget(): DeepLinkTarget | undefined {
    const live = this.live()
    if (live.length === 0) return undefined
    return this.options.pickTarget?.(live) ?? live[live.length - 1]
  }

  private deliver(target: DeepLinkTarget, url: string): void {
    target.send(url)
    this.options.onDelivered?.(target, url)
  }
}
