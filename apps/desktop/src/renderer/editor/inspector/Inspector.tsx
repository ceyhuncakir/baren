/**
 * Inspector (right panel). Header: collaborators, zoom chip/menu, Share. Body by state:
 *  - comment mode → the page's comments (`comments/CommentsPanel`)
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
 */
import { Avatar, cx, EditorPanel, PanelHeader } from '@baren/ui'
import { memo, type CSSProperties } from 'react'
import { uniquePeers } from '../collab/presence'
import { useEditor, useEditorState, useSelectedNodes } from '../session/context'
import { TokenInspector } from '../theme/TokenInspector'
import { CommentsPanel } from '../comments/CommentsPanel'
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
      <Avatar
        name={identity?.name ?? 'You'}
        size={22}
        {...(identity ? {} : { variant: 'muted' as const })}
      />
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

function InspectorBody() {
  const mode = useEditorState((s) => s.mode)
  const token = useEditorState((s) => s.selectedToken)
  const commentMode = useEditorState((s) => s.commentMode)
  const snapshot = useSelectedNodes()
  if (commentMode) return <CommentsPanel />
  if (mode === 'theme' && token) return <TokenInspector name={token} />
  const nodes = snapshot.nodes
  if (nodes.length === 0) {
    return (
      <>
        <PageSection />
        <McpSection />
      </>
    )
  }
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
