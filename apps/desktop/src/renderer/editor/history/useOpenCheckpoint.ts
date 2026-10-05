/**
 * Once per opened file: record a checkpoint of the design as it was opened, when it changed
 * since the newest version (`checkpointOnOpen`). Waits for the account (the author) and, in a
 * shared file, for the first sync (so the checkpoint has collaborators' latest edits), at most
 * SYNC_WAIT_MS. Viewers record nothing (the server refuses their changes); fixtures neither.
 */
import { useEffect } from 'react'
import type { EditorSession } from '../session/context'
import { isViewer } from '../session/readOnly'
import { commentAuthor } from '../comments/model'
import { checkpointOnOpen } from './ops'

const SYNC_WAIT_MS = 8_000

export function useOpenCheckpoint(session: EditorSession): void {
  useEffect(() => {
    if (session.fixture.enabled || session.headless) return
    const { store } = session
    let done = false
    const started = Date.now()
    const tryRun = () => {
      if (done) return
      const s = store.getState()
      if (!s.accountLoaded) return
      const shared = s.remoteId !== null && s.identity !== null
      const waited = Date.now() - started >= SYNC_WAIT_MS
      if (shared && s.syncStatus !== 'synced' && !waited) return
      done = true
      if (isViewer(session, s)) return
      checkpointOnOpen(session.doc, commentAuthor(s.identity))
    }
    const off = store.subscribe(tryRun)
    const timer = setTimeout(tryRun, SYNC_WAIT_MS)
    tryRun()
    return () => {
      done = true
      off()
      clearTimeout(timer)
    }
  }, [session])
}
