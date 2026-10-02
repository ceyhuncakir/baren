import { useRef, useState } from 'react'
import {
  ArrowUpRightIcon,
  Avatar,
  Button,
  CheckIcon,
  ContextMenu,
  DropdownMenu,
  LinkIcon,
  Menu,
  MenuBarItem,
  MenuControlRow,
  MenuHeader,
  MenuInput,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PersonRow,
  PlusIcon,
  Popover,
  PopoverFooter,
  PopoverHeader,
  PopoverPanel,
  Segmented,
  SelectTrigger,
  Submenu,
  TitleBar,
  UsersIcon,
  GlobeIcon,
  WindowControls,
  Input,
  useContextMenu,
  ZoomChip,
  ShareButton,
} from '../../src'
import { Page, Row, Section, Specimen } from '../kit'
import {
  AppMenuBar,
  EditMenuItems,
  FileMenuItems,
  HelpMenuItems,
  ViewMenuItems,
  WindowMenuItems,
} from '../menus'

export function ShellPage() {
  return (
    <Page title="Shell">
      <Section title="TitleBar (live menu bar, drag region, window controls)">
        <Specimen label="title bar · Recents" width="100%">
          <TitleBar title="Recents" menu={<AppMenuBar />} controls={<WindowControls />} />
        </Specimen>
        <Specimen label="title bar · Team › Members · maximized" width="100%">
          <TitleBar
            title="Team › Members"
            menu={<AppMenuBar />}
            controls={<WindowControls maximized />}
          />
        </Specimen>
        <Row>
          <Specimen label="MenuBarItem default">
            <MenuBarItem>File</MenuBarItem>
          </Specimen>
          <Specimen label="hover">
            <MenuBarItem data-hover="">Edit</MenuBarItem>
          </Specimen>
          <Specimen label="open">
            <MenuBarItem aria-expanded>View</MenuBarItem>
          </Specimen>
        </Row>
      </Section>

      <Section title="Menus (static, as in 09–13)">
        <Row>
          <Specimen label="File · 248 · highlighted row">
            <Menu width={248}>
              <FileMenuItems highlight />
            </Menu>
          </Specimen>
          <Specimen label="Edit · disabled Redo">
            <Menu width={248}>
              <EditMenuItems highlight />
            </Menu>
          </Specimen>
          <Specimen label="View · 300">
            <Menu width={300}>
              <ViewMenuItems highlight />
            </Menu>
          </Specimen>
          <Specimen label="Window · 200">
            <Menu width={200}>
              <WindowMenuItems highlight />
            </Menu>
          </Specimen>
          <Specimen label="Help · 220">
            <Menu width={220}>
              <HelpMenuItems highlight />
            </Menu>
          </Specimen>
        </Row>
      </Section>

      <Section title="Context menu + submenu (15), zoom menu (16), account menu (17)">
        <Row>
          <Specimen label="context menu · submenu trigger open · destructive">
            <Menu width={244}>
              <StaticContextItems />
            </Menu>
          </Specimen>
          <Specimen label="submenu · Copy as · 200">
            <Menu width={200}>
              <MenuItem shortcut="Ctrl+Alt+C" data-highlighted="">
                HTML
              </MenuItem>
              <MenuItem>React (JSX)</MenuItem>
              <MenuItem>CSS</MenuItem>
              <MenuItem>SVG</MenuItem>
              <MenuSeparator />
              <MenuItem shortcut="1×">PNG</MenuItem>
              <MenuItem shortcut="2×">PNG</MenuItem>
              <MenuSeparator />
              <MenuItem>Link to selection</MenuItem>
            </Menu>
          </Specimen>
          <Specimen label="zoom · input row · checkable · inset">
            <Menu width={248}>
              <ZoomItems />
            </Menu>
          </Specimen>
          <Specimen label="account · header · label · icon rows · control row">
            <Menu width={264}>
              <AccountItems />
            </Menu>
          </Specimen>
        </Row>
      </Section>

      <Section title="Live floating layers">
        <Row align="center">
          <LiveDropdown />
          <LiveContextMenu />
          <LiveSharePopover />
          <LiveZoom />
        </Row>
      </Section>

      <Section title="Popover panel (share, 08)">
        <PopoverPanel style={{ width: 360 }}>
          <ShareContent onClose={() => undefined} />
        </PopoverPanel>
      </Section>
    </Page>
  )
}

function StaticContextItems() {
  return (
    <>
      <MenuItem shortcut="Ctrl+C">Copy</MenuItem>
      <MenuItem shortcut="Ctrl+V">Paste here</MenuItem>
      <MenuItem shortcut="Ctrl+D">Duplicate</MenuItem>
      <MenuItem submenu data-open="">
        Copy as
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="Shift+A">Add flex layout</MenuItem>
      <MenuItem shortcut="Ctrl+Alt+G">Wrap in frame</MenuItem>
      <MenuItem shortcut="Ctrl+]">Bring to front</MenuItem>
      <MenuItem shortcut="Ctrl+[">Send to back</MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="F2">Rename</MenuItem>
      <MenuItem shortcut="Ctrl+Shift+L">Lock</MenuItem>
      <MenuItem shortcut="Ctrl+Shift+H">Hide</MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="Del" destructive>
        Delete
      </MenuItem>
    </>
  )
}

export function ZoomItems({ highlight = true }: { highlight?: boolean }) {
  const [grid, setGrid] = useState(true)
  const [snap, setSnap] = useState(true)
  return (
    <>
      <MenuInput defaultValue="100%" hint="Enter" aria-label="Zoom level" />
      <MenuItem inset shortcut="Ctrl+=" data-highlighted={highlight ? '' : undefined}>
        Zoom in
      </MenuItem>
      <MenuItem inset shortcut="Ctrl+-">
        Zoom out
      </MenuItem>
      <MenuItem inset shortcut="Shift+1">
        Zoom to fit
      </MenuItem>
      <MenuItem inset shortcut="Shift+2" disabled>
        Zoom to selection
      </MenuItem>
      <MenuSeparator />
      <MenuItem checked={false}>50%</MenuItem>
      <MenuItem checked shortcut="Ctrl+0">
        100%
      </MenuItem>
      <MenuItem checked={false}>200%</MenuItem>
      <MenuSeparator />
      <MenuItem checked={grid} keepOpen shortcut="Ctrl+'" onSelect={() => setGrid((v) => !v)}>
        Pixel grid
      </MenuItem>
      <MenuItem checked={snap} keepOpen onSelect={() => setSnap((v) => !v)}>
        Snap to pixel grid
      </MenuItem>
      <MenuItem checked={false} shortcut="Shift+R">
        Rulers
      </MenuItem>
      <MenuItem checked={false} shortcut="Ctrl+Y">
        Outline mode
      </MenuItem>
    </>
  )
}

export function AccountItems() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light')
  return (
    <>
      <MenuHeader
        avatar={<Avatar name="ceyhun cakir" size={32} />}
        title="ceyhun cakir"
        subtitle="ceyhun@example.com"
      />
      <MenuSeparator style={{ paddingTop: 3 }} />
      <MenuLabel>Teams</MenuLabel>
      <MenuItem
        icon={<Avatar name="ceyhun's Team" initials="c" size={18} shape="square" color="#1A1A1A" />}
        trailing={<CheckIcon size={13} strokeWidth={2.5} />}
        data-highlighted=""
      >
        ceyhun's Team
      </MenuItem>
      <MenuItem
        icon={<Avatar name="Acme Labs" initials="i" size={18} shape="square" color="#C8F230" />}
      >
        Acme Labs
      </MenuItem>
      <MenuItem icon={<PlusIcon size={14} strokeWidth={2} />} muted>
        Create team
      </MenuItem>
      <MenuSeparator />
      <MenuControlRow
        label="Theme"
        control={
          <Segmented
            size={22}
            textSize={11}
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        }
      />
      <MenuItem shortcut="Ctrl+,">Preferences</MenuItem>
      <MenuItem shortcut="Ctrl+/">Keyboard shortcuts</MenuItem>
      <MenuSeparator />
      <MenuItem>Log out</MenuItem>
    </>
  )
}

function LiveDropdown() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <Specimen label="DropdownMenu (account)">
      <Button
        variant="outline"
        size={30}
        ref={ref}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Account menu
      </Button>
      <DropdownMenu open={open} onOpenChange={setOpen} anchorRef={ref} width={264} offset={2}>
        <AccountItems />
      </DropdownMenu>
    </Specimen>
  )
}

function LiveContextMenu() {
  const menu = useContextMenu()
  return (
    <Specimen label="ContextMenu (right-click the box)">
      <div
        onContextMenu={menu.onContextMenu}
        data-testid="context-target"
        style={{
          width: 220,
          height: 80,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 8,
          background: 'var(--color-canvas)',
          color: 'var(--color-foreground-muted)',
        }}
      >
        Right-click me
      </div>
      <ContextMenu open={menu.open} x={menu.x} y={menu.y} onClose={menu.close}>
        <MenuItem shortcut="Ctrl+C">Copy</MenuItem>
        <MenuItem shortcut="Ctrl+V">Paste here</MenuItem>
        <MenuItem shortcut="Ctrl+D">Duplicate</MenuItem>
        <Submenu label="Copy as">
          <MenuItem shortcut="Ctrl+Alt+C">HTML</MenuItem>
          <MenuItem>React (JSX)</MenuItem>
          <MenuItem>CSS</MenuItem>
          <MenuItem>SVG</MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="1×">PNG</MenuItem>
          <MenuItem shortcut="2×">PNG</MenuItem>
        </Submenu>
        <MenuSeparator />
        <MenuItem shortcut="F2">Rename</MenuItem>
        <MenuItem shortcut="Del" destructive>
          Delete
        </MenuItem>
      </ContextMenu>
    </Specimen>
  )
}

function LiveSharePopover() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <Specimen label="Popover (share)">
      <ShareButton ref={ref} open={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onOpenChange={setOpen} anchorRef={ref} aria-label="Share acme">
        <ShareContent onClose={() => setOpen(false)} />
      </Popover>
    </Specimen>
  )
}

function LiveZoom() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <Specimen label="ZoomChip + zoom menu">
      <ZoomChip ref={ref} zoom={100} open={open} onClick={() => setOpen((v) => !v)} />
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={ref}
        placement="bottom-end"
        offset={5}
        width={248}
      >
        <ZoomItems highlight={false} />
      </DropdownMenu>
    </Specimen>
  )
}

export function ShareContent({ onClose }: { onClose: () => void }) {
  return (
    <>
      <PopoverHeader title="Share acme" onClose={onClose} />
      <div style={{ display: 'flex', gap: 6, padding: '12px 16px 14px' }}>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <Input
            variant="filled"
            size={32}
            textSize={12}
            placeholder="Add people by email"
            controlClassName="pg-share-input"
            trailing={
              <SelectTrigger variant="ghost" size={24}>
                can edit
              </SelectTrigger>
            }
          />
        </div>
        <Button variant="primary" size={32} textSize={12}>
          Invite
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', padding: '0 8px 8px' }}>
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
            <SelectTrigger variant="ghost" size={24} style={{ marginRight: -6 }}>
              can edit
            </SelectTrigger>
          }
        />
        <PersonRow
          avatar={
            <Avatar size={28} shape="square" variant="muted" icon={<UsersIcon size={14} />} />
          }
          name="Everyone at ceyhun's Team"
          secondary="3 members"
          trailing={
            <SelectTrigger variant="ghost" size={24} style={{ marginRight: -6 }}>
              can edit
            </SelectTrigger>
          }
        />
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '12px 16px 14px',
          borderTop: '1px solid var(--color-border)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            lineHeight: '14px',
            color: 'var(--color-foreground-muted)',
          }}
        >
          General access
        </div>
        <PersonRow
          style={{ padding: 0, height: 'auto' }}
          avatar={<Avatar size={28} variant="accent" icon={<GlobeIcon size={14} />} />}
          name="Anyone with the link"
          secondary="Team default"
          trailing={
            <SelectTrigger variant="ghost" size={24} style={{ marginRight: -6 }}>
              can view
            </SelectTrigger>
          }
        />
      </div>
      <PopoverFooter>
        <Button variant="link-muted" textSize={12} leadingIcon={<ArrowUpRightIcon size={13} />}>
          Export
        </Button>
        <Button variant="outline" size={30} textSize={12} leadingIcon={<LinkIcon size={13} />}>
          Copy link
        </Button>
      </PopoverFooter>
    </>
  )
}
