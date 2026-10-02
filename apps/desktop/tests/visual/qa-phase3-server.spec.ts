/**
 * QA (Phase 3): two people in browser mode against a real `baren-server`, with B's
 * WebSocket routed through a pausable proxy so edits are truly concurrent (both peers edit
 * while partitioned, then the queued messages flow). After each scenario both peers must have
 * identical snapshots and identical canvas DOM for the shared content:
 *
 * - A groups {x, y} while B moves x;
 * - A edits the main component while B overrides it in an instance;
 * - A and B edit points of one vector;
 * - A pastes (Ctrl+V of a copied instance) while B edits the main.
 *
 * Opt-in, like server.spec.ts / phase3-server.spec.ts:
 *
 *   MAIL_TRANSPORT=file:/tmp/mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
 *     baren-server &
 *   BAREN_E2E_MAIL_DIR=/tmp/mail VITE_SERVER_URL=http://127.0.0.1:8899 \
 *     pnpm test:visual tests/visual/qa-phase3-server.spec.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')

/* eslint-disable @typescript-eslint/no-explicit-any */
type Hook = any

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

async function account(name: string, email: string): Promise<string> {
  const sent = Date.now() - 1000
  await api('POST', '/api/auth/register', { name, email, password: 'shared-passw0rd' })
  const code = await mailedCode(email, sent)
  return (await api<{ token: string }>('POST', '/api/auth/verify', { email, code })).token
}

async function signedIn(context: BrowserContext, token: string): Promise<Page> {
  await context.addInitScript((t) => sessionStorage.setItem('baren.mock.token', t), token)
  return context.newPage()
}

async function hooked(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor?.canvas,
  )
}

async function inPage<T, A>(page: Page, fn: (hook: Hook, arg: A) => T, arg: A): Promise<T> {
  return page.evaluate(
    ([source, a]) => {
      const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
      // eslint-disable-next-line no-new-func
      return (
        new Function('hook', 'arg', `return (${source})(hook, arg)`) as (h: Hook, x: unknown) => T
      )(hook, a)
    },
    [fn.toString(), arg] as const,
  )
}

/** A pausable proxy for a page's sync socket: while paused, both directions queue up. */
class Partition {
  paused = false
  private queue: (() => void)[] = []

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws\/files\//, (ws: WebSocketRoute) => {
      const server = ws.connectToServer()
      ws.onMessage((m) => this.pass(() => server.send(m)))
      server.onMessage((m) => this.pass(() => ws.send(m)))
    })
  }

  private pass(fn: () => void): void {
    if (this.paused) this.queue.push(fn)
    else fn()
  }

  resume(): void {
    this.paused = false
    const q = this.queue
    this.queue = []
    for (const fn of q) fn()
  }
}

/** Snapshot JSON (ids included) of a peer. */
function snapshotOf(page: Page): Promise<string> {
  return inPage(page, (hook) => JSON.stringify(hook.snapshot()), null)
}

/**
 * The canvas DOM of the page content: every rendered node's id, tag, inline style, text and
 * path data, sorted by id (identical documents must render identically on both peers).
 */
function canvasDom(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('.ic-root [data-nid]')) {
      const nid = el.getAttribute('data-nid') ?? ''
      const text = el.classList.contains('ic-text') ? (el.textContent ?? '') : ''
      const d =
        el.tagName.toLowerCase() === 'svg'
          ? (el.querySelector('path')?.getAttribute('d') ?? '')
          : ''
      const style = (el.getAttribute('style') ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s !== '' && !s.startsWith('visibility'))
        .sort()
        .join(';')
      out.push(`${nid}|${el.tagName}|${style}|${text}|${d}`)
    }
    return out.sort().join('\n')
  })
}

test.describe('QA against a real server: concurrent Phase 3 edits converge and render identically', () => {
  test.skip(!MAIL_DIR, 'needs BAREN_E2E_MAIL_DIR + VITE_SERVER_URL (see above)')

  test('group vs move, main edit vs override, vector edits, paste vs main edit', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const tokenA = await account('Ada QA', `ada-qa-${stamp}@example.com`)
    const tokenB = await account('Bora QA', `bora-qa-${stamp}@example.com`)
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
    await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'])
    const a = await signedIn(ctxA, tokenA)
    const b = await signedIn(ctxB, tokenB)
    const partition = new Partition()
    await partition.install(b)
    const errors: string[] = []
    a.on('pageerror', (e) => errors.push(`A: ${e.message}`))
    b.on('pageerror', (e) => errors.push(`B: ${e.message}`))

    // --- A: a new file with rectangles, a component + instance and a vector; share it.
    await a.goto('/?editorTestHook=1#/recents')
    await a.getByRole('button', { name: 'New file' }).click()
    await expect(a).toHaveURL(/#\/file\//)
    await hooked(a)
    const ids = await inPage(
      a,
      (hook) => {
        const { schema, session } = hook
        const doc = session.doc
        const page = session.store.getState().pageId
        const rect = (name: string, left: number, top: number) =>
          schema.createNode(doc, {
            type: 'rect',
            parentId: page,
            name,
            styles: { left, top, width: 40, height: 40, backgroundColor: '#3366FF' },
          })
        const x = rect('x', 0, 300)
        const y = rect('y', 80, 340)
        const card = schema.createNode(doc, {
          type: 'frame',
          parentId: page,
          name: 'Card',
          styles: { left: 0, top: 0, width: 200, height: 100, backgroundColor: '#FFFFFF' },
        })
        const title = schema.createNode(doc, {
          type: 'text',
          parentId: card,
          name: 'Title',
          text: 'Hello',
          styles: { position: 'absolute', left: 10, top: 10, fontSize: '16px', color: '#111111' },
        })
        const icon = schema.createNode(doc, {
          type: 'rect',
          parentId: card,
          name: 'Icon',
          styles: {
            position: 'absolute',
            left: 150,
            top: 10,
            width: 20,
            height: 20,
            backgroundColor: '#FF0000',
          },
        })
        const main = schema.createComponent(doc, [card], session.actions.geometry())
        const instance = schema.createInstance(doc, {
          componentKey: schema.getNode(doc, main).componentKey,
          parentId: page,
          styles: { left: 300, top: 0 },
        })
        const vector = schema.createNode(doc, {
          type: 'vector',
          parentId: page,
          name: 'Path',
          styles: { left: 300, top: 300, width: 100, height: 100, stroke: '#000000', fill: 'none' },
          vector: {
            fillRule: 'nonzero',
            subpaths: [
              {
                id: 'qa000001',
                closed: false,
                points: [
                  { x: 0, y: 0 },
                  { x: 50, y: 0 },
                  { x: 100, y: 50 },
                  { x: 100, y: 100 },
                ],
              },
            ],
          },
        })
        hook.canvas.setViewport({ x: -50, y: -50, zoom: 1 }, { animate: false })
        return {
          x,
          y,
          main,
          title,
          icon,
          instance,
          vector,
          tk: schema.getNode(doc, title).nodeKey,
          ik: schema.getNode(doc, icon).nodeKey,
        }
      },
      null,
    )
    await a.getByRole('button', { name: 'Share', exact: true }).click()
    await a.getByRole('button', { name: 'Copy link' }).click()
    await a.keyboard.press('Escape')

    await b.goto('/?editorTestHook=1#/recents')
    const card = b.locator('[data-file-id]').filter({ hasText: 'Untitled' })
    await expect(card).toHaveCount(1, { timeout: 20_000 })
    await card.click()
    await hooked(b)
    await inPage(
      b,
      (hook) => hook.canvas.setViewport({ x: -50, y: -50, zoom: 1 }, { animate: false }),
      null,
    )

    const converge = async (label: string) => {
      await expect
        .poll(async () => (await snapshotOf(a)) === (await snapshotOf(b)), {
          message: `${label}: snapshots converge`,
          timeout: 20_000,
        })
        .toBe(true)
      await expect
        .poll(async () => (await canvasDom(a)) === (await canvasDom(b)), {
          message: `${label}: canvases render identically`,
          timeout: 10_000,
        })
        .toBe(true)
    }
    await converge('initial')

    // 1. A groups {x, y}; B moves x (partitioned).
    partition.paused = true
    await inPage(
      a,
      (hook, arg) =>
        hook.schema.groupNodes(hook.session.doc, [arg.x, arg.y], hook.session.actions.geometry(), {
          origin: 'editor:group',
        }),
      ids,
    )
    await inPage(
      b,
      (hook, arg) =>
        hook.schema.transact(
          hook.session.doc,
          () => hook.schema.setStyles(hook.session.doc, arg.x, { left: 500 }),
          { origin: 'canvas:move' },
        ),
      ids,
    )
    // The partition holds: B has not seen A's group yet (the edits are concurrent).
    await a.waitForTimeout(400)
    expect(
      await inPage(b, (hook, id) => hook.schema.getNode(hook.session.doc, id).parentId, ids.x),
    ).toBe(await inPage(b, (hook) => hook.session.store.getState().pageId, null))
    partition.resume()
    await converge('group vs move')
    const xParent = await inPage(
      a,
      (hook, id) => hook.schema.getNode(hook.session.doc, id).parentId,
      ids.x,
    )
    expect(
      await inPage(a, (hook, id) => hook.schema.getNode(hook.session.doc, id).type, xParent),
    ).toBe('group')

    // 2. A edits the main; B overrides the same nodes in the instance.
    partition.paused = true
    await inPage(
      a,
      (hook, arg) =>
        hook.schema.transact(
          hook.session.doc,
          () => {
            hook.schema.setStyles(hook.session.doc, arg.icon, {
              backgroundColor: '#00AA00',
              width: 30,
            })
            hook.schema.setStyles(hook.session.doc, arg.title, { fontSize: '20px' })
          },
          { origin: 'editor:inspector' },
        ),
      ids,
    )
    await inPage(
      b,
      (hook, arg) =>
        hook.schema.transact(
          hook.session.doc,
          () => {
            hook.schema.setStylesAt(hook.session.doc, `${arg.instance}/${arg.ik}`, {
              backgroundColor: '#0000AA',
            })
            hook.schema.setTextAt(hook.session.doc, `${arg.instance}/${arg.tk}`, 'From B')
          },
          { origin: 'editor:inspector' },
        ),
      ids,
    )
    partition.resume()
    await converge('main edit vs override')
    for (const peer of [a, b]) {
      const icon = await inPage(
        peer,
        (hook, arg) => hook.session.resolver.resolveNode(`${arg.instance}/${arg.ik}`).styles,
        ids,
      )
      expect(icon).toMatchObject({ backgroundColor: '#0000AA', width: 30 })
      const el = await peer.evaluate(
        (nid) => document.querySelector(`[data-nid="${nid}"]`)?.textContent,
        `${ids.instance}/${ids.tk}`,
      )
      expect(el).toBe('From B')
    }

    // 3. Concurrent vector edits.
    partition.paused = true
    await inPage(
      a,
      (hook, arg) =>
        hook.schema.transact(
          hook.session.doc,
          () =>
            hook.schema.editVector(hook.session.doc, arg.vector, [
              { kind: 'set', subpathId: 'qa000001', index: 0, point: { x: 5, y: 5 } },
              { kind: 'insert', subpathId: 'qa000001', index: 2, point: { x: 75, y: 10 } },
            ]),
          { origin: 'canvas:vector' },
        ),
      ids,
    )
    await inPage(
      b,
      (hook, arg) =>
        hook.schema.transact(
          hook.session.doc,
          () =>
            hook.schema.editVector(hook.session.doc, arg.vector, [
              { kind: 'set', subpathId: 'qa000001', index: 3, point: { x: 80, y: 90 } },
              { kind: 'closed', subpathId: 'qa000001', closed: true },
            ]),
          { origin: 'canvas:vector' },
        ),
      ids,
    )
    partition.resume()
    await converge('vector edits')
    const d = await a.evaluate(
      (nid) => document.querySelector(`[data-nid="${nid}"] path`)?.getAttribute('d'),
      ids.vector,
    )
    expect(d).toBe('M 5 5 L 50 0 L 75 10 L 100 50 L 80 90 Z')

    // 4. A pastes a copied instance (Ctrl+V) while B edits the main.
    await inPage(a, (hook, id) => hook.canvas.select([id]), ids.instance)
    await a
      .locator('.ic-root')
      .first()
      .focus()
      .catch(() => undefined)
    await a.keyboard.press('Control+c')
    await expect
      .poll(() =>
        a.evaluate(async () =>
          (await navigator.clipboard.read()).some((i) =>
            i.types.includes('web application/x-baren-clipboard+json'),
          ),
        ),
      )
      .toBe(true)
    partition.paused = true
    await inPage(a, (hook) => hook.canvas.select([]), null)
    await a.keyboard.press('Control+v')
    await expect
      .poll(async () =>
        inPage(
          a,
          (hook) =>
            Object.values(hook.snapshot().nodes).filter((n: any) => n.type === 'instance').length,
          null,
        ),
      )
      .toBe(2)
    await inPage(
      b,
      (hook, arg) =>
        hook.schema.transact(
          hook.session.doc,
          () => hook.schema.setStyles(hook.session.doc, arg.main, { borderRadius: 12 }),
          { origin: 'editor:inspector' },
        ),
      ids,
    )
    partition.resume()
    await converge('paste vs main edit')
    for (const peer of [a, b]) {
      const radii = await inPage(
        peer,
        (hook) =>
          Object.values(hook.snapshot().nodes)
            .filter((n: any) => n.type === 'instance')
            .map((n: any) => hook.session.resolver.resolveNode(n.id).styles.borderRadius),
        null,
      )
      expect(radii).toEqual([12, 12])
    }

    expect(errors, 'page errors').toEqual([])
    await ctxA.close()
    await ctxB.close()
  })
})
