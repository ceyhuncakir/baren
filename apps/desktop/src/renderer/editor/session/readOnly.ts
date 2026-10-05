/**
 * View-only editing. A viewer of a shared file can look, select, inspect, copy, follow and read
 * comments, but not change the file: the server drops a viewer's document updates (`read_only`),
 * so an edit made here would stay in this copy only and never reach anyone. While a version
 * preview covers the canvas the live file is read-only too.
 *
 * The canvas is put in its read-only mode (`CanvasArea`), edit commands and shortcuts are not
 * registered, and every other write path (panels, inspector, drops) asks `canEdit` first.
 */
import { toast } from '@baren/ui'
import { knownRole } from '../../agent/role'
import type { EditorSession } from './context'
import { useEditor, useEditorState } from './context'
import type { EditorState } from './store'

export const VIEW_ONLY_MESSAGE =
  'You can view this file but not edit it. Ask an editor of the file for edit access.'

/** The user may only view this file: their role in its room, else in its team. */
export function isViewer(
  session: EditorSession,
  s: EditorState = session.store.getState(),
): boolean {
  return (
    knownRole({
      self: s.self,
      // Test sessions may come without teams.
      teams: session.teams ?? [],
      teamId: session.file?.teamId ?? null,
      accountLoaded: s.accountLoaded,
      syncStatus: s.syncStatus,
    }) === 'viewer'
  )
}

/** The live document takes no edits from this window: a viewer, or a version preview. */
export function isReadOnly(
  session: EditorSession,
  s: EditorState = session.store.getState(),
): boolean {
  return s.previewVersionId !== null || isViewer(session, s)
}

let lastNotice = 0

/**
 * Whether the user may change the document now. A viewer is told why not (at most every few
 * seconds, so a drag over many targets shows one toast).
 */
export function canEdit(session: EditorSession): boolean {
  const s = session.store.getState()
  if (s.previewVersionId !== null) return false
  if (!isViewer(session, s)) return true
  const now = Date.now()
  if (now - lastNotice > 4_000) {
    lastNotice = now
    toast(VIEW_ONLY_MESSAGE)
  }
  return false
}

/** Re-renders when the user becomes (or stops being) a viewer of this file. */
export function useViewer(): boolean {
  const session = useEditor()
  // `session.teams` is set right before `accountLoaded`, so the selector sees it.
  return useEditorState((s) => isViewer(session, s))
}

/** Re-renders when the live document becomes (or stops being) read-only here. */
export function useReadOnly(): boolean {
  const session = useEditor()
  return useEditorState((s) => isReadOnly(session, s))
}
