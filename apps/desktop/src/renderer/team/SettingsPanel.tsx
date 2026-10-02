import type { FileAccess, Team } from '@baren/sync-client/api'
import { Button, GlobeIcon, Input, Select, toast, UsersIcon } from '@baren/ui'
import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { api, errorMessage } from '../lib/api'
import { useSession } from '../state/session'
import { useTeamData } from '../state/team'
import css from './Team.module.css'

const ACCESS_OPTIONS = [
  { value: 'members', label: 'Only team members' },
  { value: 'link', label: 'Anyone with the link' },
] as const satisfies ReadonlyArray<{ value: FileAccess; label: string }>

/** Team name, saved when the field loses focus or on Enter; Escape reverts. */
function TeamNameField({ team, disabled }: { team: Team; disabled: boolean }) {
  const [name, setName] = useState(team.name)
  useEffect(() => setName(team.name), [team.name])

  const save = async () => {
    const next = name.trim()
    if (!next) return setName(team.name)
    if (next === team.name) return
    try {
      const updated = await api.teams.update(team.id, { name: next })
      useSession.getState().upsertTeam(updated)
      toast('Team name saved')
    } catch (e) {
      setName(team.name)
      toast(errorMessage(e))
    }
  }

  return (
    <Input
      variant="filled"
      size={32}
      containerClassName={css.control}
      aria-label="Team name"
      value={name}
      maxLength={80}
      disabled={disabled}
      onChange={(e) => setName(e.currentTarget.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setName(team.name)
          // Blur after the revert has rendered so save() sees the original name.
          const input = e.currentTarget
          requestAnimationFrame(() => input.blur())
        }
      }}
    />
  )
}

/** Team › Settings (artboard 03): name, default file access, delete (admins) or leave. */
export function SettingsPanel({ team }: { team: Team }) {
  const [, navigate] = useLocation()
  const [confirm, setConfirm] = useState<'delete' | 'leave' | null>(null)
  const admin = team.role === 'admin'
  const selfId = useSession((s) => s.user?.id ?? null)

  const setAccess = async (fileAccess: FileAccess) => {
    if (fileAccess === team.fileAccess) return
    useSession.getState().upsertTeam({ ...team, fileAccess })
    try {
      const updated = await api.teams.update(team.id, { fileAccess })
      useSession.getState().upsertTeam(updated)
    } catch (e) {
      useSession.getState().upsertTeam(team)
      toast(errorMessage(e))
    }
  }

  return (
    <>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.rowLabel}>Team name</div>
        </div>
        <TeamNameField team={team} disabled={!admin} />
      </div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.rowLabel}>File access</div>
          <div className={css.rowHint}>The default access level for files in your team.</div>
        </div>
        <div className={css.control}>
          <Select
            fullWidth
            value={team.fileAccess}
            options={ACCESS_OPTIONS}
            disabled={!admin}
            aria-label="File access"
            leadingIcon={
              team.fileAccess === 'link' ? (
                <GlobeIcon size={14} strokeWidth={1.75} />
              ) : (
                <UsersIcon size={14} strokeWidth={1.75} />
              )
            }
            onChange={(v) => void setAccess(v)}
          />
        </div>
      </div>
      {admin ? (
        <div className={css.row}>
          <div className={css.rowText}>
            <div className={css.rowLabel}>Delete team</div>
            <div className={css.rowHint}>
              Permanently remove this team and all of its files. This can't be undone.
            </div>
          </div>
          <Button variant="destructive" size={32} onClick={() => setConfirm('delete')}>
            Delete team
          </Button>
        </div>
      ) : (
        <div className={css.row}>
          <div className={css.rowText}>
            <div className={css.rowLabel}>Leave team</div>
            <div className={css.rowHint}>You lose access to the team's files.</div>
          </div>
          <Button variant="destructive" size={32} onClick={() => setConfirm('leave')}>
            Leave team
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title={`Delete ${team.name}?`}
        description="Every file in this team is deleted for all members. This can't be undone."
        confirmLabel="Delete team"
        destructive
        confirmText={team.name}
        onConfirm={async () => {
          await api.teams.remove(team.id)
          useSession.getState().removeTeam(team.id)
          toast(`Deleted ${team.name}`)
          navigate(paths.recents)
        }}
      />
      <ConfirmDialog
        open={confirm === 'leave'}
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
