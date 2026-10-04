/**
 * QA: app restarts with agents connected, through both transports a real client uses — the SDK
 * Streamable HTTP client and the stdio shim launched the way the setup snippet configures it
 * (`ELECTRON_RUN_AS_NODE=1 <electron> <userData>/mcp/baren-mcp-stdio.cjs`). Also the shim
 * when the app is not running, and token rotation under a running shim.
 *
 * Opt-in: `pnpm --filter @baren/desktop build`, then
 * `BAREN_MCP_E2E=1 pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts qa-restart`.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from '@playwright/test'
import { call, connect, readEndpoint, type LaunchedApp } from './harness'
import { goOffline, relaunch } from './qa-helpers'

test.skip(!process.env['BAREN_MCP_E2E'], 'set BAREN_MCP_E2E=1 (needs a build)')

/** A fixed port for this spec (never the user's 29170, 8787 or 5173). */
const PORT = 29391

const root = join(tmpdir(), `baren-mcp-qa-restart-${process.pid}-${Date.now()}`)
const userData = join(root, 'profile')
const exportDir = join(root, 'exports')
let launched: LaunchedApp | null = null
const clients: Client[] = []

test.beforeAll(() => {
  mkdirSync(userData, { recursive: true })
  mkdirSync(exportDir, { recursive: true })
})

test.afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  await launched?.close()
  rmSync(root, { recursive: true, force: true })
})

/** An MCP client over the stdio shim, launched as the "Other → stdio" snippet configures it. */
async function stdioClient(name: string): Promise<{ client: Client; stderr: () => string }> {
  const setupCommand = (await launched!.app.evaluate(() => process.execPath)) as string
  const transport = new StdioClientTransport({
    command: setupCommand,
    args: [join(userData, 'mcp/baren-mcp-stdio.cjs')],
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  })
  let err = ''
  transport.stderr?.on('data', (d: Buffer) => {
    err += d.toString()
  })
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(transport)
  clients.push(client)
  return { client, stderr: () => err }
}

test('the stdio shim says the app is not running when it is not', async () => {
  // First run: install the shim, then quit.
  launched = await relaunch(userData, exportDir, { BAREN_MCP_PORT: String(PORT) })
  await goOffline(launched)
  await readEndpoint(userData)
  const electronPath = (await launched.app.evaluate(() => process.execPath)) as string
  await launched.close()
  launched = null
  expect(existsSync(join(userData, 'mcp/endpoint.json'))).toBe(false)
  expect(existsSync(join(userData, 'mcp/baren-mcp-stdio.cjs'))).toBe(true)
  const transport = new StdioClientTransport({
    command: electronPath,
    args: [join(userData, 'mcp/baren-mcp-stdio.cjs')],
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'qa-not-running', version: '1.0.0' })
  await expect(client.connect(transport)).rejects.toThrow(/not running/)
  await client.close().catch(() => undefined)
})

test('agents over HTTP and stdio survive an app restart', async () => {
  test.setTimeout(180_000)
  launched = await relaunch(userData, exportDir, { BAREN_MCP_PORT: String(PORT) })
  await goOffline(launched)
  const endpoint = await readEndpoint(userData)
  expect(endpoint.url).toBe(`http://127.0.0.1:${PORT}/mcp`)
  const http = await connect(endpoint, 'claude-code')
  clients.push(http)
  const { client: stdio, stderr } = await stdioClient('codex-mcp-client')
  expect((await stdio.listTools()).tools).toHaveLength(33)

  const file = (await call(stdio, 'create_file', { name: 'Restart' })).body as { fileId: string }
  const board = (
    await call(stdio, 'create_artboard', {
      fileId: file.fileId,
      name: 'Before restart',
      styles: { width: '400px', height: '300px' },
    })
  ).body as { id: string }
  await call(http, 'write_html', {
    fileId: file.fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: '<p layer-name="Kept" style="font-size: 20px">Written before the restart</p>',
  })
  const status = await launched.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes('#/recents'),
    )
    return w?.webContents.executeJavaScript('window.baren.mcp.status()') as Promise<{
      agents: { name: string; connected: boolean }[]
    }>
  })
  expect(
    status.agents
      .filter((a) => a.connected)
      .map((a) => a.name)
      .sort(),
  ).toEqual(['Claude Code', 'Codex'])

  // Quit with both agents connected (an open SSE stream must not hold the quit).
  const t = Date.now()
  await launched.close()
  launched = null
  expect(Date.now() - t).toBeLessThan(15_000)
  expect(existsSync(join(userData, 'mcp/endpoint.json'))).toBe(false)

  // Start again on the same profile and port.
  launched = await relaunch(userData, exportDir, { BAREN_MCP_PORT: String(PORT) })
  await goOffline(launched)
  await readEndpoint(userData)

  // stdio: the shim re-initialises transparently (HTTP 404 → replay) and the call succeeds.
  const after = (await call(stdio, 'get_basic_info', { fileId: file.fileId })).body as {
    artboards: { id: string; name: string }[]
  }
  expect(after.artboards.map((a) => a.name)).toEqual(['Before restart'])
  expect(stderr()).toContain('reconnected')
  const tree = (
    await call(stdio, 'get_tree_summary', { fileId: file.fileId, nodeId: after.artboards[0]!.id })
  ).body as { summary: string }
  expect(tree.summary).toContain('Written before the restart')

  // HTTP: the old session is gone (404 → the SDK reports it); a reconnect works.
  await expect(call(http, 'list_files')).rejects.toThrow()
  const again = await connect(await readEndpoint(userData), 'claude-code')
  clients.push(again)
  expect(((await call(again, 'list_files')).body as { count: number }).count).toBeGreaterThan(0)

  // Recently seen agents survive the restart (agents.json).
  const recent = await launched.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes('#/recents'),
    )
    return w?.webContents.executeJavaScript('window.baren.mcp.status()') as Promise<{
      agents: { name: string; connected: boolean }[]
    }>
  })
  expect(recent.agents.map((a) => a.name)).toEqual(expect.arrayContaining(['Claude Code', 'Codex']))
})

test('a running stdio shim keeps working after the token is regenerated', async () => {
  test.setTimeout(120_000)
  if (!launched) {
    launched = await relaunch(userData, exportDir, { BAREN_MCP_PORT: String(PORT) })
    await goOffline(launched)
  }
  await readEndpoint(userData)
  const { client: stdio, stderr } = await stdioClient('codex-mcp-client')
  expect(((await call(stdio, 'list_files')).body as { count: number }).count).toBeGreaterThan(0)
  await launched.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes('#/recents'),
    )
    await w?.webContents.executeJavaScript('window.baren.mcp.resetToken()')
  })
  // The configuration holds no token, so the shim picks up the new one (contract §3.2).
  const res = await call(stdio, 'list_files').catch((e: Error) => e)
  expect(res instanceof Error ? `${res.message}\n${stderr()}` : 'ok').toBe('ok')
})

test('a running stdio shim follows the app to another port after a restart', async () => {
  test.setTimeout(120_000)
  if (!launched) {
    launched = await relaunch(userData, exportDir, { BAREN_MCP_PORT: String(PORT) })
    await goOffline(launched)
  }
  await readEndpoint(userData)
  const { client: stdio, stderr } = await stdioClient('codex-mcp-client')
  expect(((await call(stdio, 'list_files')).body as { count: number }).count).toBeGreaterThan(0)
  await launched.close()
  launched = await relaunch(userData, exportDir, { BAREN_MCP_PORT: String(PORT + 1) })
  await goOffline(launched)
  expect((await readEndpoint(userData)).url).toBe(`http://127.0.0.1:${PORT + 1}/mcp`)
  const res = await call(stdio, 'list_files').catch((e: Error) => e)
  expect(res instanceof Error ? `${res.message}\n${stderr()}` : 'ok').toBe('ok')
})
