/**
 * QA: agents in a shared file against a real baren-server. User A runs the built app (hidden)
 * with an agent connected; peer B is a Node `connectFile` client.
 *
 * - The file open in A's window: the agent and B write into one artboard at the same time and
 *   both sides converge on the same children in the same order; an image the agent writes from a
 *   local path is uploaded and B downloads the same bytes; Ctrl+Z in A's window undoes the
 *   agent's last call for B too.
 * - A as a viewer of B's team file: the agent can read it, every write is refused with
 *   `read_only` and nothing reaches B.
 *
 * Opt-in; needs a scratch server and a build made with its URL (never the user's 8787):
 *
 *   VITE_SERVER_URL=http://127.0.0.1:8898 npx electron-vite build --outDir /tmp/qa-out
 *   MAIL_TRANSPORT=file:/tmp/qa-mail BIND=127.0.0.1:8898 DATABASE_URL=sqlite:///tmp/qa.db?mode=rwc \
 *     target/debug/baren-server &
 *   BAREN_MCP_E2E=1 BAREN_ELECTRON_OUT=/tmp/qa-out BAREN_E2E_MAIL_DIR=/tmp/qa-mail \
 *     VITE_SERVER_URL=http://127.0.0.1:8898 \
 *     pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts qa-collab
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createNode, getChildIds, getNode } from '@baren/schema'
import { connectFile } from '@baren/sync-client'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, test, type Page } from '@playwright/test'
import { LoroDoc } from 'loro-crdt'
import { call, callError, connect, disconnect, editorWindow } from './qa-helpers'
import { launchApp, readEndpoint, type LaunchedApp } from './harness'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? '').replace(/\/+$/, '')
const PASSWORD = 'agent-passw0rd'
const NATIVE = resolve(__dirname, '../../../../crates/napi/baren-core.linux-x64-gnu.node')

test.skip(
  !process.env['BAREN_MCP_E2E'] || !MAIL_DIR || !SERVER || SERVER.endsWith(':8787'),
  'needs BAREN_MCP_E2E=1, BAREN_E2E_MAIL_DIR, VITE_SERVER_URL (a scratch server) and a build for it',
)
test.describe.configure({ mode: 'serial' })

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

const stamp = Date.now()
const emailA = `qa-agent-a-${stamp}@example.com`
const emailB = `qa-peer-b-${stamp}@example.com`
let tokenA = ''
let tokenB = ''
const apps: LaunchedApp[] = []
const clients: Client[] = []

test.beforeAll(async () => {
  tokenA = await account('Ada QA', emailA)
  tokenB = await account('Bora QA', emailB)
})

test.afterAll(async () => {
  for (const c of clients) await disconnect(c)
  for (const a of apps) await a.close()
})

/** Launch the app on a fresh profile and sign A in through the sign-in screen. */
async function signedInApp(currentTeam?: string): Promise<{ launched: LaunchedApp; first: Page }> {
  const launched = await launchApp({ BAREN_CORE: 'native', BAREN_NATIVE_PATH: NATIVE })
  apps.push(launched)
  const first = await launched.app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  if (currentTeam) {
    await first.evaluate((id) => localStorage.setItem('baren.currentTeam', id), currentTeam)
  }
  await first.getByLabel('Email').fill(emailA)
  await first.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await first.getByRole('button', { name: 'Sign in', exact: true }).click()
  return { launched, first }
}

test('an agent and a collaborator write into one artboard at once; images and undo reach the peer', async () => {
  test.setTimeout(240_000)
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
    { name: 'QA shared' },
    tokenA,
  )

  const { launched, first } = await signedInApp()
  await expect(first.locator('[data-file-id]').filter({ hasText: 'Untitled' })).toHaveCount(1, {
    timeout: 30_000,
  })
  const agent = await connect(await readEndpoint(launched.userData), 'claude-code')
  clients.push(agent)
  const shared = (
    (await call(agent, 'list_files')).body as { files: { id: string; isShared: boolean }[] }
  ).files.find((f) => f.isShared)!
  const fileId = shared.id
  await call(agent, 'open_file', { fileId })
  const page = await editorWindow(launched, fileId)
  await page.locator('.ic-root').waitFor({ state: 'attached' })

  const docB = new LoroDoc()
  const connB = connectFile({ baseUrl: SERVER, token: tokenB, fileId: remote.id, doc: docB })
  try {
    const board = (
      await call(agent, 'create_artboard', {
        fileId,
        name: 'Shared board',
        styles: { width: '600px', height: 'fit-content' },
      })
    ).body as { id: string }
    await expect
      .poll(() => getNode(docB, board.id)?.name ?? null, { timeout: 5_000 })
      .toBe('Shared board')

    // Both write six rows into the artboard at the same time.
    const agentRows = (async () => {
      for (let i = 0; i < 6; i++) {
        await call(agent, 'write_html', {
          fileId,
          targetNodeId: board.id,
          mode: 'insert-children',
          html: `<p layer-name="Agent ${i}" style="font-size: 14px">Agent row ${i}</p>`,
        })
      }
    })()
    const peerRows = (async () => {
      for (let i = 0; i < 6; i++) {
        createNode(docB, {
          type: 'text',
          parentId: board.id,
          name: `Peer ${i}`,
          styles: { fontSize: 14 },
          text: `Peer row ${i}`,
        })
        docB.commit()
        await new Promise((r) => setTimeout(r, 15))
      }
    })()
    await Promise.all([agentRows, peerRows])
    const agentSees = async (): Promise<string[]> =>
      (
        (await call(agent, 'get_children', { fileId, nodeId: board.id })).body as {
          children: { id: string }[]
        }
      ).children.map((c) => c.id)
    await expect.poll(async () => (await agentSees()).length, { timeout: 10_000 }).toBe(12)
    await expect.poll(() => getChildIds(docB, board.id).length, { timeout: 10_000 }).toBe(12)
    // Same children, same order, on both sides.
    await expect
      .poll(async () => JSON.stringify(await agentSees()), { timeout: 5_000 })
      .toBe(JSON.stringify(getChildIds(docB, board.id)))
    const names = getChildIds(docB, board.id).map((id) => getNode(docB, id)?.name)
    expect(names.filter((n) => n?.startsWith('Agent')).sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `Agent ${i}`),
    )
    expect(names.filter((n) => n?.startsWith('Peer')).sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `Peer ${i}`),
    )

    // An image from a local path: stored, uploaded, and the peer downloads the same bytes.
    const pngPath = join(launched.userData, '..', 'shared.png')
    const png = await launched.app.evaluate(({ nativeImage }) => {
      const bitmap = Buffer.alloc(24 * 16 * 4)
      for (let i = 0; i < 24 * 16; i++) bitmap.set([0x40, 0x20, 0xd0, 0xff], i * 4)
      return nativeImage
        .createFromBitmap(bitmap, { width: 24, height: 16 })
        .toPNG()
        .toString('base64')
    })
    writeFileSync(pngPath, Buffer.from(png, 'base64'))
    const img = (
      (
        await call(agent, 'write_html', {
          fileId,
          targetNodeId: board.id,
          mode: 'insert-children',
          html: `<img layer-name="Shared image" src="${pngPath}">`,
        })
      ).body as { createdNodes: { id: string }[] }
    ).createdNodes[0]!.id
    await expect.poll(() => getNode(docB, img)?.type ?? null, { timeout: 5_000 }).toBe('image')
    const asset = (getNode(docB, img) as { assetId?: string } | undefined)?.assetId ?? null
    expect(asset).toMatch(/^[0-9a-f]{64}$/)
    await expect
      .poll(
        async () => {
          const res = await fetch(`${SERVER}/api/files/${remote.id}/assets/${asset}`, {
            headers: { authorization: `Bearer ${tokenB}` },
          })
          return res.ok
            ? Buffer.from(await res.arrayBuffer()).equals(Buffer.from(png, 'base64'))
            : res.status
        },
        { timeout: 10_000 },
      )
      .toBe(true)

    // Ctrl+Z in A's window undoes the agent's last call — for B too.
    await page.bringToFront()
    await page.mouse.click(5, 450)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+z')
    await expect.poll(() => getNode(docB, img) ?? null, { timeout: 5_000 }).toBeNull()
    expect(getChildIds(docB, board.id)).toHaveLength(12)
    await call(agent, 'finish_working_on_nodes', { fileId })
  } finally {
    connB.disconnect()
  }
})

test('a viewer’s agent can read a shared file but every write is refused', async () => {
  test.setTimeout(240_000)
  // A team of B's with a file; A joins it as a viewer.
  const ownTeam = (
    await api<{ id: string }>('POST', '/api/teams', { name: `QA viewers ${stamp}` }, tokenB)
  ).id
  const invite = await api<{ token: string }>(
    'POST',
    `/api/teams/${ownTeam}/invites`,
    { role: 'viewer' },
    tokenB,
  )
  await api('POST', `/api/invites/${invite.token}/accept`, {}, tokenA)
  const remote = await api<{ id: string }>(
    'POST',
    `/api/teams/${ownTeam}/files`,
    { name: 'Read only' },
    tokenB,
  )
  const docB = new LoroDoc()
  const connB = connectFile({ baseUrl: SERVER, token: tokenB, fileId: remote.id, doc: docB })
  try {
    // B fills the (empty) file first: a page with an artboard.
    await new Promise((r) => setTimeout(r, 500))
    const pageId =
      getChildIds(docB, null)[0] ??
      createNode(docB, { type: 'page', parentId: null, name: 'Page 1', styles: {} })
    const board = createNode(docB, {
      type: 'frame',
      parentId: pageId,
      name: 'B board',
      styles: { width: 300, height: 200 },
    })
    docB.commit()

    const { launched, first } = await signedInApp(ownTeam)
    // The team pull brings the viewer file in (A's other team's files may come along).
    await expect(first.locator('[data-file-id]').first()).toBeVisible({ timeout: 30_000 })
    const agent = await connect(await readEndpoint(launched.userData), 'claude-code')
    clients.push(agent)
    // Reads work (through a hidden host that joins the room as a viewer): find the file by its
    // content.
    let fileId = ''
    await expect
      .poll(
        async () => {
          const files = (
            (await call(agent, 'list_files')).body as { files: { id: string; isShared: boolean }[] }
          ).files
          for (const f of files.filter((x) => x.isShared)) {
            const info = (await call(agent, 'get_basic_info', { fileId: f.id })).body as {
              artboards: { name: string }[]
            }
            if (info.artboards.some((a) => a.name === 'B board')) {
              fileId = f.id
              return true
            }
          }
          return false
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    // Writes are refused with read_only, in-band errors included.
    const writes: [string, Record<string, unknown>][] = [
      ['write_html', { targetNodeId: board, mode: 'insert-children', html: '<p>agent</p>' }],
      ['create_artboard', { name: 'x', styles: { width: '100px', height: '100px' } }],
      ['update_styles', { updates: [{ nodeIds: [board], styles: { backgroundColor: 'red' } }] }],
      ['rename_nodes', { updates: [{ nodeId: board, name: 'renamed' }] }],
      ['create_tokens', { tokens: [{ type: 'color', name: '--color-x', value: 'red' }] }],
      ['delete_nodes', { nodeIds: [board] }],
    ]
    for (const [name, args] of writes) {
      const r = await callError(agent, name, { fileId, ...args })
      expect(r.isError, name).toBe(true)
      expect(r.text, name).toMatch(/read_only|viewer/i)
    }
    await new Promise((r) => setTimeout(r, 1_000))
    expect(getNode(docB, board)).toMatchObject({ name: 'B board' })
    expect(getChildIds(docB, board)).toEqual([])
  } finally {
    connB.disconnect()
  }
})
