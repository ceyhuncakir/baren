import { describe, expect, it } from 'vitest'
import { buildSetup } from '../../main/mcp/setup'
import type { AgentRequest } from '../types/bridge'
import {
  MOCK_AGENT_PRESENCE_ID,
  MOCK_MCP_TOKEN,
  MOCK_MCP_URL,
  MOCK_STDIO_COMMAND,
  MOCK_STDIO_SHIM,
  createMockBridge,
  mockMcpStatus,
} from './mockBridge'

describe('mock bridge: mcp', () => {
  it('defaults to a running server with no agents (not-connected)', async () => {
    const bridge = createMockBridge()
    expect(await bridge.mcp.status()).toEqual({
      state: 'running',
      enabled: true,
      url: MOCK_MCP_URL,
      port: 29170,
      portChanged: false,
      error: null,
      agents: [],
    })
  })

  it('has the states of artboards 34–36', async () => {
    const now = 1_000_000_000
    const connected = mockMcpStatus('connected', now)
    expect(connected.agents.map((a) => [a.name, a.connected])).toEqual([
      ['Claude Code', true],
      ['Cursor', false],
    ])
    expect(connected.agents[0]).toMatchObject({
      presenceId: MOCK_AGENT_PRESENCE_ID,
      lastActivityAt: now,
      lastFileName: 'Baren',
    })
    expect(connected.agents[1]?.lastActivityAt).toBe(now - 2 * 60 * 60_000)
    expect(mockMcpStatus('error').error).toBe('port 29170 is in use')
    expect(mockMcpStatus('off')).toMatchObject({ state: 'off', enabled: false, url: null })
    const bridge = createMockBridge({ mcp: 'connected' })
    expect((await bridge.mcp.status()).agents).toHaveLength(2)
  })

  it('returns the contract snippets with the mock token, and rejects when off', async () => {
    const bridge = createMockBridge()
    const setup = await bridge.mcp.setup()
    expect(setup).toEqual(
      buildSetup({
        url: MOCK_MCP_URL,
        token: MOCK_MCP_TOKEN,
        command: MOCK_STDIO_COMMAND,
        args: [MOCK_STDIO_SHIM],
      }),
    )
    expect(setup.snippets.claudeCode).toBe(
      [
        'claude mcp add --scope user --transport http \\',
        '  baren http://127.0.0.1:29170/mcp \\',
        '  --header "Authorization: Bearer brn_mock_token_7f3a"',
      ].join('\n'),
    )
    const off = createMockBridge({ mcp: 'off' })
    await expect(off.mcp.setup()).rejects.toThrow('The MCP server is off')
  })

  it('setEnabled and resetToken update the status and notify', async () => {
    const bridge = createMockBridge({ mcp: 'connected' })
    const states: string[] = []
    bridge.mcp.onStatus((s) =>
      states.push(`${s.state}:${s.agents.filter((a) => a.connected).length}`),
    )
    const off = await bridge.mcp.setEnabled(false)
    expect(off).toMatchObject({ state: 'off', enabled: false, url: null })
    await expect(bridge.mcp.setup()).rejects.toThrow('The MCP server is off')
    await bridge.mcp.setEnabled(true)
    const before = await bridge.mcp.setup()
    const after = await bridge.mcp.resetToken()
    expect(after.token).not.toBe(before.token)
    expect(after.snippets.cursor).toContain(after.token)
    expect(states).toEqual(['off:0', 'running:0', 'running:0'])
    bridge.mock.setMcpStatus('error')
    expect((await bridge.mcp.status()).state).toBe('error')
  })

  it('files.onChanged never fires', () => {
    const bridge = createMockBridge()
    const off = bridge.files.onChanged(() => {
      throw new Error('never')
    })
    expect(typeof off).toBe('function')
    off()
  })
})

describe('mock bridge: agent loop', () => {
  it('delivers requests to onRequest listeners and resolves with respond()', async () => {
    const bridge = createMockBridge({ exposeAgentLoop: false })
    const seen: AgentRequest[] = []
    bridge.agent.host({ fileId: 'f1', state: 'opened', headless: false })
    bridge.agent.onRequest((req) => {
      seen.push(req)
      bridge.agent.respond({
        id: req.id,
        ok: true,
        header: { file: { id: 'f1', name: 'F' }, contentHash: { tokens: '00000000' } },
        result: { echo: req.args },
        touched: ['1@1'],
      })
    })
    const res = await bridge.mock.agent.dispatch('get_children', { nodeId: '1@1' })
    expect(res).toMatchObject({ ok: true, result: { echo: { nodeId: '1@1' } } })
    expect(seen[0]).toMatchObject({
      fileId: 'f1',
      tool: 'get_children',
      agent: { presenceId: MOCK_AGENT_PRESENCE_ID, name: 'Claude Code' },
    })
    expect(seen[0]!.deadline).toBeGreaterThan(Date.now())
    expect(bridge.mock.agent.hosts()).toEqual([{ fileId: 'f1', state: 'opened', headless: false }])
    bridge.agent.host({ fileId: 'f1', state: 'closed', headless: false })
    expect(bridge.mock.agent.hosts()).toEqual([])
  })

  it('times out with a cancel, and answers host_unavailable without listeners', async () => {
    const bridge = createMockBridge({ exposeAgentLoop: false })
    expect(await bridge.mock.agent.dispatch('get_selection', {}, { fileId: 'f1' })).toMatchObject({
      ok: false,
      error: { code: 'host_unavailable' },
    })
    const cancelled: string[] = []
    bridge.agent.onRequest(() => undefined)
    bridge.agent.onCancel((id) => cancelled.push(id))
    const res = await bridge.mock.agent.dispatch(
      'get_selection',
      {},
      {
        fileId: 'f1',
        timeoutMs: 10,
      },
    )
    expect(res).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(cancelled).toEqual([res.id])
  })

  it('pushes presence updates to onPresence listeners', () => {
    const bridge = createMockBridge({ exposeAgentLoop: false })
    const seen: string[] = []
    const off = bridge.agent.onPresence((u) => seen.push(u.agents.map((a) => a.name).join()))
    bridge.mock.agent.presence({
      fileId: 'f1',
      agents: [{ id: 'p1', name: 'Claude Code', working: ['1@2'], activeAt: 1 }],
    })
    off()
    bridge.mock.agent.presence({ fileId: 'f1', agents: [] })
    expect(seen).toEqual(['Claude Code'])
  })
})
