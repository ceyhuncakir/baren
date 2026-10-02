/**
 * Share button + popover (artboard 08): invite by email (team invite through the server),
 * people with access, the team row, general link access, Export and Copy link.
 */
import {
  ArrowUpRightIcon,
  Avatar,
  Button,
  ChevronDownIcon,
  DropdownMenu,
  GlobeIcon,
  Input,
  LinkIcon,
  MenuItem,
  PersonRow,
  Popover,
  PopoverFooter,
  PopoverHeader,
  SelectTrigger,
  ShareButton,
  UsersIcon,
  toast,
} from '@baren/ui'
import { useEffect, useRef, useState } from 'react'
import { bridge } from '../../lib/bridge'
import { copyText, downloadText } from '../commands/clipboard'
import {
  fileLink,
  invite,
  loadShareModel,
  setLinkAccess,
  shareToTeam,
  type ShareModel,
  type ShareRole,
} from '../collab/account'
import { useDocName, useEditor, useEditorState } from '../session/context'
import css from './Inspector.module.css'

const ROLE_LABEL: Record<ShareRole, string> = { owner: 'Owner', edit: 'can edit', view: 'can view' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function RoleMenu({
  value,
  onChange,
  disabled = false,
}: {
  value: 'edit' | 'view'
  onChange: (v: 'edit' | 'view') => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <SelectTrigger
        ref={ref}
        variant="ghost"
        size={24}
        open={open}
        disabled={disabled}
        className={css.roleSelect}
        onClick={() => setOpen((v) => !v)}
      >
        {ROLE_LABEL[value]}
      </SelectTrigger>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={ref}
        placement="bottom-end"
        width={140}
      >
        <MenuItem checked={value === 'edit'} onSelect={() => onChange('edit')}>
          can edit
        </MenuItem>
        <MenuItem checked={value === 'view'} onSelect={() => onChange('view')}>
          can view
        </MenuItem>
      </DropdownMenu>
    </>
  )
}

export function SharePopover() {
  const session = useEditor()
  const { store } = session
  const open = useEditorState((s) => s.shareOpen)
  const identity = useEditorState((s) => s.identity)
  const docName = useDocName()
  const name = docName || session.file?.name || 'file'
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [model, setModel] = useState<ShareModel | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'edit' | 'view'>('edit')
  const [busy, setBusy] = useState(false)
  const accessRef = useRef<HTMLButtonElement>(null)
  const [accessMenu, setAccessMenu] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    void loadShareModel(session.fixture, session.file, identity, session.teams).then((m) => {
      if (alive) setModel(m)
    })
    return () => {
      alive = false
    }
  }, [open, session, identity])

  const setOpen = (v: boolean) => store.setState({ shareOpen: v })

  const sendInvite = async () => {
    const team = model?.team
    const address = email.trim()
    if (!team || !EMAIL_RE.test(address)) {
      toast(team ? 'Enter a valid email address.' : 'Add this file to a team to invite people.')
      return
    }
    setBusy(true)
    try {
      // Inviting someone to a file puts the file in the team first (so they can open it).
      const remoteId = await ensureShared(team.id)
      const url = await invite(session.fixture, team.id, address, role)
      await copyText(url)
      setModel((m) =>
        m
          ? {
              ...m,
              people: [
                ...m.people,
                {
                  id: `invite-${address}`,
                  name: address,
                  email: address,
                  role,
                  isSelf: false,
                  color: undefined,
                },
              ],
            }
          : m,
      )
      setEmail('')
      setModel((m) => (m ? { ...m, remoteId } : m))
      toast(`Invited ${address}. Invite link copied.`)
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't send the invite.")
    } finally {
      setBusy(false)
    }
  }

  /** The file's server id, sharing it to `teamId` first when it is still local-only. */
  const ensureShared = async (teamId: string): Promise<string> => {
    const already = model?.remoteId ?? store.getState().remoteId
    if (already) return already
    const remoteId = await shareToTeam(session, teamId)
    if (!session.fixture.enabled) toast(`Shared to ${model?.team?.name ?? 'your team'}`)
    return remoteId
  }

  const copyLink = async () => {
    let remoteId = model?.remoteId ?? store.getState().remoteId
    if (!remoteId && model?.team && model.team.role !== 'viewer') {
      try {
        remoteId = await ensureShared(model.team.id)
        setModel((m) => (m ? { ...m, remoteId } : m))
      } catch (error) {
        toast(error instanceof Error ? error.message : "Couldn't share the file")
        return
      }
    }
    const ok = await copyText(fileLink(session.fileId, remoteId ?? null))
    toast(ok ? 'Link copied' : "Couldn't copy the link")
  }

  const exportJson = async () => {
    try {
      const json = await bridge.export.json(session.fileId)
      downloadText(`${name}.json`, json, 'application/json')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Export failed')
    }
  }

  const team = model?.team ?? null
  const linkAccess = model?.linkAccess ?? 'none'

  return (
    <>
      <ShareButton ref={buttonRef} open={open} onClick={() => setOpen(!open)} />
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        placement="bottom-end"
        offset={13.5}
        alignOffset={6}
        width={360}
        aria-label={`Share ${name}`}
      >
        <div className={css.share}>
          <PopoverHeader title={`Share ${name}`} onClose={() => setOpen(false)} />
          <div className={css.shareInvite}>
            <div className={css.shareInviteField}>
              <Input
                variant="filled"
                size={32}
                textSize={12}
                type="email"
                placeholder="Add people by email"
                value={email}
                disabled={!model?.canInvite}
                controlClassName={css.shareInviteControl}
                onChange={(e) => setEmail(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void sendInvite()
                }}
                trailing={<RoleMenu value={role} onChange={setRole} disabled={!model?.canInvite} />}
              />
            </div>
            <Button
              variant="primary"
              size={32}
              textSize={12}
              loading={busy}
              disabled={!model?.canInvite}
              onClick={() => void sendInvite()}
            >
              Invite
            </Button>
          </div>
          <div className={css.sharePeople}>
            {(model?.people ?? []).map((p) => (
              <PersonRow
                key={p.id}
                avatar={<Avatar name={p.name} size={28} {...(p.color ? { color: p.color } : {})} />}
                name={p.isSelf ? `${p.name} (you)` : p.name}
                secondary={p.email}
                trailing={
                  p.role === 'owner' ? (
                    'Owner'
                  ) : (
                    <RoleMenu
                      value={p.role}
                      onChange={() => toast('Change roles in Team settings.')}
                    />
                  )
                }
              />
            ))}
            {team && (
              <PersonRow
                avatar={
                  <Avatar size={28} shape="square" variant="muted" icon={<UsersIcon size={14} />} />
                }
                name={`Everyone at ${team.name}`}
                secondary={`${team.memberCount} ${team.memberCount === 1 ? 'member' : 'members'}`}
                trailing={
                  <RoleMenu value="edit" onChange={() => toast('Change roles in Team settings.')} />
                }
              />
            )}
          </div>
          <div className={css.shareAccess}>
            <div className={css.shareAccessLabel}>General access</div>
            <PersonRow
              className={css.shareAccessRow}
              avatar={<Avatar size={28} variant="accent" icon={<GlobeIcon size={14} />} />}
              name={
                <button
                  ref={accessRef}
                  type="button"
                  className={css.shareAccessName}
                  disabled={!team || team.role !== 'admin'}
                  onClick={() => setAccessMenu((v) => !v)}
                >
                  {linkAccess === 'none' ? 'Only people invited' : 'Anyone with the link'}
                  <ChevronDownIcon size={10} strokeWidth={2.5} />
                </button>
              }
              secondary={team ? 'Team default' : 'Sign in to share'}
              trailing={
                linkAccess === 'none' ? undefined : (
                  <RoleMenu value="view" onChange={() => toast('Link access is view-only.')} />
                )
              }
            />
          </div>
          <PopoverFooter>
            <Button
              variant="link-muted"
              textSize={12}
              leadingIcon={<ArrowUpRightIcon size={13} />}
              onClick={() => void exportJson()}
            >
              Export
            </Button>
            <Button
              variant="outline"
              size={30}
              textSize={12}
              leadingIcon={<LinkIcon size={13} />}
              onClick={() => void copyLink()}
            >
              Copy link
            </Button>
          </PopoverFooter>
          <DropdownMenu
            open={accessMenu}
            onOpenChange={setAccessMenu}
            anchorRef={accessRef}
            width={200}
          >
            {(['view', 'none'] as const).map((a) => (
              <MenuItem
                key={a}
                checked={linkAccess === a}
                onSelect={() => {
                  if (!team) return
                  setModel((m) => (m ? { ...m, linkAccess: a } : m))
                  void setLinkAccess(session.fixture, team.id, a).catch(() =>
                    toast("Couldn't change link access"),
                  )
                }}
              >
                {a === 'view' ? 'Anyone with the link' : 'Only people invited'}
              </MenuItem>
            ))}
          </DropdownMenu>
        </div>
      </Popover>
    </>
  )
}
