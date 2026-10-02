import { expect, test, type Page } from '@playwright/test'
import { frames, isColor, overlayPixel, setup } from './helpers.ts'

/**
 * Agents on the overlay (Phase 4 contract §10.4, artboard 35): an artboard in an agent's
 * working set gets a ring, a glow, a travelling sweep and a "<name> is working" badge; the
 * overlay keeps redrawing (≤ 30 fps) only while that sweep is on screen, and not at all with
 * prefers-reduced-motion.
 *
 * Fixture (bench/e2e.ts): Board B is world (500,0) 300×300 → client (550,50)–(850,350) at 100 %.
 */

const AGENT: [number, number, number] = [0xd2, 0x1f, 0x75]

interface PresenceLike {
  userId: string
  name: string
  color: string
  pageId: string | null
  cursor: { x: number; y: number } | null
  selection: string[]
  kind?: 'user' | 'agent'
  badge?: string
}

async function setAgents(page: Page, agents: { name: string; on: 'boardB' | 'box' }[]) {
  await page.evaluate((list) => {
    const e = window.__e2e
    const presence: PresenceLike[] = list.map((a, i) => ({
      userId: `agent-${i}`,
      name: a.name,
      color: '',
      pageId: null,
      cursor: { x: 600, y: 100 },
      selection: [e.ids[a.on]],
      kind: 'agent',
      badge: a.name,
    }))
    e.setPresence(presence as Parameters<typeof e.setPresence>[0])
  }, agents)
  await frames(page, 3)
}

/** Counts overlay redraws (clearRect on the overlay canvas) during `ms`. */
async function overlayRedraws(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (wait) => {
    const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
    const ctx = c?.getContext('2d')
    if (!ctx) throw new Error('no overlay')
    let n = 0
    const original = ctx.clearRect.bind(ctx)
    ctx.clearRect = (...args: Parameters<CanvasRenderingContext2D['clearRect']>) => {
      n++
      original(...args)
    }
    await new Promise((r) => setTimeout(r, wait))
    ctx.clearRect = original
    return n
  }, ms)
}

/** Whether any pixel of the overlay inside the rect is (nearly) the agent colour. */
async function hasAgentPixels(page: Page, x: number, y: number, w: number, h: number) {
  return page.evaluate(
    ([rx, ry, rw, rh, rgb]) => {
      const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
      const d = c?.getContext('2d')?.getImageData(rx, ry, rw, rh).data
      if (!d) return false
      for (let i = 0; i < d.length; i += 4) {
        if (
          (d[i + 3] ?? 0) > 200 &&
          Math.abs((d[i] ?? 0) - rgb[0]) < 30 &&
          Math.abs((d[i + 1] ?? 0) - rgb[1]) < 30 &&
          Math.abs((d[i + 2] ?? 0) - rgb[2]) < 30
        )
          return true
      }
      return false
    },
    [x, y, w, h, AGENT] as const,
  )
}

test.describe('agent working edge and badge', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page)
  })

  test('draws ring, badge and sweep on the working artboard, at two zoom levels', async ({
    page,
  }) => {
    await setAgents(page, [{ name: 'Claude Code', on: 'boardB' }])
    // Badge: 18 px pill ending 6 px above the board, right-aligned to its right edge (850).
    expect(await hasAgentPixels(page, 700, 26, 150, 18)).toBe(true)
    expect(isColor(await overlayPixel(page, 846, 30), AGENT, 30)).toBe(true)
    // Ring just outside the left edge (x 548–549): translucent agent colour, not blue.
    const ring = await overlayPixel(page, 548, 200)
    expect(ring[3]).toBeGreaterThan(40)
    expect(ring[0]).toBeGreaterThan(ring[2])
    // Nothing is drawn over the artboard itself.
    expect((await overlayPixel(page, 700, 200))[3]).toBe(0)
    await page.screenshot({
      path: test.info().outputPath('agent-100.png'),
      clip: { x: 480, y: 0, width: 440, height: 400 },
    })

    // 25 %: Board B is client (137.5,50)–(212.5,125), 75 px wide. Ring, glow and badge keep
    // their screen size; the badge no longer fits → the 18 px sparkle-only chip, right-aligned.
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: -50, y: -200, zoom: 0.25 }))
    await frames(page, 3)
    expect(isColor(await overlayPixel(page, 198, 35), AGENT, 30)).toBe(true)
    expect(await hasAgentPixels(page, 140, 28, 50, 14)).toBe(false)
    const small = await overlayPixel(page, 136, 90)
    expect(small[3]).toBeGreaterThan(40)
    await page.screenshot({
      path: test.info().outputPath('agent-25.png'),
      clip: { x: 80, y: 0, width: 200, height: 200 },
    })
  })

  test('joins names on one badge and ignores layers that are not top-level artboards', async ({
    page,
  }) => {
    await setAgents(page, [
      { name: 'Claude Code', on: 'boardB' },
      { name: 'Cursor', on: 'boardB' },
    ])
    // "Claude Code and Cursor are working" is wider than the one-name badge: starts further left.
    expect(await hasAgentPixels(page, 640, 26, 40, 18)).toBe(true)
    await setAgents(page, [{ name: 'Claude Code', on: 'box' }])
    expect(await hasAgentPixels(page, 0, 0, 1000, 48)).toBe(false)
  })

  test('animates only while a sweep is visible (≤ 30 fps), then stops', async ({ page }) => {
    // Idle canvas: no redraws.
    expect(await overlayRedraws(page, 300)).toBe(0)
    await setAgents(page, [{ name: 'Claude Code', on: 'boardB' }])
    const n = await overlayRedraws(page, 1000)
    expect(n).toBeGreaterThanOrEqual(15)
    expect(n).toBeLessThanOrEqual(33)
    // Scrolled out of view: the loop stops.
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: 20_000, y: 20_000, zoom: 1 }))
    await page.waitForTimeout(300)
    expect(await overlayRedraws(page, 400)).toBe(0)
    // Back in view, then cleared: stops again.
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: -50, y: -50, zoom: 1 }))
    await page.waitForTimeout(200)
    expect(await overlayRedraws(page, 300)).toBeGreaterThan(4)
    await page.evaluate(() => window.__e2e.setPresence([]))
    await page.waitForTimeout(100)
    expect(await overlayRedraws(page, 300)).toBe(0)
  })
})

test.describe('agent edge with prefers-reduced-motion', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await setup(page)
  })

  test('no sweep and no animation frames; the ring is 1.5 px in the full accent', async ({
    page,
  }) => {
    await setAgents(page, [{ name: 'Claude Code', on: 'boardB' }])
    expect(await overlayRedraws(page, 600)).toBe(0)
    // 1.5 px ring outside the left edge at x 548.5–550: the pixel next to the board is solid.
    expect(isColor(await overlayPixel(page, 549, 200), AGENT, 40)).toBe(true)
    expect(await hasAgentPixels(page, 700, 26, 150, 18)).toBe(true)
  })
})
