import { Button, PageTitle, Tabs } from '@baren/ui'
import { useEffect } from 'react'
import { useLocation } from 'wouter'
import { paths, type TeamTab } from '../app/routes'
import { signalAppReady } from '../lib/ready'
import { useCurrentTeam, useSession } from '../state/session'
import { useTeamData } from '../state/team'
import { useUi } from '../state/ui'
import { MembersPanel } from './MembersPanel'
import { SettingsPanel } from './SettingsPanel'
import css from './Team.module.css'

/** Billing is dropped (product decision): Members and Settings only. */
const TABS = [
  { value: 'members', label: 'Members', panelId: 'team-panel-members' },
  { value: 'settings', label: 'Settings', panelId: 'team-panel-settings' },
] as const

function TeamEmpty({ signedIn }: { signedIn: boolean }) {
  const [, navigate] = useLocation()
  return (
    <div className={css.empty} role="status">
      <p className={css.emptyTitle}>
        {signedIn ? 'You are not in a team yet' : 'Sign in to work with your team'}
      </p>
      <p className={css.emptyBody}>
        {signedIn
          ? 'Create a team to share files and invite people.'
          : 'Teams, invites and live collaboration need an account. Your local files keep working offline.'}
      </p>
      {signedIn ? (
        <Button size={30} onClick={() => useUi.getState().openDialog({ kind: 'createTeam' })}>
          Create team
        </Button>
      ) : (
        <Button size={30} onClick={() => navigate(paths.signIn)}>
          Sign in
        </Button>
      )}
    </div>
  )
}

/** Team settings (artboards 02 and 03): title, tabs, then the members table or settings rows. */
export default function TeamScreen({ tab }: { tab: TeamTab }) {
  const [, navigate] = useLocation()
  const status = useSession((s) => s.status)
  const team = useCurrentTeam()
  const teamId = team?.id ?? null

  useEffect(() => {
    if (teamId) void useTeamData.getState().load(teamId)
  }, [teamId])

  useEffect(() => signalAppReady(), [])

  if (status !== 'signedIn') return <TeamEmpty signedIn={false} />
  if (!team) return <TeamEmpty signedIn />

  return (
    <section className={css.screen} aria-label={`${team.name} settings`}>
      <header className={css.header}>
        <div className={css.headerColumn}>
          <PageTitle size={24}>{team.name} settings</PageTitle>
          <Tabs
            items={TABS}
            value={tab}
            aria-label="Team settings sections"
            onChange={(next) =>
              navigate(next === 'members' ? paths.teamMembers : paths.teamSettings)
            }
          />
        </div>
      </header>
      <div className={css.scroll}>
        {tab === 'members' ? (
          <div id="team-panel-members" role="tabpanel" className={css.membersPanel}>
            <MembersPanel team={team} />
          </div>
        ) : (
          <div id="team-panel-settings" role="tabpanel" className={css.settingsPanel}>
            <SettingsPanel team={team} />
          </div>
        )}
      </div>
    </section>
  )
}
