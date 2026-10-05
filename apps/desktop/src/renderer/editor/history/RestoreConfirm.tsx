/**
 * "Restore this version?" for the history panel and the preview banner: explains what happens
 * (everyone's file changes, comments stay, a checkpoint is saved first, Undo works) and runs
 * the restore.
 */
import type { DocVersion } from '@baren/schema'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useCommentAuthor } from '../comments/hooks'
import { useEditor } from '../session/context'
import { versionLabel } from './model'
import { restoreToVersion } from './ops'

export function RestoreConfirm({
  version,
  onClose,
}: {
  version: DocVersion | null
  onClose: () => void
}) {
  const session = useEditor()
  const me = useCommentAuthor()
  return (
    <ConfirmDialog
      open={version !== null}
      onClose={onClose}
      title="Restore this version?"
      description={
        version
          ? `The file goes back to “${versionLabel(version)}” for everyone working on it. Comments stay as they are, the current file is saved as a version first, and you can undo the restore.`
          : ''
      }
      confirmLabel="Restore"
      onConfirm={() => {
        if (version) restoreToVersion(session, me, version)
      }}
    />
  )
}
