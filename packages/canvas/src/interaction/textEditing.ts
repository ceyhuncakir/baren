import type { LoroDoc } from 'loro-crdt'
import type { History } from '../doc/history.ts'
import type { SceneManager } from '../render/sceneManager.ts'
import { TextEditSession, type CaretPlacement, type TextIO } from './textEdit.ts'

export interface TextEditingHost {
  readonly doc: LoroDoc
  readonly history: History | null
  /** Text reads/writes (virtual ids write instance overrides). */
  readonly io: TextIO
  /** Whether a (real or virtual) node exists. */
  exists(id: string): boolean
  scenes(): SceneManager
  isReadOnly(): boolean
  setSelection(ids: readonly string[]): void
  undo(): void
  redo(): void
  focus(): void
  /** Redraw the overlay (editing outline). */
  invalidate(): void
  onChange(id: string | null): void
}

/** Max frames to wait for a new text node's element before giving up. */
const MAX_WAIT_FRAMES = 30

/**
 * Owns the in-place text editing lifecycle: waits for the node's element to
 * exist (it may be created this frame), keeps its artboard live (pinned)
 * while editing, and ends sessions cleanly.
 */
export class TextEditing {
  private session: TextEditSession | null = null
  private sessionTop: string | null = null
  private pending: { id: string; caret: CaretPlacement; created: boolean; frames: number } | null =
    null

  constructor(private readonly host: TextEditingHost) {}

  get id(): string | null {
    return this.session?.id ?? null
  }

  get element(): HTMLElement | null {
    return this.session?.el ?? null
  }

  get active(): boolean {
    return this.session !== null
  }

  get hasPending(): boolean {
    return this.pending !== null
  }

  isEditing(id: string): boolean {
    return this.session?.id === id
  }

  /** Start editing an existing text node. */
  edit(id: string, caret: CaretPlacement = { kind: 'all' }): void {
    if (this.host.isReadOnly()) return
    const info = this.host.scenes().info(id)
    if (!info || info.type !== 'text' || info.locked) return
    this.stop()
    this.host.setSelection([id])
    this.whenReady(id, caret, false)
  }

  /** Edit `id` as soon as its element is rendered (a just-created node). */
  whenReady(id: string, caret: CaretPlacement, created: boolean): void {
    this.pending = { id, caret, created, frames: 0 }
    const top = this.host.scenes().topLevelOf(id)
    if (top) this.host.scenes().pin(top)
  }

  /** Called in the frame's write phase after document changes were applied. */
  tick(): void {
    const pe = this.pending
    if (!pe) return
    const scenes = this.host.scenes()
    const el = scenes.elementOf(pe.id)
    if (!(el instanceof HTMLElement) || !el.isConnected) {
      if (++pe.frames > MAX_WAIT_FRAMES || !this.host.exists(pe.id)) this.dropPending()
      return
    }
    this.pending = null
    this.sessionTop = scenes.topLevelOf(pe.id)
    const session = new TextEditSession(
      {
        doc: this.host.doc,
        history: this.host.history,
        io: this.host.io,
        undo: () => this.host.undo(),
        redo: () => this.host.redo(),
        onEnd: () => {
          if (this.session === session) this.session = null
          if (this.sessionTop) this.host.scenes().unpin(this.sessionTop)
          this.sessionTop = null
          this.host.invalidate()
          // Keep keyboard shortcuts working after Escape ends the session.
          this.host.focus()
          this.host.onChange(null)
        },
      },
      pe.id,
      el,
      pe.created,
    )
    this.session = session
    session.start(pe.caret)
    this.host.invalidate()
    this.host.onChange(pe.id)
  }

  private dropPending(): void {
    const pe = this.pending
    if (!pe) return
    this.pending = null
    const top = this.host.scenes().topLevelOf(pe.id)
    if (top) this.host.scenes().unpin(top)
    if (pe.created) this.host.history?.groupEnd()
  }

  /** A text change that did not come from the active session (remote, undo). */
  applyExternal(id: string, text: string): void {
    if (this.session?.id === id) this.session.applyExternal(text)
  }

  /** End editing if the edited node disappeared. */
  validate(): void {
    if (this.session && !this.host.exists(this.session.id)) this.stop()
  }

  stop(): void {
    this.dropPending()
    const s = this.session
    if (!s) return
    s.end()
    this.session = null
    this.host.focus()
  }
}
