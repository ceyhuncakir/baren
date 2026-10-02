/**
 * QA: the MCP endpoint's security against a real build (contract docs/phase4/contract.md §3.2,
 * §4.1, §13): loopback only, bearer token, Host/Origin checks (DNS rebinding), no CORS, body
 * limits, rate limiting, token rotation, disabling the server, file permissions.
 *
 * Opt-in like the other MCP specs: `pnpm --filter @baren/desktop build`, then
 * `BAREN_MCP_E2E=1 pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts qa-security`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, test } from '@playwright/test'
import { readEndpoint } from './harness'
import { INITIALIZE, call, connect, launchOffline, raw, type OfflineApp } from './qa-helpers'

test.skip(!process.env['BAREN_MCP_E2E'], 'set BAREN_MCP_E2E=1 (needs a build)')
test.describe.configure({ mode: 'serial' })

let app: OfflineApp
const clients: Client[] = []

test.beforeAll(async () => {
  app = await launchOffline()
})

test.afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  await app?.launched.close()
})

const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

function noCors(headers: Record<string, unknown>): void {
  for (const key of Object.keys(headers)) expect(key.toLowerCase()).not.toMatch(/^access-control-/)
}

test('requests without a valid token are refused with 401 and no CORS headers', async () => {
  const { url, token } = app.endpoint
  const none = await raw(url, { body: INITIALIZE })
  expect(none.status).toBe(401)
  expect(none.headers['www-authenticate']).toBe('Bearer realm="Baren"')
  expect(JSON.parse(none.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null })
  noCors(none.headers)

  const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
  for (const value of [
    `Bearer ${wrong}`,
    `Bearer ${token.slice(0, -1)}`,
    `Bearer ${token}x`,
    `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
    token,
    `Bearer`,
  ]) {
    const res = await raw(url, { body: INITIALIZE, headers: { Authorization: value } })
    expect(res.status, value.slice(0, 12)).toBe(401)
  }
  // The right token in any case of the scheme works.
  const ok = await raw(url, { body: INITIALIZE, headers: { Authorization: `bearer ${token}` } })
  expect(ok.status).toBe(200)
  expect(ok.headers['mcp-session-id']).toBeTruthy()
  noCors(ok.headers)
})

test('DNS rebinding: foreign Host and Origin headers are refused even with the token', async () => {
  const { url, token } = app.endpoint
  const port = new URL(url).port
  for (const host of [
    `evil.example:${port}`,
    `127.0.0.1`,
    `localhost`,
    `127.0.0.1:${Number(port) + 1}`,
    `127.0.0.2:${port}`,
    `[::1]:${port}`,
    `0.0.0.0:${port}`,
  ]) {
    const res = await raw(url, { body: INITIALIZE, headers: { ...auth(token), Host: host } })
    expect(res.status, host).toBe(403)
    expect(res.body, host).toContain('invalid_host')
  }
  for (const origin of [
    'http://evil.example',
    `http://evil.example:${port}`,
    'null',
    `https://127.0.0.1:${port}`,
    `http://localhost:${Number(port) + 1}`,
    'app://baren',
    'file://',
  ]) {
    const res = await raw(url, { body: INITIALIZE, headers: { ...auth(token), Origin: origin } })
    expect(res.status, origin).toBe(403)
    expect(res.body, origin).toContain('invalid_origin')
    noCors(res.headers)
  }
  // Loopback names of this port are fine (Host and Origin). (Upper-case spellings pass our own
  // check but the SDK transport's exact-match DNS-rebinding check refuses them: harmless, as
  // HTTP clients send the lower-case host of the URL.)
  for (const [host, origin] of [
    [`localhost:${port}`, undefined],
    [`localhost:${port}`, `http://localhost:${port}`],
    [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
  ] as const) {
    const res = await raw(url, {
      body: INITIALIZE,
      headers: { ...auth(token), Host: host, ...(origin ? { Origin: origin } : {}) },
    })
    expect(res.status, `${host} ${origin}`).toBe(200)
  }
})

test('only POST/GET/DELETE on /mcp; preflights, other paths and oversized bodies are refused', async () => {
  const { url, token } = app.endpoint
  const options = await raw(url, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  expect(options.status).toBe(405)
  noCors(options.headers)
  for (const method of ['PUT', 'PATCH']) {
    expect((await raw(url, { method, headers: auth(token), body: INITIALIZE })).status).toBe(405)
  }
  for (const path of ['/', '/MCP', '/mcp/', '/mcp/x', '/sse', '/../mcp2']) {
    expect((await raw(url, { path, headers: auth(token), body: INITIALIZE })).status, path).toBe(
      404,
    )
  }
  // A query string is fine.
  expect(
    (await raw(url, { path: '/mcp?x=1', headers: auth(token), body: INITIALIZE })).status,
  ).toBe(200)
  const big = Buffer.alloc(4 * 1024 * 1024 + 16, 0x20)
  const tooBig = await raw(url, { headers: auth(token), body: big, timeoutMs: 30_000 }).catch(
    (e: Error) => ({ status: -1, body: e.message, headers: {} }),
  )
  // 413, or the connection is cut after the limit.
  expect([413, -1]).toContain(tooBig.status)
  const bad = await raw(url, { headers: auth(token), body: '{"jsonrpc":"2.0",' })
  expect(bad.status).toBe(400)
  // Without a session id only initialize is accepted; an unknown session id is 404.
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  expect((await raw(url, { headers: auth(token), body: list })).status).toBe(400)
  expect(
    (await raw(url, { headers: { ...auth(token), 'Mcp-Session-Id': 'nope' }, body: list })).status,
  ).toBe(404)
})

test('the server listens on 127.0.0.1 only', async () => {
  const port = Number(new URL(app.endpoint.url).port)
  const tryConnect = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = netConnect({ host, port, timeout: 2_000 })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
  expect(await tryConnect('127.0.0.1')).toBe(true)
  expect(await tryConnect('::1')).toBe(false)
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === 'IPv4')
    .map((i) => i!.address)
  for (const address of lan.slice(0, 3)) expect(await tryConnect(address), address).toBe(false)
})

test('config and endpoint files: private modes, no token in endpoint.json or status', async () => {
  const dir = join(app.launched.userData, 'mcp')
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, 'endpoint.json')).mode & 0o777).toBe(0o600)
  const endpointText = readFileSync(join(dir, 'endpoint.json'), 'utf8')
  expect(endpointText).not.toContain(app.endpoint.token)
  expect(app.endpoint.token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/)
  const status = await app.first.evaluate(() => window.baren!.mcp.status())
  expect(JSON.stringify(status)).not.toContain(app.endpoint.token)
  // The stdio shim config holds no secret either.
  const setup = await app.first.evaluate(() => window.baren!.mcp.setup())
  expect(setup.token).toBe(app.endpoint.token)
  expect(JSON.stringify(setup.stdio)).not.toContain(app.endpoint.token)
  expect(setup.snippets.stdioJson).not.toContain(app.endpoint.token)
})

test('requests without any Authorization header do not lock out the real agent', async () => {
  // A web page can make the browser send credential-less GETs (an <img src>, no Origin header)
  // to the default port; they must not count as brute-force attempts.
  const { url, token } = app.endpoint
  for (let i = 0; i < 40; i++) {
    const res = await raw(url, { method: 'GET', headers: { Accept: 'image/*' } })
    expect(res.status).toBe(401)
  }
  const ok = await raw(url, { body: INITIALIZE, headers: auth(token) })
  expect(ok.status).toBe(200)
})

test('token rotation closes old sessions; old tokens get 401, old session ids 404', async () => {
  const client = await connect(app.endpoint, 'qa-rotation')
  clients.push(client)
  expect((await client.listTools()).tools.length).toBe(30)
  const before = await app.first.evaluate(() => window.baren!.mcp.status())
  expect(before.agents.some((a) => a.name === 'qa-rotation' && a.connected)).toBe(true)
  const sessionId = (client.transport as { sessionId?: string } | undefined)?.sessionId
  expect(sessionId).toBeTruthy()

  const setup = await app.first.evaluate(() => window.baren!.mcp.resetToken())
  expect(setup.token).not.toBe(app.endpoint.token)
  expect(setup.token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/)
  expect(
    JSON.parse(readFileSync(join(app.launched.userData, 'mcp/config.json'), 'utf8')).token,
  ).toBe(setup.token)
  await expect(client.listTools()).rejects.toThrow()
  const list = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const stale = await raw(app.endpoint.url, {
    headers: { ...auth(app.endpoint.token), 'Mcp-Session-Id': sessionId! },
    body: list,
  })
  expect(stale.status).toBe(401)
  const closed = await raw(app.endpoint.url, {
    headers: { ...auth(setup.token), 'Mcp-Session-Id': sessionId! },
    body: list,
  })
  expect(closed.status).toBe(404)
  const after = await app.first.evaluate(() => window.baren!.mcp.status())
  expect(after.agents.some((a) => a.name === 'qa-rotation' && a.connected)).toBe(false)

  app.endpoint = { url: app.endpoint.url, token: setup.token }
  const fresh = await connect(app.endpoint, 'qa-rotation-2')
  clients.push(fresh)
  expect((await call(fresh, 'list_files')).body).toMatchObject({ count: expect.any(Number) })
})

test('brute force: more than 30 wrong tokens a minute block everyone (429) until a token reset', async () => {
  const { url, token } = app.endpoint
  for (let i = 0; i < 31; i++) {
    await raw(url, { body: INITIALIZE, headers: { Authorization: `Bearer brn_wrong${i}` } })
  }
  const blocked = await raw(url, { body: INITIALIZE, headers: auth(token) })
  expect(blocked.status).toBe(429)
  expect(blocked.headers['retry-after']).toBe('60')
  // Regenerating the token (the user's way out) clears the block.
  const setup = await app.first.evaluate(() => window.baren!.mcp.resetToken())
  app.endpoint = { url, token: setup.token }
  expect((await raw(url, { body: INITIALIZE, headers: auth(setup.token) })).status).toBe(200)
})

test('a disabled server refuses connections and comes back with the same token', async () => {
  const client = await connect(app.endpoint, 'qa-disable')
  clients.push(client)
  const off = await app.first.evaluate(() => window.baren!.mcp.setEnabled(false))
  expect(off).toMatchObject({ state: 'off', enabled: false, url: null })
  expect(existsSync(join(app.launched.userData, 'mcp/endpoint.json'))).toBe(false)
  await expect(
    raw(app.endpoint.url, { body: INITIALIZE, headers: auth(app.endpoint.token) }),
  ).rejects.toThrow(/ECONNREFUSED/)
  await expect(client.listTools()).rejects.toThrow()
  await expect(app.first.evaluate(() => window.baren!.mcp.setup())).rejects.toThrow(/off/)
  expect(
    JSON.parse(readFileSync(join(app.launched.userData, 'mcp/config.json'), 'utf8')).enabled,
  ).toBe(false)

  const on = await app.first.evaluate(() => window.baren!.mcp.setEnabled(true))
  expect(on.state).toBe('running')
  const endpoint = await readEndpoint(app.launched.userData)
  expect(endpoint.token).toBe(app.endpoint.token)
  app.endpoint = endpoint
  const again = await connect(endpoint, 'qa-disable-2')
  clients.push(again)
  expect((await again.listTools()).tools.length).toBe(30)
})

test('at most 32 sessions: the 33rd initialize is refused until one ends', async () => {
  const { url, token } = app.endpoint
  // Clients connected by earlier tests count too.
  const opened: string[] = []
  for (let i = 0; i < 40; i++) {
    const res = await raw(url, { body: INITIALIZE, headers: auth(token) })
    if (res.status !== 200) {
      expect(res.status).toBe(503)
      expect(res.body).toContain('too_many_sessions')
      break
    }
    opened.push(String(res.headers['mcp-session-id']))
  }
  expect(opened.length).toBeGreaterThan(20)
  expect(opened.length).toBeLessThan(33)
  // DELETE ends a session and frees its slot.
  const del = await raw(url, {
    method: 'DELETE',
    headers: { ...auth(token), 'Mcp-Session-Id': opened[0]! },
  })
  expect(del.status).toBe(200)
  const again = await raw(url, { body: INITIALIZE, headers: auth(token) })
  expect(again.status).toBe(200)
  for (const id of [...opened.slice(1), String(again.headers['mcp-session-id'])]) {
    await raw(url, { method: 'DELETE', headers: { ...auth(token), 'Mcp-Session-Id': id } })
  }
})
