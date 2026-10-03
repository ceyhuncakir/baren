/**
 * Editor entry point (artboards 04–08, 14–16). `EditorScreen` opens the file through the
 * desktop bridge, then renders the editor below the app's title bar:
 *
 *   left panel (pages, layers / theme tokens) · tool rail · canvas · inspector
 *
 * Document state lives in Loro; React only renders panels from narrow subscriptions.
 */
import * as schema from '@baren/schema'
import { getTokens, toSnapshot } from '@baren/schema'
import { Button } from '@baren/ui'
import { useEffect, useRef, useState } from 'react'
import { onReveal } from '../state/fileLinks'
import { EditorLayout } from './EditorLayout'
import { EditorProvider, type EditorSession } from './session/context'
import { openSession, type SessionHandle } from './session/openSession'
import css from './Editor.module.css'

export interface EditorScreenProps {
  fileId: string
  onExit(): void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; session: EditorSession }
  | { status: 'error'; message: string }

export function EditorScreen({ fileId, onExit }: EditorScreenProps) {
  const exitRef = useRef(onExit)
  exitRef.current = onExit
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let disposed = false
    let handle: SessionHandle | null = null
    setState({ status: 'loading' })
    openSession(fileId, () => exitRef.current()).then(
      (h) => {
        if (disposed) {
          void h.close()
          return
        }
        handle = h
        setState({ status: 'ready', session: h.session })
        if (h.session.fixture.enabled || wantsTestHook()) exposeTestHook(h.session)
      },
      (error: unknown) => {
        if (!disposed) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'The file could not be opened.',
          })
        }
      },
    )
    // Save before the window goes away (reload, close, app quit).
    const flush = () => void handle?.session.persistence.flush()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      void handle?.close()
    }
  }, [fileId])

  // Layer links ("Copy link to selection"): select and zoom to the layer.
  const session = state.status === 'ready' ? state.session : null
  useEffect(() => {
    if (!session) return
    return onReveal(fileId, (nodeId) => revealWhenReady(session, nodeId))
  }, [session, fileId])

  if (state.status === 'error') {
    return (
      <div className={css.status} role="alert">
        <div className={css.statusBox}>
          <span>{state.message}</span>
          <Button variant="outline" size={30} onClick={() => exitRef.current()}>
            Back to files
          </Button>
        </div>
      </div>
    )
  }
  if (state.status === 'loading') return <div className={css.editor} data-testid="editor-loading" />
  return (
    <EditorProvider session={state.session}>
      <EditorLayout />
    </EditorProvider>
  )
}

/** `actions.reveal` once the canvas has mounted and laid the page out (≈5 s at most). */
function revealWhenReady(session: EditorSession, nodeId: string, frames = 300): void {
  const canvas = session.canvas.current
  if (canvas && canvas.getStats().pendingWork === 0) session.actions.reveal(nodeId)
  else if (frames > 0) requestAnimationFrame(() => revealWhenReady(session, nodeId, frames - 1))
}

/**
 * Browser mode (mock bridge) with `?editorTestHook=1`: the hook without fixture data, for the
 * two-client tests against a real server. Never inside Electron.
 */
function wantsTestHook(): boolean {
  if (typeof window === 'undefined' || window.baren !== undefined) return false
  try {
    return new URLSearchParams(window.location.search).get('editorTestHook') === '1'
  } catch {
    return false
  }
}

/** Fixture mode (or `editorTestHook`): lets tests drive the canvas deterministically. */
function exposeTestHook(session: EditorSession): void {
  ;(window as unknown as { __barenEditor?: unknown }).__barenEditor = {
    session,
    get canvas() {
      return session.canvas.current
    },
    snapshot: () => toSnapshot(session.doc),
    tokens: () => getTokens(session.doc),
    /** The schema helpers, so behaviour tests can build documents in the page. */
    schema,
  }
}
