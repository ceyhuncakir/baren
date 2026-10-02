/**
 * Phase 3 with the real desktop app: A in browser mode, B in the built Electron app (native
 * Rust core, real preload and IPC, `app://` with the production CSP, the main-process
 * clipboard) against a real `baren-server`.
 *
 * - B signs in through the app's sign-in screen and opens A's shared file: instances (with an
 *   override), a rotated layer, a group, a vector and an image render; A's main edit reaches
 *   B's instance live.
 * - B, through the UI: rotates with the inspector field, groups with Ctrl+G, draws with the pen
 *   and overrides instance content; A sees each edit.
 * - Copy/paste across app windows: B copies the instance in window 1 (renderer → IPC → main
 *   clipboard), opens a second window with a new file and pastes there: the instance renders
 *   and its main arrives on a "Components" page (read back from the native core).
 * - Both peers end with the same document (A's snapshot = B's native-core JSON export).
 *
 * Chromium runs with the headless Ozone platform: no window is shown and the OS clipboard is
 * never touched. Opt-in; needs a build made with the same server URL:
 *
 *   VITE_SERVER_URL=http://127.0.0.1:8899 npx electron-vite build --outDir /tmp/e2e-out
 *   MAIL_TRANSPORT=file:/tmp/mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
 *     baren-server &
 *   BAREN_ELECTRON_E2E=1 BAREN_ELECTRON_OUT=/tmp/e2e-out BAREN_E2E_MAIL_DIR=/tmp/mail \
 *     VITE_SERVER_URL=http://127.0.0.1:8899 pnpm test:visual tests/visual/phase3-electron-server.spec.ts
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron,
  expect,
  test,
  type BrowserContext,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const DESKTOP = resolve(__dirname, '../..')
const OUT = process.env['BAREN_ELECTRON_OUT'] ?? join(DESKTOP, 'out')
const NATIVE = resolve(DESKTOP, '../../crates/napi/baren-core.linux-x64-gnu.node')
const PASSWORD = 'shared-passw0rd'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Hook = any

interface NodeLike {
  id: string
  type: string
  name: string
  parentId: string | null
  children: string[]
  styles: Record<string, string | number>
  componentKey?: string
  nodeKey?: string
}

interface SnapshotLike {
  pageIds: string[]
  nodes: Record<string, NodeLike>
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
  await api('POST', '/api/auth/register', { name, email, password: PASSWORD })
  const code = await mailedCode(email, sent)
  return (await api<{ token: string }>('POST', '/api/auth/verify', { email, code })).token
}

async function signedIn(context: BrowserContext, token: string): Promise<Page> {
  await context.addInitScript((t) => sessionStorage.setItem('baren.mock.token', t), token)
  return context.newPage()
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

async function frames(page: Page, n = 2) {
  await page.evaluate(
    (count) =>
      new Promise<void>((r) => {
        let i = 0
        const tick = () => (++i >= count ? r() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )
}

/** Centre (client px) of a rendered canvas node. */
async function centreOf(page: Page, nid: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`.ic-root [data-nid="${nid}"]`).first().boundingBox()
  expect(box, `rendered node ${nid}`).not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

async function clickNode(
  page: Page,
  nid: string,
  opts: { shift?: boolean; double?: boolean } = {},
) {
  const c = await centreOf(page, nid)
  if (opts.shift) await page.keyboard.down('Shift')
  if (opts.double) await page.mouse.dblclick(c.x, c.y)
  else await page.mouse.click(c.x, c.y)
  if (opts.shift) await page.keyboard.up('Shift')
  await frames(page, 2)
}

/** The document as the native core stores it (B's side). */
async function coreSnapshot(page: Page, fileId: string): Promise<SnapshotLike> {
  const json = await page.evaluate(
    (id) =>
      (
        window as unknown as { baren: { export: { json(id: string): Promise<string> } } }
      ).baren.export.json(id),
    fileId,
  )
  return JSON.parse(json) as SnapshotLike
}

function fileIdOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).hash.replace(/^#\/file\//, ''))
}

function styleOf(page: Page, nid: string, prop: 'rotate' | 'backgroundColor') {
  return page.evaluate(
    ([id, p]) => {
      const el = document.querySelector<HTMLElement>(`.ic-root [data-nid="${id}"]`)
      if (!el) return null
      return p === 'rotate' ? el.style.rotate : getComputedStyle(el).backgroundColor
    },
    [nid, prop] as const,
  )
}

test.describe('Phase 3 with the Electron app against a real server', () => {
  test.skip(
    !MAIL_DIR || !process.env['BAREN_ELECTRON_E2E'],
    'needs BAREN_ELECTRON_E2E=1, a build (BAREN_ELECTRON_OUT), BAREN_E2E_MAIL_DIR + VITE_SERVER_URL',
  )

  test('B in Electron renders, edits and pastes between app windows; both peers converge', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const stamp = Date.now()
    const emailB = `bora-el-${stamp}@example.com`
    const tokenA = await account('Ada Browser', `ada-el-${stamp}@example.com`)
    const tokenB = await account('Bora Electron', emailB)
    const me = await api<{ teams: { id: string }[] }>('GET', '/api/me', undefined, tokenA)
    const teamId = me.teams[0]?.id as string
    const invite = await api<{ token: string }>(
      'POST',
      `/api/teams/${teamId}/invites`,
      { role: 'editor' },
      tokenA,
    )
    await api('POST', `/api/invites/${invite.token}/accept`, {}, tokenB)

    // --- A (browser): a shared file with every Phase 3 structure.
    const ctxA = await browser.newContext()
    await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'])
    const a = await signedIn(ctxA, tokenA)
    const errors: string[] = []
    a.on('pageerror', (e) => errors.push(`A: ${e.message}`))
    await a.goto('/?editorTestHook=1#/recents')
    await a.getByRole('button', { name: 'New file' }).click()
    await expect(a).toHaveURL(/#\/file\//)
    const sharedId = fileIdOf(a)
    await a.waitForFunction(
      (id) =>
        (
          window as unknown as {
            __barenEditor?: { canvas: unknown; session: { fileId: string } }
          }
        ).__barenEditor?.session.fileId === id,
      sharedId,
    )
    const ids = await inPage(
      a,
      (hook) => {
        const { schema, session } = hook
        const doc = session.doc
        const page = session.store.getState().pageId
        const abs = (left: number, top: number, width: number, height: number) => ({
          position: 'absolute',
          left,
          top,
          width,
          height,
        })
        const board = schema.createNode(doc, {
          type: 'frame',
          parentId: page,
          name: 'Board',
          styles: { left: 0, top: 0, width: 640, height: 400, backgroundColor: '#FFFFFF' },
        })
        const rect = (name: string, styles: Record<string, unknown>) =>
          schema.createNode(doc, { type: 'rect', parentId: board, name, styles })
        const tilt = rect('Tilt', { ...abs(40, 40, 100, 60), backgroundColor: '#FF9500' })
        schema.setRotation(doc, [tilt], 30, session.actions.geometry())
        const g1 = rect('G1', { ...abs(40, 160, 60, 60), backgroundColor: '#5856D6' })
        const g2 = rect('G2', { ...abs(120, 160, 60, 60), backgroundColor: '#AF52DE' })
        const g3 = rect('G3', { ...abs(40, 260, 50, 50), backgroundColor: '#8E8E93' })
        const g4 = rect('G4', { ...abs(110, 260, 50, 50), backgroundColor: '#636366' })
        const group = schema.groupNodes(doc, [g3, g4], session.actions.geometry(), {
          origin: 'editor:group',
        })
        const vector = schema.createNode(doc, {
          type: 'vector',
          parentId: board,
          name: 'Wave',
          styles: { ...abs(220, 40, 120, 60), fill: 'none', stroke: '#000000', strokeWidth: 2 },
          vector: {
            fillRule: 'nonzero',
            subpaths: [
              {
                id: 'el000001',
                closed: false,
                points: [
                  { x: 0, y: 60 },
                  { x: 60, y: 0, in: { x: -30, y: 0 }, out: { x: 30, y: 0 }, mode: 'smooth' },
                  { x: 120, y: 60 },
                ],
              },
            ],
          },
        })
        // A component (Card: Title + Icon) and an instance with a text override.
        const card = schema.createNode(doc, {
          type: 'frame',
          parentId: page,
          name: 'Card',
          styles: { left: 0, top: 460, width: 220, height: 90, backgroundColor: '#F2F2F2' },
        })
        const title = schema.createNode(doc, {
          type: 'text',
          parentId: card,
          name: 'Title',
          text: 'Hello',
          styles: { ...abs(12, 12, 140, 28), fontSize: '18px', color: '#111111' },
        })
        const icon = schema.createNode(doc, {
          type: 'rect',
          parentId: card,
          name: 'Icon',
          styles: { ...abs(170, 12, 36, 36), backgroundColor: '#FF0000' },
        })
        const main = schema.createComponent(doc, [card], session.actions.geometry())
        const key = schema.getNode(doc, main).componentKey as string
        const instance = schema.createInstance(doc, {
          componentKey: key,
          parentId: page,
          styles: { left: 300, top: 460 },
        })
        const titleKey = schema.getNode(doc, title).nodeKey as string
        const iconKey = schema.getNode(doc, icon).nodeKey as string
        schema.setTextAt(doc, `${instance}/${titleKey}`, 'Overridden')
        hook.canvas.setViewport({ x: -40, y: -40, zoom: 1 }, { animate: false })
        hook.canvas.select([board])
        return { board, tilt, g1, g2, group, vector, main, instance, titleKey, iconKey }
      },
      null,
    )
    // An image pasted into the artboard (bytes from "another app").
    await a.evaluate(async () => {
      const canvas = new OffscreenCanvas(32, 24)
      const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      g.fillStyle = '#0055FF'
      g.fillRect(0, 0, 32, 24)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    })
    await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await a.keyboard.press('Control+v')
    await expect
      .poll(async () =>
        inPage(
          a,
          (hook) =>
            (Object.values(hook.snapshot().nodes) as NodeLike[]).find((n) => n.type === 'image')
              ?.id ?? null,
          null,
        ),
      )
      .not.toBeNull()
    const imageId = (await inPage(
      a,
      (hook) =>
        (Object.values(hook.snapshot().nodes) as NodeLike[]).find((n) => n.type === 'image')?.id,
      null,
    )) as string
    await a.getByRole('button', { name: 'Share', exact: true }).click()
    await a.getByRole('button', { name: 'Copy link' }).click()
    await a.keyboard.press('Escape')

    // --- B: the built Electron app, headless Ozone, fresh profile, native core.
    const require_ = createRequire(join(DESKTOP, 'package.json'))
    const electronBin = require_('electron') as unknown as string
    const profile = mkdtempSync(join(tmpdir(), 'baren-e2e-electron-'))
    let app: ElectronApplication | null = null
    try {
      app = await _electron.launch({
        executablePath: electronBin,
        args: [join(OUT, 'main/index.js'), '--ozone-platform=headless'],
        env: {
          ...process.env,
          BAREN_USER_DATA_DIR: profile,
          BAREN_CORE: 'native',
          BAREN_NATIVE_PATH: NATIVE,
          ELECTRON_ENABLE_LOGGING: '0',
        },
      })
      const b = await app.firstWindow()
      b.on('pageerror', (e) => errors.push(`B: ${e.message}`))
      b.on('console', (m) => {
        if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) {
          errors.push(`B console: ${m.text()}`)
        }
      })
      // Sign in through the app.
      await b.getByLabel('Email').fill(emailB)
      await b.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await b.getByRole('button', { name: 'Sign in', exact: true }).click()
      const card = b.locator('[data-file-id]').filter({ hasText: 'Untitled' })
      await expect(card).toHaveCount(1, { timeout: 30_000 })
      await card.click()
      await b.getByTestId('editor').waitFor()
      // B's local copy of the shared file has its own local id (linked by remoteId).
      const bSharedId = fileIdOf(b)
      await expect(b.locator('.ic-root').first()).toBeVisible()
      const live = { timeout: 20_000 }

      // Everything renders on B (native core, app:// CSP).
      const vTitle = `${ids.instance}/${ids.titleKey}`
      const vIcon = `${ids.instance}/${ids.iconKey}`
      await expect(b.locator(`.ic-root [data-nid="${vTitle}"]`)).toHaveText('Overridden', live)
      await expect.poll(() => styleOf(b, ids.tilt, 'rotate'), live).toBe('30deg')
      await expect(b.locator(`.ic-root [data-nid="${ids.group}"]`)).toHaveCount(1)
      await expect
        .poll(() =>
          b.evaluate(
            (id) =>
              document
                .querySelector(`.ic-root [data-nid="${id}"]`)
                ?.querySelector('path')
                ?.getAttribute('d') ?? null,
            ids.vector,
          ),
        )
        .toBe(
          await a.evaluate(
            (id) =>
              document
                .querySelector(`.ic-root [data-nid="${id}"]`)
                ?.querySelector('path')
                ?.getAttribute('d') ?? null,
            ids.vector,
          ),
        )
      await expect
        .poll(
          () =>
            b.evaluate((id) => {
              const el = document.querySelector(`.ic-root [data-nid="${id}"]`)
              const img =
                el?.tagName === 'IMG' ? (el as HTMLImageElement) : el?.querySelector('img')
              return img && img.complete ? `${img.src.split(':')[0]} ${img.naturalWidth}` : null
            }, imageId),
          { timeout: 30_000 },
        )
        .toBe('baren-asset 32')

      // A edits the main's Icon: B's instance follows live.
      await inPage(
        a,
        (hook, id) =>
          hook.schema.transact(
            hook.session.doc,
            () => hook.schema.setStyles(hook.session.doc, id, { backgroundColor: '#00AA00' }),
            { origin: 'editor:inspector' },
          ),
        (
          await inPage(
            a,
            (hook, mainId) => hook.schema.getChildIds(hook.session.doc, mainId) as string[],
            ids.main,
          )
        )[1] as string,
      )
      await expect.poll(() => styleOf(b, vIcon, 'backgroundColor'), live).toBe('rgb(0, 170, 0)')

      // B rotates Tilt with the inspector's rotation field.
      await clickNode(b, ids.tilt)
      const rotation = b.getByRole('textbox', { name: 'Rotation' })
      await rotation.fill('45')
      await rotation.press('Enter')
      const nodeA = (id: string) =>
        inPage(a, (hook, ref) => hook.session.resolver.resolveNode(ref) as NodeLike, id)
      await expect.poll(async () => (await nodeA(ids.tilt))?.styles['rotate'], live).toBe('45deg')

      // B groups G1 + G2 with Ctrl+G.
      await clickNode(b, ids.g1)
      await clickNode(b, ids.g2, { shift: true })
      await b.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      await b.keyboard.press('Control+g')
      await expect.poll(async () => (await nodeA(ids.g1))?.parentId, live).not.toBe(ids.board)
      const newGroup = (await nodeA(ids.g1))?.parentId as string
      expect((await nodeA(newGroup))?.type).toBe('group')
      expect((await nodeA(ids.g2))?.parentId).toBe(newGroup)

      // B draws a vector with the pen in the artboard's empty lower right (640 × 400 world;
      // B's zoom is whatever the file opened with).
      const boardBox = (await b.locator(`.ic-root [data-nid="${ids.board}"]`).boundingBox())!
      const k = boardBox.width / 640
      await b.keyboard.press('Escape')
      await b.keyboard.press('p')
      for (const [x, y] of [
        [440, 300],
        [500, 360],
        [560, 300],
      ] as const) {
        await b.mouse.click(boardBox.x + x * k, boardBox.y + y * k)
        await frames(b, 1)
      }
      await b.keyboard.press('Enter')
      await expect
        .poll(
          async () =>
            (
              Object.values((await inPage(a, (hook) => hook.snapshot(), null)).nodes) as NodeLike[]
            ).filter((n) => n.type === 'vector').length,
          live,
        )
        .toBe(2)

      // B double-clicks the instance's Icon and overrides its fill.
      await b.keyboard.press('Escape')
      await clickNode(b, vIcon)
      await clickNode(b, vIcon, { double: true })
      const hex = b.getByRole('textbox', { name: 'Hex color' }).first()
      await hex.fill('AA00AA')
      await hex.press('Enter')
      await expect
        .poll(async () => (await nodeA(vIcon))?.styles['backgroundColor'], live)
        .toBe('#AA00AA')

      // --- Copy in window 1, paste in a second app window (another file).
      // Click the empty page first (B had instance content selected, which would keep the
      // instance "entered"), then the instance: the outermost instance is selected.
      const board2 = (await b.locator(`.ic-root [data-nid="${ids.board}"]`).boundingBox())!
      await b.mouse.click(board2.x + board2.width + 40, board2.y + 20)
      await frames(b, 2)
      await clickNode(b, vTitle)
      await expect(b.getByRole('button', { name: 'Go to main component' })).toBeVisible()
      await b.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      await b.keyboard.press('Control+c')
      await expect
        .poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()), live)
        .toBe('Overridden')
      // One clipboard item with the custom format next to text and HTML (Electron 44 API).
      const formats = await app.evaluate(async ({ clipboard }) => {
        const items = await (
          clipboard as unknown as { read(): Promise<{ types: string[] }[]> }
        ).read()
        return { count: items.length, types: items[0]?.types ?? [] }
      })
      expect(formats.count).toBe(1)
      expect(formats.types).toEqual(
        expect.arrayContaining([
          'web application/x-baren-clipboard+json',
          'text/plain',
          'text/html',
        ]),
      )
      const windowTwo = app.waitForEvent('window')
      await b.evaluate(() =>
        (window as unknown as { baren: { app: { newWindow(): void } } }).baren.app.newWindow(),
      )
      const c = await windowTwo
      c.on('pageerror', (e) => errors.push(`B window 2: ${e.message}`))
      // A new window opens on the current route (this file): go back to files, make a new one.
      await c.getByTestId('editor').waitFor()
      await c.getByRole('button', { name: 'Back to files' }).click()
      await expect(c).toHaveURL(/#\/(recents|files)/)
      await c.getByRole('button', { name: 'New file' }).click()
      await expect.poll(() => (/#\/file\//.test(c.url()) ? fileIdOf(c) : null)).not.toBeNull()
      const otherId = fileIdOf(c)
      expect(otherId).not.toBe(bSharedId)
      await c.getByTestId('editor').waitFor()
      await expect(c.locator('.ic-root').first()).toBeVisible()
      // The new file is empty: nothing of the shared file is on its canvas.
      await expect(c.locator(`.ic-root [data-nid="${ids.instance}"]`)).toHaveCount(0)
      await expect(c.locator('.ic-root').getByText('Overridden')).toHaveCount(0)
      await c.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      await c.keyboard.press('Control+v')
      await expect(c.locator('.ic-root').getByText('Overridden')).toBeVisible(live)
      // The pasted instance's main arrived on a "Components" page (read from the native core).
      await expect
        .poll(async () => {
          const snap = await coreSnapshot(c, otherId)
          return snap.pageIds.map((p) => snap.nodes[p]?.name)
        }, live)
        .toContain('Components')
      const other = await coreSnapshot(c, otherId)
      const pastedInstance = Object.values(other.nodes).find((n) => n.type === 'instance')
      const otherMain = Object.values(other.nodes).find((n) => n.componentKey && n.type === 'frame')
      expect(pastedInstance?.componentKey).toBe(otherMain?.componentKey)

      // --- Both peers hold the same shared document (B: the native core's copy).
      await expect
        .poll(
          async () => {
            const fromA = (await inPage(a, (hook) => hook.snapshot(), null)) as SnapshotLike
            const fromB = await coreSnapshot(b, bSharedId)
            return canon(fromA.nodes) === canon(fromB.nodes)
          },
          { timeout: 20_000, message: 'A snapshot equals B native-core export' },
        )
        .toBe(true)
      expect(errors).toEqual([])
    } finally {
      await app?.close().catch(() => undefined)
      await ctxA.close()
      rmSync(profile, { recursive: true, force: true })
    }
  })
})

/** JSON with object keys sorted at every level (array order is kept: children order matters). */
function canon(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) out[key] = sort((v as Record<string, unknown>)[key])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}
