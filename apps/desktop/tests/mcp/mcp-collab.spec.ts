/**
 * MCP with live collaboration (contract docs/phase4/contract.md §14.5): user A signs into the
 * built Electron app (hidden, headless Ozone) and an agent connected to A's app writes into a
 * team file; peer B is a Node `connectFile` client on the same file. B gets the agent's nodes and
 * sees A's peer presence carrying `agents: [{ name, working }]`; finish_working_on_nodes empties
 * the working set; B's edit of the agent's text reaches the agent.
 *
 * Opt-in; needs a scratch server and a build made with its URL (never the user's 8787):
 *
 *   VITE_SERVER_URL=http://127.0.0.1:8897 npx electron-vite build --outDir /tmp/mcp-collab-out
 *   MAIL_TRANSPORT=file:/tmp/mcp-mail BIND=127.0.0.1:8897 DATABASE_URL=sqlite:///tmp/mcp-collab.db \
 *     target/debug/baren-server &
 *   BAREN_MCP_E2E=1 BAREN_ELECTRON_OUT=/tmp/mcp-collab-out BAREN_E2E_MAIL_DIR=/tmp/mcp-mail \
 *     VITE_SERVER_URL=http://127.0.0.1:8897 \
 *     pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts mcp-collab
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getChildIds, getNode, setText } from '@baren/schema'
import { connectFile, type PeerPresence } from '@baren/sync-client'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, test } from '@playwright/test'
import { LoroDoc } from 'loro-crdt'
import { call, connect, launchApp, readEndpoint, type LaunchedApp } from './harness'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? '').replace(/\/+$/, '')
const PASSWORD = 'agent-passw0rd'
const NATIVE = resolve(__dirname, '../../../../crates/napi/baren-core.linux-x64-gnu.node')

test.skip(
  !process.env['BAREN_MCP_E2E'] || !MAIL_DIR || !SERVER || SERVER.endsWith(':8787'),
  'needs BAREN_MCP_E2E=1, BAREN_E2E_MAIL_DIR, VITE_SERVER_URL (a scratch server) and a build for it',
)

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  expect(res.ok, `${method} ${path} → ${res.status} ${text}`).toBe(true)
  return (text ? JSON.parse(text) : undefined) as T
}

async function mailedCode(to: string, after: number): Promise<string> {
  let code: string | null = null
  await expect
    .poll(
      () => {
        for (const name of readdirSync(MAIL_DIR!).sort().reverse()) {
          if (!name.endsWith('.json') || Number.parseInt(name, 10) < after) continue
          const mail = JSON.parse(readFileSync(resolve(MAIL_DIR!, name), 'utf8')) as {
            kind: string
            to: string
            code?: string | null
          }
          if (mail.kind === 'verification_code' && mail.to.includes(to) && mail.code) {
            code = mail.code
            return true
          }
        }
        return false
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return code!
}

async function account(name: string, email: string): Promise<string> {
  const sent = Date.now() - 1000
  await api('POST', '/api/auth/register', { name, email, password: PASSWORD })
  const code = await mailedCode(email, sent)
  return (await api<{ token: string }>('POST', '/api/auth/verify', { email, code })).token
}

let launched: LaunchedApp | null = null
let agent: Client | null = null

test.afterAll(async () => {
  await agent?.close().catch(() => undefined)
  await launched?.close()
})

test('an agent in A’s app edits a shared file live; B sees the nodes and the agent', async () => {
  const stamp = Date.now()
  const emailA = `ada-agent-${stamp}@example.com`
  const tokenA = await account('Ada Agent', emailA)
  const tokenB = await account('Bora Peer', `bora-peer-${stamp}@example.com`)
  const me = await api<{ teams: { id: string }[] }>('GET', '/api/me', undefined, tokenA)
  const teamId = me.teams[0]!.id
  const invite = await api<{ token: string }>(
    'POST',
    `/api/teams/${teamId}/invites`,
    { role: 'editor' },
    tokenA,
  )
  await api('POST', `/api/invites/${invite.token}/accept`, {}, tokenB)
  const remote = await api<{ id: string }>(
    'POST',
    `/api/teams/${teamId}/files`,
    { name: 'Agents shared' },
    tokenA,
  )

  // A: the app, signed in through its sign-in screen.
  launched = await launchApp({ BAREN_CORE: 'native', BAREN_NATIVE_PATH: NATIVE })
  const a = await launched.app.firstWindow()
  await a.getByLabel('Email').fill(emailA)
  await a.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await a.getByRole('button', { name: 'Sign in', exact: true }).click()
  // The team pull links a local copy (named after the document, "Untitled") to the team file.
  await expect(a.locator('[data-file-id]').filter({ hasText: 'Untitled' })).toHaveCount(1, {
    timeout: 30_000,
  })

  agent = await connect(await readEndpoint(launched.userData), 'baren-e2e')
  const files = (await call(agent, 'list_files')).body as {
    files: { id: string; name: string; isShared: boolean }[]
  }
  const shared = files.files.find((f) => f.isShared)!
  expect(shared).toBeDefined()

  // B: a Node peer on the same file.
  const docB = new LoroDoc()
  let peers: readonly PeerPresence[] = []
  const connB = connectFile({
    baseUrl: SERVER,
    token: tokenB,
    fileId: remote.id,
    doc: docB,
    onPresence: (p) => {
      peers = p
    },
  })
  try {
    // The agent writes (the file is not open in a window: a headless host joins the room).
    const board = (
      await call(agent, 'create_artboard', {
        fileId: shared.id,
        name: 'Agent board',
        styles: { width: '800px', height: '600px' },
      })
    ).body as { id: string }
    const written = (
      await call(agent, 'write_html', {
        fileId: shared.id,
        targetNodeId: board.id,
        mode: 'insert-children',
        html: '<p layer-name="Agent text" style="font-size: 24px">Written by the agent</p>',
      })
    ).body as { createdNodes: { id: string }[] }
    const textId = written.createdNodes[0]!.id

    const started = Date.now()
    await expect
      .poll(() => (getNode(docB, textId) as { text?: string } | null)?.text ?? null, {
        timeout: 5_000,
      })
      .toBe('Written by the agent')
    const syncMs = Date.now() - started
    expect(syncMs).toBeLessThan(2_000)
    expect(getChildIds(docB, board.id)).toContain(textId)

    // B sees A's peer with the agent working on the artboard.
    await expect
      .poll(
        () =>
          peers.flatMap((p) => p.agents ?? []).find((x) => x.name === 'baren-e2e')?.working ?? null,
        { timeout: 5_000 },
      )
      .toEqual([board.id])

    await call(agent, 'finish_working_on_nodes', { fileId: shared.id })
    await expect
      .poll(
        () =>
          peers.flatMap((p) => p.agents ?? []).find((x) => x.name === 'baren-e2e')?.working ?? [],
        { timeout: 5_000 },
      )
      .toEqual([])

    // B edits the agent's text; the agent reads B's text.
    setText(docB, textId, 'Edited by B')
    docB.commit()
    await expect
      .poll(
        async () =>
          (
            (await call(agent!, 'get_node_info', { fileId: shared.id, nodeId: textId })).body as {
              textContent: string
            }
          ).textContent,
        { timeout: 5_000 },
      )
      .toBe('Edited by B')
  } finally {
    connB.disconnect()
  }
})
