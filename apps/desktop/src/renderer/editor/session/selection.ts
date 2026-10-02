/**
 * Selection and hover are owned by the canvas controller (it validates ids and draws
 * them); the store mirrors them through the canvas callbacks. These helpers route UI
 * requests (layers panel, menus) through the controller when it exists.
 */
import type { EditorSession } from './context'
import { sameIds } from './store'

export function selectIds(session: EditorSession, ids: readonly string[]): void {
  const canvas = session.canvas.current
  if (canvas) {
    canvas.select(ids)
    return
  }
  const current = session.store.getState().selection
  if (!sameIds(current, ids)) session.store.setState({ selection: [...ids] })
}

/** Highlight a node on the canvas with the hover outline (layer row hover). */
export function hoverId(session: EditorSession, id: string | null): void {
  const canvas = session.canvas.current
  if (canvas) canvas.setHover(id)
  else if (session.store.getState().hoveredId !== id) session.store.setState({ hoveredId: id })
}
