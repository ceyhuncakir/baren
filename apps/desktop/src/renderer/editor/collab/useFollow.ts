/**
 * Mounts the session's FollowController (`collab/follow`) for the canvas column: store
 * reactions, plus the inputs that end following without moving the camera (a click on the
 * canvas, Escape).
 */
import { useEffect, useMemo } from 'react'
import type { EditorSession } from '../session/context'
import { FollowController } from './follow'

export function useFollow(session: EditorSession): FollowController {
  const { store, tree } = session
  const follow = useMemo(
    () =>
      new FollowController(store, {
        canvas: () => session.canvas.current,
        hasPage: (id) => tree.meta(id)?.type === 'page',
      }),
    [session, store, tree],
  )

  useEffect(() => {
    const off = follow.attach()
    let el: HTMLElement | null = null
    const stop = () => follow.stop()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') follow.stop()
    }
    const listen = (following: boolean) => {
      el?.removeEventListener('pointerdown', stop, true)
      window.removeEventListener('keydown', onKey, true)
      el = null
      if (!following) return
      el = session.canvasEl.current
      el?.addEventListener('pointerdown', stop, true)
      window.addEventListener('keydown', onKey, true)
    }
    const offFollowing = store.subscribe((s, prev) => {
      if ((s.following === null) !== (prev.following === null)) listen(s.following !== null)
    })
    listen(store.getState().following !== null)
    return () => {
      offFollowing()
      listen(false)
      off()
      follow.stop()
    }
  }, [follow, session, store])

  return follow
}
