import { expect, test } from '@playwright/test'

// Foundation smoke tests: the renderer boots in plain Chromium with the mock
// bridge, and loro-crdt's WASM loads. Visual diffs against design/reference/*.png
// are added by the screens/editor/integration workstreams.

test('renderer boots with the mock bridge', async ({ page }) => {
  await page.goto('/')
  const app = page.getByTestId('app-placeholder')
  await expect(app).toContainText('Baren')
  await expect(app).toContainText('mock bridge')
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 })
})

test('loro-crdt wasm loads and the mock bridge round-trips a file', async ({ page }) => {
  await page.goto('/')
  // Passed as a string so the test transpiler cannot rewrite import() into require().
  const result = await page.evaluate(`(async () => {
    const { bridge } = await import('/lib/bridge.ts')
    const file = await bridge.files.create('Smoke')
    const bytes = await bridge.files.open(file.id)
    const json = JSON.parse(await bridge.export.json(file.id))
    return { bytes: bytes.byteLength, name: json.name, pages: json.pageIds.length }
  })()`)
  expect(result).toMatchObject({ name: 'Smoke', pages: 1 })
  expect((result as { bytes: number }).bytes).toBeGreaterThan(0)
})
