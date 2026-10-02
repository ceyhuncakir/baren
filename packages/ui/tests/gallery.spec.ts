import { expect, test, type Page } from '@playwright/test'

/**
 * Renders every playground page and screen, fails on runtime/console errors and attaches
 * a full-page screenshot to the report (test-results/). No golden comparison here — the
 * screens can be compared against design/reference/*.png with the overlay (press "o").
 */

const PAGES = ['shell', 'forms', 'display', 'editor', 'icons'] as const
const SCREENS = ['screen-01', 'screen-06', 'screen-09'] as const

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  return errors
}

async function fontsReady(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const families = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
  )
  expect(families, 'bundled Inter must be loaded').toContain('Inter Variable')
}

for (const name of PAGES) {
  test(`page renders: ${name}`, async ({ page }, testInfo) => {
    const errors = collectErrors(page)
    await page.goto(`/#/${name}`)
    await expect(page.getByTestId('pg-page')).toBeVisible()
    await fontsReady(page)
    // Let the page grow so a full-page screenshot captures everything.
    await page.addStyleTag({
      content: '.pg{height:auto}.pg-main{overflow:visible}html,body{overflow:visible}',
    })
    const shot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' })
    await testInfo.attach(`${name}.png`, { body: shot, contentType: 'image/png' })
    expect(shot.byteLength).toBeGreaterThan(10_000)
    expect(errors).toEqual([])
  })
}

for (const name of SCREENS) {
  test(`screen renders at 1440×900: ${name}`, async ({ page }, testInfo) => {
    const errors = collectErrors(page)
    await page.goto(`/#/${name}`)
    const screen = page.getByTestId('pg-screen')
    await expect(screen).toBeVisible()
    await fontsReady(page)
    const box = await screen.boundingBox()
    expect(box).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    const shot = await page.screenshot({ animations: 'disabled', caret: 'hide' })
    await testInfo.attach(`${name}.png`, { body: shot, contentType: 'image/png' })
    expect(errors).toEqual([])
  })
}
