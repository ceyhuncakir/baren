/**
 * A viewer of a shared file (browser mode, mock bridge, `?fixture=design`): the room's welcome
 * says `viewer`, and the editor becomes view-only (`editor/session/readOnly.ts`). The canvas is
 * read-only, edit shortcuts and drawing tools do nothing (a toast says why), the inspector shows
 * values under a note, and an editor role brings everything back.
 */
import { expect, test, type Page } from '@playwright/test'

const FILE = '/?fixture=design#/file/f-acme'

interface Hook {
  session: {
    doc: unknown
    store: {
      getState(): Record<string, unknown>
      setState(s: Record<string, unknown>): void
    }
  }
  canvas: {
    getPageId(): string
    getStats(): { pendingWork: number }
    isReadOnly(): boolean
    select(ids: string[]): void
    getTool(): string
  }
  schema: Record<string, (...args: unknown[]) => unknown>
}

async function openEditor(page: Page) {
  await page.goto(FILE)
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

function setRole(page: Page, role: 'viewer' | 'editor') {
  return page.evaluate((r) => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    hook.session.store.setState({
      self: { type: 'welcome', clientId: 'c', userId: 'u', name: 'V', color: '#000', role: r },
    })
  }, role)
}

/** The first artboard of the page, selected. */
function selectFirstArtboard(page: Page) {
  return page.evaluate(() => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    const id = (
      hook.schema['getChildIds']!(hook.session.doc, hook.canvas.getPageId()) as string[]
    )[0]!
    hook.canvas.select([id])
    return id
  })
}

function exists(page: Page, id: string) {
  return page.evaluate((nodeId) => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    return hook.schema['getNode']!(hook.session.doc, nodeId) !== undefined
  }, id)
}

test('a viewer can look but not change the file; an editor role brings editing back', async ({
  page,
}) => {
  await openEditor(page)
  const isReadOnly = () =>
    page.evaluate(() =>
      (window as unknown as { __barenEditor: Hook }).__barenEditor.canvas.isReadOnly(),
    )
  expect(await isReadOnly()).toBe(false)

  await setRole(page, 'viewer')
  await expect.poll(isReadOnly).toBe(true)

  // Selecting still works, and the inspector shows the values under a note.
  const board = await selectFirstArtboard(page)
  const note = page.getByRole('note').filter({ hasText: 'You can view this file but not edit it.' })
  await expect(note).toBeVisible()

  // Delete and duplicate do nothing; the user is told why.
  await page.keyboard.press('Delete')
  await page.keyboard.press('Control+d')
  expect(await exists(page, board)).toBe(true)
  await expect(
    page.getByText('You can view this file but not edit it. Ask an editor'),
  ).toBeVisible()

  // Drawing tools stay off: the select tool is kept.
  await page.keyboard.press('r')
  expect(
    await page.evaluate(() =>
      (window as unknown as { __barenEditor: Hook }).__barenEditor.canvas.getTool(),
    ),
  ).toBe('select')

  // An editor role (e.g. the admin changed it) brings editing back.
  await setRole(page, 'editor')
  await expect.poll(isReadOnly).toBe(false)
  await expect(note).toHaveCount(0)
  await page.evaluate((id) => {
    ;(window as unknown as { __barenEditor: Hook }).__barenEditor.canvas.select([id])
  }, board)
  await page.keyboard.press('Delete')
  await expect.poll(() => exists(page, board)).toBe(false)
})
