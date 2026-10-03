/**
 * Editor visual tests (artboards 04, 05, 06, 07, 08, 14, 15, 16, 24, 29–33) at 1440×900 against the
 * reference PNGs in design/reference. Each test opens a design-fixture file
 * (`?fixture=design`, mock bridge), drives the UI to the artboard's state, and reports
 * the share of pixels that differ (any channel off by more than 24/255).
 *
 * The budgets are regression guards, not pixel-perfect assertions: the references' mock canvas
 * content and labels are not internally consistent (e.g. "12%" over 112px-wide 1440px
 * artboards), so a faithful editor cannot reach 0%. Per-screen numbers are printed and
 * attached (actual, reference and diff images) for review.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { recordCopies } from './copies'
import { readReference } from './references'

const REFERENCE_DIR = resolve(__dirname, '../../../../design/reference')
const COMPONENT_LIBRARY = '/?fixture=design#/file/f-acme'
const EMPTY_FILE = '/?fixture=design#/file/f-baren'
const THEME_FILE = '/?fixture=design&editorScene=theme#/file/f-baren'
const IMAGE_FILE = '/?fixture=design&editorScene=image#/file/f-acme'
// Phase 3 scenes (editor/fixtures/phase3.ts).
const ROTATION_FILE = '/?fixture=design&editorScene=rotation#/file/f-acme'
const PEN_FILE = '/?fixture=design&editorScene=pen#/file/f-acme'
const COMPONENTS_FILE = '/?fixture=design&editorScene=components#/file/f-acme'
const PICKER_FILE = '/?fixture=design&editorScene=picker#/file/f-acme'
const DROP_FILE = '/?fixture=design&editorScene=drop#/file/f-acme'

/** Allowed share of differing pixels per artboard (measured + headroom). */
const BUDGET: Record<string, number> = {
  '04': 0.015,
  '05': 0.035,
  '06': 0.04,
  '07': 0.025,
  '08': 0.035,
  '14': 0.035,
  '15': 0.04,
  '16': 0.015,
  '24': 0.025,
  '29': 0.03,
  '30': 0.03,
  '31': 0.03,
  '32': 0.03,
  '33': 0.03,
}

const REFERENCES: Record<string, string> = {
  '04': '04-editor-empty-file.png',
  '05': '05-editor-canvas-overview.png',
  '06': '06-editor-selection-inspector.png',
  '07': '07-editor-theme-tokens.png',
  '08': '08-editor-share-popover.png',
  '14': '14-editor-layers-expanded.png',
  '15': '15-editor-context-menu.png',
  '16': '16-editor-zoom-menu.png',
  '24': '24-editor-image-fill.png',
  '29': '29-editor-rotation-groups.png',
  '30': '30-editor-pen-tool.png',
  '31': '31-editor-components.png',
  '32': '32-editor-component-picker.png',
  '33': '33-editor-drop-into-frame.png',
}

interface CanvasStatsLike {
  pendingWork: number
  thumbnails: number
  lod: boolean
  mountedArtboards: number
}

/** Open a fixture file and wait until the canvas has painted everything it will paint. */
async function openEditor(page: Page, url: string, opts: { thumbnails?: number } = {}) {
  await page.goto(url)
  await page.getByTestId('editor').waitFor()
  await page.waitForFunction(() => {
    const hook = (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor
    return hook?.canvas != null
  })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const want = opts.thumbnails ?? 0
  await page.waitForFunction(
    (n) => {
      const hook = (
        window as unknown as { __barenEditor: { canvas: { getStats(): CanvasStatsLike } } }
      ).__barenEditor
      const s = hook.canvas.getStats()
      return s.pendingWork === 0 && (!s.lod || s.thumbnails >= n)
    },
    want,
    { timeout: 15_000 },
  )
  // Park the pointer where it highlights nothing (bottom of the left panel).
  await page.mouse.move(120, 780)
  await settle(page)
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))),
      ),
  )
}

interface DiffResult {
  ratio: number
  diff: Buffer
}

/** Decode both PNGs in a scratch page and count differing pixels (max channel delta > 24). */
async function compare(
  context: BrowserContext,
  actual: Buffer,
  reference: Buffer,
): Promise<DiffResult> {
  const scratch = await context.newPage()
  try {
    const out = await scratch.evaluate(
      async ({ a, b }) => {
        const load = async (b64: string) => {
          const img = new Image()
          img.src = `data:image/png;base64,${b64}`
          await img.decode()
          return img
        }
        const [ia, ib] = await Promise.all([load(a), load(b)])
        const w = Math.min(ia.width, ib.width)
        const h = Math.min(ia.height, ib.height)
        const read = (img: HTMLImageElement) => {
          const c = new OffscreenCanvas(w, h)
          const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
          ctx.drawImage(img, 0, 0)
          return ctx.getImageData(0, 0, w, h).data
        }
        const pa = read(ia)
        const pb = read(ib)
        const diff = new OffscreenCanvas(w, h)
        const dctx = diff.getContext('2d') as OffscreenCanvasRenderingContext2D
        const img = dctx.createImageData(w, h)
        let count = 0
        for (let i = 0; i < pa.length; i += 4) {
          const d = Math.max(
            Math.abs((pa[i] ?? 0) - (pb[i] ?? 0)),
            Math.abs((pa[i + 1] ?? 0) - (pb[i + 1] ?? 0)),
            Math.abs((pa[i + 2] ?? 0) - (pb[i + 2] ?? 0)),
          )
          if (d > 24) {
            count++
            img.data[i] = 255
            img.data[i + 1] = 0
            img.data[i + 2] = 0
            img.data[i + 3] = 255
          } else {
            const g = 255 - Math.round((255 - (pb[i] ?? 0)) * 0.25)
            img.data[i] = g
            img.data[i + 1] = g
            img.data[i + 2] = g
            img.data[i + 3] = 255
          }
        }
        dctx.putImageData(img, 0, 0)
        const blob = await diff.convertToBlob({ type: 'image/png' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        return { ratio: count / (w * h), diff: btoa(bin) }
      },
      { a: actual.toString('base64'), b: reference.toString('base64') },
    )
    return { ratio: out.ratio, diff: Buffer.from(out.diff, 'base64') }
  } finally {
    await scratch.close()
  }
}

async function check(page: Page, key: string, testInfo: TestInfo) {
  await settle(page)
  const actual = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const reference = readReference(resolve(REFERENCE_DIR, REFERENCES[key] as string), actual)
  const { ratio, diff } = await compare(page.context(), actual, reference)
  const pct = (ratio * 100).toFixed(2)
  console.log(
    `[editor visual] ${key}: ${pct}% of pixels differ (budget ${((BUDGET[key] ?? 0) * 100).toFixed(1)}%)`,
  )
  testInfo.annotations.push({ type: 'mismatch', description: `${key}: ${pct}%` })
  await testInfo.attach(`${key}-actual.png`, { body: actual, contentType: 'image/png' })
  await testInfo.attach(`${key}-reference.png`, { body: reference, contentType: 'image/png' })
  await testInfo.attach(`${key}-diff.png`, { body: diff, contentType: 'image/png' })
  // EDITOR_VISUAL_OUT=<dir> keeps the images of passing runs too (for design review).
  const outDir = process.env['EDITOR_VISUAL_OUT']
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, `${key}-actual.png`), actual)
    writeFileSync(resolve(outDir, `${key}-diff.png`), diff)
  }
  expect(ratio, `artboard ${key} mismatch`).toBeLessThanOrEqual(BUDGET[key] ?? 0)
}

/** Select a node by its name path from the current page (fixture test hook). */
async function selectByPath(page: Page, path: string[]) {
  await page.evaluate((names) => {
    type Hook = {
      session: {
        tree: { children(id: string): readonly string[]; meta(id: string): { name: string } | null }
        store: { getState(): { pageId: string } }
      }
      canvas: { select(ids: string[]): void }
    }
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    const { tree, store } = hook.session
    let id = store.getState().pageId
    for (const name of names) {
      const next = tree.children(id).find((c) => tree.meta(c)?.name === name)
      if (!next) throw new Error(`no layer ${name}`)
      id = next
    }
    hook.canvas.select([id])
  }, path)
}

async function waitForCanvasIdle(page: Page) {
  await page.waitForFunction(() => {
    const hook = (
      window as unknown as { __barenEditor: { canvas: { getStats(): CanvasStatsLike } } }
    ).__barenEditor
    return hook.canvas.getStats().pendingWork === 0
  })
}

function layerRow(page: Page, name: string) {
  return page.getByRole('treeitem').filter({ has: page.getByText(name, { exact: true }) })
}

test.describe('editor matches the reference artboards', () => {
  test('04 Editor — Empty file', async ({ page }, testInfo) => {
    await openEditor(page, EMPTY_FILE)
    await expect(page.getByText('to draw an artboard, or paste anything')).toBeVisible()
    await check(page, '04', testInfo)
  })

  test('05 Editor — Canvas overview', async ({ page }, testInfo) => {
    await openEditor(page, COMPONENT_LIBRARY, { thumbnails: 7 })
    // The reference shows the first artboard row hovered (row tint, lock/eye, canvas outline).
    await layerRow(page, '01 Foundations').hover()
    await check(page, '05', testInfo)
  })

  test('06 Editor — Selection & inspector', async ({ page }, testInfo) => {
    await openEditor(page, COMPONENT_LIBRARY, { thumbnails: 7 })
    await layerRow(page, '03 Forms').click()
    await page.mouse.move(120, 780)
    await expect(page.getByRole('heading', { name: 'Selection colors' })).toBeVisible()
    await check(page, '06', testInfo)
  })

  test('07 Editor — Theme tokens', async ({ page }, testInfo) => {
    await openEditor(page, THEME_FILE)
    await page.getByRole('radio', { name: 'Theme' }).click()
    await page.getByRole('option', { name: /^selection/ }).click()
    await page.mouse.move(120, 780)
    await expect(page.getByText('Color token')).toBeVisible()
    await check(page, '07', testInfo)
  })

  test('08 Editor — Share popover', async ({ page }, testInfo) => {
    await openEditor(page, COMPONENT_LIBRARY, { thumbnails: 7 })
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(page.getByRole('dialog', { name: /^Share / })).toBeVisible()
    await expect(page.getByText('Defne Aydın')).toBeVisible()
    await page.mouse.move(700, 880)
    await check(page, '08', testInfo)
  })

  test('14 Editor — Layers expanded', async ({ page }, testInfo) => {
    await openEditor(page, COMPONENT_LIBRARY, { thumbnails: 7 })
    // Select "Email" (Label in Field / Email) and show 03 Forms at 1:1 as in the artboard.
    await page.evaluate(() => {
      type Hook = {
        session: {
          tree: {
            children(id: string): readonly string[]
            meta(id: string): { name: string } | null
          }
          store: { getState(): { pageId: string } }
        }
        canvas: {
          setViewport(v: { x: number; y: number; zoom: number }, o?: { animate?: boolean }): void
          select(ids: string[]): void
        }
      }
      const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
      const { tree, store } = hook.session
      const find = (parent: string, name: string) =>
        tree.children(parent).find((id) => tree.meta(id)?.name === name)
      const page = store.getState().pageId
      const forms = find(page, '03 Forms') as string
      const section = find(forms, 'Section / Text input') as string
      const field = find(section, 'Field / Email') as string
      const label = find(field, 'Label') as string
      hook.canvas.setViewport({ x: 2320 - 48, y: -600 - 64, zoom: 1 }, { animate: false })
      hook.canvas.select([label])
    })
    await page.waitForFunction(() => {
      const hook = (
        window as unknown as { __barenEditor: { canvas: { getStats(): CanvasStatsLike } } }
      ).__barenEditor
      const s = hook.canvas.getStats()
      return !s.lod && s.pendingWork === 0 && s.mountedArtboards > 0
    })
    // The reference artboard also shows the "Input" frame expanded.
    await layerRow(page, 'Input').getByRole('button', { name: 'Expand' }).click()
    await expect(layerRow(page, 'Icon / mail')).toBeVisible()
    await layerRow(page, 'Label').hover()
    await expect(page.getByRole('heading', { name: 'Typography' })).toBeVisible()
    await check(page, '14', testInfo)
  })

  test('15 Editor — Context menu', async ({ page }, testInfo) => {
    await openEditor(page, COMPONENT_LIBRARY, { thumbnails: 7 })
    await page.mouse.click(872, 300, { button: 'right' })
    const menu = page.getByRole('menu', { name: 'Layer actions' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Copy as' }).hover()
    const html = page.getByRole('menuitem', { name: /^HTML/ })
    await expect(html).toBeVisible()
    await html.hover()
    await check(page, '15', testInfo)
  })

  test('24 Editor — Image fill', async ({ page }, testInfo) => {
    await openEditor(page, IMAGE_FILE)
    await selectByPath(page, ['Landing — Desktop', 'Hero', 'Hero image'])
    await expect(page.getByText('dolomites-dawn.jpg')).toBeVisible()
    await expect(page.getByText('2400 × 1200')).toBeVisible()
    await waitForCanvasIdle(page)
    // The reference shows the selected row hovered (lock and eye visible).
    await layerRow(page, 'Hero image').hover()
    await check(page, '24', testInfo)
  })

  test('29 Editor — Rotation & groups', async ({ page }, testInfo) => {
    await openEditor(page, ROTATION_FILE)
    await selectByPath(page, ['Landing — Desktop', 'Hero', 'Launch sticker', 'Sticker'])
    await expect(page.getByRole('textbox', { name: 'Rotation' })).toHaveValue('15°')
    await waitForCanvasIdle(page)
    // The reference shows the selected row hovered (lock and eye visible).
    await layerRow(page, 'Sticker').hover()
    await check(page, '29', testInfo)
  })

  test('30 Editor — Pen tool', async ({ page }, testInfo) => {
    await openEditor(page, PEN_FILE)
    await selectByPath(page, ['Logo — Mark', 'Peak'])
    await page.evaluate(() => {
      type Hook = { canvas: { editVector(id: string): void; getSelection(): string[] } }
      const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
      const id = hook.canvas.getSelection()[0]
      if (id) hook.canvas.editVector(id)
    })
    await expect(page.getByRole('heading', { name: 'Stroke' })).toBeVisible()
    await waitForCanvasIdle(page)
    await layerRow(page, 'Peak').hover()
    await check(page, '30', testInfo)
  })

  test('31 Editor — Components', async ({ page }, testInfo) => {
    await openEditor(page, COMPONENTS_FILE)
    await selectByPath(page, ['Pricing — Desktop', 'Plans', 'Team', 'Button / Primary'])
    await expect(page.getByText('2 overrides')).toBeVisible()
    await waitForCanvasIdle(page)
    // Away from the layer rows and the canvas content (nothing hovered).
    await page.mouse.move(700, 820)
    await check(page, '31', testInfo)
  })

  test('32 Editor — Component picker', async ({ page }, testInfo) => {
    await openEditor(page, PICKER_FILE)
    await page.getByRole('button', { name: 'Component', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Components' })
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Insert Button / Primary' }).hover()
    await check(page, '32', testInfo)
  })

  test('33 Editor — Drop into frame', async ({ page }, testInfo) => {
    await openEditor(page, DROP_FILE)
    await selectByPath(page, ['Pricing — Desktop', 'Plans', 'Team', 'Header', 'Badge / New'])
    await waitForCanvasIdle(page)
    // Drag the "Popular" badge out of Team's header into Starter, between header and price;
    // the screenshot is taken mid-drag (drop highlight, insertion line, dragged layer). The
    // badge is grabbed inside (not on a resize handle) and the pointer ends in the gap
    // between Starter's header and its price.
    await page.mouse.move(1012, 370)
    await page.mouse.down()
    await page.mouse.move(990, 375, { steps: 4 })
    await page.mouse.move(758, 397, { steps: 12 })
    await settle(page)
    try {
      await check(page, '33', testInfo)
    } finally {
      await page.keyboard.press('Escape')
      await page.mouse.up()
    }
  })

  test('16 Editor — Zoom menu', async ({ page }, testInfo) => {
    await openEditor(page, EMPTY_FILE)
    await page.getByRole('button', { name: /^Zoom / }).click()
    const menu = page.getByRole('menu', { name: 'Zoom' })
    await expect(menu).toBeVisible()
    // The zoom input keeps focus (the reference also highlights "Zoom in" under the pointer, but a
    // hover would move focus off the input in a real menu).
    await expect(page.getByRole('textbox', { name: 'Zoom level' })).toBeFocused()
    await check(page, '16', testInfo)
  })
})

// ---------------------------------------------------------------------------
// Behaviour: the same fixture driven through the UI, checked against the document.
// ---------------------------------------------------------------------------

interface DocNode {
  id: string
  name: string
  type: string
  styles: Record<string, string | number>
  locked?: boolean
  hidden?: boolean
  children: string[]
}

/** Read nodes of the open document through the fixture-mode test hook. */
async function nodesByName(page: Page, names: string[]): Promise<Record<string, DocNode>> {
  return page.evaluate((wanted) => {
    type Hook = { snapshot(): { nodes: Record<string, DocNode> } }
    const snap = (window as unknown as { __barenEditor: Hook }).__barenEditor.snapshot()
    const out: Record<string, DocNode> = {}
    for (const n of Object.values(snap.nodes))
      if (wanted.includes(n.name) && !out[n.name]) out[n.name] = n
    return out
  }, names)
}

/** The first selected node of the open document. */
async function selectedNode(page: Page): Promise<DocNode | undefined> {
  return page.evaluate(() => {
    type Hook = {
      snapshot(): { nodes: Record<string, DocNode> }
      session: { store: { getState(): { selection: readonly string[] } } }
    }
    const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
    const id = hook.session.store.getState().selection[0]
    return id === undefined ? undefined : hook.snapshot().nodes[id]
  })
}

async function pageChildren(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Hook = {
      session: {
        tree: { children(id: string): readonly string[]; meta(id: string): { name: string } | null }
        store: { getState(): { pageId: string } }
      }
    }
    const { tree, store } = (window as unknown as { __barenEditor: Hook }).__barenEditor.session
    return tree.children(store.getState().pageId).map((id) => tree.meta(id)?.name ?? '')
  })
}

test.describe('editor behaviour', () => {
  test('layers: select, rename, lock, reorder by drag', async ({ page }) => {
    await openEditor(page, COMPONENT_LIBRARY)
    const row = layerRow(page, '02 Actions')
    await row.dblclick()
    const input = page.getByRole('textbox', { name: 'Layer name' })
    await input.fill('02 Buttons')
    await input.press('Enter')
    await expect(layerRow(page, '02 Buttons')).toBeVisible()
    expect(Object.keys(await nodesByName(page, ['02 Buttons']))).toEqual(['02 Buttons'])

    const renamed = layerRow(page, '02 Buttons')
    await renamed.hover()
    await renamed.getByRole('button', { name: 'Lock' }).click()
    expect((await nodesByName(page, ['02 Buttons']))['02 Buttons']?.locked).toBe(true)

    // Drag "01 Foundations" below "03 Forms" (bottom half of the leaf-like collapsed row).
    const from = await layerRow(page, '01 Foundations').boundingBox()
    const to = await layerRow(page, '03 Forms').boundingBox()
    if (!from || !to) throw new Error('rows not laid out')
    await page.mouse.move(from.x + 60, from.y + 14)
    await page.mouse.down()
    await page.mouse.move(from.x + 60, from.y + 30, { steps: 4 })
    await page.mouse.move(to.x + 60, to.y + 25, { steps: 6 })
    await page.mouse.up()
    expect((await pageChildren(page)).slice(0, 3)).toEqual([
      '02 Buttons',
      '03 Forms',
      '01 Foundations',
    ])
  })

  test('inspector edits are one undo step each', async ({ page }) => {
    await openEditor(page, COMPONENT_LIBRARY)
    await layerRow(page, '04 Labels & Status').click()
    const x = page.getByRole('textbox', { name: 'X', exact: true })
    await x.fill('3300')
    await x.press('Enter')
    expect(
      (await nodesByName(page, ['04 Labels & Status']))['04 Labels & Status']?.styles['left'],
    ).toBe(3300)
    await page.getByRole('textbox', { name: 'Opacity', exact: true }).first().fill('50')
    await page.keyboard.press('Enter')
    expect(
      (await nodesByName(page, ['04 Labels & Status']))['04 Labels & Status']?.styles['opacity'],
    ).toBe(0.5)
    // Undo through the app's Edit → Undo command (Ctrl+Z outside text fields).
    await page.mouse.click(700, 820)
    await layerRow(page, '04 Labels & Status').click()
    await page.keyboard.press('Control+z')
    expect(
      (await nodesByName(page, ['04 Labels & Status']))['04 Labels & Status']?.styles['opacity'],
    ).toBeUndefined()
    await page.keyboard.press('Control+z')
    expect(
      (await nodesByName(page, ['04 Labels & Status']))['04 Labels & Status']?.styles['left'],
    ).toBe(3220)
  })

  test('theme: add a token and edit its color', async ({ page }) => {
    await openEditor(page, THEME_FILE)
    await page.getByRole('radio', { name: 'Theme' }).click()
    await page.getByRole('button', { name: 'Add token' }).click()
    await expect(page.getByRole('option', { name: /^new/ })).toBeVisible()
    const hex = page.getByRole('textbox', { name: 'Hex color' }).first()
    await hex.fill('FF0055')
    await hex.press('Enter')
    const value = await page.evaluate(() => {
      type Hook = { tokens(): Record<string, { value: string }> }
      return (window as unknown as { __barenEditor: Hook }).__barenEditor.tokens()['--color-new']
        ?.value
    })
    expect(value).toBe('#FF0055')
  })

  test('menus: zoom presets and add page', async ({ page }) => {
    await openEditor(page, EMPTY_FILE)
    await page.getByRole('button', { name: /^Zoom / }).click()
    await page.getByRole('menuitemcheckbox', { name: /^50%/ }).click()
    await expect(page.getByRole('button', { name: 'Zoom 50%' })).toBeVisible()

    await page.getByRole('button', { name: 'Add page' }).click()
    const name = page.getByRole('textbox', { name: 'Page name' })
    await name.fill('Flows')
    await name.press('Enter')
    await expect(page.getByRole('button', { name: 'Flows' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('typography, fill tokens and keyboard navigation in layers', async ({ page }) => {
    await openEditor(page, COMPONENT_LIBRARY)
    await page.evaluate(() => {
      type Hook = {
        session: {
          tree: {
            children(id: string): readonly string[]
            meta(id: string): { name: string } | null
          }
          store: { getState(): { pageId: string } }
        }
        canvas: { select(ids: string[]): void }
      }
      const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
      const { tree, store } = hook.session
      const find = (parent: string, name: string) =>
        tree.children(parent).find((id) => tree.meta(id)?.name === name) as string
      const forms = find(store.getState().pageId, '03 Forms')
      const header = find(forms, 'Header')
      const title = find(header, 'Title')
      hook.canvas.select([find(title, 'Heading')])
    })
    await expect(page.getByRole('heading', { name: 'Typography' })).toBeVisible()
    const size = page.getByRole('textbox', { name: 'Font size' })
    await expect(size).toHaveValue('26')
    await size.fill('30')
    await size.press('Enter')
    await page.getByRole('button', { name: 'Font weight' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Bold', exact: true }).click()
    expect((await selectedNode(page))?.styles).toMatchObject({ fontSize: '30px', fontWeight: 700 })

    // Bind the text color to a token through the Fill section's token menu.
    await page.getByRole('button', { name: /^Token: foreground/ }).click()
    await page.getByRole('menuitemcheckbox', { name: /^gray-500/ }).click()
    expect((await selectedNode(page))?.styles['color']).toBe('var(--color-gray-500)')

    // Arrow keys walk the revealed tree.
    await layerRow(page, 'Heading').click()
    await page.keyboard.press('ArrowDown')
    await expect(layerRow(page, 'Description').first()).toHaveAttribute('aria-selected', 'true')
  })

  test('context menu: copy as CSS and duplicate', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openEditor(page, COMPONENT_LIBRARY)
    await page.mouse.click(620, 200, { button: 'right' })
    const menu = page.getByRole('menu', { name: 'Layer actions' })
    await menu.getByRole('menuitem', { name: 'Copy as' }).hover()
    await page.getByRole('menuitem', { name: 'CSS', exact: true }).click()
    const css = await page.evaluate(() => navigator.clipboard.readText())
    expect(css).toContain('.03-forms {')
    expect(css).toContain('width: 800px;')
    await page.mouse.click(620, 200, { button: 'right' })
    await page.getByRole('menuitem', { name: /^Duplicate/ }).click()
    await expect
      .poll(async () => (await pageChildren(page)).filter((n) => n === '03 Forms').length)
      .toBe(2)
  })

  test('copy as agent context: the context menu and Ctrl+Shift+C', async ({ page }) => {
    const clipboard = await recordCopies(page)
    await openEditor(page, COMPONENT_LIBRARY)

    // A whole artboard: its JSX is too long, so its children are outlined with their ids.
    await page.mouse.click(620, 200, { button: 'right' })
    await page
      .getByRole('menu', { name: 'Layer actions' })
      .getByRole('menuitem', { name: 'Copy as' })
      .hover()
    await page.getByRole('menuitem', { name: /^Agent context/ }).click()
    await expect(page.getByText('Agent context copied')).toBeVisible()
    const board = await clipboard()
    expect(board).toMatch(/^<baren-selection file="acme" fileId="f-acme" page="Component library">/)
    expect(board).toMatch(
      /<node nodeId="[^"]+" name="03 Forms" type="Frame" path="03 Forms" size="800×\d+">/,
    )
    expect(board).toContain('get_jsx returns it.')
    expect(board).toMatch(/^- Header \(Frame, \d+×\d+\) nodeId=\S+$/m)

    // A nested text layer, by shortcut: its JSX is included.
    const title = await page.evaluate(() => {
      const hook = (
        window as unknown as {
          __barenEditor: {
            snapshot(): { nodes: Record<string, { id: string; type: string; text?: string }> }
            canvas: { select(ids: string[]): void }
          }
        }
      ).__barenEditor
      const node = Object.values(hook.snapshot().nodes).find(
        (n) => n.type === 'text' && n.text === 'Text input',
      )
      if (!node) throw new Error('no "Text input" text layer')
      hook.canvas.select([node.id])
      return node.id
    })
    await page.locator('.ic-root').focus()
    await page.keyboard.press('Control+Shift+C')
    await expect.poll(clipboard).toContain(`<node nodeId="${title}"`)
    const text = await clipboard()
    expect(text).toMatch(/type="Text" path="03 Forms \/ [^"]+" size="\d+×\d+">/)
    expect(text).toContain(`<div data-node-id="${title}" style={{`)
    expect(text).toContain('  Text input\n')
  })
})

// ---------------------------------------------------------------------------
// Images: insert flows and the image fill inspector (24).
// ---------------------------------------------------------------------------

/** A solid-colour PNG made in the page (bytes for file choosers, drops and the clipboard). */
async function makePng(page: Page, w: number, h: number, color: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h, color }) => {
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = color
      ctx.fillRect(0, 0, w, h)
      const bytes = new Uint8Array(
        await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(),
      )
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin)
    },
    { w, h, color },
  )
  return Buffer.from(b64, 'base64')
}

interface ImageNode extends DocNode {
  assetId?: string
  assetName?: string
  svg?: string
  parentId: string | null
}

async function nodesOfType(page: Page, type: string): Promise<ImageNode[]> {
  return page.evaluate((t) => {
    type Hook = { snapshot(): { nodes: Record<string, ImageNode> } }
    const snap = (window as unknown as { __barenEditor: Hook }).__barenEditor.snapshot()
    return Object.values(snap.nodes).filter((n) => n.type === t)
  }, type)
}

test.describe('editor zoomed out', () => {
  test('no line of the artboard background along edges that fall inside a pixel', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    // A light artboard under full-width dark sections (an agent's landing page), dark theme.
    // Its own background used to show as a light line along the right and bottom edges.
    type Hook = {
      __barenAgent: {
        dispatch(t: string, a: unknown): Promise<{ result: { id: string } }>
        hosts(): unknown[]
      }
      __barenEditor: {
        canvas: {
          getNodeFrame(id: string): { x: number; y: number; width: number; height: number }
          setViewport(v: { x: number; y: number; zoom: number }): void
          getStats(): CanvasStatsLike
        }
      }
    }
    await openEditor(page, EMPTY_FILE.replace('?fixture=design', '?fixture=design&theme=dark'))
    await page.waitForFunction(() => (window as unknown as Hook).__barenAgent.hosts().length > 0)
    const board = await page.evaluate(async () => {
      const agent = (window as unknown as Hook).__barenAgent
      const b = await agent.dispatch('create_artboard', {
        name: 'Landing',
        styles: { width: '1440px', height: 'fit-content' },
      })
      for (const [name, color] of [
        ['CTA', '#FF8933'],
        ['Footer', '#000000'],
      ])
        await agent.dispatch('write_html', {
          targetNodeId: b.result.id,
          mode: 'insert-children',
          html: `<div layer-name="${name}" style="display:flex;padding:160px 120px;background-color:${color}"><p style="font-size:40px;color:#888888">${name}</p></div>`,
        })
      return b.result.id
    })
    // Agent additions fade in under a tinted placeholder first (overlay/incoming.ts).
    await page.waitForTimeout(1_500)
    // Thumbnails below 26 %, live layers above; the right and bottom edges land mid-pixel.
    for (const zoom of [0.2, 0.245, 0.27, 0.33]) {
      const edge = await page.evaluate(
        ([id, z]) => {
          const canvas = (window as unknown as Hook).__barenEditor.canvas
          const f = canvas.getNodeFrame(id)
          const root = (document.querySelector('.ic-root') as HTMLElement).getBoundingClientRect()
          const right = Math.round(root.x + root.width * 0.6) + 0.5
          const bottom = Math.round(root.y + root.height * 0.7) + 0.5
          canvas.setViewport({
            zoom: z,
            x: f.x + f.width - (right - root.x) / z,
            y: f.y + f.height - (bottom - root.y) / z,
          })
          return { right, bottom }
        },
        [board, zoom] as const,
      )
      await page.waitForFunction(
        (z) => {
          const s = (window as unknown as Hook).__barenEditor.canvas.getStats()
          return s.pendingWork === 0 && s.lod === z < 0.25
        },
        zoom,
        { timeout: 15_000 },
      )
      await settle(page)
      // The pixels the edges cross, inside the black footer: canvas ground (#141414) or darker.
      const [rightEdge, bottomEdge] = await page.evaluate(
        async ([png, points]) => {
          const img = new Image()
          img.src = `data:image/png;base64,${png}`
          await img.decode()
          const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')
          if (!ctx) throw new Error('no 2d context')
          ctx.drawImage(img, 0, 0)
          return points.map(([x, y]) => {
            const d = ctx.getImageData(x, y, 1, 1).data
            return ((d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0)) / 3
          })
        },
        [
          (await page.screenshot()).toString('base64'),
          [
            [Math.floor(edge.right), Math.floor(edge.bottom) - 30],
            [Math.floor(edge.right) - 60, Math.floor(edge.bottom)],
          ],
        ] as const,
      )
      expect(rightEdge, `right edge at ${zoom}`).toBeLessThanOrEqual(28)
      expect(bottomEdge, `bottom edge at ${zoom}`).toBeLessThanOrEqual(28)
    }
  })
})

test.describe('editor images', () => {
  test('image fill: fit mode, opacity and remove (one undo step each)', async ({ page }) => {
    await openEditor(page, IMAGE_FILE)
    await selectByPath(page, ['Landing — Desktop', 'Hero', 'Hero image'])
    await expect(page.getByTestId('image-preview')).toBeVisible()
    await page.getByRole('button', { name: 'Image fit' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Tile' }).click()
    let hero = (await nodesByName(page, ['Hero image']))['Hero image']
    expect(hero?.styles).toMatchObject({
      backgroundSize: '2400px 1200px',
      backgroundRepeat: 'repeat',
    })
    const opacity = page.getByRole('textbox', { name: 'Image opacity' })
    await opacity.fill('40')
    await opacity.press('Enter')
    hero = (await nodesByName(page, ['Hero image']))['Hero image']
    expect(String(hero?.styles['backgroundImage'])).toMatch(
      /^-webkit-cross-fade\(url\("baren-asset:\/\/[0-9a-f]{64}"\), url\("data:image\/gif;base64,[^"]+"\), 60%\)$/,
    )
    // The canvas renders it (the asset URL is rewritten to the blob URL inside the fade).
    const bg = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('.ic-node')).find((n) =>
        n.style.backgroundImage.includes('cross-fade'),
      )
      return el ? getComputedStyle(el).backgroundImage : null
    })
    expect(bg).toMatch(/cross-fade\(url\("blob:/)
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    hero = (await nodesByName(page, ['Hero image']))['Hero image']
    expect(hero?.styles['backgroundImage']).toBeUndefined()
    await page.mouse.click(700, 880)
    await page.keyboard.press('Control+z')
    hero = (await nodesByName(page, ['Hero image']))['Hero image']
    expect(String(hero?.styles['backgroundImage'])).toContain('cross-fade')
  })

  test('drop files onto an artboard: one layer each, inside the artboard, fitted', async ({
    page,
  }) => {
    await openEditor(page, IMAGE_FILE)
    const big = await makePng(page, 3000, 1500, '#ff0000')
    const small = await makePng(page, 200, 100, '#00ff00')
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" onload="alert(1)"><script>alert(2)</script><rect width="48" height="24" fill="#00f"/></svg>'
    const data = await page.evaluateHandle(
      ({ big, small, svg }) => {
        const dt = new DataTransfer()
        const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        dt.items.add(new File([bytes(big)], 'big.png', { type: 'image/png' }))
        dt.items.add(new File([bytes(small)], 'small.png', { type: 'image/png' }))
        dt.items.add(new File([svg], 'logo.svg', { type: 'image/svg+xml' }))
        dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
        return dt
      },
      { big: big.toString('base64'), small: small.toString('base64'), svg },
    )
    const target = page.locator('.ic-root')
    // Over the artboard (client 700,600 = inside Landing — Desktop): highlighted, then dropped.
    await target.dispatchEvent('dragover', { dataTransfer: data, clientX: 700, clientY: 600 })
    await target.dispatchEvent('drop', { dataTransfer: data, clientX: 700, clientY: 600 })
    await expect.poll(async () => (await nodesOfType(page, 'image')).length).toBe(2)
    const images = await nodesOfType(page, 'image')
    const svgs = (await nodesOfType(page, 'svg')).filter((n) => n.name === 'logo')
    const board = (await nodesByName(page, ['Landing — Desktop']))['Landing — Desktop']
    for (const n of [...images, ...svgs]) expect(n.parentId).toBe(board?.id)
    const byName = Object.fromEntries(images.map((n) => [n.name, n]))
    // 3000×1500 is fitted to the 1440-wide artboard; 200×100 keeps its natural size. The
    // artboard is a flex column, so the images join its flow (no absolute position).
    expect(byName['big']?.styles).toMatchObject({ width: 1440, height: 720, flexShrink: 0 })
    expect(byName['big']?.styles['position']).toBeUndefined()
    expect(byName['small']?.styles).toMatchObject({ width: 200, height: 100 })
    expect(byName['big']?.assetName).toBe('big.png')
    expect(byName['big']?.assetId).toMatch(/^[0-9a-f]{64}$/)
    expect(svgs).toHaveLength(1)
    expect(svgs[0]?.svg).not.toMatch(/script|onload/)
    expect(svgs[0]?.styles).toMatchObject({ width: 48, height: 24 })
    // The canvas shows the dropped pixels (blob URL from the mock bridge).
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll<HTMLImageElement>('img.ic-img')).filter(
              (i) => i.complete && i.naturalWidth > 0,
            ).length,
        ),
      )
      .toBe(2)
  })

  test('tool rail image button and paste insert images', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openEditor(page, EMPTY_FILE)
    const png = await makePng(page, 320, 240, '#3366ff')
    const chooser = page.waitForEvent('filechooser')
    await page
      .getByRole('button', { name: /^Image/ })
      .first()
      .click()
    await (
      await chooser
    ).setFiles([
      { name: 'one.png', mimeType: 'image/png', buffer: png },
      { name: 'two.png', mimeType: 'image/png', buffer: png },
    ])
    await expect.poll(async () => (await nodesOfType(page, 'image')).length).toBe(2)
    const [one, two] = (await nodesOfType(page, 'image')).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    // Same bytes → same asset; laid out side by side on the empty page.
    expect(one?.assetId).toBe(two?.assetId)
    expect(Number(two?.styles['left']) - Number(one?.styles['left'])).toBe(340)

    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
      ])
    }, png.toString('base64'))
    await page.mouse.click(700, 500)
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await nodesOfType(page, 'image')).length).toBe(3)
  })
})
