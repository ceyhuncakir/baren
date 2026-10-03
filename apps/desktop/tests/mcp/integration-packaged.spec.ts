/**
 * Phase 4 integration (contract docs/phase4/contract.md §14.5, run against the packaged app):
 *
 * - **A** is the packaged app (`electron-builder --linux dir`, hidden: headless Ozone, scratch
 *   profile, ephemeral MCP port), signed in as Ada. An agent connected over Streamable HTTP
 *   ("claude-code" → "Claude Code") builds a pricing screen in a team file with the MCP tools,
 *   first through a hidden host, then (after open_file) through A's visible editor window.
 * - **B** is a second packaged app instance (own profile, MCP off), signed in as Bora on the same
 *   real server, with the file open in its editor. B watches every layer appear on its canvas,
 *   sees the agent's avatar and its working badge, and sees A's Ctrl+Z / Ctrl+Shift+Z.
 * - A **stdio** agent ("cursor" → "Cursor") is launched exactly as A's setup snippet says
 *   (`ELECTRON_RUN_AS_NODE=1 <packaged executable> <userData>/mcp/baren-mcp-stdio.cjs`),
 *   reads the screen the HTTP agent built and edits it in the same app session.
 *
 * Opt-in; needs a scratch server, a build made with its URL and that build packaged:
 *
 *   VITE_SERVER_URL=http://127.0.0.1:8899 npx electron-vite build --outDir /tmp/app/out
 *   electron-builder --linux dir (files from /tmp/app/out)   → …/linux-unpacked/baren
 *   MAIL_TRANSPORT=file:/tmp/mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
 *     target/debug/baren-server &
 *   BAREN_MCP_E2E=1 BAREN_PACKAGED_APP=…/linux-unpacked/baren \
 *     BAREN_E2E_MAIL_DIR=/tmp/mail VITE_SERVER_URL=http://127.0.0.1:8899 \
 *     pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts integration-packaged
 *
 * BAREN_E2E_EVIDENCE_DIR (optional) receives B's window and the agent's screenshot.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEmptyDoc, exportSnapshot } from '@baren/schema'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { call, connect, readEndpoint } from './harness'

const APP = process.env['BAREN_PACKAGED_APP']
const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? '').replace(/\/+$/, '')
const EVIDENCE = process.env['BAREN_E2E_EVIDENCE_DIR']
const PASSWORD = 'agent-passw0rd'
const FILE_NAME = 'Pricing (agents)'

test.skip(
  !process.env['BAREN_MCP_E2E'] ||
    !APP ||
    !MAIL_DIR ||
    !SERVER ||
    SERVER.endsWith(':8787') ||
    (APP !== undefined && !existsSync(APP)),
  'needs BAREN_MCP_E2E=1, BAREN_PACKAGED_APP (a packaged build for VITE_SERVER_URL), BAREN_E2E_MAIL_DIR and VITE_SERVER_URL (a scratch server)',
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

interface Instance {
  app: ElectronApplication
  page: Page
  profile: string
}

const launched: Instance[] = []
const clients: Client[] = []
const scratch = mkdtempSync(join(tmpdir(), 'baren-integration-'))

test.afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  for (const i of launched) await i.app.close().catch(() => undefined)
  rmSync(scratch, { recursive: true, force: true })
})

/** One packaged app instance, hidden, with its own profile, signed in through its sign-in screen. */
async function launchSignedIn(
  label: string,
  email: string,
  env: Record<string, string>,
): Promise<Instance> {
  const profile = join(scratch, label)
  mkdirSync(profile, { recursive: true })
  const app = await _electron.launch({
    executablePath: APP!,
    args: ['--ozone-platform=headless', '--disable-gpu'],
    env: {
      ...(process.env as Record<string, string>),
      BAREN_USER_DATA_DIR: profile,
      BAREN_DISABLE_GPU: '1',
      ELECTRON_ENABLE_LOGGING: '0',
      ...env,
    },
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  const instance = { app, page, profile }
  launched.push(instance)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // The team pull links a local copy (named after the document) to the team file.
  await expect(page.locator('[data-file-id]').filter({ hasText: FILE_NAME })).toHaveCount(1, {
    timeout: 30_000,
  })
  return instance
}

/** B's canvas shows a layer (its DOM node exists), measured from `since`. */
async function appearsOn(page: Page, id: string, since: number): Promise<number> {
  await expect(page.locator(`.ic-root [data-nid="${id}"]`).first()).toBeAttached({
    timeout: 10_000,
  })
  return Date.now() - since
}

/** Whether the overlay canvas has opaque agent-coloured pixels (badge, ring, sweep). */
async function overlayShowsAgent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
    const ctx = c?.getContext('2d')
    if (!c || !ctx || c.width === 0 || c.height === 0) return false
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b, a] = [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, d[i + 3] ?? 0]
      // --color-agent #d0391e.
      if (a > 200 && r > 180 && g > 25 && g < 95 && b < 70) return true
    }
    return false
  })
}

/** Zoom B's canvas to fit (Shift+1) so the agent's artboard is mounted at full detail. */
async function fit(page: Page): Promise<void> {
  await page.bringToFront()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+1')
}

const HEADER = `<div layer-name="Header" style="display: flex; align-items: center; justify-content: space-between; padding: 24px 64px; border-bottom: 1px solid #ececec">
  <span layer-name="Logo" style="font-size: 20px; font-weight: 700; color: #111111">baren</span>
  <nav layer-name="Nav" style="display: flex; gap: 28px; font-size: 14px; color: #555555"><span>Product</span><span>Pricing</span><span>Docs</span></nav>
</div>`

const HERO = `<div layer-name="Hero" style="display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 80px 64px 48px">
  <h1 layer-name="Title" style="font-size: 56px; font-weight: 700; letter-spacing: -0.02em; color: #111111">Simple pricing</h1>
  <p layer-name="Subtitle" style="font-size: 18px; color: #666666">Start free. Upgrade when your team grows.</p>
</div>`

const PLANS = `<div layer-name="Plans" style="display: flex; justify-content: center; gap: 24px; padding: 0 64px 96px">
  <div layer-name="Plan" style="display: flex; flex-direction: column; gap: 12px; width: 320px; padding: 32px; border-radius: 16px; border: 1px solid #e5e5e5; background-color: #ffffff">
    <p layer-name="Plan name" style="font-size: 16px; font-weight: 600; color: #111111">Starter</p>
    <p layer-name="Price" style="font-size: 40px; font-weight: 700; color: #111111">$0</p>
    <p layer-name="Blurb" style="font-size: 14px; color: #666666">For personal projects.</p>
    <div layer-name="Button" style="display: flex; justify-content: center; padding: 10px 16px; border-radius: 8px; background-color: #111111; color: #ffffff; font-size: 14px; font-weight: 600">Get started</div>
  </div>
</div>`

type Created = { createdNodes: { id: string; name: string; parentId: string }[] }

test('the packaged app: an agent builds a screen, a collaborator watches it appear, a stdio agent joins', async () => {
  test.setTimeout(300_000)
  const latencies: Record<string, number> = {}

  // Accounts, a team with both, and a team file (through the server's API).
  const stamp = Date.now()
  const emailA = `ada-${stamp}@example.com`
  const emailB = `bora-${stamp}@example.com`
  const tokenA = await account('Ada Agent', emailA)
  const tokenB = await account('Bora Peer', emailB)
  const me = await api<{ teams: { id: string }[] }>('GET', '/api/me', undefined, tokenA)
  const teamId = me.teams[0]!.id
  const invite = await api<{ token: string }>(
    'POST',
    `/api/teams/${teamId}/invites`,
    { role: 'editor' },
    tokenA,
  )
  await api('POST', `/api/invites/${invite.token}/accept`, {}, tokenB)
  // Created the way Share creates team files: with the snapshot of a document that already has
  // its first page (an empty server file would make each member's copy seed its own page).
  const seed = exportSnapshot(createEmptyDoc(FILE_NAME))
  await api(
    'POST',
    `/api/teams/${teamId}/files`,
    { name: FILE_NAME, snapshot: Buffer.from(seed).toString('base64') },
    tokenA,
  )

  // A: the packaged app with its MCP server on an ephemeral port.
  const exportDir = join(scratch, 'exports')
  mkdirSync(exportDir, { recursive: true })
  const a = await launchSignedIn('a', emailA, {
    BAREN_MCP: '1',
    BAREN_MCP_PORT: '0',
    BAREN_EXPORT_DIR: exportDir,
  })
  // B: a second packaged instance (MCP off) with the shared file open in its editor.
  const b = await launchSignedIn('b', emailB, { BAREN_MCP: '0' })
  // A roomy window: "zoom to fit" must stay above the 25 % level-of-detail threshold, below
  // which the canvas draws artboards as thumbnails (no layer DOM to watch).
  await b.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.setSize(1600, 1000)
  })
  await b.page.locator('[data-file-id]').filter({ hasText: FILE_NAME }).click()
  await b.page.getByTestId('editor').waitFor()
  await expect(b.page.locator('.ic-root').first()).toBeVisible()

  const endpoint = await readEndpoint(a.profile)
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const agent = await connect(endpoint, 'claude-code')
  clients.push(agent)

  let fileId = ''
  let board = ''
  const ids: Record<string, string> = {}

  await test.step('the agent finds the shared file and reads the guide', async () => {
    expect((await agent.listTools()).tools).toHaveLength(30)
    const guide = String((await call(agent, 'get_guide', { topic: 'baren-mcp-instructions' })).body)
    expect(guide.length).toBeGreaterThan(2_000)
    const files = (await call(agent, 'list_files')).body as {
      files: { id: string; isShared: boolean; isOpen: boolean }[]
    }
    const shared = files.files.find((f) => f.isShared)
    expect(shared).toBeDefined()
    expect(shared!.isOpen).toBe(false)
    fileId = shared!.id
    const info = (await call(agent, 'get_basic_info', { fileId })).body as { artboards: unknown[] }
    expect(info.artboards).toEqual([])
  })

  await test.step('it builds the screen in a hidden host; B sees every layer appear', async () => {
    const t0 = Date.now()
    board = (
      (
        await call(agent, 'create_artboard', {
          fileId,
          name: 'Pricing — Desktop',
          styles: { width: '1440px', height: 'fit-content', backgroundColor: '#fafafa' },
        })
      ).body as { id: string }
    ).id
    latencies['create_artboard → B'] = await appearsOn(b.page, board, t0)

    const write = async (html: string, label: string) => {
      const started = Date.now()
      const res = (
        await call(agent, 'write_html', {
          fileId,
          targetNodeId: board,
          mode: 'insert-children',
          html,
        })
      ).body as Created & { warnings: unknown[] }
      if (res.warnings.length > 0) console.log(`write_html ${label} warnings`, res.warnings)
      latencies[`write_html ${label} → B`] = await appearsOn(
        b.page,
        res.createdNodes[0]!.id,
        started,
      )
      return res
    }
    const header = await write(HEADER, 'header')
    ids['header'] = header.createdNodes[0]!.id
    await fit(b.page)
    const hero = await write(HERO, 'hero')
    ids['hero'] = hero.createdNodes[0]!.id
    const plans = await write(PLANS, 'plans')
    ids['plans'] = plans.createdNodes[0]!.id
    await fit(b.page)

    // The nav row of <span>s stays three text layers (html §17.3 item 1).
    const tree = String(
      (
        (await call(agent, 'get_tree_summary', { fileId, nodeId: ids['header'], depth: 3 }))
          .body as { summary: string }
      ).summary,
    )
    expect(tree).toMatch(/"Nav"/)
    for (const word of ['Product', 'Pricing', 'Docs']) expect(tree).toContain(word)

    // B's canvas has the text.
    for (const text of ['Simple pricing', 'Get started', 'Docs']) {
      await expect(
        b.page.locator('.ic-root').getByText(text, { exact: true }).first(),
      ).toBeVisible()
    }
  })

  await test.step('duplicates, restyles and retexts the plans; B follows', async () => {
    const plan = (
      (await call(agent, 'get_children', { fileId, nodeId: ids['plans'] })).body as {
        children: { id: string; name: string }[]
      }
    ).children[0]!
    type Dup = {
      duplicates: { sourceId: string; newId: string; parentId: string }[]
      descendantIdMap: Record<string, string>
    }
    const started = Date.now()
    const proDup = (await call(agent, 'duplicate_nodes', { fileId, nodes: [{ id: plan.id }] }))
      .body as Dup
    const teamDup = (await call(agent, 'duplicate_nodes', { fileId, nodes: [{ id: plan.id }] }))
      .body as Dup
    expect(proDup.duplicates).toHaveLength(1)
    latencies['duplicate_nodes → B'] = await appearsOn(
      b.page,
      teamDup.duplicates[0]!.newId,
      started,
    )

    const kids = (
      (await call(agent, 'get_children', { fileId, nodeId: plan.id })).body as {
        children: { id: string; name: string }[]
      }
    ).children
    const child = (name: string) => kids.find((k) => k.name === name)!.id
    const pro = proDup.descendantIdMap
    const team = teamDup.descendantIdMap
    await call(agent, 'set_text_content', {
      fileId,
      updates: [
        { nodeId: pro![child('Plan name')]!, textContent: 'Pro' },
        { nodeId: pro![child('Price')]!, textContent: '$12' },
        { nodeId: team![child('Plan name')]!, textContent: 'Team' },
        { nodeId: team![child('Price')]!, textContent: '$24' },
      ],
    })
    const restyled = Date.now()
    await call(agent, 'update_styles', {
      fileId,
      updates: [
        {
          nodeIds: [proDup.duplicates[0]!.newId],
          styles: { borderColor: '#1f7a50', borderWidth: '2px' },
        },
        { nodeIds: [pro![child('Button')]!], styles: { backgroundColor: '#1f7a50' } },
      ],
    })
    await expect(b.page.locator('.ic-root').getByText('$24', { exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await expect
      .poll(
        () =>
          b.page.evaluate((id) => {
            const el = document.querySelector<HTMLElement>(`.ic-root [data-nid="${id}"]`)
            return el ? getComputedStyle(el).backgroundColor : null
          }, pro![child('Button')]!),
        { timeout: 10_000 },
      )
      .toBe('rgb(31, 122, 80)')
    latencies['update_styles → B'] = Date.now() - restyled
  })

  await test.step('B sees the agent: its avatar and the working badge on the artboard', async () => {
    await expect(b.page.locator(`[title="Claude Code (Ada Agent's agent)"]`).first()).toBeVisible({
      timeout: 10_000,
    })
    await expect.poll(() => overlayShowsAgent(b.page), { timeout: 10_000 }).toBe(true)
  })

  await test.step('open_file hands the file to A’s window; Ctrl+Z there undoes one call on B too', async () => {
    const opened = (await call(agent, 'open_file', { fileId })).body as {
      artboards: { id: string }[]
    }
    expect(opened.artboards.map((x) => x.id)).toContain(board)
    await a.page.getByTestId('editor').waitFor()
    await expect(a.page.locator(`.ic-root [data-nid="${board}"]`).first()).toBeAttached({
      timeout: 15_000,
    })
    await expect(a.page.locator('[title="Claude Code (agent)"]').first()).toBeVisible({
      timeout: 10_000,
    })

    // A write served by A's visible window reaches B.
    const started = Date.now()
    const footer = (
      await call(agent, 'write_html', {
        fileId,
        targetNodeId: board,
        mode: 'insert-children',
        html: '<p layer-name="Footnote" style="padding: 0 64px 48px; font-size: 13px; color: #888888; text-align: center">Prices in USD, billed monthly.</p>',
      })
    ).body as Created
    const footId = footer.createdNodes[0]!.id
    latencies['write_html via visible window → B'] = await appearsOn(b.page, footId, started)

    await a.page.bringToFront()
    await a.page.mouse.click(700, 450)
    await a.page.keyboard.press('Escape')
    await a.page.keyboard.press('Control+z')
    await expect(
      b.page.locator('.ic-root').getByText('Prices in USD, billed monthly.'),
    ).toHaveCount(0, {
      timeout: 10_000,
    })
    await expect(b.page.locator('.ic-root').getByText('$24', { exact: true })).toBeVisible()
    await a.page.keyboard.press('Control+Shift+z')
    await expect(
      b.page.locator('.ic-root').getByText('Prices in USD, billed monthly.'),
    ).toBeVisible({ timeout: 10_000 })
  })

  await test.step('a stdio agent launched from A’s setup snippet joins the same session', async () => {
    const setup = await a.page.evaluate(() => window.baren!.mcp.setup())
    const execPath = (await a.app.evaluate(() => process.execPath)) as string
    expect(setup.stdio.command).toBe(execPath)
    expect(setup.stdio.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(setup.stdio.args).toEqual([join(a.profile, 'mcp/baren-mcp-stdio.cjs')])
    expect(setup.snippets.claudeCode).toContain(`claude mcp add --scope user --transport http`)
    expect(setup.snippets.claudeCode).toContain(endpoint.url)

    const transport = new StdioClientTransport({
      command: setup.stdio.command,
      args: setup.stdio.args,
      env: { ...(process.env as Record<string, string>), ...setup.stdio.env },
      stderr: 'pipe',
    })
    const stdio = new Client({ name: 'cursor', version: '1.0.0' })
    await stdio.connect(transport)
    clients.push(stdio)
    expect((await stdio.listTools()).tools).toHaveLength(30)

    // No fileId: the file in the most recently focused window (A's editor).
    const info = (await call(stdio, 'get_basic_info')).body as {
      fileName: string
      artboards: { id: string; name: string }[]
    }
    expect(info.artboards.map((x) => x.name)).toEqual(['Pricing — Desktop'])
    const summary = (
      (await call(stdio, 'get_tree_summary', { nodeId: board, depth: 6 })).body as {
        summary: string
      }
    ).summary
    for (const text of ['Simple pricing', 'Starter', 'Pro', 'Team', '$24']) {
      expect(summary).toContain(text)
    }

    const found = (await call(stdio, 'find_nodes', { textValue: 'Start free*' })).body as {
      nodes: { id: string }[]
    }
    expect(found.nodes).toHaveLength(1)
    const started = Date.now()
    await call(stdio, 'set_text_content', {
      updates: [{ nodeId: found.nodes[0]!.id, textContent: 'Edited over stdio.' }],
    })
    await expect(b.page.locator('.ic-root').getByText('Edited over stdio.')).toBeVisible({
      timeout: 10_000,
    })
    latencies['stdio set_text_content → B'] = Date.now() - started
    const seen = (await call(agent, 'get_node_info', { fileId, nodeId: found.nodes[0]!.id }))
      .body as { textContent: string }
    expect(seen.textContent).toBe('Edited over stdio.')

    const status = await a.page.evaluate(() => window.baren!.mcp.status())
    expect(
      status.agents
        .filter((x) => x.connected)
        .map((x) => x.name)
        .sort(),
    ).toEqual(['Claude Code', 'Cursor'])
    await expect(b.page.locator(`[title="Cursor (Ada Agent's agent)"]`).first()).toBeVisible({
      timeout: 10_000,
    })
    await call(stdio, 'finish_working_on_nodes')
  })

  await test.step('screenshot and export; finishing clears the badge on B', async () => {
    const shot = await call(agent, 'get_screenshot', { fileId, nodeId: board })
    const image = shot.content.find((c) => c.type === 'image')!
    expect(image.mimeType).toBe('image/jpeg')
    const jpeg = Buffer.from(image.data!, 'base64')
    expect(jpeg.length).toBeGreaterThan(10_000)
    const exported = (
      await call(agent, 'export', { fileId, nodes: { [board]: [{ format: 'png', scale: '1x' }] } })
    ).body as { files: { path: string; width: number; height: number }[] }
    expect(exported.files[0]!.width).toBe(1440)
    expect(existsSync(exported.files[0]!.path)).toBe(true)

    await call(agent, 'finish_working_on_nodes', { fileId })
    await expect.poll(() => overlayShowsAgent(b.page), { timeout: 10_000 }).toBe(false)

    if (EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true })
      writeFileSync(join(EVIDENCE, 'agent-screenshot.jpg'), jpeg)
      await fit(b.page)
      await b.page.waitForTimeout(500)
      await b.page.screenshot({ path: join(EVIDENCE, 'collaborator-b.png') })
      writeFileSync(join(EVIDENCE, 'latencies.json'), JSON.stringify(latencies, null, 1))
    }
    console.log('integration latencies (ms):', JSON.stringify(latencies))
  })
})
