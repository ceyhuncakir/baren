import { Button, Input } from '@baren/ui'
import { useState, type ReactNode } from 'react'
import { errorMessage } from '../lib/api'
import { Dialog } from './Dialog'
import { FormError } from './FormError'

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  /** Destructive styling for the confirm button. */
  destructive?: boolean
  /** When set, the user must type this text to enable the confirm button. */
  confirmText?: string
  onConfirm: () => Promise<void> | void
}

/** "Are you sure?" with an optional type-to-confirm field; shows the action's error inline. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive = false,
  confirmText,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = confirmText === undefined || typed.trim() === confirmText

  const close = () => {
    if (busy) return
    setTyped('')
    setError(null)
    onClose()
  }

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      setTyped('')
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="outline" size={32} onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={destructive ? 'destructive' : 'primary'}
            size={32}
            disabled={!ready}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmText !== undefined || error ? (
        <>
          {confirmText !== undefined && (
            <Input
              variant="filled"
              size={32}
              label={
                <>
                  Type <strong>{confirmText}</strong> to confirm
                </>
              }
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              data-autofocus=""
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <FormError>{error}</FormError>
        </>
      ) : undefined}
    </Dialog>
  )
}
