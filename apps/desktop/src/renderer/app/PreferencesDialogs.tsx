/**
 * Preferences (Account menu → Preferences, Ctrl+,) and Change password. Lazily loaded with
 * the other app dialogs that are not needed at startup.
 */
import { isApiError } from '@baren/sync-client/api'
import {
  Button,
  Field,
  Input,
  isAcceptablePassword,
  PasswordStrength,
  Switch,
  toast,
} from '@baren/ui'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Dialog } from '../components/Dialog'
import { FormError } from '../components/FormError'
import { api, errorMessage } from '../lib/api'
import { startAgentRuns, useAgentRuns, useAgentRunnerStatus } from '../state/agentRuns'
import { useMcp, useMcpStatus } from '../state/mcp'
import { useSession } from '../state/session'
import { useUi } from '../state/ui'
import { updateMenuItem, useUpdates } from '../state/updates'
import { runAppAction } from './actions'
import { ThemeControl } from './ThemeControl'
import css from './Preferences.module.css'

function Row({
  label,
  detail,
  children,
}: {
  label: string
  detail?: string | undefined
  children: ReactNode
}) {
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.rowLabel}>{label}</div>
        {detail && <div className={css.rowDetail}>{detail}</div>}
      </div>
      {children}
    </div>
  )
}

/** "MCP server": the Switch and "Agent settings…" (opens Connect your agent, 34). */
function McpRow() {
  const status = useMcpStatus()
  const switching = useMcp((s) => s.switching)
  const setEnabled = useMcp((s) => s.setEnabled)
  const on = status ? status.enabled && status.state !== 'off' : false
  let detail = on ? 'On · Only apps on this computer can connect' : "Off · Agents can't connect"
  if (status?.state === 'error') detail = `Error · ${status.error ?? "Couldn't start"}`
  return (
    <Row label="MCP server" detail={status ? detail : undefined}>
      <span className={css.controls}>
        <Button
          variant="link-muted"
          size={28}
          textSize={12}
          onClick={() => useUi.getState().openDialog({ kind: 'mcp' })}
        >
          Agent settings…
        </Button>
        <Switch
          checked={on}
          label="MCP server"
          disabled={switching || status === null}
          onCheckedChange={(next) =>
            void setEnabled(next).catch((error: unknown) => toast(errorMessage(error)))
          }
        />
      </span>
    </Row>
  )
}

/**
 * "Comment requests": a comment that @mentions Claude Code runs it in the background on this
 * computer (`main/agentRuns`). Needs the `claude` CLI; the detail shows where it was found.
 */
function AgentRunsRow() {
  const status = useAgentRunnerStatus()
  const switching = useAgentRuns((s) => s.switching)
  const setEnabled = useAgentRuns((s) => s.setEnabled)
  // Look for `claude` again each time Preferences opens (it may have been installed meanwhile).
  useEffect(() => startAgentRuns(true), [])
  const installed = status?.claudePath != null
  const on = installed && status?.enabled === true
  let detail = "Claude Code isn't installed on this computer"
  if (installed) {
    detail = on
      ? `On · @Claude Code in your comments runs ${status?.claudePath ?? 'claude'}`
      : 'Off · Mentions of Claude Code stay plain mentions'
  }
  return (
    <Row label="Comment requests" detail={status ? detail : undefined}>
      <Switch
        checked={on}
        label="Comment requests to Claude Code"
        disabled={!installed || switching}
        onCheckedChange={(next) =>
          void setEnabled(next).catch((error: unknown) => toast(errorMessage(error)))
        }
      />
    </Row>
  )
}

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const signedIn = useSession((s) => s.status === 'signedIn' && s.user !== null)
  const email = useSession((s) => s.user?.email ?? null)
  const version = useUpdates((s) => s.appVersion)
  const status = useUpdates((s) => s.status)
  const update = updateMenuItem(status)

  return (
    <Dialog open onClose={onClose} title="Preferences" width={440}>
      <div className={css.rows}>
        <Row label="Theme" detail="Applies to every window. Designs keep their own colours.">
          <ThemeControl size={24} textSize={12} />
        </Row>
        {signedIn && (
          <Row label="Password" detail={email ?? undefined}>
            <Button
              variant="outline"
              size={28}
              onClick={() => useUi.getState().openDialog({ kind: 'changePassword' })}
            >
              Change password…
            </Button>
          </Row>
        )}
        <McpRow />
        <AgentRunsRow />
        <Row label="Version" detail={version ? `Baren ${version}` : undefined}>
          <Button
            variant="outline"
            size={28}
            disabled={!update.enabled}
            onClick={() => {
              onClose()
              runAppAction('app.checkForUpdates')
            }}
          >
            {update.installs ? 'Restart to update' : 'Check for updates'}
          </Button>
        </Row>
      </div>
    </Dialog>
  )
}

type PasswordErrors = { current?: string; next?: string; form?: string }

function changePasswordError(error: unknown): PasswordErrors {
  if (isApiError(error)) {
    switch (error.code) {
      case 'current_password_required':
        return { current: 'Enter your current password.' }
      case 'invalid_credentials':
        return { current: "That's not your current password." }
      case 'weak_password':
        return { next: 'Use at least 8 characters, including a number.' }
      case 'rate_limited':
        return { form: 'Too many attempts. Wait a moment and try again.' }
    }
  }
  return { form: errorMessage(error) }
}

/** Account → Preferences → Change password: keeps this session, signs out the others. */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const nextId = useId()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [errors, setErrors] = useState<PasswordErrors>({})
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    const found: PasswordErrors = {}
    if (!current) found.current = 'Enter your current password.'
    if (!isAcceptablePassword(next)) found.next = 'Use at least 8 characters, including a number.'
    else if (next === current) found.next = 'Choose a password you are not using now.'
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    try {
      await api.changePassword({ currentPassword: current, newPassword: next })
      toast('Password changed. Your other devices were signed out.')
      onClose()
    } catch (error) {
      setErrors(changePasswordError(error))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Change password"
      description="You stay signed in here; other devices are signed out."
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="outline" size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size={32} loading={busy}>
            Change password
          </Button>
        </>
      }
    >
      <Input
        size={32}
        label="Current password"
        name="current-password"
        autoComplete="current-password"
        revealable
        data-autofocus=""
        value={current}
        error={errors.current}
        onChange={(e) => setCurrent(e.currentTarget.value)}
      />
      <Field label="New password" htmlFor={nextId} error={errors.next}>
        <Input
          id={nextId}
          size={32}
          name="new-password"
          autoComplete="new-password"
          revealable
          value={next}
          error={errors.next !== undefined}
          onChange={(e) => setNext(e.currentTarget.value)}
        />
        <PasswordStrength password={next} />
        {errors.next === undefined && (
          <div className={css.hint}>At least 8 characters, including a number.</div>
        )}
      </Field>
      <FormError>{errors.form}</FormError>
    </Dialog>
  )
}

/** Both dialogs, keyed by the UI store's dialog kind (one lazy chunk). */
export default function PreferencesDialogs({
  kind,
  onClose,
}: {
  kind: 'preferences' | 'changePassword'
  onClose: () => void
}) {
  return kind === 'preferences' ? (
    <PreferencesDialog onClose={onClose} />
  ) : (
    <ChangePasswordDialog onClose={onClose} />
  )
}
