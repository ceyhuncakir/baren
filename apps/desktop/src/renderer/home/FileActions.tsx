import { Button, ContextMenu, Input, MenuItem, MenuSeparator, toast } from '@baren/ui'
import { useState } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Dialog } from '../components/Dialog'
import { FormError } from '../components/FormError'
import { errorMessage } from '../lib/api'
import { useFiles } from '../state/files'
import type { FileMeta } from '../types/bridge'

export interface FileMenuState {
  fileId: string
  x: number
  y: number
}

type Pending = { kind: 'rename'; file: FileMeta } | { kind: 'delete'; file: FileMeta } | null

function RenameDialog({ file, onClose }: { file: FileMeta; onClose: () => void }) {
  const [name, setName] = useState(file.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const next = name.trim()
    if (!next || next === file.name) return onClose()
    setBusy(true)
    try {
      await useFiles.getState().rename(file.id, next)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename file"
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="outline" size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size={32} loading={busy} disabled={!name.trim()}>
            Rename
          </Button>
        </>
      }
    >
      <Input
        variant="filled"
        size={32}
        aria-label="File name"
        value={name}
        maxLength={256}
        onChange={(e) => setName(e.currentTarget.value)}
        onFocus={(e) => e.currentTarget.select()}
        data-autofocus=""
      />
      <FormError>{error}</FormError>
    </Dialog>
  )
}

/**
 * The file card context menu (open, rename, archive, delete) and the dialogs it opens.
 * One instance per screen, positioned at the cursor.
 */
export function FileActions({
  menu,
  onCloseMenu,
  onOpen,
  scratchpadId,
}: {
  menu: FileMenuState | null
  onCloseMenu: () => void
  onOpen: (fileId: string) => void
  scratchpadId: string | null
}) {
  const [pending, setPending] = useState<Pending>(null)
  const file = useFiles((s) => (menu ? s.files.find((f) => f.id === menu.fileId) : undefined))
  const isScratchpad = file !== undefined && file.id === scratchpadId

  const setArchived = async (target: FileMeta, archived: boolean) => {
    try {
      await useFiles.getState().setArchived(target.id, archived)
      toast(archived ? `Moved “${target.name}” to Archive` : `Restored “${target.name}”`, {
        actionLabel: 'Undo',
        onAction: () => void useFiles.getState().setArchived(target.id, !archived),
      })
    } catch (e) {
      toast(errorMessage(e))
    }
  }

  return (
    <>
      <ContextMenu
        open={menu !== null && file !== undefined}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={onCloseMenu}
        aria-label="File actions"
      >
        {file && (
          <>
            <MenuItem onSelect={() => onOpen(file.id)}>Open</MenuItem>
            <MenuItem onSelect={() => setPending({ kind: 'rename', file })}>Rename…</MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={isScratchpad}
              onSelect={() => void setArchived(file, !file.archived)}
            >
              {file.archived ? 'Restore from Archive' : 'Move to Archive'}
            </MenuItem>
            <MenuItem
              destructive
              disabled={isScratchpad}
              onSelect={() => setPending({ kind: 'delete', file })}
            >
              Delete…
            </MenuItem>
          </>
        )}
      </ContextMenu>
      {pending?.kind === 'rename' && (
        <RenameDialog file={pending.file} onClose={() => setPending(null)} />
      )}
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onClose={() => setPending(null)}
        title="Delete file?"
        description={
          pending?.kind === 'delete'
            ? `“${pending.file.name}” will be deleted from this device. This can't be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (pending?.kind === 'delete') await useFiles.getState().remove(pending.file.id)
        }}
      />
    </>
  )
}
