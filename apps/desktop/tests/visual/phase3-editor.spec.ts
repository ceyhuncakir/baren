/**
 * Phase 3 editor behaviour (docs/phase3/contract.md §10.3) in browser mode (mock bridge):
 * groups, rotation, components (create, insert from the picker and the panel, overrides,
 * reset, go to main, detach, cycles, deleted mains) and the clipboard — within a file, across
 * files, paste in place, cut, duplicate, plain text, SVG markup, legacy JSON and across two
 * windows (pages) of one browser.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const EMPTY_FILE = '/?fixture=design#/file/f-baren'
const LIBRARY_FILE = '/?fixture=design#/file/f-acme'
const IMAGE_FILE = '/?fixture=design&editorScene=image#/file/f-acme'
const COMPONENTS_FILE = '/?fixture=design&editorScene=components#/file/f-acme'
const PEN_FILE = '/?fixture=design&editorScene=pen#/file/f-acme'
const ROTATION_FILE = '/?fixture=design&editorScene=rotation#/file/f-acme'

interface Node {
  id: string
  type: string
  name: string
  parentId: string | null
  children: string[]
  styles: Record<string, string | number>
  text?: string
  componentKey?: string
  assetId?: string
  hidden?: boolean
}

interface CanvasStatsLike {
  pendingWork: number
}

async function openEditor(page: Page, url: string) {
  await page.goto(url)
  await page.getByTestId('editor').waitFor()
  await page.waitForFunction(() => {
    const hook = (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor
    return hook?.canvas != null
  })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await idle(page)
}

async function idle(page: Page) {
  await page.waitForFunction(() => {
    const hook = (
      window as unknown as { __barenEditor: { canvas: { getStats(): CanvasStatsLike } } }
    ).__barenEditor
    return hook.canvas.getStats().pendingWork === 0
  })
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

/** Run `fn` in the page with the editor test hook (session, canvas, schema). */
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

/* The page-side hook, loosely typed for test code. */
interface Hook {
  session: {
    doc: unknown
    store: {
      getState(): { pageId: string; selection: readonly string[] }
      setState(s: Record<string, unknown>): void
    }
    tree: {
      pages(): readonly string[]
      children(id: string): readonly string[]
      meta(id: string): { name: string; kind: string; virtual: boolean } | null
    }
    resolver: { resolveNode(id: string): Node | undefined }
    actions: { geometry(): unknown }
  }
  canvas: {
    select(ids: string[]): void
    getSelection(): string[]
    getNodeBounds(id: string): { x: number; y: number; width: number; height: number } | null
    canvasToScreen(p: { x: number; y: number }): { x: number; y: number }
    getViewport(): { x: number; y: number; zoom: number }
    setViewport(v: { x: number; y: number; zoom: number }, o?: { animate?: boolean }): void
  }
  snapshot(): { nodes: Record<string, Node> }
  tokens(): Record<string, { value: string }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any
}

/** Find a node by its name path from the current page (virtual rows included). */
async function idByPath(page: Page, path: string[]): Promise<string> {
  return inPage(
    page,
    (hook, names) => {
      const { tree, store } = hook.session
      let id = store.getState().pageId
      for (const name of names) {
        const next = tree.children(id).find((c) => tree.meta(c)?.name === name)
        if (!next) throw new Error(`no layer ${name}`)
        id = next
      }
      return id
    },
    path,
  )
}

async function select(page: Page, ids: string[]) {
  await inPage(page, (hook, list) => hook.canvas.select(list), ids)
}

async function node(page: Page, id: string): Promise<Node | undefined> {
  return inPage(page, (hook, ref) => hook.session.resolver.resolveNode(ref), id)
}

async function nodes(page: Page): Promise<Node[]> {
  return inPage(page, (hook) => Object.values(hook.snapshot().nodes), null)
}

async function pageNames(page: Page): Promise<string[]> {
  return inPage(
    page,
    (hook) => hook.session.tree.pages().map((p) => hook.session.tree.meta(p)?.name ?? ''),
    null,
  )
}

function layerRow(page: Page, name: string) {
  return page.getByRole('treeitem').filter({ has: page.getByText(name, { exact: true }) })
}

/** An artboard with two rectangles on the empty file's page, created through the schema. */
async function seedBoard(page: Page): Promise<{ board: string; a: string; b: string }> {
  return inPage(
    page,
    (hook) => {
      const { schema, session } = hook
      const doc = session.doc
      const pageId = session.store.getState().pageId
      const board = schema.createNode(doc, {
        type: 'frame',
        parentId: pageId,
        name: 'Board',
        styles: { left: 0, top: 0, width: 600, height: 400, backgroundColor: '#FFFFFF' },
      })
      const a = schema.createNode(doc, {
        type: 'rect',
        parentId: board,
        name: 'Red',
        styles: {
          position: 'absolute',
          left: 40,
          top: 40,
          width: 120,
          height: 80,
          backgroundColor: '#FF3B30',
        },
      })
      const b = schema.createNode(doc, {
        type: 'rect',
        parentId: board,
        name: 'Blue',
        styles: {
          position: 'absolute',
          left: 240,
          top: 160,
          width: 100,
          height: 100,
          backgroundColor: '#007AFF',
        },
      })
      hook.canvas.setViewport({ x: -100, y: -100, zoom: 1 }, { animate: false })
      return { board, a, b }
    },
    null,
  )
}

/** Focus the canvas so shortcuts reach the editor (not a text field). */
async function focusCanvas(page: Page) {
  await page
    .locator('.ic-root')
    .first()
    .focus()
    .catch(() => undefined)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

async function grantClipboard(context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
}

// ---------------------------------------------------------------------------
// Groups and rotation
// ---------------------------------------------------------------------------

test.describe('groups and rotation', () => {
  test('Ctrl+G groups (one undo step), the layers show the group, Ctrl+Shift+G ungroups', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const { board, a, b } = await seedBoard(page)
    await idle(page)
    await select(page, [a, b])
    await focusCanvas(page)
    await page.keyboard.press('Control+g')
    const group = (await inPage(page, (hook) => hook.canvas.getSelection(), null))[0] as string
    expect((await node(page, group))?.type).toBe('group')
    expect((await node(page, board))?.children).toEqual([group])
    expect((await node(page, group))?.children).toEqual([a, b])
    // The layer row uses the group icon (dashed square) and lists the children.
    await expect(layerRow(page, 'Group')).toBeVisible()
    await layerRow(page, 'Group').getByRole('button', { name: 'Expand' }).click()
    await expect(layerRow(page, 'Red')).toBeVisible()
    // Undo through Edit → Undo restores both rectangles in one step.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(2)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(1)
    const regrouped = (await node(page, board))?.children[0] as string
    await select(page, [regrouped])
    await focusCanvas(page)
    await page.keyboard.press('Control+Shift+g')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(2)
    const red = (await nodes(page)).find((n) => n.name === 'Red')
    expect(red?.styles).toMatchObject({ left: 40, top: 40 })
  })

  test('inspector edits inside a group refit the group box in the same step', async ({ page }) => {
    await openEditor(page, EMPTY_FILE)
    const { a, b } = await seedBoard(page)
    await select(page, [a, b])
    await focusCanvas(page)
    await page.keyboard.press('Control+g')
    const group = (await node(page, a))?.parentId as string
    expect((await node(page, group))?.styles).toMatchObject({ left: 40, top: 40, width: 300 })
    await select(page, [b])
    const w = page.getByRole('textbox', { name: 'Width' })
    await w.fill('300')
    await w.press('Enter')
    // B grew to the right: the group box follows.
    await expect.poll(async () => (await node(page, group))?.styles['width']).toBe(500)
    await focusCanvas(page)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await node(page, group))?.styles['width']).toBe(300)
  })

  test('the rotation field rotates one or several layers (setRotation, one step each)', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const { a, b } = await seedBoard(page)
    await select(page, [a])
    const field = page.getByRole('textbox', { name: 'Rotation' })
    await field.fill('30')
    await field.press('Enter')
    expect((await node(page, a))?.styles['rotate']).toBe('30deg')
    await select(page, [a, b])
    await field.fill('-45')
    await field.press('Enter')
    expect((await node(page, a))?.styles['rotate']).toBe('-45deg')
    expect((await node(page, b))?.styles['rotate']).toBe('-45deg')
    // Rotate 90° from the Layout menu adds to each layer's own rotation.
    await page.getByRole('button', { name: /^Layout/ }).click()
    await page.getByRole('menuitem', { name: 'Rotate 90°' }).click()
    expect((await node(page, b))?.styles['rotate']).toBe('45deg')
  })
})

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

test.describe('components', () => {
  test('create with Ctrl+Alt+K and the context menu; the Components section lists them', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const { board, a } = await seedBoard(page)
    await select(page, [board])
    await focusCanvas(page)
    await page.keyboard.press('Control+Alt+k')
    await expect(page.getByRole('list').getByRole('listitem', { name: /^Board/ })).toBeVisible()
    expect((await node(page, board))?.componentKey).toMatch(/^[0-9a-z]{16}$/)
    // The layer tree now has a "Layers" header row.
    await expect(page.getByRole('button', { name: 'Layers', exact: true })).toBeVisible()

    await select(page, [a])
    const box = await inPage(page, (hook, id) => hook.canvas.getNodeBounds(id), a)
    const screen = await inPage(page, (hook, p) => hook.canvas.canvasToScreen(p), {
      x: (box?.x ?? 0) + 10,
      y: (box?.y ?? 0) + 10,
    })
    const canvasBox = await page.locator('.ic-root').first().boundingBox()
    await page.mouse.click((canvasBox?.x ?? 0) + screen.x, (canvasBox?.y ?? 0) + screen.y, {
      button: 'right',
    })
    await page.getByRole('menuitem', { name: /^Create component/ }).click()
    expect((await node(page, a))?.componentKey).toBeUndefined()
    const wrapped = (await node(page, a))?.parentId as string
    expect((await node(page, wrapped))?.componentKey).toMatch(/^[0-9a-z]{16}$/)
  })

  test('insert instances from the picker (click) and the Components panel (drag)', async ({
    page,
  }) => {
    await openEditor(page, COMPONENTS_FILE)
    const before = (await nodes(page)).filter((n) => n.type === 'instance').length
    await select(page, [await idByPath(page, ['Pricing — Desktop'])])
    await page.keyboard.press('k')
    const picker = page.getByRole('dialog', { name: 'Components' })
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Insert Badge / New' }).click()
    await expect(picker).toBeHidden()
    await expect
      .poll(async () => (await nodes(page)).filter((n) => n.type === 'instance').length)
      .toBe(before + 1)
    const selected = (await inPage(page, (hook) => hook.canvas.getSelection(), null))[0] as string
    const inserted = await node(page, selected)
    expect(inserted?.type).toBe('instance')
    // Inside the selected artboard, following the main's size.
    expect(inserted?.parentId).toBe(await idByPath(page, ['Pricing — Desktop']))

    // Drag "Card / Plan" from the Components section onto the empty canvas.
    const row = page.getByRole('listitem', { name: /^Card \/ Plan/ })
    await row.dragTo(page.locator('.ic-root').first(), { targetPosition: { x: 650, y: 650 } })
    await expect
      .poll(async () => (await nodes(page)).filter((n) => n.type === 'instance').length)
      .toBe(before + 2)
  })

  test('overrides on instance content, reset, detach and go to main', async ({ page }) => {
    await openEditor(page, COMPONENTS_FILE)
    const button = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team', 'Button / Primary'])
    await select(page, [button])
    await expect(page.getByText('2 overrides')).toBeVisible()
    await expect(page.getByText('Text, Fill')).toBeVisible()
    // Edit the fill: still an override, now of a different colour.
    const hex = page.getByRole('textbox', { name: 'Hex color' }).first()
    await hex.fill('AA2200')
    await hex.press('Enter')
    expect((await node(page, button))?.styles['backgroundColor']).toBe('#AA2200')
    // Hide it from the layers panel: a hidden override, the instance keeps its structure.
    const row = layerRow(page, 'Button / Primary').last()
    await row.hover()
    await row.getByRole('button', { name: 'Hide' }).click()
    expect((await node(page, button))?.hidden).toBe(true)
    await expect(page.getByText('3 overrides')).toBeVisible()
    // Reset brings the main's look back for this node and below.
    await page.getByRole('button', { name: 'Reset overrides' }).click()
    await expect(page.getByText('No overrides')).toBeVisible()
    expect((await node(page, button))?.styles['backgroundColor']).toBe('#14213D')
    expect((await node(page, button))?.hidden).toBeFalsy()

    // Detach the Starter instance (Ctrl+Alt+B): same id, now a frame with real children.
    const starter = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Starter'])
    await select(page, [starter])
    await focusCanvas(page)
    await page.keyboard.press('Control+Alt+b')
    await expect.poll(async () => (await node(page, starter))?.type).toBe('frame')
    expect((await node(page, starter))?.children.length).toBeGreaterThan(0)

    // Go to main component switches to the page of "Card / Plan" and selects it.
    const team = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])
    await select(page, [team])
    await page.getByRole('button', { name: 'Go to main component' }).click()
    await expect
      .poll(async () => inPage(page, (hook) => hook.session.store.getState().pageId, null))
      .not.toBe(await inPage(page, (hook) => hook.session.tree.pages()[0], null))
    await expect
      .poll(async () => {
        const id = (await inPage(page, (hook) => hook.canvas.getSelection(), null))[0]
        return id ? (await node(page, id))?.name : null
      })
      .toBe('Card / Plan')
  })

  test('typing into instance text writes a text override; the main edit still propagates', async ({
    page,
  }) => {
    await openEditor(page, COMPONENTS_FILE)
    const label = await inPage(
      page,
      (hook, path) => {
        const { tree, store } = hook.session
        let id = store.getState().pageId
        for (const name of path) {
          id = tree.children(id).find((c) => tree.meta(c)?.name === name) as string
        }
        // The button's only child is its label.
        return tree.children(id)[0] as string
      },
      ['Pricing — Desktop', 'Plans', 'Starter', 'Button / Primary'],
    )
    await inPage(
      page,
      (hook, id) => (hook.canvas as unknown as { editText(i: string): void }).editText(id),
      label,
    )
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Try it')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await node(page, label))?.text).toBe('Try it')
    // The main's label is untouched; editing the main's colour reaches the instance.
    const main = await idByPath(page, ['Button / Primary'])
    const mainLabel = (await node(page, main))?.children[0] as string
    expect((await node(page, mainLabel))?.text).toBe('Get started')
    await select(page, [mainLabel])
    const hex = page.getByRole('textbox', { name: 'Hex color' }).first()
    await hex.fill('FFDD00')
    await hex.press('Enter')
    await expect.poll(async () => (await node(page, label))?.styles['color']).toBe('#14213D') // Starter overrides the colour: the override wins…
    const teamLabel = await inPage(
      page,
      (hook, path) => {
        const { tree, store } = hook.session
        let id = store.getState().pageId
        for (const name of path) {
          id = tree.children(id).find((c) => tree.meta(c)?.name === name) as string
        }
        return tree.children(id)[0] as string
      },
      ['Button / Primary'],
    )
    expect((await node(page, teamLabel))?.styles['color']).toBe('#FFDD00') // …the main shows it
  })

  test('Copy as PNG renders instances, Copy as SVG writes vector markup', async ({
    page,
    context,
  }) => {
    await grantClipboard(context)
    await openEditor(page, COMPONENTS_FILE)
    const team = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])
    await select(page, [team])
    const box = await inPage(page, (hook, id) => hook.canvas.getNodeBounds(id), team)
    const at = await inPage(page, (hook, p) => hook.canvas.canvasToScreen(p), {
      x: (box?.x ?? 0) + 20,
      y: (box?.y ?? 0) + 20,
    })
    const canvasBox = await page.locator('.ic-root').first().boundingBox()
    const openCopyAs = async () => {
      await page.mouse.click((canvasBox?.x ?? 0) + at.x, (canvasBox?.y ?? 0) + at.y, {
        button: 'right',
      })
      await page.getByRole('menuitem', { name: 'Copy as' }).hover()
    }
    await openCopyAs()
    await page.getByRole('menuitem', { name: /^PNG\s*1×/ }).click()
    await expect(page.getByText('PNG 1× copied')).toBeVisible()
    const size = await page.evaluate(async () => {
      const items = await navigator.clipboard.read()
      const item = items.find((i) => i.types.includes('image/png'))
      if (!item) return null
      const bitmap = await createImageBitmap(await item.getType('image/png'))
      return [bitmap.width, bitmap.height]
    })
    expect(size).toEqual([252, 280])

    await page.goto(PEN_FILE)
    await page.getByTestId('editor').waitFor()
    await idle(page)
    await select(page, [await idByPath(page, ['Logo — Mark', 'Peak'])])
    await page.getByRole('heading', { name: 'Stroke' }).waitFor()
    const peakBox = await page.locator('.ic-root').first().boundingBox()
    await page.mouse.click((peakBox?.x ?? 0) + 450, (peakBox?.y ?? 0) + 520, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy as' }).hover()
    await page.getByRole('menuitem', { name: 'SVG', exact: true }).click()
    await expect(page.getByText('SVG copied')).toBeVisible()
    const svg = await page.evaluate(() => navigator.clipboard.readText())
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="170" height="135"')
    expect(svg).toContain('<path d="M 0 135 L 57.5 37.5 C')
    expect(svg).toContain('stroke="#14213D"')
  })

  test('a rotated group renders upright-correct in Copy as PNG', async ({ page, context }) => {
    await grantClipboard(context)
    await openEditor(page, ROTATION_FILE)
    const group = await idByPath(page, ['Landing — Desktop', 'Hero', 'Launch sticker'])
    await select(page, [group])
    await page.evaluate(() => {
      const { session } = (window as unknown as { __barenEditor: Hook }).__barenEditor
      session.store.setState({ contextMenu: { x: 700, y: 500, source: 'layers', world: null } })
    })
    await page.getByRole('menuitem', { name: 'Copy as' }).hover()
    await page.getByRole('menuitem', { name: /^PNG\s*1×/ }).click()
    await expect(page.getByText('PNG 1× copied')).toBeVisible()
    // The sticker's yellow fills the middle of the image, the corners stay transparent.
    const samples = await page.evaluate(async () => {
      const items = await navigator.clipboard.read()
      const item = items.find((i) => i.types.includes('image/png'))
      if (!item) return null
      const bitmap = await createImageBitmap(await item.getType('image/png'))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      g.drawImage(bitmap, 0, 0)
      const at = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data)
      return {
        size: [bitmap.width, bitmap.height],
        centre: at(Math.round(bitmap.width / 2), Math.round(bitmap.height / 4)),
        corner: at(1, 1),
      }
    })
    expect(samples?.size).toEqual([324, 191])
    expect(samples?.centre.slice(0, 3)).toEqual([255, 200, 87])
    expect(samples?.corner[3]).toBe(0)
  })

  test('a deleted main keeps its instances rendering; Restore re-creates it', async ({ page }) => {
    await openEditor(page, COMPONENTS_FILE)
    const team = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])
    const main = await inPage(
      page,
      (hook, id) => {
        const n = hook.session.resolver.resolveNode(id) as Node & { mainId?: string }
        return n.mainId as string
      },
      team,
    )
    await inPage(page, (hook, id) => hook.schema.deleteNode(hook.session.doc, id), main)
    await idle(page)
    await expect(page.locator('.ic-root').getByText('Start free trial')).toBeVisible()
    await select(page, [team])
    await expect(page.getByText('Main component deleted')).toBeVisible()
    await page.getByRole('button', { name: 'Restore' }).click()
    await expect.poll(async () => pageNames(page)).toContain('Components')
  })

  test('pasting a component inside itself is refused with a message', async ({ page, context }) => {
    await grantClipboard(context)
    await openEditor(page, COMPONENTS_FILE)
    await select(page, [await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])])
    await page.keyboard.press('Control+c')
    await page.getByRole('button', { name: 'Go to main component' }).click()
    await expect
      .poll(async () => {
        const id = (await inPage(page, (hook) => hook.canvas.getSelection(), null))[0]
        return id ? (await node(page, id))?.name : null
      })
      .toBe('Card / Plan')
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect(page.getByText("Can't paste a component inside itself")).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

test.describe('clipboard', () => {
  test.beforeEach(async ({ context }) => grantClipboard(context))

  test('copy writes the custom format, text/html and text/plain; paste offsets by 24', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const { board, a } = await seedBoard(page)
    await select(page, [a])
    await focusCanvas(page)
    await page.keyboard.press('Control+c')
    const readAll = () =>
      page.evaluate(async () => {
        const items = await navigator.clipboard.read()
        const out: Record<string, string> = {}
        for (const item of items)
          for (const t of item.types) out[t] = await (await item.getType(t)).text()
        return out
      })
    // The copy is asynchronous (payload, asset bytes, HTML): wait until it has landed.
    await expect.poll(async () => (await readAll())['text/plain']).toBe('Red')
    const types = await readAll()
    expect(types['text/plain']).toBe('Red')
    expect(types['text/html']).toContain('background-color: #FF3B30')
    expect(types['web application/x-baren-clipboard+json']).toContain('"baren/clipboard"')
    await select(page, [board])
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(3)
    const copy = (await nodes(page)).filter((n) => n.name === 'Red').find((n) => n.id !== a)
    expect(copy?.styles).toMatchObject({ left: 64, top: 64 })
    // Paste in place: the exact copied position.
    await select(page, [board])
    await page.keyboard.press('Control+Shift+v')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(4)
    const inPlace = (await nodes(page)).filter((n) => n.name === 'Red' && n.styles['left'] === 40)
    expect(inPlace).toHaveLength(2)
  })

  test('"Paste here" puts the copy at the clicked point, inside the frame under it', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const { board, a } = await seedBoard(page)
    await select(page, [a])
    await focusCanvas(page)
    await page.keyboard.press('Control+c')
    await expect
      .poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).length))
      .toBeGreaterThan(0)
    // World (400, 300) is inside the artboard (0, 0, 600 × 400).
    const at = await inPage(page, (hook) => hook.canvas.canvasToScreen({ x: 400, y: 300 }), null)
    const canvasBox = await page.locator('.ic-root').first().boundingBox()
    await page.mouse.click((canvasBox?.x ?? 0) + at.x, (canvasBox?.y ?? 0) + at.y, {
      button: 'right',
    })
    await page.getByRole('menuitem', { name: /^Paste here/ }).click()
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(3)
    const pasted = (await nodes(page)).filter((n) => n.name === 'Red').find((n) => n.id !== a)
    expect(pasted?.parentId).toBe(board)
    expect(pasted?.styles).toMatchObject({ position: 'absolute', left: 400, top: 300 })
  })

  test('cut, duplicate, plain text, SVG markup and legacy JSON', async ({ page }) => {
    await openEditor(page, EMPTY_FILE)
    const { board, b } = await seedBoard(page)
    await select(page, [b])
    await focusCanvas(page)
    await page.keyboard.press('Control+x')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(1)
    await select(page, [board])
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(2)
    await page.keyboard.press('Control+d')
    await expect.poll(async () => (await node(page, board))?.children.length).toBe(3)

    await page.evaluate(() => navigator.clipboard.writeText('Hello from another app'))
    await select(page, [])
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await nodes(page)).find((n) => n.type === 'text')?.text)
      .toBe('Hello from another app')
    await page.evaluate(() =>
      navigator.clipboard.writeText(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" onload="alert(1)"><circle cx="12" cy="12" r="10" fill="#00f"/></svg>',
      ),
    )
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await nodes(page)).filter((n) => n.type === 'svg').length)
      .toBe(1)
    await page.evaluate(() =>
      navigator.clipboard.writeText(
        JSON.stringify({
          kind: 'baren/nodes',
          version: 1,
          nodes: [
            {
              type: 'rect',
              name: 'Legacy',
              styles: { left: 700, top: 0, width: 50, height: 50 },
              children: [],
            },
          ],
        }),
      ),
    )
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await nodes(page)).some((n) => n.name === 'Legacy')).toBe(true)
  })

  test('across files: tokens are added, the Components page is created, images travel', async ({
    page,
  }) => {
    // 1. A text layer bound to library tokens.
    await openEditor(page, LIBRARY_FILE)
    const forms = await idByPath(page, ['03 Forms'])
    const title = await inPage(
      page,
      (hook, id) => {
        const { tree } = hook.session
        const header = tree.children(id).find((c) => tree.meta(c)?.name === 'Header') as string
        return tree.children(header).find((c) => tree.meta(c)?.name === 'Title') as string
      },
      forms,
    )
    await select(page, [title])
    await focusCanvas(page)
    await page.keyboard.press('Control+c')
    await page.goto(EMPTY_FILE)
    await page.getByTestId('editor').waitFor()
    await page.waitForFunction(() => {
      const hook = (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor
      return hook?.canvas != null
    })
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => Object.keys(await inPage(page, (hook) => hook.tokens(), null)).length)
      .toBeGreaterThan(0)

    // 2. An instance: its main is created on a "Components" page in the target file.
    await page.goto(COMPONENTS_FILE)
    await page.getByTestId('editor').waitFor()
    await idle(page)
    await select(page, [await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])])
    await focusCanvas(page)
    await page.keyboard.press('Control+c')
    await page.goto(EMPTY_FILE)
    await page.getByTestId('editor').waitFor()
    await idle(page)
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect.poll(async () => pageNames(page)).toContain('Components')
    await expect(page.locator('.ic-root').getByText('Start free trial')).toBeVisible()

    // 3. An image fill: the bytes ride along and render in the other file.
    await page.goto(IMAGE_FILE)
    await page.getByTestId('editor').waitFor()
    await idle(page)
    await select(page, [await idByPath(page, ['Landing — Desktop', 'Hero', 'Hero image'])])
    await focusCanvas(page)
    await page.keyboard.press('Control+c')
    await page.goto(EMPTY_FILE)
    await page.getByTestId('editor').waitFor()
    await idle(page)
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await nodes(page)).some((n) => n.name === 'Hero image'))
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.ic-node')).some((el) =>
            el.style.backgroundImage.includes('blob:'),
          ),
        ),
      )
      .toBe(true)
  })

  test('across windows: copy in one page, paste in another of the same browser', async ({
    context,
  }) => {
    const one = await context.newPage()
    const two = await context.newPage()
    await openEditor(one, EMPTY_FILE)
    const { a } = await seedBoard(one)
    await openEditor(two, EMPTY_FILE)
    await one.bringToFront()
    await select(one, [a])
    await focusCanvas(one)
    await one.keyboard.press('Control+c')
    await two.bringToFront()
    await focusCanvas(two)
    await two.keyboard.press('Control+v')
    await expect.poll(async () => (await nodes(two)).some((n) => n.name === 'Red')).toBe(true)
  })
})
