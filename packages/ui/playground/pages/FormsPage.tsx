import { useState } from 'react'
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  Button,
  Checkbox,
  CodeInput,
  CopyIcon,
  Divider,
  GlobeIcon,
  IconButton,
  Input,
  Kbd,
  LayoutGridIcon,
  LinkIcon,
  ListIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PasswordStrength,
  PlusIcon,
  Radio,
  RadioGroup,
  SearchField,
  SearchIcon,
  Segmented,
  Select,
  SelectTrigger,
  Slider,
  Spinner,
  Switch,
  Tabs,
  TextArea,
  UserIcon,
  XIcon,
  type ButtonVariant,
} from '../../src'
import { Page, Row, Section, Specimen, Surface } from '../kit'

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'raised',
]

export function FormsPage() {
  return (
    <Page title="Forms">
      <ButtonsSection />
      <IconButtonsSection />
      <InputsSection />
      <SelectsSection />
      <ChoiceSection />
      <SegmentedSection />
      <MiscSection />
    </Page>
  )
}

function ButtonsSection() {
  return (
    <Section title="Button — variants × states">
      {VARIANTS.map((v) => (
        <Row key={v} align="center">
          <Specimen label={`${v} · default`}>
            <Button variant={v}>Button</Button>
          </Specimen>
          <Specimen label="hover">
            <Button variant={v} data-hover="">
              Button
            </Button>
          </Specimen>
          <Specimen label="active">
            <Button variant={v} data-active="">
              Button
            </Button>
          </Specimen>
          <Specimen label="disabled">
            <Button variant={v} disabled>
              Button
            </Button>
          </Specimen>
          <Specimen label="loading">
            <Button variant={v} loading>
              Button
            </Button>
          </Specimen>
        </Row>
      ))}
      <Row align="center">
        <Specimen label="link (13 medium)">
          <Button variant="link">Create an account</Button>
        </Specimen>
        <Specimen label="link-muted">
          <Button variant="link-muted">Forgot password?</Button>
        </Specimen>
        <Specimen label="link-muted + icon, 12px">
          <Button variant="link-muted" textSize={12} leadingIcon={<ArrowUpRightIcon size={13} />}>
            Export
          </Button>
        </Specimen>
      </Row>
      <Row align="center">
        <Specimen label="26 · outline Share">
          <Button variant="outline" size={26}>
            Share
          </Button>
        </Specimen>
        <Specimen label="26 · pressed">
          <Button variant="outline" size={26} pressed>
            Share
          </Button>
        </Specimen>
        <Specimen label="28 · outline + icon">
          <Button variant="outline" size={28} leadingIcon={<CopyIcon size={12} />}>
            Copy
          </Button>
        </Specimen>
        <Specimen label="30 · primary + icon">
          <Button leadingIcon={<PlusIcon size={14} />}>New file</Button>
        </Specimen>
        <Specimen label="30 · primary Invite members">
          <Button leadingIcon={<UserIcon size={14} />}>Invite members</Button>
        </Specimen>
        <Specimen label="30 · outline 12px + icon">
          <Button variant="outline" textSize={12} leadingIcon={<LinkIcon size={13} />}>
            Copy link
          </Button>
        </Specimen>
        <Specimen label="32 · primary 12px">
          <Button size={32} textSize={12}>
            Invite
          </Button>
        </Specimen>
        <Specimen label="32 · destructive">
          <Button variant="destructive" size={32}>
            Delete team
          </Button>
        </Specimen>
      </Row>
      <Row>
        <Specimen label="30 · secondary 12px full width (sidebar card)" width={193}>
          <Button variant="secondary" textSize={12} fullWidth leadingIcon={<UserIcon size={13} />}>
            Invite members
          </Button>
        </Specimen>
        <Specimen label="secondary + trailing chevron" width={193}>
          <Button
            variant="secondary"
            textSize={12}
            fullWidth
            style={{ gap: 4 }}
            trailingIcon={<ArrowRightIcon size={13} />}
          >
            Get started
          </Button>
        </Specimen>
        <Specimen label="28 · outline full width" width={239}>
          <Button variant="outline" size={28} fullWidth>
            Connect your agent
          </Button>
        </Specimen>
      </Row>
      <Row>
        <Specimen label="40 · auth" width={368}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button size={40} fullWidth trailingIcon={<ArrowRightIcon size={14} />}>
              Sign in
            </Button>
            <Button size={40} fullWidth disabled>
              Verify email
            </Button>
            <Button
              variant="raised"
              size={40}
              fullWidth
              trailingIcon={<ArrowUpRightIcon size={13} />}
            >
              Open browser again
            </Button>
          </div>
        </Specimen>
      </Row>
    </Section>
  )
}

function IconButtonsSection() {
  return (
    <Section title="IconButton">
      <Row align="center">
        <Specimen label="26 r4 panel toggle">
          <IconButton label="Toggle sidebar" size={26} radius="sm">
            <PanelLeftIcon size={15} />
          </IconButton>
        </Specimen>
        <Specimen label="hover">
          <IconButton label="Toggle sidebar" size={26} radius="sm" data-hover="">
            <PanelLeftIcon size={15} />
          </IconButton>
        </Specimen>
        <Specimen label="24 close">
          <IconButton label="Close" size={24} radius="sm">
            <XIcon size={14} />
          </IconButton>
        </Specimen>
        <Specimen label="30 search">
          <IconButton label="Search members" size={30}>
            <SearchIcon size={15} />
          </IconButton>
        </Specimen>
        <Specimen label="32×28 more">
          <IconButton label="More" size={28} width={32}>
            <MoreHorizontalIcon size={16} />
          </IconButton>
        </Specimen>
        <Specimen label="active (pressed)">
          <IconButton label="More" size={28} width={32} active>
            <MoreHorizontalIcon size={16} />
          </IconButton>
        </Specimen>
        <Specimen label="disabled">
          <IconButton label="More" size={28} width={32} disabled>
            <MoreHorizontalIcon size={16} />
          </IconButton>
        </Specimen>
      </Row>
    </Section>
  )
}

function InputsSection() {
  const [email, setEmail] = useState('ceyhun@example.com')
  const [password, setPassword] = useState('baren12!')
  return (
    <Section title="Input">
      <Row>
        <Specimen label="outline 40 · placeholder" width={368}>
          <Input label="Email" placeholder="you@company.com" />
        </Specimen>
        <Specimen label="outline 40 · value · focused look" width={368}>
          <Input
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            controlProps={{ 'data-focus': '' }}
          />
        </Specimen>
        <Specimen label="label action · password · revealable" width={368}>
          <Input
            label="Password"
            labelAction={
              <Button variant="link-muted" textSize={12}>
                Forgot password?
              </Button>
            }
            placeholder="Enter your password"
            revealable
          />
        </Specimen>
      </Row>
      <Row>
        <Specimen label="password value + strength + hint" width={368}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Input
              label="Password"
              revealable
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <PasswordStrength password={password} />
            <div
              style={{ fontSize: 12, lineHeight: '16px', color: 'var(--color-foreground-muted)' }}
            >
              At least 8 characters, including a number.
            </div>
          </div>
        </Specimen>
        <Specimen label="error" width={368}>
          <Input
            label="Workspace URL"
            defaultValue="acme corp"
            error="Use lowercase letters, numbers and dashes only."
          />
        </Specimen>
        <Specimen label="disabled + hint" width={368}>
          <Input
            label="Full name"
            defaultValue="Defne Aydın"
            disabled
            hint="Managed by your organization."
          />
        </Specimen>
      </Row>
      <Row>
        <Specimen label="filled 32 · team name" width={240}>
          <Input variant="filled" defaultValue="ceyhun's Team" />
        </Specimen>
        <Specimen label="filled 32 · hover" width={240}>
          <Input
            variant="filled"
            defaultValue="ceyhun's Team"
            controlProps={{ 'data-hover': '' }}
          />
        </Specimen>
        <Specimen label="filled 32 · 12px + trailing select" width={260}>
          <Input
            variant="filled"
            textSize={12}
            placeholder="Add people by email"
            controlClassName="pg-share-input"
            trailing={
              <SelectTrigger variant="ghost" size={24}>
                can edit
              </SelectTrigger>
            }
          />
        </Specimen>
        <Specimen label="leading icon" width={240}>
          <Input
            variant="filled"
            leadingIcon={<GlobeIcon size={14} />}
            placeholder="Leading icon"
          />
        </Specimen>
      </Row>
      <Row>
        <Specimen label="SearchField 30 · shortcut" width={219}>
          <Surface padding={0}>
            <SearchField shortcut="Ctrl F" />
          </Surface>
        </Specimen>
        <Specimen label="SearchField 28 · trailing +" width={220}>
          <SearchField
            size={28}
            placeholder="Search tokens"
            trailing={
              <IconButton label="Add token" size={18} radius="sm" bare>
                <PlusIcon size={14} />
              </IconButton>
            }
          />
        </Specimen>
        <Specimen label="TextArea (11px)" width={239}>
          <TextArea defaultValue="Canvas selection, focus rings, active artboard label" />
        </Specimen>
      </Row>
    </Section>
  )
}

function SelectsSection() {
  const [access, setAccess] = useState<'link' | 'team' | 'private'>('link')
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('editor')
  return (
    <Section title="Select">
      <Row align="center">
        <Specimen label="filled 32 · leading icon" width={240}>
          <SelectTrigger fullWidth leadingIcon={<GlobeIcon size={14} />}>
            Anyone with the link
          </SelectTrigger>
        </Specimen>
        <Specimen label="open" width={240}>
          <SelectTrigger fullWidth open leadingIcon={<GlobeIcon size={14} />}>
            Anyone with the link
          </SelectTrigger>
        </Specimen>
        <Specimen label="placeholder" width={240}>
          <SelectTrigger fullWidth placeholder="Choose access" />
        </Specimen>
        <Specimen label="disabled" width={240}>
          <SelectTrigger fullWidth disabled>
            Daily
          </SelectTrigger>
        </Specimen>
      </Row>
      <Row align="center">
        <Specimen label="filled 26 · role chip">
          <SelectTrigger size={26}>Editor</SelectTrigger>
        </Specimen>
        <Specimen label="ghost 24">
          <SelectTrigger variant="ghost">can edit</SelectTrigger>
        </Specimen>
        <Specimen label="ghost hover">
          <SelectTrigger variant="ghost" data-hover="">
            can view
          </SelectTrigger>
        </Specimen>
        <Specimen label="live Select" width={240}>
          <Select
            fullWidth
            leadingIcon={<GlobeIcon size={14} />}
            value={access}
            onChange={setAccess}
            options={[
              { value: 'link', label: 'Anyone with the link' },
              { value: 'team', label: 'Only team members' },
              { value: 'private', label: 'Only invited people' },
            ]}
          />
        </Specimen>
        <Specimen label="live Select 26">
          <Select
            size={26}
            value={role}
            onChange={setRole}
            options={[
              { value: 'admin', label: 'Admin' },
              { value: 'editor', label: 'Editor' },
              { value: 'viewer', label: 'Viewer' },
            ]}
          />
        </Specimen>
      </Row>
    </Section>
  )
}

function ChoiceSection() {
  const [agree, setAgree] = useState(true)
  const [alerts, setAlerts] = useState(true)
  const [clip, setClip] = useState(true)
  const [mode, setMode] = useState<string | null>('critical')
  return (
    <Section title="Checkbox · Radio">
      <Row>
        <Specimen label="md checked">
          <Checkbox label="Email alerts" checked={alerts} onCheckedChange={setAlerts} />
        </Specimen>
        <Specimen label="md unchecked">
          <Checkbox label="Weekly digest" defaultChecked={false} />
        </Specimen>
        <Specimen label="indeterminate">
          <Checkbox label="Some layers" indeterminate />
        </Specimen>
        <Specimen label="disabled">
          <Checkbox label="Disabled" disabled defaultChecked />
        </Specimen>
        <Specimen label="muted, 12px" width={368}>
          <Checkbox
            tone="muted"
            checked={agree}
            onCheckedChange={setAgree}
            label="Email me when someone shares a file with me."
          />
        </Specimen>
        <Specimen label="sm inspector + shortcut">
          <Surface>
            <Checkbox
              size="sm"
              label="Clip content"
              shortcut="Alt+C"
              checked={clip}
              onCheckedChange={setClip}
            />
          </Surface>
        </Specimen>
      </Row>
      <Row>
        <Specimen label="Switch on (34)">
          <Switch label="MCP server" checked={alerts} onCheckedChange={setAlerts} />
        </Specimen>
        <Specimen label="Switch off">
          <Switch label="Off" checked={false} />
        </Specimen>
        <Specimen label="Switch disabled">
          <Switch label="Disabled" checked disabled />
        </Specimen>
      </Row>
      <Row>
        <Specimen label="RadioGroup">
          <RadioGroup value={mode} onValueChange={setMode}>
            <Radio value="critical" label="Critical only" />
            <Radio value="all" label="All findings" />
            <Radio value="none" label="Disabled option" disabled />
          </RadioGroup>
        </Specimen>
      </Row>
    </Section>
  )
}

function SegmentedSection() {
  const [mode, setMode] = useState<'design' | 'theme'>('design')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [tab, setTab] = useState<'members' | 'settings'>('members')
  const [radius, setRadius] = useState(0)
  const [opacity, setOpacity] = useState(64)
  return (
    <Section title="Segmented · Tabs · Slider">
      <Row align="center">
        <Specimen label="mode switch (fullWidth, 24)" width={219}>
          <Segmented
            fullWidth
            value={mode}
            onChange={setMode}
            options={[
              { value: 'design', label: 'Design' },
              { value: 'theme', label: 'Theme' },
            ]}
          />
        </Specimen>
        <Specimen label="theme (22, 11px)">
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
        </Specimen>
        <Specimen label="view toggle (surface, 26×24)">
          <Segmented
            variant="surface"
            itemWidth={26}
            value={view}
            onChange={setView}
            options={[
              { value: 'grid', icon: <LayoutGridIcon size={14} />, 'aria-label': 'Grid view' },
              { value: 'list', icon: <ListIcon size={14} />, 'aria-label': 'List view' },
            ]}
          />
        </Specimen>
        <Specimen label="disabled option">
          <Segmented
            value="a"
            onChange={() => undefined}
            options={[
              { value: 'a', label: 'Enabled' },
              { value: 'b', label: 'Disabled', disabled: true },
            ]}
          />
        </Specimen>
      </Row>
      <Row align="center">
        <Specimen label="Tabs (underline)">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'members', label: 'Members' },
              { value: 'settings', label: 'Settings' },
            ]}
          />
        </Specimen>
        <Specimen label="Slider (radius 0..100)" width={167}>
          <Slider aria-label="Radius" value={radius} onChange={setRadius} />
        </Specimen>
        <Specimen label="Slider value 64" width={167}>
          <Slider aria-label="Opacity" value={opacity} onChange={setOpacity} />
        </Specimen>
        <Specimen label="Slider disabled" width={167}>
          <Slider aria-label="Disabled" value={30} onChange={() => undefined} disabled />
        </Specimen>
      </Row>
    </Section>
  )
}

function MiscSection() {
  const [code, setCode] = useState('4827')
  const [code2, setCode2] = useState('')
  return (
    <Section title="CodeInput · PasswordStrength · Divider · Spinner · Kbd">
      <Row>
        <Specimen label="CodeInput · focused look (4827)">
          <CodeInput value={code} onChange={setCode} showFocus aria-label="Verification code" />
        </Specimen>
        <Specimen label="CodeInput · live, empty">
          <CodeInput value={code2} onChange={setCode2} aria-label="Verification code" />
        </Specimen>
        <Specimen label="CodeInput · invalid">
          <CodeInput
            value="482703"
            onChange={() => undefined}
            invalid
            aria-label="Verification code"
          />
        </Specimen>
      </Row>
      <Row>
        {([0, 1, 2, 3, 4] as const).map((s) => (
          <Specimen key={s} label={`strength ${s}`} width={240}>
            <PasswordStrength score={s} />
          </Specimen>
        ))}
      </Row>
      <Row align="center">
        <Specimen label="Divider with label" width={368}>
          <Divider label="or with email" />
        </Specimen>
        <Specimen label="Divider" width={200}>
          <Divider />
        </Specimen>
        <Specimen label="Spinner 16">
          <Spinner label="Loading" />
        </Specimen>
        <Specimen label="Spinner 24">
          <Spinner size={24} />
        </Specimen>
        <Specimen label="Spinner inverse">
          <div style={{ padding: 6, background: 'var(--color-primary)', borderRadius: 6 }}>
            <Spinner tone="inverse" />
          </div>
        </Specimen>
        <Specimen label="Kbd">
          <div style={{ display: 'flex', gap: 6 }}>
            <Kbd>A</Kbd>
            <Kbd>Ctrl</Kbd>
            <Kbd>⇧</Kbd>
          </div>
        </Specimen>
      </Row>
    </Section>
  )
}
