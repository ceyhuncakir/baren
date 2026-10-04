/**
 * When an open file's thumbnail (its Home card preview) is written. Not only on close: a file
 * left open when the app quits, or edited by an agent in a hidden window, would keep an old
 * preview or none. So it is written once saves have been quiet for a few seconds, then on close
 * if edits came after that — or if the file has no thumbnail yet (a team file pulled before,
 * an older file). Writes never overlap. Pure scheduling: rendering is `save` (thumbnail.ts).
 */

/** Quiet time after the last save before the thumbnail is written. */
export const THUMBNAIL_SETTLE_MS = 4000

export interface ThumbnailWriterDeps {
  /** Render and store the thumbnail. */
  save(): Promise<unknown>
  /** Whether the file has a stored thumbnail. */
  has(): Promise<boolean>
  settleMs?: number
}

export class ThumbnailWriter {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Saves since the last write. */
  private behind = false
  private writing: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly deps: ThumbnailWriterDeps) {}

  /** A save landed: write once saves have been quiet for a while. */
  saved(): void {
    if (this.closed) return
    this.behind = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, this.deps.settleMs ?? THUMBNAIL_SETTLE_MS)
  }

  /** The file is closing (its last save done): write now if behind, or if there is none. */
  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.writing
    if (this.behind || !(await this.deps.has().catch(() => true))) await this.write()
  }

  private write(): Promise<void> {
    this.behind = false
    this.writing = this.writing
      .then(() => this.deps.save())
      .then(
        () => undefined,
        () => undefined,
      )
    return this.writing
  }
}
