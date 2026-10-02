import { UndoManager, type LoroDoc } from 'loro-crdt'
import type { HistoryState } from '../types.ts'

export interface HistoryOptions {
  excludeOriginPrefixes: string[]
  getSelection: () => string[]
  restoreSelection: (ids: string[]) => void
  onChange?: (state: HistoryState) => void
}

/**
 * Loro UndoManager wrapper. Every local commit is one undo step (no time
 * based merging — the canvas commits once per gesture); text editing sessions
 * are grouped explicitly. The selection at commit time is stored with each
 * step and restored on undo/redo.
 */
export class History {
  private readonly undoManager: UndoManager
  private grouping = false
  private last: HistoryState = { canUndo: false, canRedo: false }

  constructor(
    doc: LoroDoc,
    private readonly opts: HistoryOptions,
  ) {
    this.undoManager = new UndoManager(doc, {
      mergeInterval: 0,
      maxUndoSteps: 200,
      excludeOriginPrefixes: opts.excludeOriginPrefixes,
      onPush: () => ({ value: opts.getSelection(), cursors: [] }),
      onPop: (_isUndo, meta) => {
        const v = meta.value
        if (Array.isArray(v))
          opts.restoreSelection(v.filter((x): x is string => typeof x === 'string'))
      },
    })
  }

  undo(): boolean {
    this.groupEnd()
    const ok = this.undoManager.undo()
    this.notify()
    return ok
  }

  redo(): boolean {
    this.groupEnd()
    const ok = this.undoManager.redo()
    this.notify()
    return ok
  }

  canUndo(): boolean {
    return this.undoManager.canUndo()
  }

  canRedo(): boolean {
    return this.undoManager.canRedo()
  }

  groupStart(): void {
    if (this.grouping) return
    try {
      this.undoManager.groupStart()
      this.grouping = true
    } catch {
      this.grouping = false
    }
  }

  groupEnd(): void {
    if (!this.grouping) return
    this.grouping = false
    try {
      this.undoManager.groupEnd()
    } catch {
      // A remote import may already have closed the group.
    }
  }

  /** Emit `onChange` if can-undo/can-redo changed. */
  notify(): void {
    const next = { canUndo: this.undoManager.canUndo(), canRedo: this.undoManager.canRedo() }
    if (next.canUndo !== this.last.canUndo || next.canRedo !== this.last.canRedo) {
      this.last = next
      this.opts.onChange?.(next)
    }
  }

  dispose(): void {
    this.groupEnd()
    this.undoManager.free()
  }
}
