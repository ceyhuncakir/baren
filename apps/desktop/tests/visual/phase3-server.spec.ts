/**
 * Components between two people against a real `baren-server` (contract §10.3, "Two
 * peers"): A makes a component and an instance and shares the file; B edits the main and A's
 * instance follows; an override made by A while B edits the main converge on both sides; B
 * deletes the main and A's instance keeps rendering from the retained main.
 *
 * Opt-in, like server.spec.ts:
 *
 *   MAIL_TRANSPORT=file:/tmp/mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
 *     baren-server &
 *   BAREN_E2E_MAIL_DIR=/tmp/mail VITE_SERVER_URL=http://127.0.0.1:8899 \
 *     pnpm test:visual tests/visual/phase3-server.spec.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')

interface MailRecord {
  kind: string
  to: string
  code?: string | null
}

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

async function account(name: string, email: string, password: string): Promise<string> {
  const sent = Date.now() - 1000
  await api('POST', '/api/auth/register', { name, email, password })
  const { code } = await mailed('verification_code', email, sent)
  return (await api<{ token: string }>('POST', '/api/auth/verify', { email, code })).token
}

/** A browser context signed in with `token` (the mock bridge keeps it in sessionStorage). */
async function signedIn(context: BrowserContext, token: string): Promise<Page> {
  await context.addInitScript((t) => sessionStorage.setItem('baren.mock.token', t), token)
  return context.newPage()
}

interface ResolvedLike {
  type: string
  text?: string
  styles: Record<string, string | number>
  children: string[]
  mainDeleted?: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Hook = any

async function hooked(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor?.canvas,
  )
}

async function resolved(page: Page, ref: string): Promise<ResolvedLike | undefined> {
  return page.evaluate(
    (id) =>
      (window as unknown as { __barenEditor: Hook }).__barenEditor.session.resolver.resolveNode(id),
    ref,
  )
}

test.describe('against a real server: components between two people', () => {
  test.skip(!MAIL_DIR, 'needs BAREN_E2E_MAIL_DIR + VITE_SERVER_URL (see above)')

  test('main edits reach instances live; overrides and main edits converge; deleted mains', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const password = 'shared-passw0rd'
    const tokenA = await account('Ada Lovelace', `ada-c-${stamp}@example.com`, password)
    const tokenB = await account('Bora Demir', `bora-c-${stamp}@example.com`, password)
    // B joins A's team through an invite link (API).
    const me = await api<{ teams: { id: string }[] }>('GET', '/api/me', undefined, tokenA)
    const teamId = me.teams[0]?.id as string
    const invite = await api<{ token: string }>(
      'POST',
      `/api/teams/${teamId}/invites`,
      { role: 'editor' },
      tokenA,
    )
    await api('POST', `/api/invites/${invite.token}/accept`, {}, tokenB)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const a = await signedIn(ctxA, tokenA)
    const b = await signedIn(ctxB, tokenB)
    const errors: string[] = []
    a.on('pageerror', (e) => errors.push(`A: ${e.message}`))
    b.on('pageerror', (e) => errors.push(`B: ${e.message}`))

    // --- A: a new file with a component (Card: a label) and an instance of it, then share.
    await a.goto('/?editorTestHook=1#/recents')
    await a.getByRole('button', { name: 'New file' }).click()
    await expect(a).toHaveURL(/#\/file\//)
    await hooked(a)
    const ids = await a.evaluate(() => {
      const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
      const { schema, session } = hook
      const doc = session.doc
      const page = session.store.getState().pageId
      const card = schema.createNode(doc, {
        type: 'frame',
        parentId: page,
        name: 'Card',
        styles: { left: 0, top: 0, width: 200, height: 80, backgroundColor: '#FFFFFF' },
      })
      const label = schema.createNode(doc, {
        type: 'text',
        parentId: card,
        name: 'Label',
        text: 'Hello',
        styles: { fontSize: '16px', color: '#111111' },
      })
      const main = schema.createComponent(doc, [card], session.actions.geometry())
      const key = schema.getNode(doc, main).componentKey
      const instance = schema.createInstance(doc, {
        componentKey: key,
        parentId: page,
        styles: { left: 300, top: 0 },
      })
      const labelKey = schema.getNode(doc, label).nodeKey
      return { main, label, instance, virtualLabel: `${instance}/${labelKey}` }
    })
    await a.getByRole('button', { name: 'Share', exact: true }).click()
    await a.getByRole('button', { name: 'Copy link' }).click()
    await a.keyboard.press('Escape')

    // --- B opens the shared file and sees the instance resolved from the main.
    await b.goto('/?editorTestHook=1#/recents')
    const card = b.locator('[data-file-id]').filter({ hasText: 'Untitled' })
    await expect(card).toHaveCount(1, { timeout: 20_000 })
    await card.click()
    await hooked(b)
    await expect.poll(async () => (await resolved(b, ids.virtualLabel))?.text).toBe('Hello')

    // --- B edits the main's fill: A's instance follows (live).
    await b.evaluate((main) => {
      const { schema, session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
      schema.transact(
        session.doc,
        () => schema.setStyles(session.doc, main, { backgroundColor: '#00AA00' }),
        { origin: 'editor:inspector' },
      )
    }, ids.main)
    await expect
      .poll(async () => (await resolved(a, ids.instance))?.styles['backgroundColor'], {
        timeout: 15_000,
      })
      .toBe('#00AA00')
    // The canvas re-rendered the instance too.
    await expect
      .poll(
        () =>
          a.evaluate((id) => {
            const el = document.querySelector<HTMLElement>(`[data-nid="${id}"]`)
            return el ? getComputedStyle(el).backgroundColor : null
          }, ids.instance),
        { timeout: 15_000 },
      )
      .toBe('rgb(0, 170, 0)')

    // --- Concurrently: A overrides the label text, B changes the main's radius.
    await Promise.all([
      a.evaluate((ref) => {
        const { schema, session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
        schema.setTextAt(session.doc, ref, 'Override from A', { origin: 'canvas:text' })
      }, ids.virtualLabel),
      b.evaluate((main) => {
        const { schema, session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
        schema.transact(
          session.doc,
          () => schema.setStyles(session.doc, main, { borderRadius: 12 }),
          { origin: 'editor:inspector' },
        )
      }, ids.main),
    ])
    for (const peer of [a, b]) {
      await expect
        .poll(async () => (await resolved(peer, ids.virtualLabel))?.text, { timeout: 15_000 })
        .toBe('Override from A')
      await expect
        .poll(async () => (await resolved(peer, ids.instance))?.styles['borderRadius'], {
          timeout: 15_000,
        })
        .toBe(12)
    }

    // --- B deletes the main: A's instance keeps rendering from the retained main.
    await b.evaluate((main) => {
      const { schema, session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
      schema.transact(session.doc, () => schema.deleteNode(session.doc, main), {
        origin: 'editor:menu',
      })
    }, ids.main)
    await expect
      .poll(async () => (await resolved(a, ids.instance))?.mainDeleted, { timeout: 15_000 })
      .toBe(true)
    expect((await resolved(a, ids.virtualLabel))?.text).toBe('Override from A')
    await expect(a.locator('.ic-root').getByText('Override from A')).toBeVisible()

    expect(errors, 'page errors').toEqual([])
    await ctxA.close()
    await ctxB.close()
  })
})
