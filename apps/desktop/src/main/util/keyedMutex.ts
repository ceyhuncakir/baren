/**
 * Serialises async work per key (e.g. per file id) while different keys run
 * concurrently. A failing task does not block the ones queued after it.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }

  /** Resolves when every task queued so far has settled. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()])
  }
}
