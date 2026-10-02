import { expect, test } from '@playwright/test'

/** Behavior checks for the floating layers and keyboard models (playground "Shell"/"Forms"). */

test('menu bar: open, hover-switch, keyboard navigation, escape', async ({ page }) => {
  await page.goto('/#/shell')
  const bar = page.getByRole('menubar').first()
  const file = bar.getByRole('menuitem', { name: 'File' })
  const edit = bar.getByRole('menuitem', { name: 'Edit' })

  await file.click()
  const fileMenu = page.getByRole('menu', { name: 'File' })
  await expect(fileMenu).toBeVisible()
  // Placement: 8px under the title (title bar bottom + 2), left-aligned.
  const fb = await file.boundingBox()
  const mb = await fileMenu.boundingBox()
  expect(Math.round(mb!.x)).toBe(Math.round(fb!.x))
  expect(Math.round(mb!.y)).toBe(Math.round(fb!.y + fb!.height + 8))

  await edit.hover()
  const editMenu = page.getByRole('menu', { name: 'Edit' })
  await expect(editMenu).toBeVisible()
  await expect(fileMenu).toBeHidden()

  // ArrowDown skips the disabled "Redo".
  await page.keyboard.press('ArrowDown')
  await expect(editMenu.getByRole('menuitem', { name: /^Undo/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(editMenu.getByRole('menuitem', { name: /^Cut/ })).toBeFocused()

  // ArrowRight moves to the View menu.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menu', { name: 'View' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'View' })).toBeHidden()
  await expect(bar.getByRole('menuitem', { name: 'View' })).toBeFocused()
})

test('context menu opens at the cursor, submenu opens on hover, selection closes', async ({
  page,
}) => {
  await page.goto('/#/shell')
  const target = page.getByTestId('context-target')
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const tb = await target.boundingBox()
  await target.click({ button: 'right', position: { x: 20, y: 20 } })
  const floating = page.locator('[data-floating-layer]')
  const menu = floating.getByRole('menu').filter({ hasText: 'Paste here' })
  await expect(menu).toBeVisible()
  const mb = await menu.boundingBox()
  expect(Math.round(mb!.x)).toBe(Math.round(tb!.x + 20))
  expect(Math.round(mb!.y)).toBe(Math.round(tb!.y + 20))

  await menu.getByRole('menuitem', { name: 'Copy as' }).hover()
  const sub = floating.getByRole('menu').filter({ hasText: 'React (JSX)' })
  await expect(sub).toBeVisible()
  const sb = await sub.boundingBox()
  // 4px overlap with the parent menu.
  expect(Math.round(sb!.x)).toBe(Math.round(mb!.x + mb!.width - 4))

  await sub.getByRole('menuitem', { name: /^CSS/ }).click()
  await expect(menu).toBeHidden()
  await expect(sub).toBeHidden()
})

test('outside click and Escape close the share popover', async ({ page }) => {
  await page.goto('/#/shell')
  const share = page.getByRole('button', { name: 'Share' }).first()
  await share.click()
  const dialog = page.getByRole('dialog', { name: 'Share baren' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(share).toBeFocused()
  await share.click()
  await expect(dialog).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(dialog).toBeHidden()
})

test('select picks an option with the keyboard', async ({ page }) => {
  await page.goto('/#/forms')
  const trigger = page.getByRole('button', { name: /Anyone with the link/ }).last()
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu').filter({ hasText: 'Only team members' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(page.getByRole('button', { name: /Only team members/ })).toBeVisible()
})

test('switch toggles with the pointer and the keyboard (role=switch)', async ({ page }) => {
  await page.goto('/#/forms')
  const toggle = page.getByRole('switch', { name: 'MCP server' })
  const before = await toggle.getAttribute('aria-checked')
  const flip = (v: string | null) => (v === 'true' ? 'false' : 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', flip(before))
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-checked', before ?? 'false')
  await expect(page.getByRole('switch', { name: 'Disabled' })).toBeDisabled()
})

test('number field scrubs, nudges and parses math', async ({ page }) => {
  await page.goto('/#/editor')
  const input = page.getByRole('textbox', { name: 'Width' }).last()
  await expect(input).toHaveValue('96')
  await input.click()
  await page.keyboard.press('ArrowUp')
  await expect(input).toHaveValue('97')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(input).toHaveValue('87')
  await input.fill('96/2')
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('48')
  await expect(page.getByTestId('number-log')).toHaveText('48 · commit')

  // Drag the "W" label 40px right: +20 (2px per step).
  const label = input.locator('xpath=preceding-sibling::span[1]')
  const lb = await label.boundingBox()
  await page.mouse.move(lb!.x + lb!.width / 2, lb!.y + lb!.height / 2)
  await page.mouse.down()
  await page.mouse.move(lb!.x + lb!.width / 2 + 40, lb!.y + lb!.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(input).toHaveValue('68')
  await expect(page.getByTestId('number-log')).toHaveText('68 · commit')
})

test('layer row: select on press, rename on double-click', async ({ page }) => {
  await page.goto('/#/editor')
  const tree = page.getByRole('tree', { name: 'Layers' }).first()
  const header = tree.getByRole('treeitem', { name: /Header/ })
  await header.click()
  await expect(header).toHaveAttribute('aria-selected', 'true')
  await header.dblclick({ position: { x: 120, y: 14 } })
  const rename = tree.getByRole('textbox', { name: 'Layer name' })
  await expect(rename).toBeFocused()
  await rename.fill('Top bar')
  await page.keyboard.press('Enter')
  await expect(tree.getByRole('treeitem', { name: /Top bar/ })).toBeVisible()
})
