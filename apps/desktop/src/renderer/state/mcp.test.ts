import { describe, expect, it } from 'vitest'
import { buildSetup } from '../../main/mcp/setup'
import { mockMcpStatus } from '../lib/mockBridge'
import type { McpAgentInfo, McpStatus } from '../types/bridge'
import {
  agentActivity,
  connectedAgents,
  dialogStatusLine,
  homeAgentLine,
  isAgentActive,
  maskedToken,
  maskSnippet,
  mcpSectionLabel,
  mcpSectionState,
  snippetFor,
  startMcpStatus,
  useMcp,
} from './mcp'

const NOW = 1_800_000_000_000
const MIN = 60_000

const agent = (patch: Partial<McpAgentInfo> = {}): McpAgentInfo => ({
  name: 'Claude Code',
  client: 'claude-code',
  version: null,
  connected: true,
  presenceId: 'p1',
  connectedAt: NOW - 10 * MIN,
  lastActivityAt: NOW,
  lastFileId: 'f1',
  lastFileName: 'Baren',
  files: [],
  ...patch,
})

describe('MCP section state (34, 35, off, error)', () => {
  it('follows the server state and the connected agents', () => {
    expect(mcpSectionState(null)).toBe('starting')
    expect(mcpSectionState(mockMcpStatus('off', NOW))).toBe('off')
    expect(mcpSectionState(mockMcpStatus('error', NOW))).toBe('error')
    expect(mcpSectionState(mockMcpStatus('not-connected', NOW))).toBe('not-connected')
    expect(mcpSectionState(mockMcpStatus('connected', NOW))).toBe('connected')
    // Only recently seen agents: not connected.
    const recent: McpStatus = {
      ...mockMcpStatus('not-connected', NOW),
      agents: [agent({ connected: false, presenceId: null })],
    }
    expect(mcpSectionState(recent)).toBe('not-connected')
    expect(connectedAgents(mockMcpStatus('connected', NOW)).map((a) => a.name)).toEqual([
      'Claude Code',
    ])
  })

  it('labels the states as drawn', () => {
    expect(mcpSectionLabel('connected')).toEqual({ text: 'Connected', tone: 'success' })
    expect(mcpSectionLabel('not-connected')).toEqual({ text: 'Not connected', tone: 'neutral' })
    expect(mcpSectionLabel('starting')).toEqual({ text: 'Not connected', tone: 'neutral' })
    expect(mcpSectionLabel('off')).toEqual({ text: 'Off', tone: 'neutral' })
    expect(mcpSectionLabel('error')).toEqual({ text: 'Error', tone: 'danger' })
  })
})

describe('Connect dialog status line (34 footer)', () => {
  it('reads waiting, connected, off and error', () => {
    expect(dialogStatusLine(mockMcpStatus('not-connected', NOW))).toEqual({
      text: 'Waiting for an agent to connect…',
      tone: 'neutral',
    })
    expect(dialogStatusLine(mockMcpStatus('connected', NOW))).toEqual({
      text: 'Connected · Claude Code',
      tone: 'success',
    })
    expect(dialogStatusLine(mockMcpStatus('off', NOW))).toEqual({
      text: 'MCP server is off',
      tone: 'neutral',
    })
    expect(dialogStatusLine(mockMcpStatus('error', NOW))).toEqual({
      text: "Couldn't start the MCP server: port 29170 is in use",
      tone: 'danger',
    })
  })

  it('names several connected clients once each and flags a new address', () => {
    const status: McpStatus = {
      ...mockMcpStatus('not-connected', NOW),
      portChanged: true,
      agents: [
        agent(),
        agent({ name: 'Cursor', presenceId: 'p2' }),
        agent({ name: 'Codex', connected: false, presenceId: null }),
      ],
    }
    expect(dialogStatusLine(status).text).toBe('Connected · Claude Code, Cursor · new address')
  })
})

describe('agent activity lines', () => {
  const names: Record<string, string> = { a1: 'Pricing — Desktop' }
  const artboardName = (id: string) => names[id] ?? null

  it('MCP section: "Editing <artboard>" while working, else "Idle · <time>"', () => {
    expect(agentActivity(agent(), ['gone', 'a1'], artboardName, NOW)).toBe(
      'Editing Pricing — Desktop',
    )
    expect(agentActivity(agent({ lastActivityAt: NOW - 2 * MIN }), [], artboardName, NOW)).toBe(
      'Idle · 2 minutes ago',
    )
  })

  it('home card: active within 5 minutes of a connected agent, else "Last active"', () => {
    expect(isAgentActive(agent({ lastActivityAt: NOW - 4 * MIN }), NOW)).toBe(true)
    expect(isAgentActive(agent({ lastActivityAt: NOW - 6 * MIN }), NOW)).toBe(false)
    expect(isAgentActive(agent({ connected: false }), NOW)).toBe(false)
    expect(homeAgentLine(agent(), NOW)).toBe('Active now · Baren')
    expect(homeAgentLine(agent({ lastFileName: null }), NOW)).toBe('Active now')
    expect(homeAgentLine(agent({ connected: false, lastActivityAt: NOW - 120 * MIN }), NOW)).toBe(
      'Last active 2 hours ago',
    )
  })
})

describe('snippets and the masked token', () => {
  const setup = buildSetup({
    url: 'http://127.0.0.1:29170/mcp',
    token: 'brn_secret_token_7f3a',
    command: '/opt/baren',
    args: ['/shim.cjs'],
  })

  it('picks the segment snippet ("Other" = the generic HTTP JSON)', () => {
    expect(snippetFor(setup, 'claudeCode')).toContain('claude mcp add --scope user')
    expect(snippetFor(setup, 'cursor')).toContain('"headers"')
    expect(snippetFor(setup, 'codex')).toContain('[mcp_servers.baren]')
    expect(snippetFor(setup, 'other')).toContain('"type": "http"')
  })

  it('masks the token as eight dots and its last four characters', () => {
    expect(maskedToken('brn_secret_token_7f3a')).toBe('••••••••7f3a')
    const masked = maskSnippet(snippetFor(setup, 'claudeCode'), setup.token)
    expect(masked).toContain('Bearer ••••••••7f3a"')
    expect(masked).not.toContain('brn_secret')
    expect(maskSnippet('no token here', '')).toBe('no token here')
  })
})

describe('status subscription', () => {
  it('takes the first status, then every push (pushes win over a late first answer)', async () => {
    startMcpStatus()
    await expect.poll(() => useMcp.getState().status?.state).toBe('running')
    await useMcp.getState().setEnabled(false)
    expect(useMcp.getState().status?.state).toBe('off')
    expect(useMcp.getState().switching).toBe(false)
    await useMcp.getState().setEnabled(true)
    expect(useMcp.getState().status?.state).toBe('running')
  })
})
