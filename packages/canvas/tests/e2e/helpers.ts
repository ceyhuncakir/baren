import type { Page } from '@playwright/test'
import type {} from '../../bench/e2e.ts'

export async function setup(page: Page): Promise<void> {
  await page.goto('/e2e.html')
  await page.waitForFunction(() => window.__e2e !== undefined)
  await page.evaluate(() => window.__e2e.ready)
  await frames(page, 2)
}

export function frames(page: Page, n = 2): Promise<void> {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let i = 0
        const step = (): void => {
          if (++i >= count) resolve()
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    n,
  )
}

/** Centre of a node's element in client coordinates. */
export async function centerOf(
  page: Page,
  key: keyof Window['__e2e']['ids'],
): Promise<{ x: number; y: number }> {
  return page.evaluate((k) => {
    const e = window.__e2e
    const el = e.elementOf(e.ids[k])
    if (!el) throw new Error(`no element for ${k}`)
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, key)
}

export function selection(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__e2e.canvas().getSelection())
}

export function ids(page: Page): Promise<Window['__e2e']['ids']> {
  return page.evaluate(() => window.__e2e.ids)
}

/** RGBA of an overlay canvas pixel (device px == CSS px at DPR 1). */
export function overlayPixel(
  page: Page,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  return page.evaluate(
    ([px, py]) => {
      const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
      const ctx = c?.getContext('2d')
      if (!ctx) throw new Error('no overlay')
      const d = ctx.getImageData(px, py, 1, 1).data
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0] as [number, number, number, number]
    },
    [x, y] as const,
  )
}

/** Pixel has the given RGB (within `tol`) and is mostly opaque (anti-aliased edges allowed). */
export function isColor(px: readonly number[], rgb: readonly number[], tol = 40): boolean {
  return (px[3] ?? 0) > 100 && rgb.every((v, i) => Math.abs(v - (px[i] ?? 0)) <= tol)
}
