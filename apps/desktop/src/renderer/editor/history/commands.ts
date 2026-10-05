/**
 * Opening and closing version history and its preview. History and comment mode share the
 * inspector, so opening one closes the other; closing history leaves any preview.
 */
import type { EditorSession } from '../session/context'

export function toggleHistory(session: EditorSession): void {
  const s = session.store.getState()
  if (s.historyOpen) {
    closeHistory(session)
    return
  }
  session.store.setState({ historyOpen: true, commentMode: false, openCommentId: null })
}

export function closeHistory(session: EditorSession): void {
  session.store.setState({ historyOpen: false, previewVersionId: null })
}

/** Show a version read-only on the canvas (null: back to the live file). */
export function previewVersion(session: EditorSession, id: string | null): void {
  session.store.setState({ previewVersionId: id, ...(id !== null ? { historyOpen: true } : {}) })
}
