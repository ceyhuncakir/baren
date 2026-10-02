import {
  AccountTrigger,
  ArchiveIcon,
  AuthHeading,
  Avatar,
  AvatarStack,
  Badge,
  BrandLockup,
  BrowserOpenIcon,
  Button,
  Callout,
  ClockIcon,
  FileCard,
  FileGrid,
  FooterLinks,
  GlobeIcon,
  GraduationCapIcon,
  IconButton,
  IconTile,
  LayoutGridIcon,
  LogoMark,
  MailIcon,
  MemberCell,
  MoreHorizontalIcon,
  NavItem,
  PageTitle,
  PencilIcon,
  PersonRow,
  PromoCard,
  SearchField,
  SelectTrigger,
  SettingsIcon,
  Sidebar,
  SidebarNav,
  SidebarSpacer,
  Status,
  StatusDot,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Toast,
  toast,
  UserIcon,
  UsersIcon,
  ChevronRightIcon,
} from '../../src'
import { Page, Row, Section, Specimen } from '../kit'

export function DisplayPage() {
  return (
    <Page title="Display">
      <Section title="Avatar">
        <Row align="center">
          {([22, 28, 32, 36] as const).map((s) => (
            <Specimen key={s} label={`${s}`}>
              <Avatar name="ceyhun cakir" size={s} />
            </Specimen>
          ))}
          <Specimen label="36 dark">
            <Avatar name="Defne Aydın" size={36} color="#1A1A1A" />
          </Specimen>
          <Specimen label="team marks 18">
            <div style={{ display: 'flex', gap: 8 }}>
              <Avatar name="ceyhun's Team" initials="c" size={18} shape="square" color="#1A1A1A" />
              <Avatar name="Acme Labs" initials="i" size={18} shape="square" color="#C8F230" />
            </div>
          </Specimen>
          <Specimen label="pending 36">
            <Avatar size={36} variant="pending" icon={<MailIcon size={16} />} />
          </Specimen>
          <Specimen label="group 28">
            <Avatar size={28} shape="square" variant="muted" icon={<UsersIcon size={14} />} />
          </Specimen>
          <Specimen label="accent 28">
            <Avatar size={28} variant="accent" icon={<GlobeIcon size={14} />} />
          </Specimen>
          <Specimen label="stack">
            <AvatarStack>
              <Avatar name="ceyhun cakir" size={28} />
              <Avatar name="Defne Aydın" size={28} color="#1A1A1A" />
            </AvatarStack>
          </Specimen>
          <Specimen label="agent 22 (35)">
            <Avatar name="Claude Code (agent)" size={22} variant="agent" />
          </Specimen>
          <Specimen label="agent + presence (36)">
            <Avatar name="Claude Code" size={22} variant="agent" presence />
          </Specimen>
          <Specimen label="idle agent (36)">
            <Avatar name="Cursor" size={22} variant="idle" />
          </Specimen>
          <Specimen label="person + agent (35)">
            <AvatarStack>
              <Avatar name="ceyhun cakir" size={22} />
              <Avatar name="Claude Code (agent)" size={22} variant="agent" />
            </AvatarStack>
          </Specimen>
        </Row>
      </Section>

      <Section title="Badge · StatusDot">
        <Row align="center">
          <Specimen label="muted">
            <Badge>Invited</Badge>
          </Specimen>
          <Specimen label="outline">
            <Badge variant="outline">Beta</Badge>
          </Specimen>
          <Specimen label="input (usage chips)">
            <div style={{ display: 'flex', gap: 4 }}>
              <Badge variant="input">fill · 38</Badge>
              <Badge variant="input">outline · 96</Badge>
              <Badge variant="input">text · 8</Badge>
            </div>
          </Specimen>
          <Specimen label="selection">
            <Badge variant="selection">New</Badge>
          </Specimen>
          <Specimen label="count">
            <Badge variant="count">13</Badge>
          </Specimen>
          <Specimen label="dots">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <StatusDot tone="success" />
              <StatusDot tone="neutral" />
              <StatusDot tone="accent" />
              <StatusDot tone="danger" />
            </div>
          </Specimen>
          <Specimen label="Status">
            <Status>Not connected</Status>
          </Specimen>
          <Specimen label="Status success">
            <Status tone="success">Connected</Status>
          </Specimen>
        </Row>
      </Section>

      <Section title="FileCard · FileGrid">
        <div style={{ width: 1088 }}>
          <FileGrid>
            <FileCard
              title="Scratchpad"
              titleAccessory={<PencilIcon size={13} />}
              subtitle="Your permanent draft"
            />
            <FileCard title="Baren" subtitle="Edited just now" thumbnail={<BlocksThumb />} />
            <FileCard title="Hovered" subtitle="Edited 4 minutes ago" data-hover="" />
            <FileCard title="Selected" subtitle="Edited 28 days ago" selected />
          </FileGrid>
        </div>
      </Section>

      <Section title="Sidebar (01) · NavItem states">
        <Row>
          <Specimen label="sidebar 240 × 600">
            <div style={{ height: 600, display: 'flex', border: '1px solid var(--color-border)' }}>
              <HomeSidebar active="recents" />
            </div>
          </Specimen>
          <Specimen label="NavItem states" width={219}>
            <div style={{ background: 'var(--color-surface)', padding: 0 }}>
              <NavItem icon={<ClockIcon size={15} />}>Default</NavItem>
              <NavItem icon={<ClockIcon size={15} />} data-hover="">
                Hover
              </NavItem>
              <NavItem icon={<ClockIcon size={15} />} active>
                Active
              </NavItem>
              <NavItem icon={<UsersIcon size={15} />} strong>
                Strong (team heading)
              </NavItem>
              <NavItem
                icon={<GraduationCapIcon size={15} />}
                trailing={<StatusDot tone="accent" />}
              >
                With dot
              </NavItem>
            </div>
          </Specimen>
          <Specimen label="AccountTrigger · open">
            <div
              style={{
                background: 'var(--color-surface)',
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <AccountTrigger name="ceyhun cakir" />
              <AccountTrigger name="ceyhun cakir" open />
            </div>
          </Specimen>
        </Row>
      </Section>

      <Section title="Members table (02)">
        <div style={{ width: 800 }}>
          <MembersTable />
        </div>
      </Section>

      <Section title="PersonRow (08)">
        <div style={{ width: 344 }}>
          <PersonRow
            avatar={<Avatar name="ceyhun cakir" size={28} />}
            name="ceyhun cakir (you)"
            secondary="ceyhun@example.com"
            trailing="Owner"
          />
          <PersonRow
            avatar={<Avatar name="Defne Aydın" size={28} color="#1A1A1A" />}
            name="Defne Aydın"
            secondary="defne@example.com"
            trailing={
              <SelectTrigger variant="ghost" style={{ marginRight: -6 }}>
                can edit
              </SelectTrigger>
            }
          />
        </div>
      </Section>

      <Section title="Toast">
        <Row align="center">
          <Toast>Link copied to clipboard</Toast>
          <Toast actionLabel="Undo" onAction={() => undefined} onClose={() => undefined}>
            Moved 3 layers to Archive
          </Toast>
          <Button
            variant="outline"
            onClick={() => toast('Saved a copy to Recents', { actionLabel: 'Open' })}
          >
            Show toast
          </Button>
        </Row>
      </Section>

      <Section title="Brand · auth pieces · titles">
        <Row align="center">
          <Specimen label="LogoMark 18">
            <LogoMark />
          </Specimen>
          <Specimen label="LogoMark 26">
            <LogoMark size={26} />
          </Specimen>
          <Specimen label="BrandLockup">
            <BrandLockup />
          </Specimen>
          <Specimen label="IconTile mail">
            <IconTile>
              <MailIcon size={22} strokeWidth={1.6} />
            </IconTile>
          </Specimen>
          <Specimen label="IconTile browser">
            <IconTile>
              <BrowserOpenIcon size={22} />
            </IconTile>
          </Specimen>
        </Row>
        <Row>
          <Specimen label="AuthHeading" width={368}>
            <AuthHeading
              title="Check your email"
              lead="We sent a 6-digit code to defne@example.com. It expires in 10 minutes."
            />
          </Specimen>
          <Specimen label="Callout" width={368}>
            <Callout>
              You can also click the link in the email — we'll bring you back to the app
              automatically.
            </Callout>
          </Specimen>
        </Row>
        <Row>
          <Specimen label="PageTitle 22">
            <PageTitle>Recents</PageTitle>
          </Specimen>
          <Specimen label="PageTitle 24">
            <PageTitle size={24}>ceyhun's Team settings</PageTitle>
          </Specimen>
        </Row>
      </Section>
    </Page>
  )
}

export function BlocksThumb() {
  return (
    <span style={{ display: 'flex', gap: 6 }}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} style={{ width: 44, height: 28, borderRadius: 1, background: '#FFFFFF' }} />
      ))}
    </span>
  )
}

export function HomeSidebar({ active }: { active: 'recents' | 'files' | 'archive' | 'settings' }) {
  return (
    <Sidebar>
      <AccountTrigger name="ceyhun cakir" />
      <SearchField shortcut="Ctrl F" />
      <SidebarNav divided aria-label="Primary">
        <NavItem icon={<ClockIcon size={15} />} active={active === 'recents'}>
          Recents
        </NavItem>
        <NavItem icon={<GraduationCapIcon size={15} />} trailing={<StatusDot tone="accent" />}>
          Learn
        </NavItem>
      </SidebarNav>
      <SidebarNav aria-label="Team">
        <NavItem icon={<UsersIcon size={15} />} strong>
          ceyhun's Team
        </NavItem>
        <NavItem icon={<LayoutGridIcon size={15} />} active={active === 'files'}>
          Files
        </NavItem>
        <NavItem icon={<ArchiveIcon size={15} />} active={active === 'archive'}>
          Archive
        </NavItem>
        <NavItem icon={<SettingsIcon size={15} />} active={active === 'settings'}>
          Settings
        </NavItem>
      </SidebarNav>
      <PromoCard
        title="Add members to your team"
        onDismiss={() => undefined}
        action={
          <Button variant="secondary" textSize={12} fullWidth leadingIcon={<UserIcon size={13} />}>
            Invite members
          </Button>
        }
      >
        Design is better with others. Add your colleagues to collaborate.
      </PromoCard>
      <SidebarSpacer />
      <PromoCard
        title="Using agents"
        onDismiss={() => undefined}
        action={
          <Button
            variant="secondary"
            textSize={12}
            fullWidth
            style={{ gap: 4 }}
            trailingIcon={<ChevronRightIcon size={13} />}
          >
            Get started
          </Button>
        }
      >
        Enable agentic workflows with the built-in MCP server.
      </PromoCard>
      <FooterLinks
        style={{ padding: '4px 4px 0' }}
        links={[{ label: "What's new" }, { label: 'Feedback' }]}
      />
    </Sidebar>
  )
}

function MembersTable() {
  return (
    <Table columns="1fr 160px 160px 32px">
      <TableHeader>
        <TableHeaderCell sort="desc" onClick={() => undefined}>
          Member
        </TableHeaderCell>
        <TableHeaderCell>Role</TableHeaderCell>
        <TableHeaderCell>Last seen</TableHeaderCell>
        <span />
      </TableHeader>
      <TableRow>
        <MemberCell
          avatar={<Avatar name="ceyhun cakir" size={36} />}
          name="ceyhun cakir"
          suffix="(you)"
          secondary="ceyhun@example.com"
        />
        <TableCell>Admin</TableCell>
        <TableCell>
          <StatusDot tone="success" />
          Active now
        </TableCell>
        <IconButton label="More" size={28} width={32}>
          <MoreHorizontalIcon size={16} />
        </IconButton>
      </TableRow>
      <TableRow>
        <MemberCell
          avatar={<Avatar name="Defne Aydın" size={36} color="#1A1A1A" />}
          name="Defne Aydın"
          secondary="defne@example.com"
        />
        <TableCell>
          <SelectTrigger size={26}>Editor</SelectTrigger>
        </TableCell>
        <TableCell>2 hours ago</TableCell>
        <IconButton label="More" size={28} width={32}>
          <MoreHorizontalIcon size={16} />
        </IconButton>
      </TableRow>
      <TableRow>
        <MemberCell
          avatar={<Avatar size={36} variant="pending" icon={<MailIcon size={16} />} />}
          name="mert@example.com"
          badge={<Badge>Invited</Badge>}
          secondary="Resend invite · Revoke"
        />
        <TableCell>Viewer</TableCell>
        <TableCell>—</TableCell>
        <IconButton label="More" size={28} width={32}>
          <MoreHorizontalIcon size={16} />
        </IconButton>
      </TableRow>
    </Table>
  )
}
