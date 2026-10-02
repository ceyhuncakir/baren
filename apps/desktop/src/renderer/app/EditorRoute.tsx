import { useCallback, useEffect } from 'react'
import { useLocation } from 'wouter'
import { signalAppReady } from '../lib/ready'
import { useFiles } from '../state/files'
import { lastHomeLocation } from './lastRoute'
import css from './App.module.css'
import { EditorScreens } from './screens'

// The editor (canvas, Loro) is the heaviest chunk: loaded on demand, warmed when idle.
const EditorScreen = EditorScreens.Component

/**
 * /file/:id — the editor workstream's EditorScreen, below the shared title bar. The shell
 * records the open for Recents, and "back" returns to the last home screen.
 */
export function EditorRoute({ fileId }: { fileId: string }) {
  const [, navigate] = useLocation()
  const status = useFiles((s) => s.status)
  const exists = useFiles((s) => s.files.some((f) => f.id === fileId))

  useEffect(() => {
    void useFiles.getState().load()
  }, [])

  useEffect(() => {
    useFiles.getState().markOpened(fileId)
  }, [fileId])

  // Cold start straight into a file (last route restored): ready once the editor chunk is in.
  useEffect(() => {
    void EditorScreens.preload().then(signalAppReady, () => undefined)
  }, [])

  // A remembered or stale link to a deleted file falls back to Recents.
  useEffect(() => {
    if (status === 'ready' && !exists) navigate(lastHomeLocation(), { replace: true })
  }, [status, exists, navigate])

  const onExit = useCallback(() => {
    void useFiles.getState().load()
    navigate(lastHomeLocation())
  }, [navigate])

  return (
    <div className={css.editor}>
      <EditorScreen key={fileId} fileId={fileId} onExit={onExit} />
    </div>
  )
}
