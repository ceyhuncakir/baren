/**
 * Phase 4 UI (docs/phase4/contract.md §10.1, §10.8, §14.4) in browser mode (mock bridge):
 *
 * 1. Pixel fidelity of artboards 34, 35, 36, D34 and D35 (design/reference) — any channel off by
 *    more than 24/255, 3 % budget (the Phase 3 metric of editor.spec.ts) — with
 *    `?fixture=design&mcp=<state>`: `not-connected` for 34/D34, `connected` for 35/D35/36. The
 *    agent of 35 is injected as the runtime receives it from main (`window.__barenAgent
 *    .presence`, the mock bridge's agent loop). The sweep is frozen where the reference draws it
 *    (head on the top-right corner) with the overlay's test-only `__barenAgentSweepPhase = 0`
 *    instead of emulating reduced motion (which would draw the static 1.5 px ring instead).
 * 2. Behaviour: the Connect dialog's segments, masking, Reveal, Copy, the Switch, Regenerate
 *    token and the remembered segment; the MCP section and the home card for every `?mcp=`
 *    state and live status changes; agent avatars and badges for injected presence; every
 *    entry point opens the same dialog.
 *
 * Known, accepted differences: artboard 34/D34's code block still shows the design's
 * placeholder snippet (port 29980, no `--scope user`); the app shows the contract's (§4.13).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { readReference } from './references'

const REFERENCE_DIR = resolve(__dirname, '../../../../design/reference')
/** "Edited …" / "Last active …" labels are computed from this fixed clock (screens.spec.ts). */
const FIXED_NOW = new Date('2026-10-02T12:00:00Z')

const LIBRARY = 'f-acme'
const PICKER_SCENE = 'editorScene=picker'
const MOCK_PRESENCE_ID = 'mockclaudecd'
const MOCK_TOKEN = 'brn_mock_token_7f3a'

/** Allowed share of differing pixels (contract §10.8: the Phase 3 budget). */
const BUDGET = 0.03

const REFERENCES = {
  '34': '34-editor-connect-agent.png',
  '35': '35-editor-agent-working.png',
  '36': '36-home-agents-connected.png',
  D34: 'D34-editor-connect-agent-dark.png',
  D35: 'D35-editor-agent-working-dark.png',
} as const

type Key = keyof typeof REFERENCES

/* ------------------------------------------------------------------ helpers */

function url(opts: { mcp?: string; theme?: 'dark' | 'light'; scene?: string; hash: string }) {
  const q = ['fixture=design']
  if (opts.scene) q.push(opts.scene)
  if (opts.mcp) q.push(`mcp=${opts.mcp}`)
  if (opts.theme) q.push(`theme=${opts.theme}`)
  return `/?${q.join('&')}${opts.hash}`
}

async function freezeSweep(page: Page) {
  await page.addInitScript(() => {
    ;(globalThis as { __barenAgentSweepPhase?: number }).__barenAgentSweepPhase = 0
  })
}

interface CanvasStatsLike {
  pendingWork: number
  thumbnails: number
  lod: boolean
}

/** Opens a fixture file and waits until the canvas has painted everything it will paint. */
async function openEditor(page: Page, path: string, thumbnails = 0) {
  await page.clock.setFixedTime(FIXED_NOW)
  await page.goto(path)
  await page.getByTestId('editor').waitFor()
  await page.waitForFunction(() => {
    const hook = (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor
    return hook?.canvas != null
  })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForFunction(
    (n) => {
      const hook = (
        window as unknown as { __barenEditor: { canvas: { getStats(): CanvasStatsLike } } }
      ).__barenEditor
      const s = hook.canvas.getStats()
      return s.pendingWork === 0 && (!s.lod || s.thumbnails >= n)
    },
    thumbnails,
    { timeout: 15_000 },
  )
  await page.mouse.move(120, 780)
  await settle(page)
}

async function openHome(page: Page, path: string) {
  await page.clock.setFixedTime(FIXED_NOW)
  await page.goto(path)
  await page.waitForFunction('document.fonts.status === "loaded"')
  await expect(page.getByTestId('file-grid').locator('img')).toHaveCount(7)
  await page.waitForFunction(
    '[...document.images].every((img) => img.complete && img.naturalWidth > 0)',
  )
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))),
      ),
  )
}

/** Decodes both PNGs in a scratch page and counts differing pixels (max channel delta > 24). */
async function compare(context: BrowserContext, actual: Buffer, reference: Buffer) {
  const scratch = await context.newPage()
  try {
    const out = await scratch.evaluate(
      async ({ a, b }) => {
        const load = async (b64: string) => {
          const img = new Image()
          img.src = `data:image/png;base64,${b64}`
          await img.decode()
          return img
        }
        const [ia, ib] = await Promise.all([load(a), load(b)])
        const w = Math.min(ia.width, ib.width)
        const h = Math.min(ia.height, ib.height)
        const read = (img: HTMLImageElement) => {
          const c = new OffscreenCanvas(w, h)
          const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
          ctx.drawImage(img, 0, 0)
          return ctx.getImageData(0, 0, w, h).data
        }
        const pa = read(ia)
        const pb = read(ib)
        const diff = new OffscreenCanvas(w, h)
        const dctx = diff.getContext('2d') as OffscreenCanvasRenderingContext2D
        const img = dctx.createImageData(w, h)
        let count = 0
        for (let i = 0; i < pa.length; i += 4) {
          const d = Math.max(
            Math.abs((pa[i] ?? 0) - (pb[i] ?? 0)),
            Math.abs((pa[i + 1] ?? 0) - (pb[i + 1] ?? 0)),
            Math.abs((pa[i + 2] ?? 0) - (pb[i + 2] ?? 0)),
          )
          if (d > 24) {
            count++
            img.data[i] = 255
            img.data[i + 1] = 0
            img.data[i + 2] = 0
            img.data[i + 3] = 255
          } else {
            const g = 255 - Math.round((255 - (pb[i] ?? 0)) * 0.25)
            img.data[i] = g
            img.data[i + 1] = g
            img.data[i + 2] = g
            img.data[i + 3] = 255
          }
        }
        dctx.putImageData(img, 0, 0)
        const blob = await diff.convertToBlob({ type: 'image/png' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        return { ratio: count / (w * h), diff: btoa(bin) }
      },
      { a: actual.toString('base64'), b: reference.toString('base64') },
    )
    return { ratio: out.ratio, diff: Buffer.from(out.diff, 'base64') }
  } finally {
    await scratch.close()
  }
}

async function check(page: Page, key: Key, testInfo: TestInfo) {
  await settle(page)
  const actual = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const reference = readReference(resolve(REFERENCE_DIR, REFERENCES[key]), actual)
  const { ratio, diff } = await compare(page.context(), actual, reference)
  const pct = (ratio * 100).toFixed(2)
  console.log(`[phase4 visual] ${key}: ${pct}% of pixels differ (budget ${BUDGET * 100}%)`)
  testInfo.annotations.push({ type: 'mismatch', description: `${key}: ${pct}%` })
  writeFileSync(testInfo.outputPath('actual.png'), actual)
  writeFileSync(testInfo.outputPath('diff.png'), diff)
  await testInfo.attach(`${key}-actual.png`, { body: actual, contentType: 'image/png' })
  await testInfo.attach(`${key}-reference.png`, { body: reference, contentType: 'image/png' })
  await testInfo.attach(`${key}-diff.png`, { body: diff, contentType: 'image/png' })
  // PHASE4_VISUAL_OUT=<dir> keeps the images of passing runs too (for design review).
  const outDir = process.env['PHASE4_VISUAL_OUT']
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, `${key}-actual.png`), actual)
    writeFileSync(resolve(outDir, `${key}-diff.png`), diff)
  }
  expect(ratio, `artboard ${key} mismatch`).toBeLessThanOrEqual(BUDGET)
}

interface Hook {
  session: {
    fileId: string
    tree: { children(id: string): readonly string[]; meta(id: string): { name: string } | null }
    store: { getState(): { pageId: string; agents?: readonly { id: string }[] } }
  }
}

/** Id of a top-level layer of the current page, by name. */
async function topId(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const { session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
    const page = session.store.getState().pageId
    const id = session.tree.children(page).find((c) => session.tree.meta(c)?.name === n)
    if (!id) throw new Error(`no layer ${n}`)
    return id
  }, name)
}

/** Pushes `agent:presence` for the open file, as main would (mock bridge agent loop). */
async function agentPresence(
  page: Page,
  agents: { id: string; name: string; working: string[] }[],
): Promise<void> {
  await page.evaluate((list) => {
    const { session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
    const loop = (
      window as unknown as {
        __barenAgent: { presence(u: { fileId: string; agents: unknown[] }): void }
      }
    ).__barenAgent
    loop.presence({
      fileId: session.fileId,
      agents: list.map((a) => ({ ...a, activeAt: Date.now() })),
    })
  }, agents)
  // Presence updates are applied at most 10 per second (contract §11.7).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
        return session.store.getState().agents?.length ?? 0
      }),
    )
    .toBe(agents.length)
  await settle(page)
}

/** Whether the overlay has agent-coloured pixels inside the rect (badge, ring). */
async function overlayHasAgent(page: Page, x: number, y: number, w: number, h: number) {
  return page.evaluate(
    ([rx, ry, rw, rh]) => {
      const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
      const ctx = c?.getContext('2d')
      if (!c || !ctx) return false
      const box = c.getBoundingClientRect()
      const d = ctx.getImageData(rx - box.left, ry - box.top, rw, rh).data
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b, a] = [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, d[i + 3] ?? 0]
        // --color-agent #d21f75 (light) / #ec5a9c (dark), opaque.
        if (a > 200 && r > 190 && g < 110 && b > 90 && b < 180) return true
      }
      return false
    },
    [x, y, w, h] as const,
  )
}

function mcpSection(page: Page) {
  return page.getByTestId('mcp-section')
}

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'Connect your agent' })
}

async function openDialogFromSection(page: Page) {
  await mcpSection(page).getByRole('button').last().click()
  await expect(dialog(page)).toBeVisible()
  // The live setup (token and snippets) has arrived.
  await expect(
    dialog(page)
      .getByLabel(/ setup$/)
      .first(),
  ).toContainText('127.0.0.1')
  await expect(dialog(page).getByRole('button', { name: 'Copy' }).first()).toBeEnabled()
}

/* ------------------------------------------------------------------ artboards */

test.describe('Phase 4 artboards vs references', () => {
  test('34 Editor — Connect your agent', async ({ page }, testInfo) => {
    await openEditor(page, url({ mcp: 'not-connected', hash: `#/file/${LIBRARY}` }), 7)
    await expect(mcpSection(page)).toContainText('Not connected')
    await openDialogFromSection(page)
    await page.mouse.move(1300, 780)
    await check(page, '34', testInfo)
  })

  test('D34 Editor — Connect your agent (dark)', async ({ page }, testInfo) => {
    await openEditor(
      page,
      url({ mcp: 'not-connected', theme: 'dark', hash: `#/file/${LIBRARY}` }),
      7,
    )
    await openDialogFromSection(page)
    await page.mouse.move(1300, 780)
    await check(page, 'D34', testInfo)
  })

  for (const key of ['35', 'D35'] as const) {
    test(`${key} Editor — Agent working${key === 'D35' ? ' (dark)' : ''}`, async ({
      page,
    }, testInfo) => {
      await freezeSweep(page)
      await openEditor(
        page,
        url({
          mcp: 'connected',
          scene: PICKER_SCENE,
          ...(key === 'D35' ? { theme: 'dark' as const } : {}),
          hash: `#/file/${LIBRARY}`,
        }),
      )
      const pricing = await topId(page, 'Pricing — Desktop')
      await agentPresence(page, [{ id: MOCK_PRESENCE_ID, name: 'Claude Code', working: [pricing] }])
      await expect(mcpSection(page)).toContainText('Editing Pricing — Desktop')
      await page.mouse.move(120, 780)
      await check(page, key, testInfo)
    })
  }

  test('36 Home — Agents connected', async ({ page }, testInfo) => {
    await openHome(page, url({ mcp: 'connected', hash: '#/recents' }))
    await expect(page.getByTestId('home-agents')).toContainText('Last active 2 hours ago')
    await check(page, '36', testInfo)
  })
})

/* ------------------------------------------------------------------ behaviour */

test.describe('Connect your agent', () => {
  test('segments show their label and snippet; the token is masked until Reveal', async ({
    page,
  }) => {
    await openEditor(page, url({ hash: `#/file/${LIBRARY}` }))
    await openDialogFromSection(page)
    const d = dialog(page)
    const cases = [
      ['Claude Code', 'Run this in your terminal', 'claude mcp add --scope user --transport http'],
      ['Cursor', 'Add to ~/.cursor/mcp.json', '"headers": { "Authorization": "Bearer'],
      ['Codex', 'Add to ~/.codex/config.toml', '[mcp_servers.baren]'],
      ['Other', "Add to your MCP client's config", '"type": "http"'],
    ] as const
    for (const [segment, hint, text] of cases) {
      await d.getByRole('radio', { name: segment }).click()
      await expect(d.getByText(hint, { exact: true })).toBeVisible()
      const code = d.getByLabel(`${segment} setup`)
      await expect(code).toContainText(text)
      await expect(code).toContainText('http://127.0.0.1:29170/mcp')
      await expect(code).toContainText('••••••••7f3a')
      await expect(code).not.toContainText(MOCK_TOKEN)
    }
    // "Other" adds the stdio shim.
    await expect(
      d.getByText('Only supports stdio? Use the baren stdio shim instead.'),
    ).toBeVisible()
    await expect(d.getByLabel('stdio setup')).toContainText('"ELECTRON_RUN_AS_NODE": "1"')

    await d.getByRole('button', { name: 'Reveal token' }).first().click()
    await expect(d.getByLabel('Other setup')).toContainText(`Bearer ${MOCK_TOKEN}`)
    await d.getByRole('button', { name: 'Hide token' }).click()
    await expect(d.getByLabel('Other setup')).not.toContainText(MOCK_TOKEN)
  })

  test('Copy writes the unmasked snippet and shows a check', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openEditor(page, url({ hash: `#/file/${LIBRARY}` }))
    await openDialogFromSection(page)
    const d = dialog(page)
    await d.getByRole('button', { name: 'Copy' }).first().click()
    await expect(d.getByRole('button', { name: 'Copied' })).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(
      [
        'claude mcp add --scope user --transport http \\',
        '  baren http://127.0.0.1:29170/mcp \\',
        `  --header "Authorization: Bearer ${MOCK_TOKEN}"`,
      ].join('\n'),
    )
    // The check reverts after 1.5 s.
    await expect(d.getByRole('button', { name: 'Copy' }).first()).toBeVisible({ timeout: 3000 })
  })

  test('the Switch turns the server off (setup dimmed and inert) and on again', async ({
    page,
  }) => {
    await openEditor(page, url({ hash: `#/file/${LIBRARY}` }))
    await openDialogFromSection(page)
    const d = dialog(page)
    const toggle = d.getByRole('switch', { name: 'MCP server' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(d.getByTestId('mcp-dialog-status')).toHaveText('Waiting for an agent to connect…')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(d.getByText("Off · Agents can't connect")).toBeVisible()
    await expect(d.getByTestId('mcp-dialog-status')).toHaveText('MCP server is off')
    const setup = d.getByTestId('mcp-setup')
    await expect(setup).toHaveCSS('opacity', '0.5')
    expect(await setup.evaluate((el) => (el as HTMLElement).inert)).toBe(true)
    // Live status reaches the inspector behind the dialog.
    await expect(mcpSection(page)).toContainText('Off')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(setup).toHaveCSS('opacity', '1')
    await expect(mcpSection(page)).toContainText('Not connected')
    await expect(d.getByLabel('Claude Code setup')).toContainText('••••••••7f3a')
  })

  test('Regenerate token asks first, then shows the new token in place', async ({ page }) => {
    await openEditor(page, url({ mcp: 'connected', hash: `#/file/${LIBRARY}` }))
    await openDialogFromSection(page)
    const d = dialog(page)
    await expect(d.getByTestId('mcp-dialog-status')).toHaveText('Connected · Claude Code')
    await d.getByRole('button', { name: 'Regenerate token' }).click()
    await expect(d.getByText('Regenerate? Connected agents will need the new token.')).toBeVisible()
    await d.getByRole('button', { name: 'Cancel' }).click()
    await expect(d.getByLabel('Claude Code setup')).toContainText('••••••••7f3a')
    await d.getByRole('button', { name: 'Regenerate token' }).click()
    await d.getByRole('button', { name: 'Regenerate', exact: true }).click()
    // The mock's next token ends in 904b; connected agents were disconnected.
    await expect(d.getByLabel('Claude Code setup')).toContainText('••••••••904b')
    await expect(d.getByTestId('mcp-dialog-status')).toHaveText('Waiting for an agent to connect…')
    await d.getByRole('button', { name: 'Reveal token' }).click()
    await expect(d.getByLabel('Claude Code setup')).toContainText('Bearer brn_mock_token_904b')
  })

  test('remembers the last segment; Escape, Done and the close button close it', async ({
    page,
  }) => {
    await openEditor(page, url({ hash: `#/file/${LIBRARY}` }))
    await openDialogFromSection(page)
    await dialog(page).getByRole('radio', { name: 'Codex' }).click()
    await dialog(page).getByRole('button', { name: 'Done' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await openDialogFromSection(page)
    await expect(dialog(page).getByRole('radio', { name: 'Codex' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await openDialogFromSection(page)
    await dialog(page).getByRole('button', { name: 'Close' }).click()
    await expect(dialog(page)).toHaveCount(0)
  })

  test('remembers the segment across reloads (plain mock, persistent storage)', async ({
    page,
  }) => {
    await page.goto('/#/auth/sign-in')
    await page.getByRole('button', { name: 'Continue offline' }).click()
    await page.getByRole('button', { name: 'Get started' }).click()
    await dialog(page).getByRole('radio', { name: 'Cursor' }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Get started' }).click()
    await expect(dialog(page).getByRole('radio', { name: 'Cursor' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})

test.describe('MCP section, home card and Preferences', () => {
  const STATES = [
    ['not-connected', 'Not connected', 'Connect your agent'],
    ['off', 'Off', 'Connect your agent'],
    ['error', 'Error', 'Connect your agent'],
    ['connected', 'Connected', 'Agent settings'],
  ] as const

  for (const [state, label, button] of STATES) {
    test(`inspector MCP section: ${state}`, async ({ page }) => {
      await openEditor(page, url({ mcp: state, hash: `#/file/${LIBRARY}` }))
      const section = mcpSection(page)
      await expect(section.getByText(label, { exact: true })).toBeVisible()
      await expect(section.getByRole('button', { name: button })).toBeVisible()
      if (state === 'connected') {
        await expect(section.getByText('Claude Code', { exact: true })).toBeVisible()
        await expect(section.getByText('Idle · just now')).toBeVisible()
        // Cursor is only a recent agent (not connected): no row.
        await expect(section.getByText('Cursor')).toHaveCount(0)
      }
      if (state === 'error') {
        await expect(section.getByText('Error', { exact: true })).toHaveAttribute(
          'title',
          'port 29170 is in use',
        )
      }
      await section.getByRole('button', { name: button }).click()
      await expect(dialog(page)).toBeVisible()
      if (state === 'error') {
        await expect(dialog(page).getByTestId('mcp-dialog-status')).toHaveText(
          "Couldn't start the MCP server: port 29170 is in use",
        )
      }
      if (state === 'off') {
        await expect(dialog(page).getByTestId('mcp-setup')).toHaveCSS('opacity', '0.5')
      }
    })
  }

  test('home card: Get started until an agent is seen, then the agents', async ({ page }) => {
    await openHome(page, url({ mcp: 'not-connected', hash: '#/recents' }))
    const card = page
      .getByRole('region', { name: 'Using agents' })
      .or(page.locator('section').filter({ hasText: 'Using agents' }))
    await card.getByRole('button', { name: 'Get started' }).click()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')

    await openHome(page, url({ mcp: 'connected', hash: '#/recents' }))
    const rows = page.getByTestId('home-agents')
    await expect(rows).toContainText('Claude Code')
    await expect(rows).toContainText('Active now · Baren')
    await expect(rows).toContainText('Cursor')
    await expect(rows).toContainText('Last active 2 hours ago')
    await page.getByRole('button', { name: 'Agent settings' }).click()
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByTestId('mcp-dialog-status')).toHaveText(
      'Connected · Claude Code',
    )
  })

  test('Preferences: the MCP server row toggles the server and opens the dialog', async ({
    page,
  }) => {
    await openHome(page, url({ mcp: 'not-connected', hash: '#/recents' }))
    await page.keyboard.press('Control+,')
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    const toggle = prefs.getByRole('switch', { name: 'MCP server' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(prefs.getByText("Off · Agents can't connect")).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await prefs.getByRole('button', { name: 'Agent settings…' }).click()
    await expect(dialog(page)).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toHaveCount(0)
  })
})

test.describe('agents in the editor', () => {
  test('avatars and the working badge follow injected presence and clear with it', async ({
    page,
  }) => {
    await freezeSweep(page)
    await openEditor(
      page,
      url({ mcp: 'connected', scene: PICKER_SCENE, hash: `#/file/${LIBRARY}` }),
    )
    const avatars = page.getByTestId('collaborators')
    await expect(avatars.getByRole('img', { name: 'Claude Code (agent)' })).toHaveCount(0)
    const pricing = await topId(page, 'Pricing — Desktop')
    await agentPresence(page, [{ id: MOCK_PRESENCE_ID, name: 'Claude Code', working: [pricing] }])
    await expect(avatars.getByRole('img', { name: 'Claude Code (agent)' })).toBeVisible()
    await expect(mcpSection(page)).toContainText('Editing Pricing — Desktop')
    // The badge sits in the label row, right-aligned to the artboard (35: x 986–1136, y 182–200).
    expect(await overlayHasAgent(page, 990, 184, 140, 14)).toBe(true)

    await agentPresence(page, [])
    await expect(avatars.getByRole('img', { name: 'Claude Code (agent)' })).toHaveCount(0)
    await expect(mcpSection(page)).toContainText('Idle · just now')
    await expect.poll(() => overlayHasAgent(page, 990, 184, 140, 14)).toBe(false)
  })

  test('Connect your agent, Agent settings and the home card open the same dialog', async ({
    page,
  }) => {
    await openEditor(page, url({ mcp: 'connected', hash: `#/file/${LIBRARY}` }))
    await mcpSection(page).getByRole('button', { name: 'Agent settings' }).click()
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page)).toHaveAttribute('data-testid', 'mcp-dialog')
    await page.keyboard.press('Escape')
    await openEditor(page, url({ mcp: 'not-connected', hash: `#/file/${LIBRARY}` }))
    await mcpSection(page).getByRole('button', { name: 'Connect your agent' }).click()
    await expect(page.getByTestId('mcp-dialog')).toBeVisible()
  })
})
