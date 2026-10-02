import { isApiError, type InvitePreview } from '@baren/sync-client/api'
import { AuthHeading, Button, IconTile, Spinner, toast, UsersIcon } from '@baren/ui'
import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { FormError } from '../components/FormError'
import { api, errorMessage } from '../lib/api'
import { signalAppReady } from '../lib/ready'
import { useSession } from '../state/session'
import { ROLE_LABELS } from '../team/members'
import { AuthLayout } from './AuthLayout'
import css from './Auth.module.css'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: InvitePreview }
  | { kind: 'invalid'; title: string; message: string }

export function invalidInviteText(error: unknown): { title: string; message: string } {
  const code = isApiError(error) ? error.code : ''
  switch (code) {
    case 'invite_expired':
      return { title: 'This invite has expired', message: 'Ask a team admin for a new link.' }
    case 'invite_revoked':
      return { title: 'This invite was revoked', message: 'Ask a team admin for a new link.' }
    case 'invite_used_up':
      return {
        title: 'This invite has been used',
        message: 'It reached its limit. Ask a team admin for a new link.',
      }
    case 'invite_not_found':
      return { title: 'This invite link is not valid', message: 'Check the link and try again.' }
    default:
      return { title: "Couldn't open this invite", message: errorMessage(error) }
  }
}

/**
 * baren://invite/<token> lands here: preview the team and inviter, then accept. Signed-out
 * users sign in or register first; the token waits in the session and brings them back.
 */
export function InviteScreen({ token }: { token: string }) {
  const [, navigate] = useLocation()
  const status = useSession((s) => s.status)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => signalAppReady(), [])

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    api.invites.preview(token).then(
      (preview) => alive && setState({ kind: 'ready', preview }),
      (e: unknown) => alive && setState({ kind: 'invalid', ...invalidInviteText(e) }),
    )
    return () => {
      alive = false
    }
  }, [token])

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.invites.accept(token)
      const session = useSession.getState()
      session.setPendingInvite(null)
      session.upsertTeam(result.team)
      session.setCurrentTeam(result.team.id)
      void session.refresh()
      navigate(paths.teamMembers, { replace: true })
      toast(
        result.alreadyMember
          ? `You're already a member of ${result.team.name}`
          : `You joined ${result.team.name}`,
      )
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const later = () => {
    useSession.getState().setPendingInvite(null)
    navigate(status === 'signedOut' ? paths.signIn : paths.recents, { replace: true })
  }

  const authFirst = (to: string) => {
    useSession.getState().setPendingInvite(token)
    navigate(to)
  }

  let body
  if (state.kind === 'loading') {
    body = (
      <div className={css.waiting} role="status">
        <Spinner size={16} /> Opening invite…
      </div>
    )
  } else if (state.kind === 'invalid') {
    body = (
      <>
        <AuthHeading title={state.title} lead={state.message} />
        <Button size={40} fullWidth onClick={later}>
          Continue
        </Button>
      </>
    )
  } else {
    const { preview } = state
    const signedIn = status === 'signedIn'
    body = (
      <>
        <AuthHeading
          title={`Join ${preview.teamName}`}
          lead={`${preview.inviterName ?? 'A teammate'} invited you to collaborate as ${ROLE_LABELS[
            preview.role
          ].toLowerCase()}. ${preview.memberCount} ${preview.memberCount === 1 ? 'person is' : 'people are'} on this team.`}
        />
        <div className={css.actions}>
          <FormError>{error}</FormError>
          {signedIn ? (
            <Button size={40} fullWidth loading={busy} onClick={() => void accept()}>
              Accept invite
            </Button>
          ) : (
            <Button size={40} fullWidth onClick={() => authFirst(paths.signIn)}>
              Sign in to accept
            </Button>
          )}
          <div className={css.row}>
            {signedIn ? (
              <span />
            ) : (
              <Button variant="link-muted" onClick={() => authFirst(paths.register)}>
                Create an account
              </Button>
            )}
            <Button variant="link" onClick={later}>
              Not now
            </Button>
          </div>
        </div>
      </>
    )
  }

  return (
    <AuthLayout>
      <div className={`${css.form} ${css.formStep}`}>
        <IconTile>
          <UsersIcon size={22} strokeWidth={1.6} />
        </IconTile>
        {body}
      </div>
    </AuthLayout>
  )
}
