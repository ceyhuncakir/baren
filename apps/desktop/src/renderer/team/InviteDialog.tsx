import type { CreateInviteResponse, Role, Team } from '@baren/sync-client/api'
import { Button, CopyIcon, Field, Input, Select, toast } from '@baren/ui'
import { useMemo, useState } from 'react'
import { Dialog } from '../components/Dialog'
import { FormError } from '../components/FormError'
import { errorMessage } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { useSendsEmail } from '../lib/providers'
import { useTeamData } from '../state/team'
import { roleOptionsFor } from './members'
import css from './Team.module.css'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * "Invite members": creates an invite on the server. With an email address and a server
 * that sends email, the invite is mailed (artboard 28) and the link is there to copy too;
 * otherwise the link is what gets shared, so it is copied straight away.
 */
export default function InviteDialog({ team, onClose }: { team: Team; onClose: () => void }) {
  const sendsEmail = useSendsEmail()
  const roleOptions = useMemo(() => roleOptionsFor(team.role), [team.role])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>(team.role === 'viewer' ? 'viewer' : 'editor')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreateInviteResponse | null>(null)
  const emailInvalid = email.trim() !== '' && !EMAIL_RE.test(email.trim())
  const willEmail = sendsEmail && email.trim() !== '' && !emailInvalid

  const create = async () => {
    if (busy || emailInvalid) return
    setBusy(true)
    setError(null)
    try {
      const trimmed = email.trim()
      const invite = await useTeamData
        .getState()
        .createInvite(team.id, { role, ...(trimmed ? { email: trimmed } : {}) })
      setCreated(invite)
      if (invite.email && sendsEmail) {
        toast(`Invite sent to ${invite.email}`)
        return
      }
      const copied = await copyText(invite.url)
      toast(copied ? 'Invite link copied' : 'Invite link created')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const copyAgain = async () => {
    if (!created) return
    toast((await copyText(created.url)) ? 'Invite link copied' : "Couldn't copy the link")
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite members"
      description={`People who open the link join ${team.name}. Links expire after 14 days.`}
      onSubmit={() => (created ? onClose() : void create())}
      footer={
        created ? (
          <>
            <Button
              variant="outline"
              size={32}
              onClick={() => {
                setCreated(null)
                setEmail('')
              }}
            >
              Invite someone else
            </Button>
            <Button type="submit" size={32}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size={32} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size={32} loading={busy} disabled={emailInvalid}>
              {willEmail ? 'Send invite' : 'Create invite link'}
            </Button>
          </>
        )
      }
    >
      {created?.email && (
        <p className={css.inviteNote}>
          {sendsEmail
            ? `We emailed ${created.email} a link to join ${team.name}. You can also share it yourself:`
            : `This server doesn't send email. Share this link with ${created.email}:`}
        </p>
      )}
      {created ? (
        <div className={css.linkRow}>
          <Input
            variant="filled"
            size={32}
            label="Invite link"
            value={created.url}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            variant="outline"
            size={32}
            leadingIcon={<CopyIcon size={12} />}
            onClick={() => void copyAgain()}
          >
            Copy
          </Button>
        </div>
      ) : (
        <>
          <Input
            variant="filled"
            size={32}
            type="email"
            label="Email (optional)"
            hint={
              sendsEmail
                ? 'We email them the invite. Leave empty to just create a link.'
                : "This server doesn't send email; you'll get a link to share."
            }
            placeholder="name@company.com"
            value={email}
            error={emailInvalid ? 'Enter a valid email address.' : undefined}
            data-autofocus=""
            autoComplete="off"
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <Field label="Role" htmlFor="invite-role">
            <Select
              id="invite-role"
              fullWidth
              value={role}
              options={roleOptions}
              onChange={setRole}
            />
          </Field>
        </>
      )}
      <FormError>{error}</FormError>
    </Dialog>
  )
}
