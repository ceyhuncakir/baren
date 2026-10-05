/**
 * Version history in the editor (browser mode, mock bridge, `?fixture=design`): the rail's
 * history button, "Save version", an edit, previewing the version read-only (the live file
 * untouched, editing blocked), Escape back, restoring it (with the "Before restoring"
 * checkpoint) and undoing the restore from the toast. Screenshots are attached for review.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const FILE = '/?fixture=design#/file/f-acme'

interface Hook {
  session: {
    doc: unknown
    store: { getState(): Record<string, unknown> }
  }
  canvas: {
    getPageId(): string
    getStats(): { pendingWork: number }
    isReadOnly(): boolean
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

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

/** The first artboard of the page: its id and name. */
function firstArtboard(page: Page) {
  return page.evaluate(() => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    const id = (
      hook.schema['getChildIds']!(hook.session.doc, hook.canvas.getPageId()) as string[]
    )[0]!
    const node = hook.schema['getNode']!(hook.session.doc, id) as { name: string }
    return { id, name: node.name }
  })
}

function versionNames(page: Page) {
  return page.evaluate(() => {
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    return (hook.schema['getVersions']!(hook.session.doc) as { name: string }[]).map((v) => v.name)
  })
}

test('save a version, edit, preview it read-only, restore it and undo the restore', async ({
  page,
}, testInfo) => {
  await openEditor(page)
  const board = await firstArtboard(page)

  // Open version history from the rail.
  const rail = page.getByRole('button', { name: 'Version history' })
  await rail.click()
  const panel = page.getByTestId('history-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Current version')).toBeVisible()

  // Save a named version.
  await panel.getByRole('button', { name: 'Save version' }).click()
  await page.getByRole('textbox', { name: 'Version name' }).fill('Before the rename')
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('group', { name: 'Named versions' })).toContainText(
    'Before the rename',
  )
  expect(await versionNames(page)).toEqual(['Before the rename'])

  // An edit after it (undoable, like any design change).
  await page.evaluate(
    ({ id }) => {
      const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
      hook.schema['transact']!(
        hook.session.doc,
        () => hook.schema['setNodeProps']!(hook.session.doc, id, { name: 'Renamed board' }),
        { origin: 'editor:layers' },
      )
    },
    { id: board.id },
  )
  const nameOf = () =>
    page.evaluate(
      ({ id }) => {
        const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
        return (hook.schema['getNode']!(hook.session.doc, id) as { name: string } | undefined)?.name
      },
      { id: board.id },
    )
  expect(await nameOf()).toBe('Renamed board')

  // Preview the version: read-only, the live file untouched, the left panel inert.
  await panel.getByTitle('Preview “Before the rename”').click()
  const preview = page.getByTestId('version-preview')
  await expect(preview).toBeVisible()
  await expect(preview.getByRole('status', { name: 'Previewing a version' })).toContainText(
    'Before the rename',
  )
  expect(
    await page.evaluate(() =>
      (window as unknown as { __barenEditor: Hook }).__barenEditor.canvas.isReadOnly(),
    ),
  ).toBe(true)
  await expect(page.getByRole('complementary', { name: 'Layers and pages' })).toHaveAttribute(
    'inert',
    '',
  )
  expect(await nameOf()).toBe('Renamed board')
  await shot(page, testInfo, 'history-preview')

  // Escape goes back to the live file.
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      (window as unknown as { __barenEditor: Hook }).__barenEditor.canvas.isReadOnly(),
    ),
  ).toBe(false)

  // Preview again and restore from the banner.
  await panel.getByTitle('Preview “Before the rename”').click()
  await preview.getByRole('button', { name: 'Restore this version' }).click()
  const dialog = page.getByRole('dialog', { name: 'Restore this version?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Restore' }).click()
  await expect(preview).toHaveCount(0)
  expect(await nameOf()).toBe(board.name)
  expect(await versionNames(page)).toContain('Before restoring “Before the rename”')
  const toast = page.getByText('Restored “Before the rename”')
  await expect(toast).toBeVisible()
  await shot(page, testInfo, 'history-restored')

  // Undo from the toast brings the edit back; the versions stay.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(nameOf).toBe('Renamed board')
  expect(await versionNames(page)).toContain('Before the rename')
})
