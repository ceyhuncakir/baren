import { expect, test, type Page } from '@playwright/test'
import { frames, setup } from './helpers.ts'

// Fixture (bench/e2e.ts): viewport x=-50, y=-50, zoom 1 → world (x, y) is at client (x + 50, y + 50).
// Board B: world (500,0) 300×300 → client (550,50)–(850,350).

const RED = 'a'.repeat(64)
const LATE = 'b'.repeat(64)

test.beforeEach(async ({ page }) => {
  await setup(page)
})

/** Register a solid-colour PNG under `id` in the fixture's asset resolver. */
async function addAsset(page: Page, id: string, color: string, w = 20, h = 10): Promise<void> {
  await page.evaluate(
    async ({ id, color, w, h }) => {
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = color
      ctx.fillRect(0, 0, w, h)
      const blob = await c.convertToBlob({ type: 'image/png' })
      window.__e2e.assetUrls.set(id, URL.createObjectURL(blob))
    },
    { id, color, w, h },
  )
}

/** Create an image layer, an image-fill rect and a missing-asset image in Board B. */
async function addImageNodes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(
    ({ red, late }) => {
      const e = window.__e2e
      const layer = e.createNode({
        type: 'image',
        parentId: e.ids.boardB,
        name: 'Layer',
        assetId: red,
        styles: { width: 100, height: 50, objectFit: 'cover' },
      })
      const fill = e.createNode({
        type: 'rect',
        parentId: e.ids.boardB,
        name: 'Fill',
        styles: {
          width: 100,
          height: 50,
          backgroundImage: `url("baren-asset://${red}")`,
          backgroundSize: 'cover',
        },
      })
      const missing = e.createNode({
        type: 'image',
        parentId: e.ids.boardB,
        name: 'Missing',
        assetId: late,
        styles: { width: 40, height: 40 },
      })
      const missingFill = e.createNode({
        type: 'rect',
        parentId: e.ids.boardB,
        name: 'Missing fill',
        styles: { width: 40, height: 40, backgroundImage: `url("baren-asset://${late}")` },
      })
      return { layer, fill, missing, missingFill }
    },
    { red: RED, late: LATE },
  )
}

async function idle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__e2e.canvas().getStats().pendingWork === 0)
  await frames(page, 2)
}

test('renders image layers, image fills and placeholders for missing assets', async ({ page }) => {
  await addAsset(page, RED, '#FF0000')
  const ids = await addImageNodes(page)
  await idle(page)
  const r = await page.evaluate((ids) => {
    const e = window.__e2e
    const layer = e.elementOf(ids.layer as string) as HTMLImageElement
    const fill = e.elementOf(ids.fill as string) as HTMLElement
    const missing = e.elementOf(ids.missing as string) as HTMLImageElement
    const missingFill = e.elementOf(ids.missingFill as string) as HTMLElement
    return {
      layerLoaded: layer.complete && layer.naturalWidth === 20,
      decoding: layer.decoding,
      fit: getComputedStyle(layer).objectFit,
      fillBg: getComputedStyle(fill).backgroundImage,
      // The stored document value is untouched; only the DOM sees the resolved URL.
      stored: e.node(ids.fill as string)?.styles['backgroundImage'],
      missingClass: missing.classList.contains('ic-img-missing'),
      missingFillBg: getComputedStyle(missingFill).backgroundImage,
    }
  }, ids)
  expect(r.layerLoaded).toBe(true)
  expect(r.decoding).toBe('async')
  expect(r.fit).toBe('cover')
  expect(r.fillBg).toMatch(/^url\("blob:/)
  expect(r.stored).toBe(`url("baren-asset://${RED}")`)
  expect(r.missingClass).toBe(true)
  expect(r.missingFillBg).toMatch(/^linear-gradient/)

  // The bytes arrive later (download from the server): reloadAssets swaps the placeholders.
  await addAsset(page, LATE, '#0000FF')
  await page.evaluate((late) => window.__e2e.canvas().reloadAssets([late]), LATE)
  await idle(page)
  const after = await page.evaluate((ids) => {
    const e = window.__e2e
    const missing = e.elementOf(ids.missing as string) as HTMLImageElement
    return {
      loaded: missing.complete && missing.naturalWidth === 20,
      placeholder: missing.classList.contains('ic-img-missing'),
      fill: getComputedStyle(e.elementOf(ids.missingFill as string) as HTMLElement).backgroundImage,
    }
  }, ids)
  expect(after.loaded).toBe(true)
  expect(after.placeholder).toBe(false)
  expect(after.fill).toMatch(/^url\("blob:/)
})

test('LOD thumbnails include image layers and image fills', async ({ page }) => {
  await addAsset(page, RED, '#FF0000')
  await page.evaluate((red) => {
    const e = window.__e2e
    // A board whose whole area is an image fill, plus an image layer on Board A.
    e.createNode({
      type: 'frame',
      parentId: e.pageId,
      name: 'Photo board',
      styles: {
        left: 0,
        top: 400,
        width: 300,
        height: 200,
        backgroundImage: `url("baren-asset://${red}")`,
        backgroundSize: 'cover',
      },
    })
  }, RED)
  await page.evaluate(() => window.__e2e.canvas().setViewport({ x: -200, y: -200, zoom: 0.1 }))
  await page.waitForFunction(() => {
    const s = window.__e2e.canvas().getStats()
    return s.lod && s.pendingWork === 0 && document.querySelectorAll('.ic-thumb').length >= 3
  })
  const px = await page.evaluate(async () => {
    const wrapper = Array.from(document.querySelectorAll<HTMLElement>('.ic-top')).find((w) =>
      w.querySelector('.ic-thumb'),
    )
    const thumbs = Array.from(document.querySelectorAll<HTMLImageElement>('.ic-thumb'))
    // The photo board is the last top-level node (created last).
    const img = thumbs[thumbs.length - 1] as HTMLImageElement
    await img.decode()
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
    return { rgba: [d[0], d[1], d[2], d[3]], hasWrapper: wrapper !== undefined }
  })
  expect(px.hasWrapper).toBe(true)
  expect(px.rgba[0]).toBeGreaterThan(200)
  expect(px.rgba[1]).toBeLessThan(60)
  expect(px.rgba[3]).toBeGreaterThan(200)
})

test('drop targets: the artboard under the point (flow or absolute), else the page', async ({
  page,
}) => {
  const r = await page.evaluate(() => {
    const e = window.__e2e
    const c = e.canvas()
    // Board A (flex column) at client (50,50)–(450,350).
    const a = c.dropTargetAt({ clientX: 100, clientY: 320 })
    const aPlace = a?.place({ x: 10, y: 260, width: 80, height: 20 })
    // Board B (no layout) at client (550,50)–(850,350).
    const b = c.dropTargetAt({ clientX: 700, clientY: 200 })
    const bPlace = b?.place({ x: 600, y: 100, width: 80, height: 40 })
    const page = c.dropTargetAt({ clientX: 950, clientY: 450 })
    const pagePlace = page?.place({ x: 900, y: 400, width: 10, height: 10 })
    c.dropTargetAt(null)
    return {
      a: a?.parentId === e.ids.boardA,
      aBounds: a?.bounds,
      aPlace,
      b: b?.parentId === e.ids.boardB,
      bPlace,
      page: page?.parentId === e.pageId,
      pageBounds: page?.bounds,
      pagePlace,
      world: b?.world,
    }
  })
  expect(r.a).toBe(true)
  expect(r.aBounds).toEqual({ x: 0, y: 0, width: 400, height: 300 })
  expect(r.aPlace).toEqual({ styles: { width: 80, height: 20, flexShrink: 0 }, index: 4 })
  expect(r.b).toBe(true)
  expect(r.bPlace).toEqual({
    styles: { position: 'absolute', left: 100, top: 100, width: 80, height: 40 },
  })
  expect(r.world).toEqual({ x: 650, y: 150 })
  expect(r.page).toBe(true)
  expect(r.pageBounds).toBeNull()
  expect(r.pagePlace).toEqual({ styles: { left: 900, top: 400, width: 10, height: 10 } })
})
