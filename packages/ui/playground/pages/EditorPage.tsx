import { useState } from 'react'
import {
  AlignmentGrid,
  EmptyCanvasHint,
  LayerRow,
  LayerTypeIcon,
  NumberField,
  PageRow,
  PanelSectionHeader,
  PointerToolIcon,
  RectangleToolIcon,
  SectionAction,
  PlusIcon,
  ShareButton,
  TokenRow,
  ToolButton,
  ZoomChip,
  type Alignment,
  type LayerKind,
} from '../../src'
import {
  BlendingSection,
  CollapsedSections,
  ColorTokenSection,
  EditorToolRail,
  FileHeader,
  FillSection,
  FlexSection,
  InspectorHeader,
  LAYERS_14,
  LayerList,
  LayoutSection,
  McpSection,
  ModeSwitch,
  PageSection,
  PagesBlock,
  RadiusSection,
  SelectionColorsSection,
  TypographySection,
} from '../editorParts'
import { Canvas, Page, Row, Section, Specimen, Surface } from '../kit'

const PANEL = {
  width: 239,
  background: 'var(--color-surface)',
  boxShadow: 'inset 0 0 0 1px var(--color-border)',
}
const INSPECTOR = {
  width: 263,
  background: 'var(--color-surface)',
  boxShadow: 'inset 0 0 0 1px var(--color-border)',
}

export function EditorPage() {
  return (
    <Page title="Editor">
      <Section title="Tool rail · ToolButton states">
        <Row>
          <Specimen label="rail (live)">
            <div style={{ height: 420, display: 'flex' }}>
              <EditorToolRail />
            </div>
          </Specimen>
          <Specimen label="default">
            <Surface padding={6}>
              <ToolButton label="Rectangle" shortcut="R">
                <RectangleToolIcon size={16} />
              </ToolButton>
            </Surface>
          </Specimen>
          <Specimen label="hover">
            <Surface padding={6}>
              <ToolButton label="Rectangle" data-hover="">
                <RectangleToolIcon size={16} />
              </ToolButton>
            </Surface>
          </Specimen>
          <Specimen label="active">
            <Surface padding={6}>
              <ToolButton label="Select" active>
                <PointerToolIcon size={16} />
              </ToolButton>
            </Surface>
          </Specimen>
          <Specimen label="disabled">
            <Surface padding={6}>
              <ToolButton label="Rectangle" disabled>
                <RectangleToolIcon size={16} />
              </ToolButton>
            </Surface>
          </Specimen>
        </Row>
      </Section>

      <Section title="Left panel pieces">
        <Row>
          <Specimen label="file header · mode switch · pages">
            <div style={PANEL}>
              <FileHeader name="acme" />
              <ModeSwitch />
              <PagesBlock pages={['Component library', 'Logo', 'Cloud posture']} active={0} />
            </div>
          </Specimen>
          <Specimen label="PageRow states">
            <div style={PANEL}>
              <PageRow>Default</PageRow>
              <PageRow data-hover="">Hover</PageRow>
              <PageRow active>Active</PageRow>
            </div>
          </Specimen>
          <Specimen label="Theme tokens (07)">
            <div style={{ ...PANEL, padding: '6px 0' }}>
              <PanelSectionHeader title="Colors" count={13} wide />
              <TokenRow kind="color" name="background" value="FFFFFF" color="FFFFFF" />
              <TokenRow kind="color" name="canvas" value="EEEEEE" color="EEEEEE" />
              <TokenRow kind="color" name="foreground" value="1A1A1A" color="1A1A1A" />
              <TokenRow kind="color" name="selection" value="2F80FF" color="2F80FF" selected />
              <TokenRow kind="color" name="avatar" value="F04E1E" color="F04E1E" data-hover="" />
              <PanelSectionHeader title="Typography" count={8} wide />
              <TokenRow kind="typography" name="font-sans" value="Inter" />
              <TokenRow kind="typography" name="text-base" value="13px" />
              <PanelSectionHeader title="Spacing" count={7} wide expanded={false} />
              <PanelSectionHeader
                title="Radius"
                count={5}
                wide
                expanded={false}
                action={
                  <SectionAction label="Add token">
                    <PlusIcon size={14} />
                  </SectionAction>
                }
              />
            </div>
          </Specimen>
        </Row>
      </Section>

      <Section title="LayerRow — states (14)">
        <Row>
          <Specimen label="live tree (click, double-click to rename, lock/eye on hover)">
            <div style={PANEL}>
              <LayerList initial={LAYERS_14} />
            </div>
          </Specimen>
          <Specimen label="every state">
            <div style={{ ...PANEL, padding: '6px 0' }}>
              <StaticRow name="idle" />
              <StaticRow name="hover" hover />
              <StaticRow name="selected (top level)" state="selected" />
              <StaticRow name="selected (nested)" state="selected" depth={2} kind="text" />
              <StaticRow
                name="ancestor of selection"
                state="ancestor"
                depth={1}
                kind="frame-column"
                expandable
                expanded
              />
              <StaticRow name="locked" locked depth={1} />
              <StaticRow name="hidden" hidden depth={1} kind="rect" />
              <StaticRow name="dragging" dragging depth={1} kind="image" />
              <StaticRow name="drop before" drop="before" depth={1} kind="svg" />
              <StaticRow name="drop inside" drop="inside" depth={1} kind="frame-row" expandable />
              <StaticRow name="drop after" drop="after" depth={1} kind="component" />
              <StaticRow name="Renaming…" renaming depth={1} />
              <StaticRow
                name="A very long layer name that has to be truncated with an ellipsis"
                depth={3}
                kind="text"
              />
            </div>
          </Specimen>
        </Row>
      </Section>

      <Section title="Inspector (06 / 14 / 04 / 07)">
        <Row>
          <Specimen label="header · layout · flex · radius · blending · fill · collapsed · selection colors">
            <div style={INSPECTOR}>
              <InspectorHeader zoom={18} />
              <LayoutSection />
              <FlexSection />
              <RadiusSection />
              <BlendingSection />
              <FillSection />
              <CollapsedSections />
              <SelectionColorsSection />
            </div>
          </Specimen>
          <Specimen label="typography (14) · page + MCP (04)">
            <div style={INSPECTOR}>
              <TypographySection />
              <PageSection />
              <McpSection />
            </div>
          </Specimen>
          <Specimen label="color token · picker · description · used in (07)">
            <div style={INSPECTOR}>
              <ColorTokenSection />
            </div>
          </Specimen>
        </Row>
      </Section>

      <Section title="Fields & small controls">
        <Row align="center">
          <NumberFieldDemo />
          <Specimen label="ZoomChip default / hover / open">
            <Surface>
              <div style={{ display: 'flex', gap: 8 }}>
                <ZoomChip zoom={18} />
                <ZoomChip zoom={100} data-hover="" />
                <ZoomChip zoom={75} open />
              </div>
            </Surface>
          </Specimen>
          <Specimen label="ShareButton default / open">
            <Surface>
              <div style={{ display: 'flex', gap: 8 }}>
                <ShareButton />
                <ShareButton open />
              </div>
            </Surface>
          </Specimen>
        </Row>
        <Row>
          <AlignmentDemo />
        </Row>
      </Section>

      <Section title="Canvas empty hint (04)">
        <Canvas width={600} height={120}>
          <EmptyCanvasHint />
        </Canvas>
      </Section>
    </Page>
  )
}

function StaticRow({
  name,
  depth = 0,
  kind = 'artboard',
  state,
  hover,
  locked,
  hidden,
  dragging,
  drop,
  renaming,
  expandable = true,
  expanded = false,
}: {
  name: string
  depth?: number
  kind?: LayerKind
  state?: 'idle' | 'selected' | 'ancestor'
  hover?: boolean
  locked?: boolean
  hidden?: boolean
  dragging?: boolean
  drop?: 'before' | 'after' | 'inside'
  renaming?: boolean
  expandable?: boolean
  expanded?: boolean
}) {
  return (
    <LayerRow
      id={name}
      name={name}
      depth={depth}
      icon={<LayerTypeIcon kind={kind} />}
      expandable={expandable && (kind === 'artboard' || kind.startsWith('frame'))}
      expanded={expanded}
      state={state}
      locked={locked}
      hidden={hidden}
      dragging={dragging}
      dropPosition={drop ?? null}
      renaming={renaming}
      data-hover={hover ? '' : undefined}
    />
  )
}

function NumberFieldDemo() {
  const [v, setV] = useState(96)
  const [log, setLog] = useState('')
  return (
    <Specimen label="NumberField (drag the W label, ↑/↓, type 96/2)" width={239}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <NumberField
          prefix="W"
          value={v}
          min={0}
          onChange={(next, meta) => {
            setV(next)
            setLog(`${next} · ${meta.final ? 'commit' : 'preview'}`)
          }}
          aria-label="Width"
        />
        <NumberField
          prefix="H"
          value={null}
          onChange={() => undefined}
          aria-label="Height (mixed)"
        />
        <NumberField
          prefix="X"
          value={12}
          disabled
          onChange={() => undefined}
          aria-label="Disabled"
        />
        <div className="pg-label" data-testid="number-log">
          {log || '—'}
        </div>
      </div>
    </Specimen>
  )
}

function AlignmentDemo() {
  const [a, setA] = useState<Alignment>({ x: 'start', y: 'start' })
  const [b, setB] = useState<Alignment>({ x: 'center', y: 'center' })
  return (
    <>
      <Specimen label="column · start/start (06)">
        <AlignmentGrid value={a} onChange={setA} direction="column" />
      </Specimen>
      <Specimen label="row · center">
        <AlignmentGrid value={b} onChange={setB} direction="row" />
      </Specimen>
      <Specimen label="column · space-between">
        <AlignmentGrid
          value={{ x: 'center', y: 'start' }}
          onChange={() => undefined}
          direction="column"
          distribution="space-between"
        />
      </Specimen>
      <Specimen label="row · end/end">
        <AlignmentGrid value={{ x: 'end', y: 'end' }} onChange={() => undefined} direction="row" />
      </Specimen>
    </>
  )
}
