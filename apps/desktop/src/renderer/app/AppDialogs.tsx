import { Button, Input, Kbd, toast } from '@baren/ui'
import { lazy, Suspense, useState } from 'react'
import { Dialog } from '../components/Dialog'
import { FormError } from '../components/FormError'
import { api, errorMessage } from '../lib/api'
import { bridge } from '../lib/bridge'
import { formatShortcut } from '../lib/shortcuts'
import { useCurrentTeam, useSession } from '../state/session'
import { useUi } from '../state/ui'
import css from './App.module.css'
import { SHORTCUTS } from './menuModel'
import { InviteDialogScreen, PreferencesDialogScreen } from './screens'

const InviteDialog = InviteDialogScreen.Component
const PreferencesDialogs = PreferencesDialogScreen.Component
/** Connect your agent (34): its own small chunk, loaded when first opened. */
const McpConnectDialog = lazy(() => import('./McpConnectDialog'))

function CreateTeamDialog({ onClose }: { onClose: () => void }) {
  const user = useSession((s) => s.user)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const team = await api.teams.create(trimmed)
      useSession.getState().upsertTeam(team)
      useSession.getState().setCurrentTeam(team.id)
      toast(`Created ${team.name}`)
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
      title="Create team"
      description="Teams share files and invite links. You can rename it later."
      onSubmit={() => void create()}
      footer={
        <>
          <Button variant="outline" size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size={32} loading={busy} disabled={!name.trim()}>
            Create team
          </Button>
        </>
      }
    >
      <Input
        variant="filled"
        size={32}
        label="Team name"
        placeholder={user ? `${user.name.split(' ')[0] ?? user.name}'s Team` : 'Team name'}
        value={name}
        maxLength={80}
        data-autofocus=""
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <FormError>{error}</FormError>
    </Dialog>
  )
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Keyboard shortcuts" width={420}>
      <ul className={css.shortcutList}>
        {SHORTCUTS.filter((s) => s.shortcut !== 'Backspace' && s.shortcut !== 'Mod+Y').map((s) => (
          <li key={s.shortcut} className={css.shortcutRow}>
            <span>{s.label}</span>
            <Kbd>{formatShortcut(s.shortcut, bridge.platform)}</Kbd>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

/** App-wide dialogs opened from the sidebar, account menu or shortcuts. */
export function AppDialogs() {
  const dialog = useUi((s) => s.dialog)
  const close = useUi((s) => s.closeDialog)
  const team = useCurrentTeam()
  switch (dialog?.kind) {
    case 'invite':
      return team ? <InviteDialog team={team} onClose={close} /> : null
    case 'createTeam':
      return <CreateTeamDialog onClose={close} />
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />
    case 'preferences':
    case 'changePassword':
      return <PreferencesDialogs kind={dialog.kind} onClose={close} />
    case 'mcp':
      return (
        <Suspense fallback={null}>
          <McpConnectDialog onClose={close} />
        </Suspense>
      )
    default:
      return null
  }
}
