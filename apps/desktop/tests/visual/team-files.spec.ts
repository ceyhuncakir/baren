/**
 * Team files reach members who are already in the team (real `baren-server`, browser mode).
 * Opt-in like server.spec.ts: start the server with `MAIL_TRANSPORT=file:<dir>`, then run with
 * `BAREN_E2E_MAIL_DIR=<dir>` and `VITE_SERVER_URL=<server>`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { recordCopies } from './copies'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')

async function mailed(kind: string, to: string, after: number): Promise<{ code?: string }> {
  let found: { code?: string } | null = null
  await expect
    .poll(() => {
      for (const name of readdirSync(MAIL_DIR!).sort().reverse()) {
        if (!name.endsWith('.json') || Number.parseInt(name, 10) < after) continue
        const mail = JSON.parse(readFileSync(resolve(MAIL_DIR!, name), 'utf8')) as {
          kind: string
          to: string
          code?: string
        }
        if (mail.kind === kind && mail.to.includes(to)) {
          found = mail
          return true
        }
      }
      return false
    })
    .toBe(true)
  return found!
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  expect(res.ok, `${method} ${path} → ${res.status} ${text}`).toBe(true)
  return (text ? JSON.parse(text) : undefined) as T
}

async function createAccount(name: string, email: string, password: string): Promise<string> {
  const sent = Date.now() - 1000
  await call('POST', '/api/auth/register', { name, email, password })
  const { code } = await mailed('verification_code', email, sent)
  const { token } = await call<{ token: string }>('POST', '/api/auth/verify', { email, code })
  return token
}

/** Accounts A and B, with B an editor in A's team (invite + accept through the API). */
async function teamOfTwo() {
  const stamp = Date.now()
  const emailA = `ada-${stamp}@example.com`
  const emailB = `bora-${stamp}@example.com`
  const password = 'shared-passw0rd'
  const tokenA = await createAccount('Ada Lovelace', emailA, password)
  const tokenB = await createAccount('Bora Demir', emailB, password)

  // B joins A's team (invite + accept through the API).
  const me = await call<{ teams: { id: string; name: string }[] }>(
    'GET',
    '/api/me',
    undefined,
    tokenA,
  )
  const team = me.teams.find((t) => t.name === "Ada's Team")!
  const { url } = await call<{ url: string }>(
    'POST',
    `/api/teams/${team.id}/invites`,
    { role: 'editor', email: emailB },
    tokenA,
  )
  const inviteToken = url.match(/\/i\/([^/?#]+)$/)![1]!
  await call('POST', `/api/invites/${inviteToken}/accept`, {}, tokenB)
  return { emailA, emailB, password, team, tokenB }
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/#\/recents$/)
}

test.describe('against a real server: team files', () => {
  test.skip(!MAIL_DIR, 'needs BAREN_E2E_MAIL_DIR + VITE_SERVER_URL (see server.spec.ts)')

  test('files go into the team on their own and show up in B’s open Files screen', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const { emailA, emailB, password, team, tokenB } = await teamOfTwo()
    const teamFiles = async () => {
      const list = await call<{ name: string }[] | { files: { name: string }[] }>(
        'GET',
        `/api/teams/${team.id}/files`,
        undefined,
        tokenB,
      )
      return (Array.isArray(list) ? list : list.files).map((f) => f.name).sort()
    }

    const a = await (await browser.newContext()).newPage()
    const b = await (await browser.newContext()).newPage()

    // B signs in and keeps the Files screen open.
    await b.goto('/')
    await b.getByLabel('Email').fill(emailB)
    await b.getByLabel('Password', { exact: true }).fill(password)
    await b.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(b).toHaveURL(/#\/recents$/)
    await b.evaluate(() => {
      window.location.hash = '#/files'
    })
    await expect(b.getByRole('region', { name: 'Files' })).toBeVisible()

    // A has a local file that was never shared or opened: Home uploads it.
    await a.goto('/')
    await a.getByLabel('Email').fill(emailA)
    await a.getByLabel('Password', { exact: true }).fill(password)
    await a.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(a).toHaveURL(/#\/recents$/)
    await a.evaluate(() =>
      (
        window as unknown as {
          __barenTest: { createFiles(count: number, prefix: string): Promise<void> }
        }
      ).__barenTest.createFiles(1, 'Drafted'),
    )
    // (The browser bridge also starts with demo files; they go up the same way.)
    await expect.poll(teamFiles, { timeout: 30_000 }).toContain('Drafted 0')

    // A new file goes up as soon as it opens.
    await a.getByRole('button', { name: 'New file' }).click()
    await expect(a).toHaveURL(/#\/file\//)
    await expect.poll(teamFiles, { timeout: 15_000 }).toContain('Untitled')
    expect(await teamFiles(), 'the Scratchpad stays private').not.toContain('Scratchpad')

    // B sees both without leaving the screen.
    for (const name of ['Drafted 0', 'Untitled']) {
      await expect(b.locator('[data-file-id]').filter({ hasText: name })).toHaveCount(1, {
        timeout: 30_000,
      })
    }
  })

  test('Copy link gives a link to the server that opens the file for a teammate', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const { emailA, emailB, password } = await teamOfTwo()
    const a = await (await browser.newContext()).newPage()
    const copied = await recordCopies(a)
    const b = await (await browser.newContext()).newPage()
    const emitDeepLink = (url: string) =>
      b.evaluate(
        (u) =>
          (
            window as unknown as { __barenTest: { emitDeepLink(u: string): void } }
          ).__barenTest.emitDeepLink(u),
        url,
      )

    // A makes a file (it goes into the team) and copies its link.
    await signIn(a, emailA, password)
    await a.getByRole('button', { name: 'New file' }).click()
    await expect(a).toHaveURL(/#\/file\//)
    await a.getByRole('button', { name: 'Share', exact: true }).click()
    await expect
      .poll(
        async () => {
          await a.getByRole('button', { name: 'Copy link' }).click()
          return copied()
        },
        { timeout: 15_000 },
      )
      .toMatch(new RegExp(`^${SERVER.replace(/[.]/g, '\\.')}/f/[0-9a-f-]{36}$`))
    const link = await copied()
    const remoteId = link.split('/f/')[1]!

    // The page behind it opens the app on the file.
    const page = await (await fetch(link)).text()
    expect(page).toContain(`baren://file/${remoteId}`)

    // B opens the link: the app pulls the file and opens it.
    await signIn(b, emailB, password)
    await emitDeepLink(`baren://file/${remoteId}`)
    await expect(b).toHaveURL(/#\/file\//, { timeout: 15_000 })
    await expect(b.getByRole('button', { name: 'Share', exact: true })).toBeVisible()

    // A file in none of B's teams.
    await emitDeepLink('baren://file/01a0fefe-0b75-71ce-b315-000000000000')
    await expect(b.getByText("You don't have access to this file.", { exact: false })).toBeVisible()
  })
})
