/**
 * Dark theme (ARCHITECTURE.md "Dark theme", Phase 2).
 *
 * 1. Pixel fidelity of the dark artboards D01, D06 and D18 (design/reference/D*.png) with
 *    `?fixture=design&theme=dark`. D01/D18 use the screens metric (pixelmatch-style YIQ
 *    delta, threshold 0.1), D06 the editor metric (any channel off by more than 24/255), so
 *    each number is comparable with its light counterpart (01, 06, 18).
 * 2. Design content isolation: the canvas renders the same pixels in both themes, a document
 *    that uses `var(--color-*)` gets the document's value (or the light default), never the
 *    app's dark value, and file thumbnails captured in dark show the document's colours.
 * 3. Switching theme at runtime re-themes the chrome, including the canvas ground and the
 *    Canvas 2D overlay, without a reload.
 *
 * Known, accepted differences: text rasterisation (as in the light suites) and the fixture's
 * mock-ups (see screens.spec.ts / editor.spec.ts). The design fixture's file thumbnails are
 * RGBA with a transparent ground (matted from 01 and D01), so D01 is compared full-frame.
 */
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readReference } from './references'

const REFERENCE_DIR = resolve(__dirname, '../../../../design/reference')
/** The renderer imports @baren/schema from source; Vite serves it at /@fs/<path>. */
const SCHEMA_MODULE = `/@fs${resolve(__dirname, '../../../../packages/schema/src/index.ts')}`
/** All "Edited …" labels are computed from this fixed clock (as in screens.spec.ts). */
const FIXED_NOW = new Date('2026-10-02T12:00:00Z')

const DARK = '?fixture=design&theme=dark'
const LIGHT = '?fixture=design&theme=light'
const COMPONENT_LIBRARY = '#/file/f-acme'
const EMPTY_FILE = '#/file/f-baren'

/** Share of differing pixels allowed (percent), measured + headroom, like the light suites. */
const BUDGET = {
  D01: 1.6,
  D06: 4,
  D18: 1.6,
} as const

/* ------------------------------------------------------------------ pixels */

interface Region {
  x: number
  y: number
  width: number
  height: number
}

type Metric = 'yiq' | 'channel'

interface DiffResult {
  /** Percent of differing pixels in the frame outside the excluded regions. */
  percent: number
  differing: number
  diff: Buffer
}

/**
 * Decodes both PNGs in a scratch page and counts differing pixels: `yiq` = squared YIQ
 * distance above pixelmatch's 0.1 threshold (screens.spec.ts), `channel` = any channel off
 * by more than 24/255 (editor.spec.ts).
 */
async function compare(
  context: BrowserContext,
  actual: Buffer,
  reference: Buffer,
  metric: Metric,
  exclude: readonly Region[] = [],
): Promise<DiffResult> {
  const scratch = await context.newPage()
  try {
    const out = await scratch.evaluate(
      async ({ a, b, metric, exclude }) => {
        const load = async (b64: string) => {
          const img = new Image()
          img.src = `data:image/png;base64,${b64}`
          await img.decode()
          return img
        }
        const [ia, ib] = await Promise.all([load(a), load(b)])
        if (ia.width !== ib.width || ia.height !== ib.height)
          throw new Error(`size ${ia.width}×${ia.height} vs ${ib.width}×${ib.height}`)
        const w = ia.width
        const h = ia.height
        const read = (img: HTMLImageElement) => {
          const c = new OffscreenCanvas(w, h)
          const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
          ctx.drawImage(img, 0, 0)
          return ctx.getImageData(0, 0, w, h).data
        }
        const pa = read(ia)
        const pb = read(ib)
        const maxDelta = 35215 * 0.1 * 0.1
        const inside = (x: number, y: number) =>
          !exclude.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
        const diff = new OffscreenCanvas(w, h)
        const dctx = diff.getContext('2d') as OffscreenCanvasRenderingContext2D
        const img = dctx.createImageData(w, h)
        let count = 0
        let total = 0
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4
            const r1 = pa[i] ?? 0
            const g1 = pa[i + 1] ?? 0
            const b1 = pa[i + 2] ?? 0
            const r2 = pb[i] ?? 0
            const g2 = pb[i + 1] ?? 0
            const b2 = pb[i + 2] ?? 0
            const shade = Math.round((r2 * 0.3 + g2 * 0.59 + b2 * 0.11) * 0.35 + 255 * 0.65)
            img.data.set([shade, shade, shade, 255], i)
            if (!inside(x, y)) continue
            total++
            let differs: boolean
            if (metric === 'yiq') {
              const dr = r1 - r2
              const dg = g1 - g2
              const db = b1 - b2
              const yy = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223
              const ii = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189
              const qq = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694
              differs = 0.5053 * yy * yy + 0.299 * ii * ii + 0.1957 * qq * qq > maxDelta
            } else {
              differs = Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) > 24
            }
            if (differs) {
              count++
              img.data.set([255, 0, 0, 255], i)
            }
          }
        }
        dctx.putImageData(img, 0, 0)
        const blob = await diff.convertToBlob({ type: 'image/png' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000)
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return { percent: total === 0 ? 0 : (count / total) * 100, count, diff: btoa(bin) }
      },
      { a: actual.toString('base64'), b: reference.toString('base64'), metric, exclude },
    )
    return { percent: out.percent, differing: out.count, diff: Buffer.from(out.diff, 'base64') }
  } finally {
    await scratch.close()
  }
}

/** Every <img> decoded, fonts ready, then two frames (and a beat for the canvas overlay). */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    '[...document.images].every((img) => img.complete && img.naturalWidth > 0)',
  )
  await page.evaluate(
    () =>
      new Promise<void>((r) => {
        void document.fonts.ready.then(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))),
        )
      }),
  )
}

async function checkArtboard(
  page: Page,
  testInfo: TestInfo,
  key: keyof typeof BUDGET,
  reference: string,
  metric: Metric,
  exclude: readonly Region[] = [],
): Promise<void> {
  await settle(page)
  const actual = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const expected = readReference(resolve(REFERENCE_DIR, reference), actual)
  const { percent, diff } = await compare(page.context(), actual, expected, metric, exclude)
  let text = `${percent.toFixed(2)}%`
  if (exclude.length > 0) {
    const full = await compare(page.context(), actual, expected, metric)
    text += ` (full frame ${full.percent.toFixed(2)}%, ${exclude.length} regions excluded)`
  }
  console.log(`[dark visual] ${key}: ${text} (budget ${BUDGET[key]}%)`)
  testInfo.annotations.push({ type: 'mismatch', description: `${key}: ${text}` })
  writeFileSync(testInfo.outputPath('actual.png'), actual)
  writeFileSync(testInfo.outputPath('diff.png'), diff)
  await testInfo.attach(`${key}-actual.png`, { body: actual, contentType: 'image/png' })
  await testInfo.attach(`${key}-reference.png`, { body: expected, contentType: 'image/png' })
  await testInfo.attach(`${key}-diff.png`, { body: diff, contentType: 'image/png' })
  // DARK_VISUAL_OUT=<dir> keeps the images of passing runs too (for design review).
  const outDir = process.env['DARK_VISUAL_OUT']
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, `${key}-actual.png`), actual)
    writeFileSync(resolve(outDir, `${key}-diff.png`), diff)
  }
  expect(percent, `${key} differing pixels (%)`).toBeLessThanOrEqual(BUDGET[key])
}

/* ------------------------------------------------------------------ app helpers */

async function open(page: Page, query: string, hash: string): Promise<string[]> {
  await page.clock.setFixedTime(FIXED_NOW)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/${query}${hash}`)
  await page.waitForFunction('document.fonts.status === "loaded"')
  return errors
}

interface CanvasStatsLike {
  pendingWork: number
  thumbnails: number
  lod: boolean
}

/** Waits until the editor's canvas has painted everything it will paint. */
async function waitForEditor(page: Page, thumbnails = 0): Promise<void> {
  await page.getByTestId('editor').waitFor()
  await page.waitForFunction(() => {
    const hook = (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor
    return hook?.canvas != null
  })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForFunction(
    (n) => {
      const hook = (
        window as unknown as { __barenEditor: { canvas: { getStats(): CanvasStatsLike } } }
      ).__barenEditor
      const s = hook.canvas.getStats()
      return s.pendingWork === 0 && (!s.lod || s.thumbnails >= n)
    },
    thumbnails,
    { timeout: 15_000 },
  )
  await page.mouse.move(120, 780)
}

function layerRow(page: Page, name: string) {
  return page.getByRole('treeitem').filter({ has: page.getByText(name, { exact: true }) })
}

/** With `?theme=system`: the OS switches dark mode (mock bridge test hook), the app follows. */
async function setSystemDark(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((d) => {
    const hooks = (window as unknown as { __barenTest: { setSystemDark(d: boolean): void } })
      .__barenTest
    hooks.setSystemDark(d)
  }, dark)
  await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'dark' : 'light')
}

/* ------------------------------------------------------------------ artboards */

test.describe('dark artboards vs references', () => {
  test('D01 Home — Recents (dark)', async ({ page }, testInfo) => {
    const errors = await open(page, DARK, '#/recents')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const thumbnails = page.getByTestId('file-grid').locator('img')
    await expect(thumbnails).toHaveCount(7)
    // Thumbnails are the artboards alone (transparent ground), drawn on the card's
    // --color-canvas well, as real thumbnails from editor/session/raster.ts are.
    await expect
      .poll(() =>
        thumbnails.evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).complete)),
      )
      .toBe(true)
    const wells = await thumbnails.evaluateAll((imgs) =>
      imgs.map((img) => getComputedStyle(img.parentElement as Element).backgroundColor),
    )
    expect(new Set(wells)).toEqual(new Set(['rgb(20, 20, 20)']))
    await checkArtboard(page, testInfo, 'D01', 'D01-home-recents-dark.png', 'yiq')
    expect(errors, 'page errors').toEqual([])
  })

  test('D06 Editor — Selection & inspector (dark)', async ({ page }, testInfo) => {
    const errors = await open(page, DARK, COMPONENT_LIBRARY)
    await waitForEditor(page, 7)
    await layerRow(page, '03 Forms').click()
    await page.mouse.move(120, 780)
    await expect(page.getByRole('heading', { name: 'Selection colors' })).toBeVisible()
    await checkArtboard(page, testInfo, 'D06', 'D06-editor-selection-inspector-dark.png', 'channel')
    expect(errors, 'page errors').toEqual([])
  })

  test('D18 Auth — Sign in (dark)', async ({ page }, testInfo) => {
    const errors = await open(page, DARK, '#/auth/sign-in')
    await page.getByLabel('Email').fill('ceyhun@example.com')
    await checkArtboard(page, testInfo, 'D18', 'D18-auth-sign-in-dark.png', 'yiq')
    expect(errors, 'page errors').toEqual([])
  })
})

/* ------------------------------------------------------------------ content isolation */

type Box = Region

/** Screenshots `clips` of the same screen opened in light and dark; returns diff % per clip. */
async function lightVsDark(
  browserPage: (theme: 'light' | 'dark') => Promise<{ page: Page; clips: Box[] }>,
  context: BrowserContext,
): Promise<number[]> {
  const light = await browserPage('light')
  const dark = await browserPage('dark')
  expect(dark.clips).toEqual(light.clips)
  const out: number[] = []
  for (const clip of light.clips) {
    const a = await light.page.screenshot({ clip, animations: 'disabled', caret: 'hide' })
    const b = await dark.page.screenshot({ clip, animations: 'disabled', caret: 'hide' })
    out.push((await compare(context, a, b, 'channel')).percent)
  }
  return out
}

const inset = (r: Box, by: number): Box => ({
  x: Math.ceil(r.x) + by,
  y: Math.ceil(r.y) + by,
  width: Math.floor(r.width) - 2 * by - 1,
  height: Math.floor(r.height) - 2 * by - 1,
})

interface EditorHook {
  session: {
    doc: unknown
    tree: { children(id: string): readonly string[]; meta(id: string): { name: string } | null }
    store: { getState(): { pageId: string } }
  }
  canvas: {
    getNodeBounds(id: string): Box | null
    getViewport(): { x: number; y: number; zoom: number }
    setViewport(v: { x?: number; y?: number; zoom?: number }): void
    getStats(): CanvasStatsLike
    select(ids: string[]): void
  }
}

/** Calls @baren/schema helpers on the open document (the app's own module instance). */
async function withSchema<T>(page: Page, fn: string, arg: unknown = null): Promise<T> {
  return (await page.evaluate(
    async ({ fn, arg, url }) => {
      // Same URL as the app's import, so this is the app's module instance.
      const schema = (await import(/* @vite-ignore */ url)) as Record<string, unknown>
      const hook = (window as unknown as { __barenEditor: unknown }).__barenEditor
      return new Function('schema', 'hook', 'arg', `return (${fn})(schema, hook, arg)`)(
        schema,
        hook,
        arg,
      ) as unknown
    },
    { fn, arg, url: SCHEMA_MODULE },
  )) as T
}

async function frame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

async function computed(page: Page, id: string, prop: 'backgroundColor' | 'color') {
  return page.evaluate(
    ({ id, prop }) => {
      const el = document.querySelector(`[data-nid="${id}"]`)
      return el ? getComputedStyle(el)[prop] : null
    },
    { id, prop },
  )
}

test.describe('design content does not follow the app theme', () => {
  test('documents render their own tokens (or light defaults), never the app values', async ({
    page,
  }) => {
    const errors = await open(page, '?fixture=design&theme=system', EMPTY_FILE)
    await waitForEditor(page)
    await setSystemDark(page, true)

    const ids = await withSchema<{ frame: string; text: string; rect: string; pageId: string }>(
      page,
      `(schema, hook) => {
        const doc = hook.session.doc
        const pageId = hook.session.store.getState().pageId
        const frame = schema.createNode(doc, { type: 'frame', parentId: pageId, name: 'Tokens',
          styles: { left: 0, top: 0, width: 320, height: 200, display: 'flex', gap: 8,
            backgroundColor: 'var(--color-surface)' } })
        const text = schema.createNode(doc, { type: 'text', parentId: frame, name: 'Plain text',
          text: 'Hello', styles: { fontSize: 13 } })
        const rect = schema.createNode(doc, { type: 'rect', parentId: frame, name: 'Selected row',
          styles: { width: 40, height: 40, backgroundColor: 'var(--color-selection-subtle)',
            color: 'var(--color-foreground)' } })
        return { frame, text, rect, pageId }
      }`,
    )
    await frame(page)
    await expect.poll(() => computed(page, ids.frame, 'backgroundColor')).not.toBeNull()

    // Undefined in the document: the light default values, not the dark app's.
    expect(await computed(page, ids.frame, 'backgroundColor')).toBe('rgb(247, 247, 247)')
    expect(await computed(page, ids.rect, 'backgroundColor')).toBe('rgb(227, 238, 255)')
    expect(await computed(page, ids.rect, 'color')).toBe('rgb(26, 26, 26)')
    // Text without a colour inherits the document default, not the dark chrome foreground.
    expect(await computed(page, ids.text, 'color')).toBe('rgb(26, 26, 26)')
    // The chrome around it is dark, including the default page ground.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(26, 26, 26)',
    )
    const ground = () =>
      page.evaluate(
        () => getComputedStyle(document.querySelector('.ic-root') as Element).backgroundColor,
      )
    expect(await ground()).toBe('rgb(20, 20, 20)')

    // Defined in the document: the document's value wins.
    await withSchema(
      page,
      `(schema, hook) => schema.setTokens(hook.session.doc, {
        '--color-surface': { type: 'color', value: '#123456' },
        '--color-foreground': { type: 'color', value: '#654321' } })`,
    )
    await expect.poll(() => computed(page, ids.frame, 'backgroundColor')).toBe('rgb(18, 52, 86)')
    expect(await computed(page, ids.rect, 'color')).toBe('rgb(101, 67, 33)')

    // A custom page background is document data; the default one is chrome.
    await withSchema(
      page,
      `(schema, hook, pageId) => schema.setNodeProps(hook.session.doc, pageId, { background: '#FAFAFA' })`,
      ids.pageId,
    )
    await expect.poll(ground).toBe('rgb(250, 250, 250)')
    await withSchema(
      page,
      `(schema, hook, pageId) => schema.setNodeProps(hook.session.doc, pageId, { background: '#EEEEEE' })`,
      ids.pageId,
    )
    await expect.poll(ground).toBe('rgb(20, 20, 20)')

    // Back to light: the document renders exactly the same, the ground follows the app.
    await setSystemDark(page, false)
    await frame(page)
    expect(await computed(page, ids.frame, 'backgroundColor')).toBe('rgb(18, 52, 86)')
    expect(await computed(page, ids.rect, 'backgroundColor')).toBe('rgb(227, 238, 255)')
    expect(await computed(page, ids.text, 'color')).toBe('rgb(26, 26, 26)')
    expect(await ground()).toBe('rgb(238, 238, 238)')
    expect(errors, 'page errors').toEqual([])
  })

  test('file thumbnails written in dark render the document, not the app theme', async ({
    page,
  }) => {
    const errors = await open(page, DARK, EMPTY_FILE)
    await waitForEditor(page)
    await withSchema(
      page,
      `(schema, hook) => {
        const doc = hook.session.doc
        const pageId = hook.session.store.getState().pageId
        schema.createNode(doc, { type: 'frame', parentId: pageId, name: 'Card',
          styles: { left: 0, top: 0, width: 400, height: 300, backgroundColor: 'var(--color-surface)' } })
      }`,
    )
    await frame(page)
    // Leaving the editor captures the thumbnail (editor/session/raster.ts).
    await page.evaluate(() => {
      window.location.hash = '#/recents'
    })
    const card = page.getByTestId('file-grid').locator('img').first()
    await expect(page.getByTestId('file-grid')).toBeVisible()
    const pixel = async () =>
      page.evaluate(async () => {
        const imgs = [
          ...document.querySelectorAll<HTMLImageElement>('[data-testid="file-grid"] img'),
        ]
        const img = imgs.find((i) => i.src.startsWith('blob:'))
        if (!img) return null
        await img.decode()
        const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
        const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
        ctx.drawImage(img, 0, 0)
        const d = ctx.getImageData(img.naturalWidth >> 1, img.naturalHeight >> 1, 1, 1).data
        return [d[0], d[1], d[2]]
      })
    await expect(card).toBeVisible()
    await expect.poll(pixel, { timeout: 10_000 }).toEqual([247, 247, 247])
    expect(errors, 'page errors').toEqual([])
  })

  test('canvas artboards are the same pixels in light and dark (LOD and DOM)', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const pages: Partial<Record<'light' | 'dark', Page>> = {}
    const openCanvas = async (theme: 'light' | 'dark') => {
      const page = await context.newPage()
      pages[theme] = page
      await open(page, theme === 'dark' ? DARK : LIGHT, COMPONENT_LIBRARY)
      await waitForEditor(page, 7)
      await settle(page)
      const clips = await page.evaluate(() => {
        const hook = (window as unknown as { __barenEditor: EditorHook }).__barenEditor
        const { tree, store } = hook.session
        const v = hook.canvas.getViewport()
        const root = (document.querySelector('.ic-root') as Element).getBoundingClientRect()
        return tree
          .children(store.getState().pageId)
          .map((id) => hook.canvas.getNodeBounds(id))
          .filter((b): b is Box => b !== null)
          .map((b) => ({
            x: root.x + (b.x - v.x) * v.zoom,
            y: root.y + (b.y - v.y) * v.zoom,
            width: b.width * v.zoom,
            height: b.height * v.zoom,
          }))
          .filter((r) => r.width > 20 && r.x >= root.x && r.x + r.width <= root.right)
      })
      return { page, clips: clips.map((c) => inset(c, 2)) }
    }
    const lod = await lightVsDark(openCanvas, context)
    expect(lod.length).toBeGreaterThanOrEqual(6)
    console.log(`[dark content] LOD artboards differ: ${lod.map((p) => p.toFixed(3)).join(' ')} %`)
    for (const p of lod) expect(p).toBe(0)

    // 100 %: real DOM nodes of one artboard.
    const zoomIn = async (theme: 'light' | 'dark') => {
      const page = pages[theme] as Page
      const clip = await page.evaluate(() => {
        const hook = (window as unknown as { __barenEditor: EditorHook }).__barenEditor
        const { tree, store } = hook.session
        const id = tree
          .children(store.getState().pageId)
          .find((c) => tree.meta(c)?.name === '02 Actions')
        const b = id ? hook.canvas.getNodeBounds(id) : null
        if (!b) throw new Error('no 02 Actions')
        hook.canvas.setViewport({ x: b.x - 40, y: b.y - 40, zoom: 1 })
        const root = (document.querySelector('.ic-root') as Element).getBoundingClientRect()
        return {
          x: root.x + 40,
          y: root.y + 40,
          width: Math.min(b.width, root.width - 60),
          height: Math.min(b.height, root.height - 60),
        }
      })
      await page.waitForFunction(() => {
        const hook = (window as unknown as { __barenEditor: EditorHook }).__barenEditor
        const s = hook.canvas.getStats()
        return s.pendingWork === 0 && !s.lod
      })
      await settle(page)
      return { page, clips: [inset(clip, 2)] }
    }
    const dom = await lightVsDark(zoomIn, context)
    console.log(`[dark content] artboard at 100% differs: ${dom[0]?.toFixed(3)} %`)
    expect(dom[0]).toBe(0)
    await context.close()
  })
})

/* ------------------------------------------------------------------ runtime switch */

test('switching theme at runtime re-themes chrome, the canvas ground and the overlay', async ({
  page,
}) => {
  const errors = await open(page, '?fixture=design&theme=system', COMPONENT_LIBRARY)
  await waitForEditor(page, 7)
  await layerRow(page, '03 Forms').click()
  await page.mouse.move(120, 780)
  await frame(page)

  /** Overlay pixels painted in exactly `rgb` (selection outline, handles' border, label). */
  const overlayCount = (rgb: [number, number, number]) =>
    page.evaluate(([r, g, b]) => {
      const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
      const ctx = c?.getContext('2d')
      if (!c || !ctx) return -1
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4)
        if (d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3] === 255) n++
      return n
    }, rgb)
  const chrome = () =>
    page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      ground: getComputedStyle(document.querySelector('.ic-root') as Element).backgroundColor,
    }))
  const LIGHT_SELECTION: [number, number, number] = [47, 128, 255]
  const DARK_SELECTION: [number, number, number] = [59, 140, 255]

  expect(await chrome()).toEqual({ body: 'rgb(255, 255, 255)', ground: 'rgb(238, 238, 238)' })
  expect(await overlayCount(LIGHT_SELECTION)).toBeGreaterThan(500)
  expect(await overlayCount(DARK_SELECTION)).toBe(0)

  await setSystemDark(page, true)
  await expect.poll(chrome).toEqual({ body: 'rgb(26, 26, 26)', ground: 'rgb(20, 20, 20)' })
  await expect.poll(() => overlayCount(DARK_SELECTION)).toBeGreaterThan(500)
  expect(await overlayCount(LIGHT_SELECTION)).toBe(0)

  await setSystemDark(page, false)
  await expect.poll(() => overlayCount(LIGHT_SELECTION)).toBeGreaterThan(500)
  expect(await chrome()).toEqual({ body: 'rgb(255, 255, 255)', ground: 'rgb(238, 238, 238)' })
  expect(errors, 'page errors').toEqual([])
})
