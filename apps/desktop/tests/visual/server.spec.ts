/**
 * Two clients against a real `baren-server` (browser mode, no fixture): email + password
 * sign-in, an email invite from the share popover and its acceptance, and a shared file whose
 * images reach the other client and render there.
 *
 * Opt-in, like the "against a real server" block in screens.spec.ts. Start the server with
 * `MAIL_TRANSPORT=file:<dir>`, then run the tests with `BAREN_E2E_MAIL_DIR=<dir>` and
 * `VITE_SERVER_URL=<server>` (the Vite dev server bakes the URL in):
 *
 *   MAIL_TRANSPORT=file:/tmp/mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
 *     baren-server &
 *   BAREN_E2E_MAIL_DIR=/tmp/mail VITE_SERVER_URL=http://127.0.0.1:8899 \
 *     pnpm test:visual tests/visual/server.spec.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blake3 } from '@noble/hashes/blake3'
import { bytesToHex } from '@noble/hashes/utils'
import { expect, test, type Page } from '@playwright/test'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')

interface MailRecord {
  kind: string
  to: string
  code?: string | null
  url?: string | null
}

/** The newest message of `kind` to `to` written after `after` (ms) by the file transport. */
async function mailed(kind: string, to: string, after: number): Promise<MailRecord> {
  let found: MailRecord | null = null
  await expect
    .poll(
      () => {
        for (const name of readdirSync(MAIL_DIR!).sort().reverse()) {
          if (!name.endsWith('.json') || Number.parseInt(name, 10) < after) continue
          const mail = JSON.parse(readFileSync(resolve(MAIL_DIR!, name), 'utf8')) as MailRecord
          if (mail.kind === kind && mail.to.includes(to)) {
            found = mail
            return true
          }
        }
        return false
      },
      { message: `${kind} mail to ${to}`, timeout: 10_000 },
    )
    .toBe(true)
  return found!
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  expect(res.ok, `${path} → ${res.status} ${text}`).toBe(true)
  return (text ? JSON.parse(text) : undefined) as T
}

/** Register and verify an account through the API, with the code from the mail file. */
async function createAccount(name: string, email: string, password: string): Promise<string> {
  const sent = Date.now() - 1000
  await postJson('/api/auth/register', { name, email, password })
  const { code } = await mailed('verification_code', email, sent)
  const { token } = await postJson<{ token: string }>('/api/auth/verify', { email, code })
  return token
}

/** A solid-colour PNG drawn by the page's canvas. */
async function makePng(page: Page, w: number, h: number, color: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h, color }) => {
      const canvas = new OffscreenCanvas(w, h)
      const g = canvas.getContext('2d')!
      g.fillStyle = color
      g.fillRect(0, 0, w, h)
      const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin)
    },
    { w, h, color },
  )
  return Buffer.from(b64, 'base64')
}

/** Insert images through the tool rail's image button (file picker). */
async function insertImage(page: Page, name: string, png: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /^Image/ })
    .first()
    .click()
  await (await chooser).setFiles([{ name, mimeType: 'image/png', buffer: png }])
}

/** RGB of every decoded canvas image layer (`img.ic-img`), sampled by drawing it at 1×1. */
async function renderedImageColors(page: Page): Promise<number[][]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('img.ic-img'))
      .filter((img) => img.complete && img.naturalWidth > 0)
      .map((img) => {
        const c = document.createElement('canvas')
        c.width = 1
        c.height = 1
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0, 1, 1)
        return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3))
      }),
  )
}

const BLUE = [0x33, 0x66, 0xff]
const RED = [0xff, 0x3b, 0x30]

test.describe('against a real server: sign-in, email invite, shared images', () => {
  test.skip(!MAIL_DIR, 'needs BAREN_E2E_MAIL_DIR + VITE_SERVER_URL (see above)')

  test('B signs in, accepts A’s emailed invite and sees A’s images', async ({ browser }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const emailA = `ada-${stamp}@example.com`
    const emailB = `bora-${stamp}@example.com`
    const password = 'shared-passw0rd'
    await createAccount('Ada Lovelace', emailA, password)
    const tokenB = await createAccount('Bora Demir', emailB, password)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'])
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    const errors: string[] = []
    a.on('pageerror', (e) => errors.push(`A: ${e.message}`))
    b.on('pageerror', (e) => errors.push(`B: ${e.message}`))

    // --- A signs in with email + password and makes a file with an image.
    await a.goto('/')
    await expect(a).toHaveURL(/#\/auth\/sign-in$/)
    await a.getByLabel('Email').fill(emailA)
    await a.getByLabel('Password', { exact: true }).fill(password)
    await a.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(a).toHaveURL(/#\/recents$/)
    await a.getByRole('button', { name: 'New file' }).click()
    await expect(a).toHaveURL(/#\/file\//)
    const blue = await makePng(a, 320, 240, '#3366ff')
    await insertImage(a, 'blue.png', blue)
    await expect.poll(() => renderedImageColors(a)).toEqual([BLUE])

    // --- A invites B by email from the share popover: the file goes to A's team first.
    await a.getByRole('button', { name: 'Share', exact: true }).click()
    await a.getByPlaceholder('Add people by email').fill(emailB)
    const invitedAt = Date.now() - 1000
    await a.getByRole('button', { name: 'Invite', exact: true }).click()
    await expect(a.getByText(`Invited ${emailB}. Invite link copied.`)).toBeVisible()
    const invite = await mailed('team_invite', emailB, invitedAt)
    const inviteToken = invite.url?.match(/\/i\/([^/?#]+)$/)?.[1]
    expect(inviteToken, `invite url ${invite.url}`).toBeTruthy()
    // The emailed link's page opens the app on the invite.
    const landing = await (await fetch(invite.url!)).text()
    expect(landing).toContain(`baren://invite/${inviteToken}`)
    await a.keyboard.press('Escape')

    // --- B signs in with email + password.
    await b.goto('/')
    await expect(b).toHaveURL(/#\/auth\/sign-in$/)
    await b.getByLabel('Email').fill(emailB)
    await b.getByLabel('Password', { exact: true }).fill(password)
    await b.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(b).toHaveURL(/#\/recents$/)
    await expect(b.getByRole('button', { name: 'Account menu: Bora Demir' })).toBeVisible()

    // --- B accepts the invite from the deep link the emailed page opens.
    await b.evaluate(
      (url) =>
        (
          window as unknown as { __barenTest: { emitDeepLink(u: string): void } }
        ).__barenTest.emitDeepLink(url),
      `baren://invite/${inviteToken}`,
    )
    await expect(b.getByRole('heading', { name: "Join Ada's Team" })).toBeVisible()
    await b.getByRole('button', { name: 'Accept invite' }).click()
    await expect(b).toHaveURL(/#\/team\/members$/)
    await expect(b.getByRole('row').filter({ hasText: emailA })).toBeVisible()

    // --- The shared file appears in B's Recents and opens with A's image.
    await b.evaluate(() => {
      window.location.hash = '#/recents'
    })
    const card = b.locator('[data-file-id]').filter({ hasText: 'Untitled' })
    await expect(card).toHaveCount(1, { timeout: 15_000 })
    await card.click()
    await expect(b).toHaveURL(/#\/file\//)
    await expect.poll(() => renderedImageColors(b), { timeout: 20_000 }).toEqual([BLUE])

    // --- A adds a second image while both have the file open: B downloads and renders it.
    const red = await makePng(a, 200, 120, '#ff3b30')
    await insertImage(a, 'red.png', red)
    await expect
      .poll(async () => (await renderedImageColors(b)).sort(), { timeout: 20_000 })
      .toEqual([BLUE, RED].sort())

    // The server holds both images for the shared file; B (an editor member) can read them.
    const files = (await (
      await fetch(`${SERVER}/api/teams`, { headers: { authorization: `Bearer ${tokenB}` } })
    ).json()) as { teams?: { id: string; name: string }[] } | { id: string; name: string }[]
    const teams = Array.isArray(files) ? files : (files.teams ?? [])
    const team = teams.find((t) => t.name === "Ada's Team")
    expect(team, 'B is in A’s team').toBeTruthy()
    const list = (await (
      await fetch(`${SERVER}/api/teams/${team!.id}/files`, {
        headers: { authorization: `Bearer ${tokenB}` },
      })
    ).json()) as { id: string; name: string }[] | { files: { id: string; name: string }[] }
    const remote = (Array.isArray(list) ? list : list.files).find((f) => f.name === 'Untitled')
    expect(remote, 'shared file on the server').toBeTruthy()
    for (const png of [blue, red]) {
      const hash = bytesToHex(blake3(png))
      const res = await fetch(`${SERVER}/api/files/${remote!.id}/assets/${hash}`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${tokenB}` },
      })
      expect(res.status, `asset ${hash}`).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
    }

    expect(errors, 'page errors').toEqual([])
    await ctxA.close()
    await ctxB.close()
  })
})
