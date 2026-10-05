import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { McpHttpServer } from './httpServer'
import { allowedHosts, allowedOrigins } from './security'
import { SessionManager, type SessionHandle } from './sessions'

const TOKEN = 'brn_test'
const RUN_TOKEN = 'brr_run'
const RUN_SCOPE = { runId: 'run1', fileId: 'file1' }

async function setup(opts: { maxSessions?: number } = {}) {
  let now = 1_000_000
  const opened: string[] = []
  const identified: string[] = []
  const closed: string[] = []
  const refs: SessionHandle[] = []
  let http: McpHttpServer
  const sessions = new SessionManager({
    createServer: (ref) => {
      refs.push(ref)
      return new McpServer({ name: 'test', version: '1' }, { capabilities: { tools: {} } })
    },
    onOpened: (id) => opened.push(id),
    onIdentified: (_id, client) => identified.push(client?.name ?? '?'),
    onClosed: (id) => closed.push(id),
    allowedHosts: () => allowedHosts(http.port ?? 0),
    allowedOrigins: () => allowedOrigins(http.port ?? 0),
    now: () => now,
    ...(opts.maxSessions ? { maxSessions: opts.maxSessions } : {}),
  })
  http = new McpHttpServer({
    security: () => ({
      token: TOKEN,
      runTokens: new Map([[RUN_TOKEN, RUN_SCOPE]]),
      extraOrigins: [],
    }),
    handle: (req, res, scope) => sessions.handle(req, res, scope),
  })
  const port = await http.listen([0])
  const url = `http://127.0.0.1:${port}/mcp`
  const connect = async (name: string, token = TOKEN) => {
    const client = new Client({ name, version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
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
    refs,
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

  it('keeps a run token session to that token, and closes it with the run', async () => {
    const t = await setup()
    cleanups.push(t.cleanup)
    await t.connect('claude-code')
    await t.connect('claude-code', RUN_TOKEN)
    await settle()
    const run = t.refs.find((r) => r.scope !== null)!
    expect(run.scope).toEqual(RUN_SCOPE)
    expect(t.refs.filter((r) => r.scope === null)).toHaveLength(1)
    // The app's token cannot drive the run's session (nor the other way round).
    const call = (token: string, sessionId: string) =>
      fetch(t.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Mcp-Session-Id': sessionId,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      })
    const app = t.refs.find((r) => r.scope === null)!
    expect((await call(TOKEN, run.sessionId)).status).toBe(404)
    expect((await call(RUN_TOKEN, app.sessionId)).status).toBe(404)
    expect((await call(RUN_TOKEN, run.sessionId)).status).toBe(200)

    await t.sessions.closeRun('run1')
    expect(t.sessions.ids()).toEqual([app.sessionId])
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
