/**
 * The headless host (contract §11.3): a hidden window main opens at `#/agent-host/<fileId>` when
 * an agent works on a file no visible window has open. It opens the file with the normal
 * session code (`openSession(…, { headless: true })`, which attaches the agent host), mounts a
 * real canvas in a 1440×900 box (undo history, geometry fallbacks) and joins live sync for
 * shared files, so agent edits reach collaborators and persist like any other edit. No app
 * shell, no preferences, no update checks. Main's `release` request closes the session.
 */
import { createCanvas } from '@baren/canvas'
import { useEffect, useRef, useState } from 'react'
import { resolveCanvasAsset } from '../../lib/assets'
import { useCollaboration } from '../../editor/collab/useCollaboration'
import { ensureDesignFonts } from '../../editor/lib/fonts'
import { PREVIEW_ORIGIN_PREFIX } from '../../editor/model/previewEdits'
import type { EditorSession } from '../../editor/session/context'
import { openSession, type SessionHandle } from '../../editor/session/openSession'

/** Not undoable, as in the editor's canvas (CanvasArea's UNDO_EXCLUDE). */
const UNDO_EXCLUDE = ['remote', 'sync', 'bench', 'fixture', PREVIEW_ORIGIN_PREFIX, 'derived']

function HeadlessCanvas({ session }: { session: EditorSession }) {
  useCollaboration(session)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const canvas = createCanvas({
      container: el,
      doc: session.doc,
      pageId: session.store.getState().pageId,
      resolveAsset: resolveCanvasAsset,
      keyboard: 'none',
      undo: true,
      undoExcludeOriginPrefixes: UNDO_EXCLUDE,
    })
    session.canvas.current = canvas
    session.canvasEl.current = el
    return () => {
      if (session.canvas.current === canvas) session.canvas.current = null
      session.canvasEl.current = null
      canvas.destroy()
    }
  }, [session])
  return (
    <div
      ref={ref}
      data-testid="agent-headless-canvas"
      style={{ position: 'fixed', left: 0, top: 0, width: 1440, height: 900, overflow: 'hidden' }}
    />
  )
}

export function HeadlessHost({ fileId }: { fileId: string }) {
  const [session, setSession] = useState<EditorSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    let handle: SessionHandle | null = null
    void ensureDesignFonts()
    openSession(fileId, () => undefined, { headless: true }).then(
      (h) => {
        if (disposed) {
          void h.close()
          return
        }
        handle = h
        setSession(h.session)
      },
      (e: unknown) => {
        console.error('[agent] headless host could not open the file', e)
        if (!disposed) setError(e instanceof Error ? e.message : 'The file could not be opened.')
      },
    )
    const flush = () => void handle?.session.persistence.flush()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      disposed = true
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      void handle?.close()
    }
  }, [fileId])
  if (error !== null) return <div data-testid="agent-headless-error">{error}</div>
  return session ? <HeadlessCanvas session={session} /> : null
}
