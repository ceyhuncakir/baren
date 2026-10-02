/**
 * The built-in MCP server as the UI sees it (Phase 4 contract §10.1, §4.14): one status
 * subscription for the whole window (started by the first component that needs it, after the
 * first paint), the derived texts of the Connect dialog, the inspector's MCP section and the
 * home "Using agents" card, and the dialog's remembered client segment.
 *
 * The access token never lives here: the dialog fetches it with `bridge.mcp.setup()` while it
 * is open and keeps it in component state only.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { bridge } from '../lib/bridge'
import { formatRelative } from '../lib/relativeTime'
import { readString, writeString } from '../lib/storage'
import type { McpAgentInfo, McpSetup, McpStatus } from '../types/bridge'

export interface McpUiState {
  /** null until the first status arrives (or when the bridge could not answer). */
  status: McpStatus | null
  /** A `setEnabled` call is in flight. */
  switching: boolean
  setEnabled(enabled: boolean): Promise<void>
}

export const useMcp = create<McpUiState>()((set, get) => ({
  status: null,
  switching: false,
  async setEnabled(enabled) {
    if (get().switching) return
    set({ switching: true })
    try {
      const status = await bridge.mcp.setEnabled(enabled)
      receive(status)
    } finally {
      set({ switching: false })
    }
  },
}))

/** Status pushes win over the first `status()` answer when they arrive before it. */
let pushed = false
let started = false

function receive(status: McpStatus): void {
  useMcp.setState({ status })
}

/** Subscribes once per window (idempotent). Exported for tests. */
export function startMcpStatus(): void {
  if (started) return
  started = true
  try {
    bridge.mcp.onStatus((status) => {
      pushed = true
      receive(status)
    })
    void bridge.mcp
      .status()
      .then((status) => {
        if (!pushed) receive(status)
      })
      .catch(() => undefined)
  } catch {
    // No MCP in this bridge (older main): the UI shows the server as off.
  }
}

/** The current MCP status; starts the subscription after the first render. */
export function useMcpStatus(): McpStatus | null {
  useEffect(startMcpStatus, [])
  return useMcp((s) => s.status)
}

/* ------------------------------------------------------------------ derived */

/** Agents with a live session, most recent activity first (main's order). */
export function connectedAgents(status: McpStatus | null): McpAgentInfo[] {
  return status?.agents.filter((a) => a.connected) ?? []
}

export type McpSectionState = 'starting' | 'off' | 'error' | 'not-connected' | 'connected'

/** The inspector MCP section's state (34, 35 and the undrawn off/error variants). */
export function mcpSectionState(status: McpStatus | null): McpSectionState {
  if (!status) return 'starting'
  if (status.state === 'off' || !status.enabled) return 'off'
  if (status.state === 'error') return 'error'
  if (status.state === 'starting') return 'starting'
  return connectedAgents(status).length > 0 ? 'connected' : 'not-connected'
}

export type StatusTone = 'success' | 'neutral' | 'danger'

/** "Connected" / "Not connected" / "Off" / "Error" next to the MCP section title. */
export function mcpSectionLabel(state: McpSectionState): { text: string; tone: StatusTone } {
  switch (state) {
    case 'connected':
      return { text: 'Connected', tone: 'success' }
    case 'off':
      return { text: 'Off', tone: 'neutral' }
    case 'error':
      return { text: 'Error', tone: 'danger' }
    case 'starting':
    case 'not-connected':
      return { text: 'Not connected', tone: 'neutral' }
  }
}

/** The Connect dialog's footer line (34). */
export function dialogStatusLine(status: McpStatus | null): { text: string; tone: StatusTone } {
  if (!status) return { text: 'Starting the MCP server…', tone: 'neutral' }
  if (status.state === 'off' || !status.enabled)
    return { text: 'MCP server is off', tone: 'neutral' }
  if (status.state === 'error') {
    const reason = status.error?.trim()
    return {
      text: reason ? `Couldn't start the MCP server: ${reason}` : "Couldn't start the MCP server",
      tone: 'danger',
    }
  }
  if (status.state === 'starting') return { text: 'Starting the MCP server…', tone: 'neutral' }
  const live = connectedAgents(status)
  const suffix = status.portChanged ? ' · new address' : ''
  if (live.length === 0)
    return { text: `Waiting for an agent to connect…${suffix}`, tone: 'neutral' }
  return {
    text: `Connected · ${[...new Set(live.map((a) => a.name))].join(', ')}${suffix}`,
    tone: 'success',
  }
}

/**
 * The MCP section's activity line for a connected agent (35): "Editing <artboard>" while it
 * holds a working set in this file (the first artboard, named by the editor), otherwise
 * "Idle · <relative time>".
 */
export function agentActivity(
  agent: McpAgentInfo,
  working: readonly string[],
  artboardName: (id: string) => string | null,
  now: number,
): string {
  for (const id of working) {
    const name = artboardName(id)
    if (name) return `Editing ${name}`
  }
  return `Idle · ${formatRelative(agent.lastActivityAt, now)}`
}

/** "Active" on the home card: connected and a tool call in the last 5 minutes. */
export const ACTIVE_WINDOW_MS = 5 * 60_000

export function isAgentActive(agent: McpAgentInfo, now: number): boolean {
  return agent.connected && now - agent.lastActivityAt < ACTIVE_WINDOW_MS
}

/** The home card's second line (36). */
export function homeAgentLine(agent: McpAgentInfo, now: number): string {
  if (isAgentActive(agent, now)) {
    return agent.lastFileName ? `Active now · ${agent.lastFileName}` : 'Active now'
  }
  return `Last active ${formatRelative(agent.lastActivityAt, now)}`
}

/* ------------------------------------------------------------------ setup snippets */

export type McpClient = 'claudeCode' | 'cursor' | 'codex' | 'other'

export const MCP_CLIENTS: readonly { value: McpClient; label: string; hint: string }[] = [
  { value: 'claudeCode', label: 'Claude Code', hint: 'Run this in your terminal' },
  { value: 'cursor', label: 'Cursor', hint: 'Add to ~/.cursor/mcp.json' },
  { value: 'codex', label: 'Codex', hint: 'Add to ~/.codex/config.toml' },
  { value: 'other', label: 'Other', hint: "Add to your MCP client's config" },
]

const CLIENT_KEY = 'mcpClient'

export function readMcpClient(): McpClient {
  const v = readString(CLIENT_KEY)
  return MCP_CLIENTS.some((c) => c.value === v) ? (v as McpClient) : 'claudeCode'
}

export function writeMcpClient(client: McpClient): void {
  writeString(CLIENT_KEY, client)
}

/** The snippet of a segment ("Other" shows the generic HTTP JSON). */
export function snippetFor(setup: McpSetup, client: McpClient): string {
  switch (client) {
    case 'claudeCode':
      return setup.snippets.claudeCode
    case 'cursor':
      return setup.snippets.cursor
    case 'codex':
      return setup.snippets.codex
    case 'other':
      return setup.snippets.json
  }
}

/** Shown in place of the token until Reveal: eight dots and its last four characters. */
export function maskedToken(token: string): string {
  return `••••••••${token.slice(-4)}`
}

/** `text` with every occurrence of the token masked. */
export function maskSnippet(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join(maskedToken(token))
}
