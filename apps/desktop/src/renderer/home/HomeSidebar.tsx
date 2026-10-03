import {
  ArchiveIcon,
  Avatar,
  Button,
  ChevronRightIcon,
  ClockIcon,
  FooterLinks,
  LayoutGridIcon,
  NavItem,
  PromoCard,
  SearchField,
  SettingsIcon,
  Sidebar,
  SidebarNav,
  SidebarSpacer,
  UserIcon,
  UsersIcon,
} from '@baren/ui'
import { memo, useCallback, type KeyboardEvent } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { bridge } from '../lib/bridge'
import { LINKS } from '../lib/links'
import { useNow } from '../lib/relativeTime'
import { formatShortcut } from '../lib/shortcuts'
import { homeAgentLine, isAgentActive, useMcpStatus } from '../state/mcp'
import { useCurrentTeam, useSession } from '../state/session'
import { registerSearchInput, useUi } from '../state/ui'
import type { McpAgentInfo } from '../types/bridge'
import { AccountMenu } from './AccountMenu'
import css from './Home.module.css'

export type SidebarItem = 'recents' | 'files' | 'archive' | 'settings'

const FOOTER = [
  { label: 'Feedback', onClick: () => void bridge.shell.openExternal(LINKS.feedback) },
] as const

const SEARCH_HINT = formatShortcut('Mod+F', bridge.platform).replace('+', ' ')

function SidebarSearch({ onSearch }: { onSearch: () => void }) {
  const search = useUi((s) => s.search)
  const setSearch = useUi((s) => s.setSearch)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setSearch('')
      e.currentTarget.blur()
    }
  }
  return (
    <SearchField
      ref={registerSearchInput}
      shortcut={search ? undefined : SEARCH_HINT}
      aria-label="Search files"
      value={search}
      onChange={(e) => {
        setSearch(e.currentTarget.value)
        onSearch()
      }}
      onKeyDown={onKeyDown}
    />
  )
}

/** Rows shown on the "Using agents" card before "+N more". */
const AGENT_ROWS = 3

/** Recently seen agents (36): the active one with a presence dot, idle ones muted. */
function AgentRows({ agents }: { agents: readonly McpAgentInfo[] }) {
  const now = useNow()
  const sorted = [...agents].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const extra = sorted.length - AGENT_ROWS
  return (
    <div className={css.agentRows} data-testid="home-agents">
      {sorted.slice(0, AGENT_ROWS).map((a) => {
        const active = isAgentActive(a, now)
        return (
          <div key={`${a.name}|${a.client}`} className={css.agentRow}>
            <Avatar size={22} variant={active ? 'agent' : 'idle'} presence={active} />
            <div className={css.agentText}>
              <div className={css.agentName}>{a.name}</div>
              <div className={css.agentActivity}>{homeAgentLine(a, now)}</div>
            </div>
          </div>
        )
      })}
      {extra > 0 && <div className={css.agentMore}>+{extra} more</div>}
    </div>
  )
}

/** The "Using agents" card: "Get started" until an agent has connected, then its agents. */
function AgentsCard({ onDismiss }: { onDismiss: () => void }) {
  const status = useMcpStatus()
  const agents = status?.agents ?? []
  const open = () => useUi.getState().openDialog({ kind: 'mcp' })
  if (agents.length === 0) {
    return (
      <PromoCard
        title="Using agents"
        onDismiss={onDismiss}
        action={
          <Button
            variant="secondary"
            textSize={12}
            fullWidth
            className={css.getStarted}
            trailingIcon={<ChevronRightIcon size={13} />}
            onClick={open}
          >
            Get started
          </Button>
        }
      >
        Enable agentic workflows with the built-in MCP server.
      </PromoCard>
    )
  }
  return (
    <PromoCard
      title="Using agents"
      onDismiss={onDismiss}
      action={
        <Button variant="secondary" textSize={12} fullWidth onClick={open}>
          Agent settings
        </Button>
      }
    >
      <AgentRows agents={agents} />
    </PromoCard>
  )
}

/** Home sidebar (artboards 01–03, 17). */
export const HomeSidebar = memo(function HomeSidebar({ active }: { active: SidebarItem }) {
  const [, navigate] = useLocation()
  const status = useSession((s) => s.status)
  const team = useCurrentTeam()
  const hasTeams = useSession((s) => s.teams.length > 0)
  const dismissed = useUi((s) => s.dismissed)
  const dismissCard = useUi((s) => s.dismissCard)
  const openDialog = useUi((s) => s.openDialog)
  const signedIn = status === 'signedIn'

  // Search filters files: from a team page, jump to the Files view.
  const onSearch = useCallback(() => {
    if (active === 'settings') navigate(paths.files)
  }, [active, navigate])

  // Signed in with a team, Settings opens it; otherwise the first team row leads to one.
  let teamHeading = null
  if (signedIn && !hasTeams) {
    teamHeading = (
      <NavItem
        icon={<UsersIcon size={15} />}
        strong
        onClick={() => openDialog({ kind: 'createTeam' })}
      >
        Create a team
      </NavItem>
    )
  } else if (!signedIn) {
    teamHeading = (
      <NavItem icon={<UsersIcon size={15} />} strong onClick={() => navigate(paths.signIn)}>
        Sign in to collaborate
      </NavItem>
    )
  }

  const canInvite = signedIn && team !== null && team.role !== 'viewer'

  return (
    <Sidebar aria-label="Home">
      <AccountMenu />
      <SidebarSearch onSearch={onSearch} />
      <SidebarNav divided aria-label="Primary">
        <NavItem
          icon={<ClockIcon size={15} />}
          active={active === 'recents'}
          onClick={() => navigate(paths.recents)}
        >
          Recents
        </NavItem>
      </SidebarNav>
      <SidebarNav aria-label="Team">
        {teamHeading}
        <NavItem
          icon={<LayoutGridIcon size={15} />}
          active={active === 'files'}
          onClick={() => navigate(paths.files)}
        >
          Files
        </NavItem>
        <NavItem
          icon={<ArchiveIcon size={15} />}
          active={active === 'archive'}
          onClick={() => navigate(paths.archive)}
        >
          Archive
        </NavItem>
        {signedIn && team && (
          <NavItem
            icon={<SettingsIcon size={15} />}
            active={active === 'settings'}
            onClick={() => navigate(paths.teamMembers)}
          >
            Settings
          </NavItem>
        )}
      </SidebarNav>
      {canInvite && !dismissed.invite && (
        <PromoCard
          title="Add members to your team"
          onDismiss={() => dismissCard('invite')}
          action={
            <Button
              variant="secondary"
              textSize={12}
              fullWidth
              leadingIcon={<UserIcon size={13} />}
              onClick={() => openDialog({ kind: 'invite' })}
            >
              Invite members
            </Button>
          }
        >
          Design is better with others. Add your colleagues to collaborate.
        </PromoCard>
      )}
      <SidebarSpacer />
      {!dismissed.agents && <AgentsCard onDismiss={() => dismissCard('agents')} />}
      <FooterLinks className={css.footer} links={FOOTER} />
    </Sidebar>
  )
})
