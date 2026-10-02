import {
  AccountTrigger,
  Avatar,
  CheckIcon,
  DropdownMenu,
  MenuControlRow,
  MenuHeader,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PlusIcon,
} from '@baren/ui'
import { useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { runAppAction } from '../app/actions'
import { paths } from '../app/routes'
import { ThemeControl } from '../app/ThemeControl'
import { bridge } from '../lib/bridge'
import { teamColorFor } from '../lib/identity'
import { formatShortcut } from '../lib/shortcuts'
import { useSession } from '../state/session'
import { refreshThemePreference } from '../state/theme'
import { useUi } from '../state/ui'
import css from './Home.module.css'

const shortcut = (s: string) => formatShortcut(s, bridge.platform)

/** Avatar + name in the sidebar, opening the account menu (artboard 17). */
export function AccountMenu() {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [, navigate] = useLocation()
  const status = useSession((s) => s.status)
  const user = useSession((s) => s.user)
  const teams = useSession((s) => s.teams)
  const currentTeamId = useSession((s) => s.currentTeamId)
  const signedIn = status === 'signedIn' && user !== null

  const switchTeam = (teamId: string) => {
    useSession.getState().setCurrentTeam(teamId)
  }

  const logOut = async () => {
    await useSession.getState().signOut()
    navigate(paths.signIn)
  }

  return (
    <>
      <AccountTrigger
        ref={triggerRef}
        name={signedIn ? user.name : 'Not signed in'}
        aria-label={`Account menu: ${signedIn ? user.name : 'not signed in'}`}
        open={open}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          if (!open) void refreshThemePreference()
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault()
            void refreshThemePreference()
            setOpen(true)
          }
        }}
      />
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        width={264}
        offset={2}
        aria-label="Account"
      >
        {signedIn ? (
          <>
            <MenuHeader
              avatar={<Avatar name={user.name} size={32} />}
              title={user.name}
              subtitle={user.email}
            />
            <MenuSeparator className={css.headerSeparator} />
            <MenuLabel>Teams</MenuLabel>
            {teams.map((team) => {
              const current = team.id === currentTeamId
              return (
                <MenuItem
                  key={team.id}
                  icon={
                    <Avatar
                      name={team.name}
                      initials={team.name.trim().charAt(0).toLocaleLowerCase() || '?'}
                      size={18}
                      shape="square"
                      color={teamColorFor(team.id)}
                    />
                  }
                  trailing={current ? <CheckIcon size={13} strokeWidth={2.5} /> : undefined}
                  data-highlighted={current ? '' : undefined}
                  aria-current={current || undefined}
                  onSelect={() => switchTeam(team.id)}
                >
                  {team.name}
                </MenuItem>
              )
            })}
            <MenuItem
              icon={<PlusIcon size={14} strokeWidth={2} />}
              muted
              onSelect={() => useUi.getState().openDialog({ kind: 'createTeam' })}
            >
              Create team
            </MenuItem>
          </>
        ) : (
          <>
            <MenuHeader
              avatar={<Avatar name="Not signed in" size={32} />}
              title="Working offline"
              subtitle="Files stay on this device"
            />
            <MenuSeparator />
            <MenuItem onSelect={() => navigate(paths.signIn)}>Sign in…</MenuItem>
          </>
        )}
        <MenuSeparator />
        <MenuControlRow label="Theme" control={<ThemeControl size={22} textSize={11} />} />
        <MenuItem shortcut={shortcut('Mod+,')} onSelect={() => runAppAction('ui.preferences')}>
          Preferences
        </MenuItem>
        <MenuItem
          shortcut={shortcut('Mod+/')}
          onSelect={() => runAppAction('ui.keyboardShortcuts')}
        >
          Keyboard shortcuts
        </MenuItem>
        {signedIn && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => void logOut()}>Log out</MenuItem>
          </>
        )}
      </DropdownMenu>
    </>
  )
}
