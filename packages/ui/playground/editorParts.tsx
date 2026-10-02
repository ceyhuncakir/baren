/**
 * Editor compositions shared by the Editor page and the 06 screen. Values are the ones
 * shown in the artboards; state is local so the controls are interactive.
 */
import { useCallback, useState, type ReactNode } from 'react'
import {
  AlignmentGrid,
  ArrowDownIcon,
  ArrowRightIcon,
  ArtboardToolIcon,
  Avatar,
  Badge,
  Button,
  Checkbox,
  ChipRow,
  CollapsedSection,
  ColorField,
  ColorPicker,
  ComponentIcon,
  CornersIcon,
  DropletIcon,
  DuplicateIcon,
  EditorPanel,
  EyeIcon,
  FieldIconButton,
  FlipIcon,
  FooterLinks,
  GapIcon,
  GenerateToolIcon,
  HandToolIcon,
  IconButton,
  IconToggleGroup,
  ImageIcon,
  ImagePlusIcon,
  InsertToolIcon,
  InspectorColumn,
  InspectorRow,
  InspectorSection,
  InspectorSelect,
  LayerRow,
  LayerTypeIcon,
  LetterSpacingIcon,
  LineHeightIcon,
  LogoMark,
  MaximizeIcon,
  MinusIcon,
  MoreHorizontalIcon,
  NumberField,
  OpacityIcon,
  PaddingBottomIcon,
  PaddingIndividualIcon,
  PaddingLeftIcon,
  PaddingRightIcon,
  PaddingTopIcon,
  PageRow,
  PanelHeader,
  PanelLeftIcon,
  PanelModeSwitch,
  PanelSectionHeader,
  PenToolIcon,
  PipetteIcon,
  PlusIcon,
  PointerToolIcon,
  RectangleToolIcon,
  RotationIcon,
  SectionAction,
  SectionHeaderAction,
  SectionHeaderLink,
  Segmented,
  SelectionColorRow,
  ShareButton,
  SlidersIcon,
  Slider,
  SplitField,
  Stat,
  Status,
  TextAaIcon,
  TextArea,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TokenNameField,
  TokensIcon,
  ToolButton,
  ToolDivider,
  ToolRail,
  WrapIcon,
  ZoomChip,
  hexToHsva,
  hsvaToHex,
  type Alignment,
  type Hsva,
  type LayerKind,
  type LayerRowState,
} from '../src'

/* ---------------- Left panel ---------------- */

export function FileHeader({ name }: { name: string }) {
  return (
    <PanelHeader
      leading={<LogoMark />}
      title={name}
      trailing={
        <IconButton label="Toggle left panel" size={26} radius="sm">
          <PanelLeftIcon size={15} />
        </IconButton>
      }
    />
  )
}

export function ModeSwitch() {
  const [mode, setMode] = useState<'design' | 'theme'>('design')
  return (
    <PanelModeSwitch>
      <Segmented
        fullWidth
        value={mode}
        onChange={setMode}
        options={[
          { value: 'design', label: 'Design' },
          { value: 'theme', label: 'Theme' },
        ]}
      />
    </PanelModeSwitch>
  )
}

export function PagesBlock({ pages, active }: { pages: string[]; active: number }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '6px 0',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <PanelSectionHeader
        title="Pages"
        expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        action={
          <SectionAction label="Add page">
            <PlusIcon size={14} />
          </SectionAction>
        }
      />
      {expanded &&
        pages.map((p, i) => (
          <PageRow key={p} active={i === active}>
            {p}
          </PageRow>
        ))}
    </div>
  )
}

interface DemoLayer {
  id: string
  name: string
  depth: number
  kind: LayerKind
  expandable?: boolean
  expanded?: boolean
  state?: LayerRowState
  hover?: boolean
  locked?: boolean
  hidden?: boolean
}

export const LAYERS_06: DemoLayer[] = [
  '01 Foundations',
  '02 Actions',
  '03 Forms',
  '04 Labels & Status',
  '05 Feedback',
  '06 Navigation',
  '07 Overlays',
  '08 Data Display',
  '09 Brand & Composer',
  '10 App Shell',
  '11 Dashboard Patterns',
  '12 Settings, Billing & Auth',
].map((name, i) => ({
  id: `ab-${i}`,
  name,
  depth: 0,
  kind: 'artboard' as const,
  expandable: true,
  state: i === 2 ? ('selected' as const) : ('idle' as const),
}))

export const LAYERS_14: DemoLayer[] = [
  { id: 'a1', name: '01 Foundations', depth: 0, kind: 'artboard', expandable: true },
  { id: 'a2', name: '02 Actions', depth: 0, kind: 'artboard', expandable: true },
  { id: 'a3', name: '03 Forms', depth: 0, kind: 'artboard', expandable: true, expanded: true },
  { id: 'h', name: 'Header', depth: 1, kind: 'frame-row', expandable: true },
  {
    id: 's',
    name: 'Section / Text input',
    depth: 1,
    kind: 'frame-column',
    expandable: true,
    expanded: true,
  },
  {
    id: 'f',
    name: 'Field / Email',
    depth: 2,
    kind: 'frame-column',
    expandable: true,
    expanded: true,
    state: 'ancestor',
  },
  { id: 'l', name: 'Label', depth: 3, kind: 'text', state: 'selected', hover: true },
  {
    id: 'i',
    name: 'Input',
    depth: 3,
    kind: 'frame-row',
    expandable: true,
    expanded: true,
    state: 'ancestor',
  },
  { id: 'm', name: 'Icon / mail', depth: 4, kind: 'svg', state: 'ancestor' },
  { id: 'p', name: 'Placeholder', depth: 4, kind: 'text', state: 'ancestor' },
  { id: 'hi', name: 'Hint', depth: 3, kind: 'text', state: 'ancestor' },
  { id: 'fp', name: 'Field / Password', depth: 2, kind: 'frame-column', expandable: true },
  {
    id: 'fe',
    name: 'Field / Error state',
    depth: 2,
    kind: 'frame-column',
    expandable: true,
    locked: true,
  },
  {
    id: 'ss',
    name: 'Section / Select',
    depth: 1,
    kind: 'frame-column',
    expandable: true,
    hidden: true,
  },
  { id: 'ft', name: 'Footer', depth: 1, kind: 'frame-row', expandable: true },
]

/** Interactive layer list (selection, rename on double-click, lock/hide toggles). */
export function LayerList({ initial }: { initial: DemoLayer[] }) {
  const [layers, setLayers] = useState(initial)
  const [renaming, setRenaming] = useState<string | null>(null)

  const patch = useCallback((id: string, p: Partial<DemoLayer>) => {
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)))
  }, [])
  const onSelectRow = useCallback((id: string) => {
    setLayers((ls) =>
      ls.map((l) => ({ ...l, hover: false, state: l.id === id ? 'selected' : 'idle' })),
    )
  }, [])
  const onToggleExpanded = useCallback(
    (id: string) =>
      setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, expanded: !l.expanded } : l))),
    [],
  )
  const onToggleLocked = useCallback(
    (id: string) =>
      setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, locked: !l.locked } : l))),
    [],
  )
  const onToggleHidden = useCallback(
    (id: string) =>
      setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, hidden: !l.hidden } : l))),
    [],
  )
  const onRename = useCallback(
    (id: string, name: string) => {
      patch(id, { name })
      setRenaming(null)
    },
    [patch],
  )
  const onRenameCancel = useCallback(() => setRenaming(null), [])

  return (
    <div
      role="tree"
      aria-label="Layers"
      style={{ display: 'flex', flexDirection: 'column', padding: '6px 0' }}
    >
      {layers.map((l) => (
        <LayerRow
          key={l.id}
          id={l.id}
          name={l.name}
          depth={l.depth}
          icon={<LayerTypeIcon kind={l.kind} />}
          expandable={l.expandable}
          expanded={l.expanded}
          state={l.state}
          locked={l.locked}
          hidden={l.hidden}
          renaming={renaming === l.id}
          data-hover={l.hover ? '' : undefined}
          onSelectRow={onSelectRow}
          onToggleExpanded={onToggleExpanded}
          onToggleLocked={onToggleLocked}
          onToggleHidden={onToggleHidden}
          onStartRename={setRenaming}
          onRename={onRename}
          onRenameCancel={onRenameCancel}
        />
      ))}
    </div>
  )
}

export function LeftPanel06() {
  return (
    <EditorPanel side="left">
      <FileHeader name="acme" />
      <ModeSwitch />
      <PagesBlock pages={['Component library', 'Logo', 'Cloud posture']} active={0} />
      <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto' }}>
        <LayerList initial={LAYERS_06} />
      </div>
      <FooterLinks
        style={{ padding: '12px 14px' }}
        links={[{ label: "What's new" }, { label: 'Feedback' }]}
      />
    </EditorPanel>
  )
}

/* ---------------- Tool rail ---------------- */

export function EditorToolRail() {
  const [tool, setTool] = useState('select')
  const t = (id: string, label: string, shortcut: string, icon: ReactNode) => (
    <ToolButton label={label} shortcut={shortcut} active={tool === id} onClick={() => setTool(id)}>
      {icon}
    </ToolButton>
  )
  return (
    <ToolRail aria-label="Tools">
      {t('select', 'Select', 'V', <PointerToolIcon size={16} />)}
      {t('hand', 'Hand', 'H', <HandToolIcon size={16} />)}
      <ToolDivider />
      {t('artboard', 'Artboard', 'A', <ArtboardToolIcon size={16} />)}
      {t('rect', 'Rectangle', 'R', <RectangleToolIcon size={16} />)}
      {t('pen', 'Pen', 'P', <PenToolIcon size={16} />)}
      {t('text', 'Text', 'T', <TextAaIcon size={15} />)}
      {t('insert', 'Insert', 'I', <InsertToolIcon size={16} />)}
      <ToolDivider />
      {t('component', 'Component', 'K', <ComponentIcon size={16} />)}
      {t('image', 'Image', 'Shift+I', <ImagePlusIcon size={16} />)}
      {t('generate', 'Generate', 'G', <GenerateToolIcon size={16} />)}
    </ToolRail>
  )
}

/* ---------------- Inspector ---------------- */

export function InspectorHeader({ zoom }: { zoom: number }) {
  return (
    <PanelHeader
      bordered
      leading={<Avatar name="ceyhun cakir" size={22} />}
      trailing={
        <>
          <ZoomChip zoom={zoom} />
          <ShareButton />
        </>
      }
    />
  )
}

export function LayoutSection() {
  const [x, setX] = useState(2320)
  const [y, setY] = useState(-600)
  const [r, setR] = useState(0)
  const [w, setW] = useState(1440)
  return (
    <InspectorSection
      title="Layout"
      titleChevron
      onTitleClick={() => undefined}
      actions={
        <SectionHeaderAction label="Expand">
          <MaximizeIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <NumberField prefix="X" value={x} onChange={setX} aria-label="X" />
        <NumberField prefix="Y" value={y} onChange={setY} aria-label="Y" />
        <NumberField
          prefix={<RotationIcon size={11} />}
          value={r}
          unit="°"
          width={64}
          onChange={setR}
          aria-label="Rotation"
          style={{ gap: 6 }}
        />
      </InspectorRow>
      <InspectorRow>
        <NumberField prefix="W" value={w} onChange={setW} chevron aria-label="Width" />
        <InspectorSelect prefix="H">Fit</InspectorSelect>
        <SplitField
          buttons={[
            { label: 'Duplicate', icon: <DuplicateIcon size={12} /> },
            { label: 'Flip', icon: <FlipIcon size={12} /> },
          ]}
        />
      </InspectorRow>
    </InspectorSection>
  )
}

export function FlexSection() {
  const [align, setAlign] = useState<Alignment>({ x: 'start', y: 'start' })
  const [dir, setDir] = useState<'column' | 'row'>('column')
  const [gap, setGap] = useState(72)
  const [pad, setPad] = useState({ l: 96, t: 80, r: 96, b: 96 })
  const [clip, setClip] = useState(true)
  return (
    <InspectorSection
      title="Flex"
      actions={
        <SectionHeaderAction label="Remove flex">
          <MinusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <AlignmentGrid value={align} onChange={setAlign} direction={dir} />
        <InspectorColumn>
          <InspectorRow>
            <IconToggleGroup
              fullWidth
              value={dir}
              onChange={setDir}
              options={[
                {
                  value: 'column',
                  icon: <ArrowDownIcon size={12} strokeWidth={2.25} />,
                  'aria-label': 'Vertical',
                },
                {
                  value: 'row',
                  icon: <ArrowRightIcon size={12} strokeWidth={2.25} />,
                  'aria-label': 'Horizontal',
                },
              ]}
              style={{ flex: '1 1 0' }}
            />
            <FieldIconButton label="Wrap">
              <WrapIcon size={12} />
            </FieldIconButton>
          </InspectorRow>
          <NumberField
            prefix={<GapIcon size={11} />}
            value={gap}
            min={0}
            onChange={setGap}
            chevron
            aria-label="Gap"
          />
        </InspectorColumn>
      </InspectorRow>
      <InspectorRow alignTop>
        <InspectorColumn>
          <InspectorRow>
            <NumberField
              prefix={<PaddingLeftIcon size={11} />}
              prefixStrong
              value={pad.l}
              min={0}
              onChange={(v) => setPad({ ...pad, l: v })}
              aria-label="Padding left"
            />
            <NumberField
              prefix={<PaddingTopIcon size={11} />}
              prefixStrong
              value={pad.t}
              min={0}
              onChange={(v) => setPad({ ...pad, t: v })}
              aria-label="Padding top"
            />
          </InspectorRow>
          <InspectorRow>
            <NumberField
              prefix={<PaddingRightIcon size={11} />}
              prefixStrong
              value={pad.r}
              min={0}
              onChange={(v) => setPad({ ...pad, r: v })}
              aria-label="Padding right"
            />
            <NumberField
              prefix={<PaddingBottomIcon size={11} />}
              prefixStrong
              value={pad.b}
              min={0}
              onChange={(v) => setPad({ ...pad, b: v })}
              aria-label="Padding bottom"
            />
          </InspectorRow>
        </InspectorColumn>
        <FieldIconButton label="Individual padding">
          <PaddingIndividualIcon size={12} />
        </FieldIconButton>
      </InspectorRow>
      <div style={{ display: 'flex', alignItems: 'center', height: 20 }}>
        <Checkbox
          size="sm"
          label="Clip content"
          shortcut="Alt+C"
          checked={clip}
          onCheckedChange={setClip}
        />
      </div>
    </InspectorSection>
  )
}

export function RadiusSection() {
  const [radius, setRadius] = useState(0)
  return (
    <InspectorSection
      title="Radius"
      actions={
        <SectionHeaderAction label="Individual corners">
          <CornersIcon size={12} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow style={{ gap: 10 }}>
        <Slider aria-label="Radius" value={radius} max={100} onChange={setRadius} />
        <NumberField
          value={radius}
          min={0}
          width={72}
          chevron
          onChange={setRadius}
          aria-label="Radius value"
        />
      </InspectorRow>
    </InspectorSection>
  )
}

export function BlendingSection() {
  const [opacity, setOpacity] = useState(100)
  return (
    <InspectorSection
      title="Blending"
      actions={
        <SectionHeaderAction label="Toggle visibility">
          <EyeIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <NumberField
          prefix={<OpacityIcon size={11} />}
          value={opacity}
          unit="%"
          min={0}
          max={100}
          onChange={setOpacity}
          aria-label="Opacity"
        />
        <InspectorSelect prefix={<DropletIcon size={11} />}>Normal</InspectorSelect>
      </InspectorRow>
    </InspectorSection>
  )
}

export function FillSection() {
  const [kind, setKind] = useState<'solid' | 'gradient' | 'image'>('solid')
  return (
    <InspectorSection
      title="Fill"
      actions={
        <SectionHeaderAction label="Add fill">
          <PlusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <IconToggleGroup
          itemWidth={26}
          value={kind}
          onChange={setKind}
          options={[
            {
              value: 'solid',
              icon: (
                <span
                  style={{
                    width: 12,
                    height: 9,
                    borderRadius: 2,
                    background: 'var(--color-glyph-muted)',
                  }}
                />
              ),
              'aria-label': 'Solid',
            },
            {
              value: 'gradient',
              icon: (
                <span
                  style={{
                    width: 12,
                    height: 9,
                    borderRadius: 2,
                    background: 'linear-gradient(90deg, #E8E8E8, #9A9A9A)',
                  }}
                />
              ),
              'aria-label': 'Gradient',
            },
            { value: 'image', icon: <ImageIcon size={12} />, 'aria-label': 'Image' },
          ]}
        />
        <span style={{ flex: '1 1 0' }} />
        <SectionHeaderAction label="Toggle fill" style={{ marginRight: 0 }}>
          <EyeIcon size={13} />
        </SectionHeaderAction>
        <SectionHeaderAction label="Remove fill" style={{ width: 18, marginRight: 0 }}>
          <MinusIcon size={13} />
        </SectionHeaderAction>
      </InspectorRow>
      <InspectorRow>
        <ColorField color="FFFFFF" token="background" />
        <FieldIconButton label="Tokens" accent>
          <TokensIcon size={12} />
        </FieldIconButton>
      </InspectorRow>
    </InspectorSection>
  )
}

export function CollapsedSections() {
  return (
    <div>
      {['Outline', 'Border', 'Shadow', 'Inner shadow', 'Filters'].map((t) => (
        <CollapsedSection key={t} title={t} />
      ))}
    </div>
  )
}

export function SelectionColorsSection() {
  return (
    <InspectorSection title="Selection colors" tight bordered={false}>
      <SelectionColorRow color="8A8A8A" name="gray-400" count={140} />
      <SelectionColorRow color="1A1A1A" name="gray-900" count={94} />
      <SelectionColorRow color="C8F230" name="lime-400" count={57} />
    </InspectorSection>
  )
}

export function TypographySection() {
  const [size, setSize] = useState(13)
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('left')
  return (
    <InspectorSection
      title="Typography"
      tight
      actions={
        <SectionHeaderAction label="Text tokens">
          <TokensIcon size={12} />
        </SectionHeaderAction>
      }
    >
      <InspectorSelect>Inter</InspectorSelect>
      <InspectorRow>
        <InspectorSelect>Medium</InspectorSelect>
        <NumberField
          value={size}
          min={1}
          width={80}
          chevron
          onChange={setSize}
          aria-label="Font size"
        />
      </InspectorRow>
      <InspectorRow>
        <NumberField
          prefix={<LineHeightIcon size={11} />}
          value={null}
          placeholder="Auto"
          onChange={() => undefined}
          aria-label="Line height"
        />
        <NumberField
          prefix={<LetterSpacingIcon size={11} />}
          value={0}
          unit="%"
          onChange={() => undefined}
          aria-label="Letter spacing"
        />
      </InspectorRow>
      <InspectorRow>
        <IconToggleGroup
          fullWidth
          value={align}
          onChange={setAlign}
          style={{ flex: '1 1 0' }}
          options={[
            { value: 'left', icon: <TextAlignLeftIcon size={12} />, 'aria-label': 'Align left' },
            {
              value: 'center',
              icon: <TextAlignCenterIcon size={12} />,
              'aria-label': 'Align center',
            },
            { value: 'right', icon: <TextAlignRightIcon size={12} />, 'aria-label': 'Align right' },
          ]}
        />
        <IconButton
          label="Text settings"
          size={26}
          style={{ background: 'var(--color-input)', borderRadius: 5 }}
        >
          <SlidersIcon size={12} />
        </IconButton>
      </InspectorRow>
    </InspectorSection>
  )
}

export function PageSection() {
  const [color, setColor] = useState('EEEEEE')
  return (
    <InspectorSection title="Page" roomy>
      <InspectorRow>
        <ColorField size={28} color={color} onColorChange={setColor} />
        <FieldIconButton label="Tokens" size={28}>
          <TokensIcon size={14} />
        </FieldIconButton>
        <FieldIconButton label="Pick color" size={28}>
          <PipetteIcon size={14} />
        </FieldIconButton>
      </InspectorRow>
    </InspectorSection>
  )
}

export function McpSection() {
  return (
    <InspectorSection title="MCP" roomy actions={<Status>Not connected</Status>}>
      <Button variant="outline" size={28} fullWidth>
        Connect your agent
      </Button>
    </InspectorSection>
  )
}

export function ColorTokenSection() {
  const [hsva, setHsva] = useState<Hsva>(
    () => hexToHsva('2F80FF') ?? { h: 216, s: 0.8, v: 1, a: 1 },
  )
  return (
    <>
      <InspectorSection
        title="Color token"
        roomy
        actions={
          <SectionHeaderAction label="More">
            <MoreHorizontalIcon size={14} />
          </SectionHeaderAction>
        }
        style={{ paddingTop: 10 }}
      >
        <TokenNameField name="selection" />
        <InspectorRow>
          <ColorField
            size={28}
            mono
            color={hsvaToHex(hsva)}
            opacity={hsva.a}
            onColorChange={(hex) => setHsva((c) => hexToHsva(hex, c.a, c.h) ?? c)}
            onOpacityChange={(a) => setHsva((c) => ({ ...c, a }))}
          />
          <FieldIconButton label="Pick color" size={28}>
            <PipetteIcon size={13} />
          </FieldIconButton>
        </InspectorRow>
        <ColorPicker value={hsva} onChange={setHsva} />
      </InspectorSection>
      <InspectorSection title="Description" roomy style={{ paddingTop: 10 }}>
        <TextArea defaultValue="Canvas selection, focus rings, active artboard label" />
      </InspectorSection>
      <InspectorSection
        title="Used in"
        roomy
        bordered={false}
        style={{ paddingTop: 10 }}
        actions={<SectionHeaderLink>Select all</SectionHeaderLink>}
      >
        <Stat value="142" caption="layers across 9 artboards" />
        <ChipRow>
          <Badge variant="input">fill · 38</Badge>
          <Badge variant="input">outline · 96</Badge>
          <Badge variant="input">text · 8</Badge>
        </ChipRow>
      </InspectorSection>
    </>
  )
}

export function Inspector06() {
  return (
    <EditorPanel side="right">
      <InspectorHeader zoom={18} />
      <LayoutSection />
      <FlexSection />
      <RadiusSection />
      <BlendingSection />
      <FillSection />
      <CollapsedSections />
      <SelectionColorsSection />
    </EditorPanel>
  )
}
