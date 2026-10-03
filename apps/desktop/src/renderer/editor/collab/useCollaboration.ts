/**
 * Loads the signed-in identity and, when the file lives on the server (`remoteId`),
 * keeps the document in a live room with @baren/sync-client: remote edits arrive as
 * Loro imports (the canvas, layers and inspector update through their normal event
 * paths), presence drives remote cursors/selections and the inspector avatars.
 *
 * MCP agents (Phase 4 contract §10.2): the canvas shows people and agents together
 * (`toRemotePresence(peers)` + `agentPresences(agents)`); peers' relayed agents feed
 * `session.agents`, and the agents connected to this app are relayed to collaborators.
 */
import { docAssetRefs } from '@baren/schema'
import type { FileConnection } from '@baren/sync-client'
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { bridge } from '../../lib/bridge'
import { SERVER_URL } from '../lib/env'
import type { EditorSession } from '../session/context'
import { toWireAgents } from '../../agent/presence'
import { api, autoShareOnOpen, loadIdentity } from './account'
import { assetApiOf } from './assetSync'
import { agentPresences, toRemotePresence } from './presence'

/**
 * Canvas presence: remote people, then agents (local and relayed). A headless host's canvas is
 * never seen, so it gets no agent entries: their working-edge sweep would keep its overlay
 * redrawing at up to 30 fps for nothing.
 */
function pushPresence(session: EditorSession): boolean {
  const canvas = session.canvas.current
  if (!canvas) return false
  canvas.setRemotePresence([
    ...toRemotePresence(session.store.getState().peers),
    ...(session.headless ? [] : agentPresences(session.agents.get())),
  ])
  return true
}

/** How long agent presence waits for the canvas to mount before giving up. */
const CANVAS_WAIT_MS = 15_000

export function useCollaboration(session: EditorSession): void {
  const { store } = session
  // Set at open from FileMeta, or later when the file is shared to a team (on open, or from
  // the SharePopover).
  const remoteId = useStore(store, (s) => s.remoteId)

  useEffect(() => {
    let cancelled = false
    let connection: FileConnection | null = null

    void (async () => {
      const account = await loadIdentity(session.fixture).catch(() => null)
      if (cancelled) return
      session.teams = account?.teams ?? []
      store.setState({ identity: account?.identity ?? null })
      if (!account || session.fixture.enabled) return
      if (!remoteId) {
        // Not in a team yet: share it into the current one (this effect then runs again).
        void autoShareOnOpen(session, account.teams).catch((error: unknown) =>
          console.warn('[share]', error),
        )
        return
      }
      const { connectFile } = await import('@baren/sync-client')
      if (cancelled) return
      connection = connectFile({
        baseUrl: SERVER_URL,
        token: () => bridge.auth.getToken(),
        fileId: remoteId,
        doc: session.doc,
        onStatus: (status) => store.setState({ syncStatus: status }),
        onWelcome: (self) => store.setState({ self }),
        onPresence: (peers) => {
          store.setState({ peers })
          session.agents.setRemote(peers)
          pushPresence(session)
        },
      })
      const conn = connection
      session.presence.attach({ setPresence: (p) => conn.setPresence(p) })
      session.presence.setPage(store.getState().pageId)
      // Assets: upload what the server lacks, download what this machine lacks, then
      // follow every new reference (AssetSync listens to the doc's change batches).
      const assetApi = assetApiOf(api())
      if (assetApi) {
        void session.assets.attach({ fileId: remoteId, api: assetApi }, docAssetRefs(session.doc))
      } else {
        console.warn('[assets] the sync client has no asset endpoints; images will not sync')
      }
    })()

    const offPage = store.subscribe((s, prev) => {
      if (s.pageId !== prev.pageId) session.presence.setPage(s.pageId)
    })

    const onOnline = () => connection?.reconnectNow()
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      offPage()
      window.removeEventListener('online', onOnline)
      session.presence.attach(null)
      void session.assets.attach(null)
      connection?.disconnect()
      store.setState({ peers: [], self: null, syncStatus: 'local' })
      session.agents.setRemote([])
    }
  }, [session, store, remoteId])

  // Agents: canvas badges for local and remote agents, relay of the local ones.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const started = Date.now()
    const push = () => {
      if (pushPresence(session) || Date.now() - started > CANVAS_WAIT_MS) return
      // The canvas mounts after the session opens: retry until it is there.
      if (timer === null && session.agents.get().length > 0) {
        timer = setTimeout(() => {
          timer = null
          push()
        }, 100)
      }
    }
    const off = session.agents.subscribe(() => {
      push()
      session.presence.setAgents(toWireAgents(session.agents.getLocal()))
    })
    push()
    session.presence.setAgents(toWireAgents(session.agents.getLocal()))
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [session])
}
