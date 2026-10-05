/**
 * Show a comment thread from anywhere (the Comments list, a mention toast): comment mode on, the
 * thread's page, the canvas centred on its pin, the thread open.
 */
import { getCommentThread } from '@baren/schema'
import type { EditorSession } from '../session/context'
import { centredOn, pinWorld } from './model'

/** Frames to wait for the canvas to show another page before centring anyway. */
const PAGE_WAIT_FRAMES = 60

export function revealThread(session: EditorSession, threadId: string): void {
  const thread = getCommentThread(session.doc, threadId)
  if (!thread) return
  const { store } = session
  const switching = store.getState().pageId !== thread.pageId
  store.setState({
    commentMode: true,
    openCommentId: threadId,
    ...(switching ? { pageId: thread.pageId, selection: [], hoveredId: null } : {}),
  })
  let frames = 0
  const centre = () => {
    const c = session.canvas.current
    if (!c) return
    if (c.getPageId() !== thread.pageId && frames++ < PAGE_WAIT_FRAMES) {
      requestAnimationFrame(centre)
      return
    }
    const v = c.getViewport()
    const world = pinWorld(thread, (id) => c.getNodeBounds(id))
    c.setViewport(centredOn(world, v.width, v.height, v.zoom), { animate: !switching })
  }
  if (switching) requestAnimationFrame(centre)
  else centre()
}
