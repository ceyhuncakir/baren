/**
 * Version history writes. Version-list changes commit with a `version:` origin (design undo
 * skips them); a restore commits as `editor:restore`, one ordinary undo step that syncs to
 * collaborators like any edit.
 */
import {
  createVersion,
  deleteVersion,
  getVersion,
  renameVersion,
  restoreVersion,
  transact,
  type CommentAuthor,
  type DocVersion,
} from '@baren/schema'
import { toast } from '@baren/ui'
import type { LoroDoc } from 'loro-crdt'
import type { EditorSession } from '../session/context'
import {
  RESTORE_ORIGIN,
  VERSION_ORIGIN_PREFIX,
  beforeRestoreName,
  shouldCheckpointOnOpen,
  versionLabel,
} from './model'

/** Run a version write; a failure (a collaborator deleted the version, …) becomes a toast. */
function tryWrite<T>(write: () => T): T | null {
  try {
    return write()
  } catch (error) {
    toast(error instanceof Error ? error.message : 'That did not work')
    return null
  }
}

export function saveVersion(doc: LoroDoc, author: CommentAuthor, name: string): string | null {
  return tryWrite(() =>
    transact(doc, () => createVersion(doc, { name, author, reason: 'manual' }), {
      origin: `${VERSION_ORIGIN_PREFIX}save`,
    }),
  )
}

export function nameVersion(doc: LoroDoc, id: string, name: string): boolean {
  return (
    tryWrite(() => {
      transact(doc, () => renameVersion(doc, id, name), {
        origin: `${VERSION_ORIGIN_PREFIX}rename`,
      })
      return true
    }) === true
  )
}

export function removeVersion(doc: LoroDoc, id: string): void {
  tryWrite(() =>
    transact(doc, () => deleteVersion(doc, id), { origin: `${VERSION_ORIGIN_PREFIX}delete` }),
  )
}

/**
 * Restore a version: record "Before restoring …", make the design equal to the version's (one
 * undo step), leave the preview and offer Undo. Returns false when nothing changed.
 */
export function restoreToVersion(
  session: EditorSession,
  author: CommentAuthor,
  version: DocVersion,
): boolean {
  const { doc, store } = session
  // The version may have been deleted by a collaborator since the panel rendered.
  if (!getVersion(doc, version.id)) {
    toast('That version was deleted.')
    return false
  }
  const restored = tryWrite(() => {
    transact(
      doc,
      () =>
        createVersion(doc, {
          name: beforeRestoreName(version),
          author,
          auto: true,
          reason: 'restore',
        }),
      { origin: `${VERSION_ORIGIN_PREFIX}checkpoint` },
    )
    return transact(doc, () => restoreVersion(doc, version), { origin: RESTORE_ORIGIN })
  })
  store.setState({ previewVersionId: null })
  if (restored === null) return false
  if (!restored) {
    toast('The file already matches this version.')
    return false
  }
  toast(`Restored “${versionLabel(version)}”`, {
    actionLabel: 'Undo',
    onAction: () => session.actions.undo(),
    duration: 8000,
  })
  return true
}

/** Opening a file: a checkpoint of the design as it was opened, when it changed (model.ts). */
export function checkpointOnOpen(doc: LoroDoc, author: CommentAuthor): string | null {
  if (!shouldCheckpointOnOpen(doc)) return null
  return tryWrite(() =>
    transact(doc, () => createVersion(doc, { name: '', author, auto: true, reason: 'session' }), {
      origin: `${VERSION_ORIGIN_PREFIX}checkpoint`,
    }),
  )
}
