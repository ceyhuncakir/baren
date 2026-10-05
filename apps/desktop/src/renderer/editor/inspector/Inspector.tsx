/**
 * Inspector (right panel). Header: collaborators, zoom chip/menu, Share. Body by state:
 *  - comment mode → the page's comments (`comments/CommentsPanel`)
 *  - version history open → the file's versions (`history/VersionHistoryPanel`)
 *  - theme mode with a token selected → token inspector (07)
 *  - nothing selected → Page + MCP (04)
 *  - frames/artboards → Layout, Flex, Radius, Blending, Fill, effects, Selection colors (06)
 *  - text → Layout, Typography, Blending, Fill, effects (14)
 *  - rectangles/images/svg → the subset that applies; image layers add an Image section
 *    and image fills show the Fill section's Image tab (24)
 *  - groups → Layout, Blending, Shadow, Filters; vectors → Layout, Fill, Stroke, Blending,
 *    Shadow, Filters (30); instances and their content → a Component section first, then the
 *    resolved node's sections with override dots (31); main components add the Component
 *    section above the frame sections
 * A viewer of a shared file sees the same values under a "view only" note and cannot change them
 * (`session/readOnly.ts`); comments, version history and the MCP section stay as they are.
 */
import { Avatar, cx, DropdownMenu, EditorPanel, MenuItem, MenuLabel, PanelHeader } from '@baren/ui'
import { memo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { uniquePeers } from '../collab/presence'
import { startSpotlight, stopSpotlight } from '../collab/spotlight'
import { useEditor, useEditorState, useSelectedNodes } from '../session/context'
import type { NodesSnapshot } from '../session/docEvents'
import { useViewer } from '../session/readOnly'
import { TokenInspector } from '../theme/TokenInspector'
import { CommentsPanel } from '../comments/CommentsPanel'
import { VersionHistoryPanel } from '../history/VersionHistoryPanel'
import { BlendingSection, FillSection, RadiusSection } from './sections/AppearanceSections'
import { ComponentSection, hasComponentSection } from './sections/ComponentSection'
import { EffectSections } from './sections/EffectSections'
import { FlexSection } from './sections/FlexSection'
import { ImageLayerSection } from './sections/ImageSections'
import { LayoutSection } from './sections/LayoutSection'
import type { EditorAgent } from '../../agent/presence'
import { McpSection, PageSection, useEditorAgents } from './sections/PageSections'
import { SelectionColorsSection } from './sections/SelectionColorsSection'
import { TypographySection } from './sections/TypographySection'
import { VectorFillSection, VectorStrokeSection } from './sections/VectorSections'
import { OverrideMarks } from './marks'
import { overriddenSections } from '../model/overrides'
import { SharePopover } from './SharePopover'
import { ZoomMenu } from './ZoomMenu'
import css from './Inspector.module.css'

/** At most this many collaborators and agents, then "+N" (contract §10.1). */
const MAX_PEOPLE = 4
const MAX_AGENTS = 3

/** "Claude Code (agent)", or "Claude Code (ana's agent)" for a collaborator's agent. */
export function agentTooltip(agent: Pick<EditorAgent, 'name' | 'via'>): string {
  return agent.via ? `${agent.name} (${agent.via}'s agent)` : `${agent.name} (agent)`
}

/**
 * Your own avatar opens the spotlight menu ("Ask everyone to follow you", `collab/spotlight`)
 * and gets a ring in your colour while you spotlight.
 */
function SelfAvatar() {
  const { store } = useEditor()
  const identity = useEditorState((s) => s.identity)
  const self = useEditorState((s) => s.self)
  const spotlight = useEditorState((s) => s.spotlight)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const on = spotlight !== null
  const name = identity?.name ?? 'You'
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx(css.follow, on && css.following)}
        style={{ '--follow-color': self?.color ?? 'var(--color-selection)' } as CSSProperties}
        title={on ? 'You are spotlighting' : name}
        aria-label={on ? `${name}, spotlighting` : name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={name} size={22} {...(identity ? {} : { variant: 'muted' as const })} />
      </button>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={ref}
        width={232}
        aria-label="Spotlight"
      >
        {on ? (
          <MenuItem onSelect={() => stopSpotlight(store)}>Stop spotlight</MenuItem>
        ) : (
          <MenuItem disabled={self === null} onSelect={() => startSpotlight(store)}>
            Ask everyone to follow you
          </MenuItem>
        )}
        {self === null && <MenuLabel>Share this file to spotlight it to your team.</MenuLabel>}
      </DropdownMenu>
    </>
  )
}

/**
 * People first (circles), then agents (rounded squares, 35), then "+N". A collaborator's avatar
 * toggles following them (`collab/follow`); the followed one gets a ring in their colour.
 */
const Collaborators = memo(function Collaborators() {
  const { store } = useEditor()
  const identity = useEditorState((s) => s.identity)
  const peers = useEditorState((s) => s.peers)
  const following = useEditorState((s) => s.following)
  const agents = useEditorAgents()
  const others = uniquePeers(peers, identity?.userId ?? null)
  const seen = new Set<string>()
  const bots = agents.filter((a) => !seen.has(a.id) && seen.add(a.id))
  const hidden = Math.max(0, others.length - MAX_PEOPLE) + Math.max(0, bots.length - MAX_AGENTS)
  return (
    <span className={css.avatars} data-testid="collaborators">
      <SelfAvatar />
      {others.slice(0, MAX_PEOPLE).map((p) => {
        const on = following === p.userId
        const label = on ? `Stop following ${p.name}` : `Follow ${p.name}`
        return (
          <button
            key={p.userId}
            type="button"
            className={cx(css.follow, on && css.following)}
            style={{ '--follow-color': p.color } as CSSProperties}
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={() => store.setState({ following: on ? null : p.userId })}
          >
            <Avatar name={p.name} size={22} color={p.color} />
          </button>
        )
      })}
      {bots.slice(0, MAX_AGENTS).map((a) => (
        <Avatar
          key={a.id}
          name={agentTooltip(a)}
          title={agentTooltip(a)}
          size={22}
          variant="agent"
        />
      ))}
      {hidden > 0 && (
        <Avatar
          size={22}
          variant="muted"
          initials={`+${hidden}`}
          name={`${hidden} more`}
          title={`${hidden} more`}
        />
      )}
    </span>
  )
})

/** `children` as they are; for a viewer, under a note and impossible to change (inert). */
function ViewOnly({ viewer, children }: { viewer: boolean; children: ReactNode }) {
  if (!viewer) return children
  return (
    <>
      <p className={css.viewOnly} role="note">
        You can view this file but not edit it.
      </p>
      <div className={css.viewOnlyBody} inert>
        {children}
      </div>
    </>
  )
}

function InspectorBody() {
  const mode = useEditorState((s) => s.mode)
  const token = useEditorState((s) => s.selectedToken)
  const commentMode = useEditorState((s) => s.commentMode)
  const historyOpen = useEditorState((s) => s.historyOpen)
  const viewer = useViewer()
  const snapshot = useSelectedNodes()
  if (historyOpen) return <VersionHistoryPanel />
  if (commentMode) return <CommentsPanel />
  if (mode === 'theme' && token) {
    return (
      <ViewOnly viewer={viewer}>
        <TokenInspector name={token} />
      </ViewOnly>
    )
  }
  if (snapshot.nodes.length === 0) {
    return (
      <>
        <ViewOnly viewer={viewer}>
          <PageSection />
        </ViewOnly>
        <McpSection />
      </>
    )
  }
  return (
    <ViewOnly viewer={viewer}>
      <SelectionSections snapshot={snapshot} />
    </ViewOnly>
  )
}

/** The sections of the selected layers (by type, see the header). */
function SelectionSections({ snapshot }: { snapshot: NodesSnapshot }) {
  const nodes = snapshot.nodes
  const types = new Set(nodes.map((n) => n.type))
  const allText = types.size === 1 && types.has('text')
  const allVector = types.size === 1 && types.has('vector')
  const allGroup = types.size === 1 && types.has('group')
  const anyFrame = types.has('frame')
  const boxes = nodes.every(
    (n) => n.type === 'frame' || n.type === 'rect' || n.type === 'image' || n.type === 'instance',
  )
  const component = nodes.some(hasComponentSection)
  const marks = overriddenSections(nodes)
  if (allVector) {
    return (
      <OverrideMarks sections={marks}>
        {component && <ComponentSection snapshot={snapshot} />}
        <LayoutSection snapshot={snapshot} />
        <VectorFillSection snapshot={snapshot} />
        <VectorStrokeSection snapshot={snapshot} />
        <BlendingSection snapshot={snapshot} />
        <EffectSections snapshot={snapshot} only={['shadow', 'filters']} />
      </OverrideMarks>
    )
  }
  if (allGroup) {
    return (
      <>
        <LayoutSection snapshot={snapshot} />
        <BlendingSection snapshot={snapshot} />
        <EffectSections snapshot={snapshot} only={['shadow', 'filters']} />
      </>
    )
  }
  return (
    <OverrideMarks sections={marks}>
      {component && <ComponentSection snapshot={snapshot} />}
      <LayoutSection snapshot={snapshot} />
      {allText && <TypographySection snapshot={snapshot} />}
      {anyFrame && <FlexSection snapshot={snapshot} />}
      {boxes && <RadiusSection snapshot={snapshot} />}
      <BlendingSection snapshot={snapshot} />
      {types.has('image') && <ImageLayerSection snapshot={snapshot} />}
      {(boxes || allText) && <FillSection snapshot={snapshot} />}
      <EffectSections snapshot={snapshot} />
      {anyFrame && <SelectionColorsSection snapshot={snapshot} />}
    </OverrideMarks>
  )
}

export function Inspector() {
  return (
    <EditorPanel side="right" aria-label="Inspector">
      <PanelHeader
        bordered
        leading={<Collaborators />}
        trailing={
          <>
            <ZoomMenu />
            <SharePopover />
          </>
        }
      />
      <div className={css.scroll}>
        <InspectorBody />
      </div>
    </EditorPanel>
  )
}
