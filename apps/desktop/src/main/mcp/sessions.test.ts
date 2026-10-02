import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { McpHttpServer } from './httpServer'
import { allowedHosts, allowedOrigins } from './security'
import { SessionManager } from './sessions'

const TOKEN = 'brn_test'

async function setup(opts: { maxSessions?: number } = {}) {
  let now = 1_000_000
  const opened: string[] = []
  const identified: string[] = []
  const closed: string[] = []
  let http: McpHttpServer
  const sessions = new SessionManager({
    createServer: () =>
      new McpServer({ name: 'test', version: '1' }, { capabilities: { tools: {} } }),
    onOpened: (id) => opened.push(id),
    onIdentified: (_id, client) => identified.push(client?.name ?? '?'),
    onClosed: (id) => closed.push(id),
    allowedHosts: () => allowedHosts(http.port ?? 0),
    allowedOrigins: () => allowedOrigins(http.port ?? 0),
    now: () => now,
    ...(opts.maxSessions ? { maxSessions: opts.maxSessions } : {}),
  })
  http = new McpHttpServer({
    security: () => ({ token: TOKEN, extraOrigins: [] }),
    handle: (req, res) => sessions.handle(req, res),
  })
  const port = await http.listen([0])
  const url = `http://127.0.0.1:${port}/mcp`
  const connect = async (name: string) => {
    const client = new Client({ name, version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    )
    return client
  }
  const cleanup = async () => {
    await sessions.closeAll()
    sessions.dispose()
    await http.close()
  }
  return {
    sessions,
    http,
    url,
    connect,
    opened,
    identified,
    closed,
    cleanup,
    advance: (ms: number) => {
      now += ms
    },
  }
}

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups) await c()
  cleanups = []
})

const settle = () => new Promise((r) => setTimeout(r, 30))

describe('SessionManager (contract §4.2)', () => {
  it('creates one session per initialize and identifies the client', async () => {
    const t = await setup()
    cleanups.push(t.cleanup)
    await t.connect('claude-code')
    await t.connect('cursor')
    await settle()
    expect(t.sessions.size).toBe(2)
    expect(t.opened).toHaveLength(2)
    expect(t.identified.sort()).toEqual(['claude-code', 'cursor'])
  })

  it('refuses the initialize beyond the session limit with 503', async () => {
    const t = await setup({ maxSessions: 1 })
    cleanups.push(t.cleanup)
    await t.connect('a')
    await expect(t.connect('b')).rejects.toThrow(/503|too_many_sessions/)
    expect(t.sessions.size).toBe(1)
  })

  it('ends a session whose client dropped its stream for a minute (no DELETE)', async () => {
    const t = await setup()
    cleanups.push(t.cleanup)
    const client = await t.connect('claude-code')
    await settle()
    expect(t.sessions.size).toBe(1)
    await client.close() // aborts the GET stream, no DELETE
    await settle()
    t.advance(30_000)
    t.sessions.sweep()
    expect(t.sessions.size).toBe(1)
    t.advance(31_000)
    t.sessions.sweep()
    await settle()
    expect(t.sessions.size).toBe(0)
    expect(t.closed).toHaveLength(1)
  })

  it('keeps a session with an open stream and closes one idle for 30 min', async () => {
    const t = await setup()
    cleanups.push(t.cleanup)
    const live = await t.connect('streaming')
    // A raw initialize without a GET stream.
    const res = await fetch(t.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      }),
    })
    await res.text()
    await settle()
    expect(t.sessions.size).toBe(2)
    t.advance(31 * 60_000)
    t.sessions.sweep()
    await settle()
    expect(t.sessions.size).toBe(1)
    await live.close()
  })

  it('rejects oversized and malformed bodies', async () => {
    const t = await setup()
    cleanups.push(t.cleanup)
    const post = (body: string) =>
      fetch(t.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
      })
    expect((await post('{nope')).status).toBe(400)
    expect((await post(`"${'x'.repeat(4 * 1024 * 1024 + 10)}"`)).status).toBe(413)
  })
})
