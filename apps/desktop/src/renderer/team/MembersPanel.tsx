import type { Invite, Member, Role, Team } from '@baren/sync-client/api'
import {
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  MailIcon,
  MemberCell,
  MenuItem,
  MoreHorizontalIcon,
  SearchField,
  SearchIcon,
  Select,
  StatusDot,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  toast,
  UserIcon,
  useStableCallback,
} from '@baren/ui'
import { memo, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { errorMessage } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { memberColorFor } from '../lib/identity'
import { useSendsEmail } from '../lib/providers'
import { formatRelative, useNow } from '../lib/relativeTime'
import { useSession } from '../state/session'
import { useTeam, useTeamData } from '../state/team'
import { useUi } from '../state/ui'
import { canChangeRoles, canInvite, roleOptionsFor, ROLE_LABELS, sortMembers } from './members'
import css from './Team.module.css'

type RowMenu =
  | { kind: 'member'; member: Member; anchor: HTMLElement }
  | { kind: 'invite'; invite: Invite; anchor: HTMLElement }

type Confirm = { kind: 'remove'; member: Member } | { kind: 'leave' } | null

const MemberRow = memo(function MemberRow({
  member,
  selfId,
  editableRole,
  roleOptions,
  now,
  onRole,
  onMenu,
}: {
  member: Member
  selfId: string | null
  editableRole: boolean
  roleOptions: ReadonlyArray<{ value: Role; label: string }>
  now: number
  onRole: (member: Member, role: Role) => void
  onMenu: ((member: Member, anchor: HTMLElement) => void) | null
}) {
  const you = member.userId === selfId
  return (
    <TableRow data-member-id={member.userId}>
      <MemberCell
        avatar={
          <Avatar name={member.name} size={36} color={memberColorFor(member.userId, selfId)} />
        }
        name={member.name}
        suffix={you ? '(you)' : undefined}
        secondary={member.email}
      />
      <TableCell>
        {editableRole ? (
          <Select
            size={26}
            value={member.role}
            options={roleOptions}
            aria-label={`Role for ${member.name}`}
            onChange={(role) => onRole(member, role)}
          />
        ) : (
          ROLE_LABELS[member.role]
        )}
      </TableCell>
      <TableCell>
        {member.online ? (
          <>
            <StatusDot tone="success" />
            Active now
          </>
        ) : member.lastSeenAt ? (
          formatRelative(member.lastSeenAt, now)
        ) : (
          '—'
        )}
      </TableCell>
      {onMenu ? (
        <IconButton
          label={`More actions for ${member.name}`}
          size={28}
          width={32}
          onClick={(e) => onMenu(member, e.currentTarget)}
        >
          <MoreHorizontalIcon size={16} />
        </IconButton>
      ) : (
        <span />
      )}
    </TableRow>
  )
})

const InviteRow = memo(function InviteRow({
  invite,
  manage,
  onResend,
  onRevoke,
  onMenu,
}: {
  invite: Invite
  manage: boolean
  onResend: (invite: Invite) => void
  onRevoke: (invite: Invite) => void
  onMenu: (invite: Invite, anchor: HTMLElement) => void
}) {
  return (
    <TableRow data-invite-id={invite.id}>
      <MemberCell
        avatar={<Avatar size={36} variant="pending" icon={<MailIcon size={16} />} />}
        name={invite.email ?? 'Invite link'}
        badge={<Badge>Invited</Badge>}
        secondary={
          manage ? (
            <span className={css.inviteLinks}>
              <button type="button" className={css.inlineLink} onClick={() => onResend(invite)}>
                {invite.email ? 'Resend invite' : 'New link'}
              </button>
              ·
              <button type="button" className={css.inlineLink} onClick={() => onRevoke(invite)}>
                Revoke
              </button>
            </span>
          ) : (
            'Pending'
          )
        }
      />
      <TableCell>{ROLE_LABELS[invite.role]}</TableCell>
      <TableCell>—</TableCell>
      {manage ? (
        <IconButton
          label={`More actions for ${invite.email ?? 'invite link'}`}
          size={28}
          width={32}
          onClick={(e) => onMenu(invite, e.currentTarget)}
        >
          <MoreHorizontalIcon size={16} />
        </IconButton>
      ) : (
        <span />
      )}
    </TableRow>
  )
})

/** Team › Members (artboard 02). */
export function MembersPanel({ team }: { team: Team }) {
  const [, navigate] = useLocation()
  const data = useTeam(team.id)
  const selfId = useSession((s) => s.user?.id ?? null)
  const now = useNow()
  const sendsEmail = useSendsEmail()
  const [order, setOrder] = useState<'az' | 'za'>('az')
  const [searching, setSearching] = useState(false)
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const anchorRef = useRef<HTMLElement | null>(null)

  const admin = canChangeRoles(team.role)
  const inviter = canInvite(team.role)
  const roleOptions = useMemo(() => roleOptionsFor(team.role), [team.role])

  const members = useMemo(
    () => sortMembers(data?.members ?? [], order, filter),
    [data?.members, order, filter],
  )
  const invites = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase()
    const list = data?.invites ?? []
    return q ? list.filter((i) => (i.email ?? '').toLocaleLowerCase().includes(q)) : list
  }, [data?.invites, filter])

  const total = (data?.members.length ?? 0) + (data?.invites.length ?? 0)

  const run = async (op: () => Promise<unknown>, success?: string) => {
    try {
      await op()
      if (success) toast(success)
    } catch (e) {
      toast(errorMessage(e))
    }
  }

  // Stable identities so the memoized rows only re-render when their own data changes.
  const onRole = useStableCallback((member: Member, role: Role) => {
    void run(
      () => useTeamData.getState().setRole(team.id, member.userId, role),
      `${member.name} is now ${ROLE_LABELS[role].toLowerCase()}`,
    )
  })

  const resend = useStableCallback((invite: Invite) => {
    void run(async () => {
      const created = await useTeamData.getState().resendInvite(team.id, invite)
      if (invite.email && sendsEmail) {
        toast(`Invite sent again to ${invite.email}`)
        return
      }
      // No email went out: the new link is what gets shared (the old one stopped working).
      const copied = await copyText(created.url)
      toast(copied ? 'New invite link copied' : 'New invite link created')
    })
  })

  const revoke = useStableCallback((invite: Invite) => {
    void run(() => useTeamData.getState().revokeInvite(team.id, invite.id), 'Invite revoked')
  })

  const openMenu = (next: RowMenu) => {
    anchorRef.current = next.anchor
    setMenu(next)
  }

  const memberMenu = useStableCallback((member: Member, anchor: HTMLElement) =>
    openMenu({ kind: 'member', member, anchor }),
  )
  const inviteMenu = useStableCallback((invite: Invite, anchor: HTMLElement) =>
    openMenu({ kind: 'invite', invite, anchor }),
  )

  return (
    <>
      <div className={css.toolbar}>
        <div className={css.count} aria-live="polite">
          {data?.status === 'ready' ? `${total} ${total === 1 ? 'member' : 'members'}` : ''}
        </div>
        <div className={css.toolbarActions}>
          {searching ? (
            <SearchField
              containerClassName={css.search}
              placeholder="Search members"
              aria-label="Search members"
              value={filter}
              autoFocus
              onChange={(e) => setFilter(e.currentTarget.value)}
              onBlur={() => !filter && setSearching(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setFilter('')
                  setSearching(false)
                }
              }}
            />
          ) : (
            <IconButton label="Search members" size={30} onClick={() => setSearching(true)}>
              <SearchIcon size={15} />
            </IconButton>
          )}
          {inviter && (
            <Button
              leadingIcon={<UserIcon size={14} />}
              onClick={() => useUi.getState().openDialog({ kind: 'invite' })}
            >
              Invite members
            </Button>
          )}
        </div>
      </div>

      <Table columns="1fr 160px 160px 32px" aria-label="Team members">
        <TableHeader>
          <TableHeaderCell
            sort={order === 'az' ? 'desc' : 'asc'}
            // The caret points down for A→Z, as drawn in 02.
            aria-sort={order === 'az' ? 'ascending' : 'descending'}
            onClick={() => setOrder((o) => (o === 'az' ? 'za' : 'az'))}
          >
            Member
          </TableHeaderCell>
          <TableHeaderCell>Role</TableHeaderCell>
          <TableHeaderCell>Last seen</TableHeaderCell>
          <span />
        </TableHeader>
        {data?.status === 'error' && <div className={css.status}>{data.error}</div>}
        {members.map((member) => {
          const you = member.userId === selfId
          return (
            <MemberRow
              key={member.userId}
              member={member}
              selfId={selfId}
              editableRole={admin && !you}
              roleOptions={roleOptions}
              now={now}
              onRole={onRole}
              onMenu={you || admin ? memberMenu : null}
            />
          )
        })}
        {invites.map((invite) => (
          <InviteRow
            key={invite.id}
            invite={invite}
            manage={inviter}
            onResend={resend}
            onRevoke={revoke}
            onMenu={inviteMenu}
          />
        ))}
      </Table>

      <DropdownMenu
        open={menu !== null}
        onOpenChange={(open) => !open && setMenu(null)}
        anchorRef={anchorRef}
        placement="bottom-end"
        width={200}
        aria-label="Member actions"
      >
        {menu?.kind === 'member' &&
          (menu.member.userId === selfId ? (
            <MenuItem destructive onSelect={() => setConfirm({ kind: 'leave' })}>
              Leave team…
            </MenuItem>
          ) : (
            <MenuItem
              destructive
              onSelect={() => setConfirm({ kind: 'remove', member: menu.member })}
            >
              Remove from team…
            </MenuItem>
          ))}
        {menu?.kind === 'invite' && (
          <>
            <MenuItem onSelect={() => resend(menu.invite)}>
              {menu.invite.email && sendsEmail ? 'Resend invite' : 'Copy a new invite link'}
            </MenuItem>
            <MenuItem destructive onSelect={() => revoke(menu.invite)}>
              Revoke invite
            </MenuItem>
          </>
        )}
      </DropdownMenu>

      <ConfirmDialog
        open={confirm?.kind === 'remove'}
        onClose={() => setConfirm(null)}
        title="Remove member?"
        description={
          confirm?.kind === 'remove'
            ? `${confirm.member.name} loses access to ${team.name} and its files.`
            : ''
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (confirm?.kind === 'remove')
            await useTeamData.getState().removeMember(team.id, confirm.member.userId)
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === 'leave'}
        onClose={() => setConfirm(null)}
        title={`Leave ${team.name}?`}
        description="You lose access to the team's files until someone invites you again."
        confirmLabel="Leave team"
        destructive
        onConfirm={async () => {
          if (!selfId) return
          await useTeamData.getState().removeMember(team.id, selfId)
          useSession.getState().removeTeam(team.id)
          navigate(paths.recents)
        }}
      />
    </>
  )
}
