/**
 * Phase 3 integration: two people against a real `baren-server`, using all six canvas-tool
 * features together, each through real input (pointer gestures on the canvas, shortcuts, the
 * inspector, the component picker and the clipboard), with every step checked live on the
 * other peer:
 *
 * 1. reparent by dragging on the canvas: into a frame (absolute), into a flex frame at the
 *    insertion line, and out of a frame onto the artboard;
 * 2. rotation: the corner zone with Shift (15° snapping), the inspector's rotation field, and
 *    undo/redo of it;
 * 3. groups: Ctrl+G, the other peer clicks the group (outermost), drags it and double-clicks
 *    into it;
 * 4. the pen tool: P, three clicks, click the first point to close; the other peer
 *    double-clicks the vector, drags an anchor; Ctrl+D duplicates it;
 * 5. components: Ctrl+Alt+K, an instance dragged in from the component picker, a main edit by
 *    the other peer propagating live, an override on instance content surviving another main
 *    edit, the Components section;
 * 6. copy/paste between files: a frame with a token fill and a pasted image is copied from a
 *    second (unshared) file into the shared one — the token and the image bytes travel and the
 *    other peer renders the image; an instance pasted into the second file brings its main
 *    (a "Components" page); paste in place back into the shared file.
 *
 * Both peers must end with identical snapshots and identical canvas DOM, without page errors.
 *
 * Opt-in, like server.spec.ts:
 *
 *   MAIL_TRANSPORT=file:/tmp/mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
 *     baren-server &
 *   BAREN_E2E_MAIL_DIR=/tmp/mail VITE_SERVER_URL=http://127.0.0.1:8899 \
 *     pnpm test:visual tests/visual/phase3-integration-server.spec.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']
const SERVER = (process.env['VITE_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')

/* eslint-disable @typescript-eslint/no-explicit-any */
type Hook = any

interface Pt {
  x: number
  y: number
}

interface NodeLike {
  id: string
  type: string
  name: string
  parentId: string | null
  children: string[]
  styles: Record<string, string | number>
  componentKey?: string
  nodeKey?: string
  assetId?: string
  vector?: { subpaths: { closed: boolean; points: { x: number; y: number }[] }[] }
}

// ---------------------------------------------------------------------------
// Server and accounts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Wait for the editor test hook of the file open in the page (by file id when given). */
async function hooked(page: Page, fileId?: string) {
  await page.waitForFunction((id) => {
    const hook = (
      window as unknown as {
        __barenEditor?: { canvas: unknown; session: { fileId: string } }
      }
    ).__barenEditor
    return !!hook?.canvas && (id === undefined || hook.session.fileId === id)
  }, fileId)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

/** The file id of the editor route (`#/file/<id>`). */
function fileIdOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).hash.replace(/^#\/file\//, ''))
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

/** Wait until the canvas has no pending work, then two more frames. */
async function idle(page: Page) {
  await page.waitForFunction(() => {
    const hook = (
      window as unknown as {
        __barenEditor?: { canvas: { getStats(): { pendingWork: number } } | null }
      }
    ).__barenEditor
    return hook?.canvas?.getStats().pendingWork === 0
  })
  await frames(page, 2)
}

/** World point → client (page) coordinates. */
async function client(page: Page, p: Pt): Promise<Pt> {
  const s = await inPage(page, (hook, q) => hook.canvas.canvasToScreen(q) as Pt, p)
  const box = await page.locator('.ic-root').first().boundingBox()
  return { x: (box?.x ?? 0) + s.x, y: (box?.y ?? 0) + s.y }
}

async function clickWorld(
  page: Page,
  p: Pt,
  opts: { modifiers?: ('Shift' | 'Control')[]; double?: boolean } = {},
) {
  const c = await client(page, p)
  await page.mouse.move(c.x, c.y)
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m)
  if (opts.double) await page.mouse.dblclick(c.x, c.y)
  else await page.mouse.click(c.x, c.y)
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m)
  await frames(page, 2)
}

async function dragWorld(page: Page, from: Pt, to: Pt) {
  const a = await client(page, from)
  const b = await client(page, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await frames(page, 2)
  await page.mouse.up()
  await frames(page, 3)
}

/** Blur any focused field so shortcuts reach the editor. */
async function focusCanvas(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

function snapshotNodes(page: Page): Promise<Record<string, NodeLike>> {
  return inPage(page, (hook) => hook.snapshot().nodes as Record<string, NodeLike>, null)
}

async function byName(page: Page, name: string): Promise<NodeLike | undefined> {
  return Object.values(await snapshotNodes(page)).find((n) => n.name === name)
}

function nodeOf(page: Page, id: string): Promise<NodeLike | undefined> {
  return inPage(page, (hook, ref) => hook.session.resolver.resolveNode(ref) as NodeLike, id)
}

function selectionOf(page: Page): Promise<string[]> {
  return inPage(page, (hook) => [...(hook.canvas.getSelection() as string[])], null)
}

async function boundsOf(page: Page, id: string) {
  return inPage(
    page,
    (hook, ref) =>
      hook.canvas.getNodeBounds(ref) as { x: number; y: number; width: number; height: number },
    id,
  )
}

function pathD(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    (nid) =>
      document.querySelector(`[data-nid="${nid}"]`)?.querySelector('path')?.getAttribute('d') ??
      null,
    id,
  )
}

/** Navigate inside the single-page app (keeps the in-memory mock bridge and its local files). */
async function goHash(page: Page, hash: string) {
  await page.evaluate((h) => {
    window.location.hash = h
  }, hash)
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
      // Image sources are per-peer blob: URLs; compare everything else.
      const style = (el.getAttribute('style') ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s !== '' && !s.startsWith('visibility'))
        .map((s) => s.replace(/blob:[^")]+/g, 'blob:'))
        .sort()
        .join(';')
      out.push(`${nid}|${el.tagName}|${style}|${text}|${d}`)
    }
    return out.sort().join('\n')
  })
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test.describe('Phase 3 integration against a real server: all six features, two people', () => {
  test.skip(!MAIL_DIR, 'needs BAREN_E2E_MAIL_DIR + VITE_SERVER_URL (see above)')

  test('reparent, rotation, groups, pen, components and cross-file paste, live on both peers', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const tokenA = await account('Ada Integration', `ada-int-${stamp}@example.com`)
    const tokenB = await account('Bora Integration', `bora-int-${stamp}@example.com`)
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
    await ctxB.grantPermissions(['clipboard-read', 'clipboard-write'])
    const a = await signedIn(ctxA, tokenA)
    const b = await signedIn(ctxB, tokenB)
    const errors: string[] = []
    a.on('pageerror', (e) => errors.push(`A: ${e.message}`))
    b.on('pageerror', (e) => errors.push(`B: ${e.message}`))
    const view = { x: -50, y: -50, zoom: 1 }
    /** Empty page, right of and below the artboard (0..700 × 0..440). */
    const EMPTY = { x: 740, y: 470 }

    // --- Setup: A creates the shared file with one artboard and shares it.
    await a.goto('/?editorTestHook=1#/recents')
    await a.getByRole('button', { name: 'New file' }).click()
    await expect(a).toHaveURL(/#\/file\//)
    const sharedHash = new URL(a.url()).hash
    const sharedId = fileIdOf(a)
    await hooked(a, sharedId)
    const ids = await inPage(
      a,
      (hook, v) => {
        const { schema, session } = hook
        const doc = session.doc
        const page = session.store.getState().pageId
        const board = schema.createNode(doc, {
          type: 'frame',
          parentId: page,
          name: 'Board',
          styles: { left: 0, top: 0, width: 700, height: 440, backgroundColor: '#FFFFFF' },
        })
        const abs = (left: number, top: number, width: number, height: number) => ({
          position: 'absolute',
          left,
          top,
          width,
          height,
        })
        const rect = (parentId: string, name: string, styles: Record<string, unknown>) =>
          schema.createNode(doc, { type: 'rect', parentId, name, styles })
        const red = rect(board, 'Red', { ...abs(40, 40, 100, 60), backgroundColor: '#FF3B30' })
        const blue = rect(board, 'Blue', { ...abs(40, 160, 80, 80), backgroundColor: '#007AFF' })
        const green = rect(board, 'Green', { ...abs(180, 160, 60, 60), backgroundColor: '#34C759' })
        const title = schema.createNode(doc, {
          type: 'text',
          parentId: board,
          name: 'Title',
          text: 'Hello',
          styles: {
            ...abs(40, 280, 80, 30),
            fontSize: '20px',
            lineHeight: '30px',
            color: '#111111',
          },
        })
        const target = schema.createNode(doc, {
          type: 'frame',
          parentId: board,
          name: 'Target',
          styles: { ...abs(380, 30, 280, 170), backgroundColor: '#F2F2F2' },
        })
        const stack = schema.createNode(doc, {
          type: 'frame',
          parentId: board,
          name: 'Stack',
          styles: {
            ...abs(380, 230, 280, 180),
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '8px',
            backgroundColor: '#E8F0FF',
          },
        })
        const s1 = rect(stack, 'S1', { width: 100, height: 36, backgroundColor: '#999999' })
        const s2 = rect(stack, 'S2', { width: 100, height: 36, backgroundColor: '#666666' })
        hook.canvas.setViewport(v, { animate: false })
        return { board, red, blue, green, title, target, stack, s1, s2 }
      },
      view,
    )
    await a.getByRole('button', { name: 'Share', exact: true }).click()
    await a.getByRole('button', { name: 'Copy link' }).click()
    await a.keyboard.press('Escape')

    // B opens the shared file from Recents (team files are pulled automatically).
    await b.goto('/?editorTestHook=1#/recents')
    const card = b.locator('[data-file-id]').filter({ hasText: 'Untitled' })
    await expect(card).toHaveCount(1, { timeout: 20_000 })
    await card.click()
    await hooked(b)
    await inPage(b, (hook, v) => hook.canvas.setViewport(v, { animate: false }), view)
    await expect
      .poll(async () => (await nodeOf(b, ids.stack))?.children, { timeout: 20_000 })
      .toEqual([ids.s1, ids.s2])
    await idle(a)
    await idle(b)

    const live = { timeout: 15_000 }

    // ---------------------------------------------------------------- 1. Reparent by drag
    // A drags Red (centre world 90,70) into Target (380..660 × 30..200): absolute inside it.
    await dragWorld(a, { x: 90, y: 70 }, { x: 470, y: 100 })
    expect((await nodeOf(a, ids.red))?.parentId).toBe(ids.target)
    expect((await nodeOf(a, ids.red))?.styles).toMatchObject({
      position: 'absolute',
      left: 40,
      top: 40,
    })
    await expect.poll(async () => (await nodeOf(b, ids.red))?.parentId, live).toBe(ids.target)
    // A drags Green into the flex Stack between S1 and S2 (insertion line): a flow item.
    // S1 spans y 238..274, S2 282..318 in world space; the gap's middle is y = 278.
    await dragWorld(a, { x: 210, y: 190 }, { x: 450, y: 278 })
    expect((await nodeOf(a, ids.stack))?.children).toEqual([ids.s1, ids.green, ids.s2])
    expect((await nodeOf(a, ids.green))?.styles['left']).toBeUndefined()
    await expect
      .poll(async () => (await nodeOf(b, ids.stack))?.children, live)
      .toEqual([ids.s1, ids.green, ids.s2])
    // B drags S2 out of the Stack onto the artboard: absolute in Board, where it was dropped.
    await idle(b)
    const s2Box = await boundsOf(b, ids.s2)
    // A click on S2 selects the Stack (the artboard's direct child); Ctrl+click selects S2.
    await clickWorld(b, { x: s2Box.x + 50, y: s2Box.y + 18 }, { modifiers: ['Control'] })
    expect(await selectionOf(b)).toEqual([ids.s2])
    await dragWorld(
      b,
      { x: s2Box.x + 50, y: s2Box.y + 18 },
      { x: s2Box.x + 50 - 130, y: s2Box.y + 18 - 200 },
    )
    expect((await nodeOf(b, ids.s2))?.parentId).toBe(ids.board)
    expect((await nodeOf(b, ids.s2))?.styles['position']).toBe('absolute')
    await expect.poll(async () => (await nodeOf(a, ids.s2))?.parentId, live).toBe(ids.board)

    // ---------------------------------------------------------------- 2. Rotation
    // B selects Blue (world 40..120 × 160..240) and drags its NE corner zone ~62° with Shift.
    await clickWorld(b, { x: 80, y: 200 })
    expect(await selectionOf(b)).toEqual([ids.blue])
    const centre = await client(b, { x: 80, y: 200 })
    const corner = await client(b, { x: 120, y: 160 })
    const zone = { x: corner.x + 8, y: corner.y - 8 }
    const r = Math.hypot(zone.x - centre.x, zone.y - centre.y)
    const a0 = Math.atan2(zone.y - centre.y, zone.x - centre.x)
    await b.mouse.move(zone.x, zone.y)
    await frames(b, 1)
    await b.mouse.down()
    await b.keyboard.down('Shift')
    for (let i = 1; i <= 6; i++) {
      const ang = a0 + ((i * 10 + 2) * Math.PI) / 180
      await b.mouse.move(centre.x + r * Math.cos(ang), centre.y + r * Math.sin(ang))
    }
    await frames(b, 2)
    await b.mouse.up()
    await b.keyboard.up('Shift')
    await frames(b, 2)
    expect((await nodeOf(b, ids.blue))?.styles['rotate']).toBe('60deg')
    // Rotation is about the centre: the unrotated box did not move.
    expect((await nodeOf(b, ids.blue))?.styles).toMatchObject({ left: 40, top: 160 })
    await expect.poll(async () => (await nodeOf(a, ids.blue))?.styles['rotate'], live).toBe('60deg')
    await expect
      .poll(
        () =>
          a.evaluate(
            (id) => document.querySelector<HTMLElement>(`[data-nid="${id}"]`)?.style.rotate,
            ids.blue,
          ),
        live,
      )
      .toBe('60deg')
    // A rotates Red with the inspector's rotation field (Ctrl+click selects inside Target).
    await clickWorld(a, { x: 470, y: 100 }, { modifiers: ['Control'] })
    expect(await selectionOf(a)).toEqual([ids.red])
    const rotation = a.getByRole('textbox', { name: 'Rotation' })
    await rotation.fill('15')
    await rotation.press('Enter')
    expect((await nodeOf(a, ids.red))?.styles['rotate']).toBe('15deg')
    await expect.poll(async () => (await nodeOf(b, ids.red))?.styles['rotate'], live).toBe('15deg')
    // A's undo and redo reach B too.
    await focusCanvas(a)
    await a.keyboard.press('Control+z')
    await expect
      .poll(async () => (await nodeOf(b, ids.red))?.styles['rotate'], live)
      .toBeUndefined()
    await a.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await nodeOf(b, ids.red))?.styles['rotate'], live).toBe('15deg')

    // ---------------------------------------------------------------- 3. Groups
    // A selects Blue, Shift+clicks Title, Ctrl+G.
    await clickWorld(a, { x: 80, y: 200 })
    await clickWorld(a, { x: 70, y: 295 }, { modifiers: ['Shift'] })
    expect([...(await selectionOf(a))].sort()).toEqual([ids.blue, ids.title].sort())
    await focusCanvas(a)
    await a.keyboard.press('Control+g')
    const group = (await nodeOf(a, ids.title))?.parentId as string
    expect((await nodeOf(a, group))?.type).toBe('group')
    expect([...((await nodeOf(a, group))?.children ?? [])].sort()).toEqual(
      [ids.blue, ids.title].sort(),
    )
    await expect.poll(async () => (await nodeOf(b, group))?.type, live).toBe('group')
    await expect.poll(async () => (await nodeOf(b, ids.title))?.parentId, live).toBe(group)
    // B clicks the Title: the outermost group is selected; B drags it 100 px right.
    // (B still has Blue selected, which is inside the group now: that would count as having
    // entered it, so B first clicks the empty canvas.)
    await idle(b)
    await clickWorld(b, EMPTY)
    expect(await selectionOf(b)).toEqual([])
    await clickWorld(b, { x: 70, y: 295 })
    expect(await selectionOf(b)).toEqual([group])
    const groupLeft = (await nodeOf(b, group))?.styles['left'] as number
    const titleLocal = (await nodeOf(b, ids.title))?.styles
    await dragWorld(b, { x: 70, y: 295 }, { x: 170, y: 295 })
    expect((await nodeOf(b, group))?.parentId).toBe(ids.board)
    expect((await nodeOf(b, group))?.styles['left']).toBe(groupLeft + 100)
    await expect
      .poll(async () => (await nodeOf(a, group))?.styles['left'], live)
      .toBe(groupLeft + 100)
    // The children moved with the group (their own positions inside it are unchanged).
    expect((await nodeOf(a, ids.title))?.styles).toMatchObject({
      left: titleLocal?.['left'],
      top: titleLocal?.['top'],
    })
    // Double-click enters the group: B now has the Title itself selected.
    await clickWorld(b, { x: 170, y: 295 }, { double: true })
    await expect.poll(() => selectionOf(b)).toEqual([ids.title])
    await b.keyboard.press('Escape')
    await b.keyboard.press('Escape')

    // ---------------------------------------------------------------- 4. Pen tool
    // B draws a triangle: P, three clicks, click the first point to close.
    await idle(b)
    await focusCanvas(b)
    await b.keyboard.press('p')
    for (const p of [
      { x: 160, y: 330 },
      { x: 240, y: 400 },
      { x: 300, y: 330 },
      { x: 160, y: 330 },
    ]) {
      await clickWorld(b, p)
    }
    const vectorId = (await selectionOf(b))[0] as string
    const drawn = await nodeOf(b, vectorId)
    expect(drawn?.type).toBe('vector')
    expect(drawn?.parentId).toBe(ids.board)
    await expect.poll(async () => (await nodeOf(a, vectorId))?.type, live).toBe('vector')
    const aVector = await inPage(
      a,
      (hook, id) => hook.schema.getNode(hook.session.doc, id) as NodeLike,
      vectorId,
    )
    expect(aVector?.vector?.subpaths[0]?.closed).toBe(true)
    expect(aVector?.vector?.subpaths[0]?.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [80, 70],
      [140, 0],
    ])
    await idle(a)
    await expect.poll(() => pathD(a, vectorId), live).toBe(await pathD(b, vectorId))
    // A double-clicks the vector's top edge to edit it and drags the bottom anchor 20 px down.
    await clickWorld(a, { x: 230, y: 330 }, { double: true })
    await expect
      .poll(() => inPage(a, (hook) => hook.canvas.getEditingVector() as string | null, null))
      .toBe(vectorId)
    await dragWorld(a, { x: 240, y: 400 }, { x: 240, y: 420 })
    await a.keyboard.press('Escape')
    await expect
      .poll(() => inPage(a, (hook) => hook.canvas.getEditingVector() as string | null, null))
      .toBeNull()
    expect((await nodeOf(a, vectorId))?.styles['height']).toBe(90)
    await expect.poll(async () => (await nodeOf(b, vectorId))?.styles['height'], live).toBe(90)
    await idle(b)
    await expect.poll(() => pathD(b, vectorId), live).toBe(await pathD(a, vectorId))
    // B duplicates the vector with Ctrl+D (B still has it selected).
    await clickWorld(b, { x: 230, y: 330 })
    expect(await selectionOf(b)).toEqual([vectorId])
    await focusCanvas(b)
    await b.keyboard.press('Control+d')
    await expect
      .poll(
        async () => Object.values(await snapshotNodes(a)).filter((n) => n.type === 'vector').length,
        live,
      )
      .toBe(2)

    // ---------------------------------------------------------------- 5. Components
    // A selects Target (its empty corner) and makes it a component with Ctrl+Alt+K.
    await idle(a)
    await clickWorld(a, { x: 630, y: 180 })
    expect(await selectionOf(a)).toEqual([ids.target])
    await focusCanvas(a)
    await a.keyboard.press('Control+Alt+k')
    await expect
      .poll(async () => (await nodeOf(a, ids.target))?.componentKey)
      .toMatch(/^[0-9a-z]{16}$/)
    await expect
      .poll(async () => (await nodeOf(b, ids.target))?.componentKey, live)
      .toMatch(/^[0-9a-z]{16}$/)
    // The Components section lists it on both sides.
    await expect(a.getByRole('listitem', { name: /^Target/ })).toBeVisible()
    await expect(b.getByRole('listitem', { name: /^Target/ })).toBeVisible(live)
    // A opens the component picker (K) and drags "Target" below the artboard.
    await a.keyboard.press('Escape')
    await focusCanvas(a)
    await a.keyboard.press('k')
    const picker = a.getByRole('dialog', { name: 'Components' })
    await expect(picker).toBeVisible()
    const dropAt = await inPage(a, (hook) => hook.canvas.canvasToScreen({ x: 200, y: 560 }), null)
    await picker
      .getByRole('button', { name: 'Insert Target' })
      .dragTo(a.locator('.ic-root').first(), { targetPosition: dropAt })
    const instanceOn = async (page: Page) =>
      Object.values(await snapshotNodes(page)).find((n) => n.type === 'instance')
    await expect.poll(async () => (await instanceOn(a))?.parentId).not.toBeUndefined()
    const instance = (await instanceOn(a)) as NodeLike
    expect(instance.componentKey).toBe((await nodeOf(a, ids.target))?.componentKey)
    await expect.poll(async () => (await instanceOn(b))?.id, live).toBe(instance.id)
    const redKey = (await nodeOf(a, ids.red))?.nodeKey as string
    const virtualRed = `${instance.id}/${redKey}`
    await expect.poll(async () => (await nodeOf(b, virtualRed))?.type, live).toBe('rect')

    // B edits the main's Red (Ctrl+click inside Target): A's instance follows, live.
    await idle(b)
    await clickWorld(b, { x: 470, y: 100 }, { modifiers: ['Control'] })
    expect(await selectionOf(b)).toEqual([ids.red])
    const hexB = b.getByRole('textbox', { name: 'Hex color' }).first()
    await hexB.fill('00AA00')
    await hexB.press('Enter')
    await expect
      .poll(async () => (await nodeOf(a, virtualRed))?.styles['backgroundColor'], live)
      .toBe('#00AA00')
    await expect
      .poll(
        () =>
          a.evaluate((id) => {
            const el = document.querySelector<HTMLElement>(`[data-nid="${id}"]`)
            return el ? getComputedStyle(el).backgroundColor : null
          }, virtualRed),
        live,
      )
      .toBe('rgb(0, 170, 0)')

    // A double-clicks the instance's Red and overrides its fill.
    await idle(a)
    const vb = await boundsOf(a, virtualRed)
    await clickWorld(a, { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 }, { double: true })
    await expect.poll(() => selectionOf(a)).toEqual([virtualRed])
    const hexA = a.getByRole('textbox', { name: 'Hex color' }).first()
    await hexA.fill('AA00AA')
    await hexA.press('Enter')
    await expect
      .poll(async () => (await nodeOf(b, virtualRed))?.styles['backgroundColor'], live)
      .toBe('#AA00AA')
    // B edits the main's own fill: the instance root follows, A's override stays.
    await clickWorld(b, { x: 630, y: 180 })
    expect(await selectionOf(b)).toEqual([ids.target])
    await hexB.fill('FFEEAA')
    await hexB.press('Enter')
    await expect
      .poll(async () => (await nodeOf(a, instance.id))?.styles['backgroundColor'], live)
      .toBe('#FFEEAA')
    expect((await nodeOf(a, virtualRed))?.styles['backgroundColor']).toBe('#AA00AA')
    expect((await nodeOf(b, ids.red))?.styles['backgroundColor']).toBe('#00AA00')

    // ---------------------------------------------------------------- 6. Copy/paste between files
    // A makes a second, unshared file with a token-filled frame and a pasted image.
    await goHash(a, '#/recents')
    await a.getByRole('button', { name: 'New file' }).click()
    await expect.poll(() => new URL(a.url()).hash).toMatch(/^#\/file\//)
    await expect.poll(() => new URL(a.url()).hash).not.toBe(sharedHash)
    const libraryHash = new URL(a.url()).hash
    const libraryId = fileIdOf(a)
    await hooked(a, libraryId)
    const sticker = await inPage(
      a,
      (hook, v) => {
        const { schema, session } = hook
        const doc = session.doc
        const page = session.store.getState().pageId
        schema.setTokens(doc, { '--color-brand': { type: 'color', value: '#FF6600' } })
        const id = schema.createNode(doc, {
          type: 'frame',
          parentId: page,
          name: 'Sticker',
          styles: {
            left: 0,
            top: 0,
            width: 200,
            height: 120,
            backgroundColor: 'var(--color-brand)',
          },
        })
        hook.canvas.setViewport(v, { animate: false })
        hook.canvas.select([id])
        return id
      },
      view,
    )
    // An image from "another app": a 32×24 PNG on the clipboard, pasted into the Sticker.
    await a.evaluate(async () => {
      const canvas = new OffscreenCanvas(32, 24)
      const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      g.fillStyle = '#0055FF'
      g.fillRect(0, 0, 32, 24)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    })
    await focusCanvas(a)
    await a.keyboard.press('Control+v')
    await expect.poll(async () => (await nodeOf(a, sticker))?.children.length, live).toBe(1)
    const imageId = (await nodeOf(a, sticker))?.children[0] as string
    expect((await nodeOf(a, imageId))?.type).toBe('image')
    // Copy the Sticker (frame + image + token).
    await inPage(a, (hook, id) => hook.canvas.select([id]), sticker)
    await focusCanvas(a)
    await a.keyboard.press('Control+c')
    await expect
      .poll(() =>
        a.evaluate(async () => {
          const items = await navigator.clipboard.read()
          for (const item of items) {
            if (!item.types.includes('web application/x-baren-clipboard+json')) continue
            const json = await (await item.getType('web application/x-baren-clipboard+json')).text()
            return json.includes('"Sticker"') && json.includes('"assets"')
          }
          return false
        }),
      )
      .toBe(true)
    // Back in the shared file: select the artboard and paste.
    await goHash(a, sharedHash)
    await hooked(a, sharedId)
    await inPage(a, (hook, v) => hook.canvas.setViewport(v, { animate: false }), view)
    await expect.poll(async () => (await nodeOf(a, ids.board))?.type, live).toBe('frame')
    await idle(a)
    await clickWorld(a, { x: 100, y: 15 })
    expect(await selectionOf(a)).toEqual([ids.board])
    await focusCanvas(a)
    await a.keyboard.press('Control+v')
    await expect.poll(async () => (await byName(a, 'Sticker'))?.parentId, live).toBe(ids.board)
    const pasted = (await byName(a, 'Sticker')) as NodeLike
    expect(pasted.styles['backgroundColor']).toBe('var(--color-brand)')
    const pastedImage = (await nodeOf(a, pasted.children[0] as string)) as NodeLike
    expect(pastedImage.type).toBe('image')
    // B gets the frame, the token and the image bytes (uploaded by A, downloaded by B).
    await expect.poll(async () => (await byName(b, 'Sticker'))?.id, live).toBe(pasted.id)
    await expect
      .poll(
        () =>
          inPage(
            b,
            (hook) => (hook.tokens() as Record<string, { value: string }>)['--color-brand']?.value,
            null,
          ),
        live,
      )
      .toBe('#FF6600')
    await expect
      .poll(
        () =>
          b.evaluate((id) => {
            const el = document.querySelector(`[data-nid="${id}"]`)
            const img = el?.tagName === 'IMG' ? (el as HTMLImageElement) : el?.querySelector('img')
            return img && img.complete ? img.naturalWidth : 0
          }, pastedImage.id),
        { timeout: 30_000 },
      )
      .toBe(32)

    // A copies the instance into the unshared file: its main arrives on a "Components" page.
    await idle(a)
    const ib = await boundsOf(a, instance.id)
    await clickWorld(a, { x: ib.x + ib.width - 10, y: ib.y + ib.height - 10 })
    expect(await selectionOf(a)).toEqual([instance.id])
    await focusCanvas(a)
    await a.keyboard.press('Control+c')
    await expect
      .poll(() =>
        a.evaluate(async () => {
          const items = await navigator.clipboard.read()
          for (const item of items) {
            if (!item.types.includes('web application/x-baren-clipboard+json')) continue
            const json = await (await item.getType('web application/x-baren-clipboard+json')).text()
            return json.includes('"instance"')
          }
          return false
        }),
      )
      .toBe(true)
    await goHash(a, libraryHash)
    await hooked(a, libraryId)
    await expect.poll(async () => (await nodeOf(a, sticker))?.name, live).toBe('Sticker')
    await focusCanvas(a)
    await a.keyboard.press('Control+v')
    await expect
      .poll(() =>
        inPage(
          a,
          (hook) =>
            hook.session.tree
              .pages()
              .map((p: string) => hook.session.tree.meta(p)?.name as string) as string[],
          null,
        ),
      )
      .toContain('Components')
    const libInstance = Object.values(await snapshotNodes(a)).find(
      (n) => n.type === 'instance',
    ) as NodeLike
    expect(libInstance.componentKey).toBe(instance.componentKey)
    const libRed = await nodeOf(a, `${libInstance.id}/${redKey}`)
    // The override travelled with the instance; the main came with B's latest edits.
    expect(libRed?.styles['backgroundColor']).toBe('#AA00AA')
    expect((await nodeOf(a, libInstance.id))?.styles['backgroundColor']).toBe('#FFEEAA')

    // Paste in place back into the shared file: a second instance at the exact position.
    await goHash(a, sharedHash)
    await hooked(a, sharedId)
    await inPage(a, (hook, v) => hook.canvas.setViewport(v, { animate: false }), view)
    await expect.poll(async () => (await nodeOf(a, instance.id))?.type, live).toBe('instance')
    await idle(a)
    await focusCanvas(a)
    await a.keyboard.press('Control+Shift+v')
    await expect
      .poll(
        async () =>
          Object.values(await snapshotNodes(b)).filter((n) => n.type === 'instance').length,
        live,
      )
      .toBe(2)
    const instances = Object.values(await snapshotNodes(a)).filter((n) => n.type === 'instance')
    expect(instances.map((n) => [n.styles['left'], n.styles['top']])).toEqual([
      [instance.styles['left'], instance.styles['top']],
      [instance.styles['left'], instance.styles['top']],
    ])

    // ---------------------------------------------------------------- Convergence
    await idle(a)
    await idle(b)
    const snapshotOf = (page: Page) => inPage(page, (hook) => JSON.stringify(hook.snapshot()), null)
    await expect
      .poll(async () => (await snapshotOf(a)) === (await snapshotOf(b)), {
        message: 'snapshots converge',
        timeout: 20_000,
      })
      .toBe(true)
    await expect
      .poll(async () => (await canvasDom(a)) === (await canvasDom(b)), {
        message: 'canvases render identically',
        timeout: 10_000,
      })
      .toBe(true)
    expect(errors).toEqual([])
    for (const [name, page] of [
      ['peer-a', a],
      ['peer-b', b],
    ] as const) {
      const path = testInfo.outputPath(`${name}.png`)
      await page.screenshot({ path })
      await testInfo.attach(name, { path, contentType: 'image/png' })
    }
    await ctxA.close()
    await ctxB.close()
  })
})
