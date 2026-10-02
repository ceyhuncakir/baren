import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger } from '../log'
import { readJsonOrNull, writeFileAtomic } from '../util/fs'
import { parseWindowState, type WindowState } from './windowState'

/**
 * Persists the last window geometry to `window-state.json` in userData.
 * Saves are debounced (move/resize fire continuously) and written
 * asynchronously; `flushSync` covers the final write at quit.
 */
export class WindowStateStore {
  private pending: WindowState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly log: Logger,
    private readonly debounceMs = 400,
  ) {}

  async load(): Promise<WindowState | null> {
    try {
      return parseWindowState(await readJsonOrNull(this.file))
    } catch (error) {
      this.log.warn('ignoring unreadable window state', { file: this.file, error: String(error) })
      return null
    }
  }

  save(state: WindowState): void {
    this.pending = state
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /** Write the pending state now (async). Resolves when it is on disk. */
  flush(): Promise<void> {
    this.clearTimer()
    const state = this.pending
    this.pending = null
    if (state !== null) {
      this.writing = this.writing
        .then(async () => {
          await mkdir(dirname(this.file), { recursive: true })
          await writeFileAtomic(this.file, JSON.stringify(state))
        })
        .catch((error: unknown) => this.log.warn('failed to save window state', String(error)))
    }
    return this.writing
  }

  /** Final synchronous write at quit, when async work may not get to run. */
  flushSync(): void {
    this.clearTimer()
    const state = this.pending
    this.pending = null
    if (state === null) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(state))
    } catch (error) {
      this.log.warn('failed to save window state', String(error))
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
