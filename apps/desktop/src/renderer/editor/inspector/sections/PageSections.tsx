/**
 * Nothing selected (artboard 04): the page background color and the MCP section — not
 * connected (34: "Connect your agent"), connected (35: one row per connected agent and
 * "Agent settings"), off and error (Phase 4 contract §10.1). Both buttons open the app-level
 * Connect dialog.
 */
import { Avatar, Button, FieldIconButton, InspectorSection, PipetteIcon, Status } from '@baren/ui'
import { useNow } from '../../../lib/relativeTime'
import {
  agentActivity,
  connectedAgents,
  mcpSectionLabel,
  mcpSectionState,
  useMcpStatus,
} from '../../../state/mcp'
import { useUi } from '../../../state/ui'
import type { EditorAgent } from '../../../agent/presence'
import { parseColor } from '../../model/colors'
import { setPageBackground } from '../../model/docOps'
import { useEditor, useEditorState, useLayerTreeVersion } from '../../session/context'
import { PaintField } from '../controls'
import css from '../Inspector.module.css'

interface EyeDropperResult {
  sRGBHex: string
}
interface EyeDropperLike {
  open(): Promise<EyeDropperResult>
}
type EyeDropperCtor = new () => EyeDropperLike

/** Chromium's EyeDropper API (Electron), when available. */
export async function pickScreenColor(): Promise<string | null> {
  const Ctor = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
  if (!Ctor) return null
  try {
    const result = await new Ctor().open()
    return result.sRGBHex
  } catch {
    return null
  }
}

export function PageSection() {
  const { doc, tree } = useEditor()
  useLayerTreeVersion()
  const pageId = useEditorState((s) => s.pageId)
  const background = tree.meta(pageId)?.background ?? '#EEEEEE'
  const set = (value: string) => setPageBackground(doc, pageId, value)
  return (
    <InspectorSection title="Page" roomy className={css.compactHeader}>
      <PaintField
        size={28}
        value={parseColor(background)}
        onChange={(value, final) => {
          if (final) set(value)
        }}
        trailing={
          <FieldIconButton
            label="Pick color"
            size={28}
            onClick={() =>
              void pickScreenColor().then((hex) => {
                if (hex) set(hex.toUpperCase())
              })
            }
          >
            <PipetteIcon size={14} />
          </FieldIconButton>
        }
      />
    </InspectorSection>
  )
}

/** `EditorState.agents`: the agents in this file, local first (contract §10.2). */
export function useEditorAgents(): readonly EditorAgent[] {
  return useEditorState((s) => s.agents)
}

const openConnectDialog = () => useUi.getState().openDialog({ kind: 'mcp' })

export function McpSection() {
  const { fileId, tree } = useEditor()
  useLayerTreeVersion()
  const status = useMcpStatus()
  const agents = useEditorAgents()
  const now = useNow()
  const state = mcpSectionState(status)
  const label = mcpSectionLabel(state)
  const live = state === 'connected' ? connectedAgents(status) : []
  const artboardName = (id: string) => tree.meta(id)?.name ?? null
  return (
    <InspectorSection
      title="MCP"
      roomy
      className={css.compactHeader}
      data-testid="mcp-section"
      actions={
        <Status
          tone={label.tone}
          title={state === 'error' ? (status?.error ?? undefined) : undefined}
        >
          {label.text}
        </Status>
      }
    >
      {live.map((agent) => {
        const mine = agent.presenceId
          ? agents.find((a) => a.origin === 'local' && a.id === agent.presenceId)
          : undefined
        const working = [
          ...(agent.files.find((f) => f.fileId === fileId)?.working ?? []),
          ...(mine?.working ?? []),
        ]
        return (
          <div key={agent.presenceId ?? agent.name} className={css.agentRow}>
            <Avatar size={22} variant="agent" />
            <div className={css.agentText}>
              <div className={css.agentName}>{agent.name}</div>
              <div className={css.agentActivity}>
                {agentActivity(agent, working, artboardName, now)}
              </div>
            </div>
          </div>
        )
      })}
      <Button variant="outline" size={28} fullWidth onClick={openConnectDialog}>
        {state === 'connected' ? 'Agent settings' : 'Connect your agent'}
      </Button>
    </InspectorSection>
  )
}
