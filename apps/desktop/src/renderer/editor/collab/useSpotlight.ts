/**
 * Mounts the session's SpotlightController (`collab/spotlight`) and relays this client's
 * `spotlight` and `following` to collaborators through presence.
 */
import { toast } from '@baren/ui'
import { useEffect } from 'react'
import type { EditorSession } from '../session/context'
import { SpotlightController, stopSpotlight } from './spotlight'

export function useSpotlight(session: EditorSession): void {
  const { store, presence } = session
  useEffect(() => {
    const spotlight = new SpotlightController(store, {
      selfUserId: () => {
        const s = store.getState()
        return s.self?.userId ?? s.identity?.userId ?? null
      },
      notify: (message) => void toast(message),
    })
    const off = spotlight.attach()
    const relay = () => {
      const s = store.getState()
      presence.setSpotlight(s.spotlight)
      presence.setFollowing(s.following)
    }
    relay()
    const offRelay = store.subscribe((s, prev) => {
      if (s.spotlight !== prev.spotlight || s.following !== prev.following) relay()
    })
    return () => {
      offRelay()
      off()
      spotlight.detach()
      // Leaving the file ends this user's spotlight.
      stopSpotlight(store)
    }
  }, [store, presence])
}
