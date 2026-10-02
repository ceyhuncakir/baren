/**
 * Saves document changes through the bridge. Every commit — local edits and imported
 * remote edits alike — marks the doc dirty; a debounced flush exports everything since
 * the last saved version as ONE Loro update and calls `bridge.files.applyUpdate`.
 *
 * Saves are serialized; a failed save keeps the old base version, so the next flush
 * re-sends the same changes (Loro imports are idempotent).
 */
import type { LoroDoc, VersionVector } from 'loro-crdt'

export interface PersistenceOptions {
  /** Quiet period before a save. */
  debounceMs?: number
  /** Upper bound on how long changes may stay unsaved while edits keep coming. */
  maxWaitMs?: number
  onError?: (error: unknown) => void
  /** Called after each successful save with the number of bytes written. */
  onSaved?: (bytes: number) => void
}

export class Persistence {
  private base: VersionVector
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstDirtyAt = 0
  private saving: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private savedAny = false
  private disposed = false

  constructor(
    private readonly doc: LoroDoc,
    private readonly save: (update: Uint8Array) => Promise<void>,
    /** Version already stored (taken right after loading, before any local change). */
    base: VersionVector,
    private readonly options: PersistenceOptions = {},
  ) {
    this.base = base
    this.unsubscribe = doc.subscribe(() => this.markDirty())
    // Changes made between load and construction (fixture seeding) count too.
    if (!this.sameVersion(base)) this.markDirty()
  }

  /** True once anything was saved in this session (the file changed). */
  get changed(): boolean {
    return this.savedAny || this.dirty
  }

  private sameVersion(v: VersionVector): boolean {
    return this.doc.oplogVersion().compare(v) === 0
  }

  private markDirty(): void {
    if (this.disposed) return
    if (!this.dirty) this.firstDirtyAt = Date.now()
    this.dirty = true
    const debounce = this.options.debounceMs ?? 400
    const maxWait = this.options.maxWaitMs ?? 2000
    const wait = Math.max(0, Math.min(debounce, this.firstDirtyAt + maxWait - Date.now()))
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, wait)
  }

  /** Save now. Resolves when everything committed so far is stored (or failed). */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.saving = this.saving.then(() => this.saveOnce())
    return this.saving
  }

  private async saveOnce(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const from = this.base
    const to = this.doc.oplogVersion()
    if (to.compare(from) === 0) return
    const update = this.doc.export({ mode: 'update', from })
    this.base = to
    try {
      await this.save(update)
      this.savedAny = true
      this.options.onSaved?.(update.byteLength)
    } catch (error) {
      // Keep the changes pending: roll the base back and retry on the next change/flush.
      this.base = from
      this.dirty = true
      this.options.onError?.(error)
    }
  }

  /** Stop listening; pending changes are flushed first. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    await this.flush()
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
