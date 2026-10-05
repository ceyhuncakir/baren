/**
 * Comments in the editor (browser mode, mock bridge, `?fixture=design`): comment mode from the
 * rail and C, pinning a comment on the layer under a click, the thread card (reply, resolve),
 * the pin and its count, "Show resolved", design undo leaving comments alone, Escape, and a
 * collaborator's comment appearing live. Screenshots are attached for review.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const FILE = '/?fixture=design#/file/f-acme'

interface Hook {
  session: {
    doc: unknown
    store: { getState(): Record<string, unknown> }
    canvas: { current: unknown }
  }
  canvas: {
    getPageId(): string
    getNodeBounds(id: string): { x: number; y: number; width: number; height: number } | null
    canvasToScreen(p: { x: number; y: number }): { x: number; y: number }
    getStats(): { pendingWork: number }
  }
  schema: Record<string, (...args: unknown[]) => unknown>
}

async function openEditor(page: Page, url = FILE) {
  await page.goto(url)
  await page.getByTestId('editor').waitFor()
  await page.waitForFunction(
    () => (window as unknown as { __barenEditor?: Hook }).__barenEditor?.canvas != null,
  )
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForFunction(
    () =>
      (window as unknown as { __barenEditor: Hook }).__barenEditor.canvas.getStats().pendingWork ===
      0,
  )
}

/** A client point inside the first artboard of the page, and that artboard's id. */
async function artboardPoint(page: Page) {
  return page.evaluate(() => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    const c = hook.canvas
    const ids = hook.schema['getChildIds']!(hook.session.doc, c.getPageId()) as string[]
    const id = ids.find((n) => c.getNodeBounds(n) !== null) as string
    const b = c.getNodeBounds(id)!
    const s = c.canvasToScreen({ x: b.x + b.width * 0.3, y: b.y + b.height * 0.3 })
    const r = document.querySelector('[data-testid="comments-layer"]')!.getBoundingClientRect()
    return { id, x: r.left + s.x, y: r.top + s.y }
  })
}

/** Save a screenshot next to the test's output and attach it for review. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

function threads(page: Page) {
  return page.evaluate(() => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    return hook.schema['getCommentThreads']!(hook.session.doc) as {
      id: string
      nodeId: string | null
      resolved: boolean
      messages: { body: string }[]
    }[]
  })
}

test('pin a comment, reply, resolve; undo leaves it; Escape leaves comment mode', async ({
  page,
}, testInfo) => {
  await openEditor(page)
  const rail = page.getByRole('button', { name: /^Comments/ })
  await expect(rail).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('c')
  await expect(rail).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('comments-panel')).toBeVisible()
  await expect(page.getByText('No comments on this page yet.')).toBeVisible()

  const at = await artboardPoint(page)
  await page.mouse.click(at.x, at.y)
  const composer = page.getByRole('dialog', { name: 'New comment' })
  await expect(composer).toBeVisible()
  await composer.locator('textarea').fill('Tighten the spacing in this card')
  await expect(composer.getByRole('button', { name: 'Post' })).toBeEnabled()
  await shot(page, testInfo, 'composer')
  await composer.locator('textarea').press('Enter')

  const card = page.getByRole('dialog', { name: 'Comment thread' })
  await expect(card).toBeVisible()
  await expect(card.getByText('Tighten the spacing in this card')).toBeVisible()
  let list = await threads(page)
  expect(list).toHaveLength(1)
  expect(list[0]?.nodeId).not.toBeNull()

  await card.locator('textarea').fill('Will do')
  await card.locator('textarea').press('Enter')
  await expect(card.getByText('Will do')).toBeVisible()
  await expect(page.getByRole('button', { name: /Comment by .*1 reply/ })).toBeVisible()
  await shot(page, testInfo, 'thread')

  // Design undo never touches comments.
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await page.keyboard.press('Control+z')
  expect(await threads(page)).toHaveLength(1)

  // The list row opens the thread; resolving hides the pin until "Show resolved".
  await page.getByTestId('comments-panel').getByRole('listitem').first().click()
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Resolve' }).click()
  await expect(card.getByText(/Resolved by/)).toBeVisible()
  list = await threads(page)
  expect(list[0]?.resolved).toBe(true)
  await card.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: /Comment by/ })).toHaveCount(0)
  await page.getByRole('switch', { name: 'Show resolved comments' }).click()
  await expect(page.getByRole('button', { name: /Comment by .*resolved/ })).toBeVisible()
  await shot(page, testInfo, 'panel')

  await page.keyboard.press('Escape')
  await expect(rail).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('comments-panel')).toHaveCount(0)
})

test("a collaborator's comment appears live, with the open count on the rail", async ({
  page,
}, testInfo) => {
  await openEditor(page)
  const at = await artboardPoint(page)
  await page.evaluate((nodeId) => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    hook.schema['transact']!(
      hook.session.doc,
      () =>
        hook.schema['createCommentThread']!(hook.session.doc, {
          pageId: hook.canvas.getPageId(),
          nodeId,
          x: 24,
          y: 24,
          worldX: 0,
          worldY: 0,
          author: { id: 'agent:Claude Code', name: 'Claude Code', kind: 'agent' },
          body: 'I tightened the card spacing to 16px.',
        }),
      { origin: 'remote:test' },
    )
  }, at.id)
  const pin = page.getByRole('button', { name: 'Comment by Claude Code' })
  const rail = page.getByRole('button', { name: 'Comments, 1 open' })
  await expect(rail).toBeVisible()
  // Pins show in comment mode only.
  await expect(pin).toHaveCount(0)
  await rail.click()
  await expect(pin).toBeVisible()
  // Hovering grows the pin in place: its bottom-left corner (the anchor) does not move.
  const before = (await pin.boundingBox())!
  await pin.hover()
  await page.waitForTimeout(250)
  const after = (await pin.boundingBox())!
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThanOrEqual(1)
  expect(after.width).toBeGreaterThan(before.width)
  await pin.click()
  const card = page.getByRole('dialog', { name: 'Comment thread' })
  await expect(card.getByText('agent', { exact: true })).toBeVisible()
  await shot(page, testInfo, 'agent-thread')
  // Escape closes the thread, then leaves comment mode: the pins go with it.
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect(pin).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pin).toHaveCount(0)
})

test('mention a teammate from the reply field; unread marks; a mention of you toasts', async ({
  page,
}, testInfo) => {
  await openEditor(page)
  const at = await artboardPoint(page)
  const post = (body: string, mentionsMe: boolean, threadId: string | null) =>
    page.evaluate(
      ({ nodeId, body, mentionsMe, threadId }) => {
        const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
        const doc = hook.session.doc
        const author = { id: 'u-defne', name: 'Defne Aydın', kind: 'user' }
        const mentions = mentionsMe ? [{ id: 'u-ceyhun', name: 'ceyhun cakir', kind: 'user' }] : []
        return hook.schema['transact']!(
          doc,
          () =>
            threadId === null
              ? hook.schema['createCommentThread']!(doc, {
                  pageId: hook.canvas.getPageId(),
                  nodeId,
                  x: 24,
                  y: 24,
                  worldX: 0,
                  worldY: 0,
                  author,
                  body,
                  mentions,
                })
              : hook.schema['addCommentMessage']!(doc, threadId, { author, body, mentions }),
          { origin: 'remote:test' },
        ) as string
      },
      { nodeId: at.id, body, mentionsMe, threadId },
    )
  const threadId = await post('Can we try a darker header?', false, null)

  // Unread: the rail dot, then the pin, until the thread is opened.
  const rail = page.getByRole('button', { name: /Comments, 1 open, unread/ })
  await expect(rail).toBeVisible()
  await rail.click()
  const pin = page.getByRole('button', { name: /^Comment by Defne Aydın/ })
  await expect(pin).toHaveAccessibleName(/unread$/)
  await pin.click()
  const card = page.getByRole('dialog', { name: 'Comment thread' })
  await expect(card).toBeVisible()
  await expect(pin).not.toHaveAccessibleName(/unread/)
  await expect(page.getByRole('button', { name: 'Comments, 1 open' })).toBeVisible()

  // @ suggests people (the team, earlier authors); Enter picks, the mention is highlighted.
  const reply = card.getByRole('combobox', { name: 'Reply' })
  await reply.click()
  await reply.pressSequentially('Sure @Def')
  const option = page.getByRole('option', { name: /Defne Aydın/ })
  await expect(option).toBeVisible()
  await shot(page, testInfo, 'mention-suggestions')
  await reply.press('Enter')
  await expect(reply).toHaveValue('Sure @Defne Aydın ')
  await reply.pressSequentially('on it')
  await reply.press('Enter')
  await expect(card.getByText('@Defne Aydın', { exact: true })).toBeVisible()
  const saved = await threads(page)
  const last = saved[0]!.messages.at(-1) as unknown as { body: string; mentions: unknown[] }
  expect(last.body).toBe('Sure @Defne Aydın on it')
  expect(last.mentions).toEqual([{ id: 'u-defne', name: 'Defne Aydın', kind: 'user' }])

  // Defne mentions you: a toast whose View opens the thread again.
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await post('@ceyhun cakir does this read better?', true, threadId)
  const toast = page.getByText('Defne Aydın mentioned you')
  await expect(toast).toBeVisible()
  await expect(pin).toHaveAccessibleName(/mentions you$/)
  await shot(page, testInfo, 'mention-toast')
  await page.getByRole('button', { name: 'View' }).click()
  await expect(card).toBeVisible()
  await expect(card.getByText('@ceyhun cakir', { exact: true })).toBeVisible()
})

test('@Claude Code in a comment starts a request: working, then Stop', async ({
  page,
}, testInfo) => {
  // `agentRuns=on`: the mock bridge has `claude` and runs a fake request that keeps working.
  await openEditor(page, '/?fixture=design&agentRuns=on#/file/f-acme')
  await page.keyboard.press('c')
  const at = await artboardPoint(page)
  await page.mouse.click(at.x, at.y)
  const composer = page.getByRole('dialog', { name: 'New comment' })
  const field = composer.locator('textarea')
  await field.pressSequentially('@Cla')
  await expect(page.getByRole('option', { name: /Claude Code/ })).toBeVisible()
  await field.press('Enter')
  await field.pressSequentially('make this card denser')
  await field.press('Enter')

  const card = page.getByRole('dialog', { name: 'Comment thread' })
  const status = card.getByRole('status')
  await expect(status).toContainText('Claude Code is working')
  await expect(status).toContainText('Taking a screenshot')
  const pin = page.getByRole('button', { name: /^Comment by / })
  await expect(pin).toHaveAttribute('data-working', 'true')
  await shot(page, testInfo, 'agent-request-working')

  await status.getByRole('button', { name: 'Stop' }).click()
  await expect(status).toHaveText('You stopped Claude Code.')
  await expect(pin).not.toHaveAttribute('data-working', 'true')
})
