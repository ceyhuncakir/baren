import { expect, test, type Page } from '@playwright/test'
import { frames, isColor, overlayPixel, setup } from './helpers.ts'

/**
 * Agents on the overlay (Phase 4 contract §10.4): an artboard in an agent's working set gets a
 * 2 px ring, a halo and a glow, plus an island fused to the ring's top edge (the Baren medallion
 * and the agents' names, or only the medallion on a narrow artboard). Nothing animates.
 *
 * Fixture (bench/e2e.ts): Board B is world (500,0) 300×300 → client (550,50)–(850,350) at 100 %.
 */

const AGENT: [number, number, number] = [0xd0, 0x39, 0x1e]
/** The medallion's cream (or its fallback disc before the image decodes). */
const CREAM: [number, number, number] = [0xf5, 0xef, 0xe5]

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

/** Whether any opaque pixel of the overlay inside the rect is (nearly) `rgb` (default: agent). */
async function hasAgentPixels(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: readonly number[] = AGENT,
) {
  return page.evaluate(
    ([rx, ry, rw, rh, rgb]) => {
      const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
      const d = c?.getContext('2d')?.getImageData(rx, ry, rw, rh).data
      if (!d) return false
      for (let i = 0; i < d.length; i += 4) {
        if (
          (d[i + 3] ?? 0) > 200 &&
          Math.abs((d[i] ?? 0) - (rgb[0] ?? 0)) < 30 &&
          Math.abs((d[i + 1] ?? 0) - (rgb[1] ?? 0)) < 30 &&
          Math.abs((d[i + 2] ?? 0) - (rgb[2] ?? 0)) < 30
        )
          return true
      }
      return false
    },
    [x, y, w, h, rgb] as const,
  )
}

test.describe('agent working edge and island', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page)
  })

  test('draws ring, halo and island on the working artboard, at two zoom levels', async ({
    page,
  }) => {
    await setAgents(page, [{ name: 'Claude Code', on: 'boardB' }])
    // Island: a 24 px tab on the ring's top edge (y 24–50), flush with its outer right edge (852).
    expect(isColor(await overlayPixel(page, 848, 30), AGENT, 30)).toBe(true)
    expect(await hasAgentPixels(page, 720, 24, 132, 26)).toBe(true)
    // The medallion near the island's left end (or its cream stand-in).
    expect(await hasAgentPixels(page, 700, 24, 100, 26, CREAM)).toBe(true)
    // Ring: 2 px solid accent just outside the left edge (x 548–550); halo beyond it.
    expect(isColor(await overlayPixel(page, 549, 200), AGENT, 40)).toBe(true)
    const halo = await overlayPixel(page, 546, 200)
    expect(halo[3]).toBeGreaterThan(0)
    expect(halo[3]).toBeLessThan(200)
    // Nothing is drawn over the artboard itself.
    expect((await overlayPixel(page, 700, 200))[3]).toBe(0)
    await page.screenshot({
      path: test.info().outputPath('agent-100.png'),
      clip: { x: 480, y: 0, width: 440, height: 400 },
    })

    // 25 %: Board B is client (137.5,50)–(212.5,125), 75 px wide. Ring and island keep their
    // screen size; the names no longer fit → a medallion-only tab, still flush right.
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: -50, y: -200, zoom: 0.25 }))
    await frames(page, 3)
    expect(isColor(await overlayPixel(page, 212, 40), AGENT, 30)).toBe(true)
    expect(await hasAgentPixels(page, 140, 24, 40, 20)).toBe(false)
    expect(isColor(await overlayPixel(page, 136, 90), AGENT, 40)).toBe(true)
    await page.screenshot({
      path: test.info().outputPath('agent-25.png'),
      clip: { x: 80, y: 0, width: 200, height: 200 },
    })
  })

  test('joins names on one island and ignores layers that are not top-level artboards', async ({
    page,
  }) => {
    await setAgents(page, [{ name: 'Claude Code', on: 'boardB' }])
    expect(await hasAgentPixels(page, 690, 26, 30, 20)).toBe(false)
    await setAgents(page, [
      { name: 'Claude Code', on: 'boardB' },
      { name: 'Cursor', on: 'boardB' },
    ])
    // "Claude Code & Cursor" is wider than one name: the island starts further left.
    expect(await hasAgentPixels(page, 690, 26, 30, 20)).toBe(true)
    await setAgents(page, [{ name: 'Claude Code', on: 'box' }])
    expect(await hasAgentPixels(page, 0, 0, 1000, 52)).toBe(false)
  })

  test('draws once: no animation loop while an agent works', async ({ page }) => {
    expect(await overlayRedraws(page, 300)).toBe(0)
    await setAgents(page, [{ name: 'Claude Code', on: 'boardB' }])
    // At most one more redraw (the medallion finishing its decode).
    expect(await overlayRedraws(page, 800)).toBeLessThanOrEqual(1)
    await page.evaluate(() => window.__e2e.setPresence([]))
    await page.waitForTimeout(100)
    expect(await overlayRedraws(page, 300)).toBe(0)
  })
})

/* Board B is world (500,0) → client (550,50); this card lands at client (570,70)–(690,150). */
const CARD = {
  type: 'rect' as const,
  name: 'Card',
  styles: {
    position: 'absolute',
    left: 20,
    top: 20,
    width: 120,
    height: 80,
    backgroundColor: '#3366ff',
  },
}

async function stagedState(page: Page, id: string): Promise<'hidden' | 'reveal' | 'shown'> {
  return page.evaluate((nid) => {
    const el = window.__e2e.elementOf(nid)
    if (el?.classList.contains('ic-incoming')) return 'hidden'
    if (el?.classList.contains('ic-revealing')) return 'reveal'
    return 'shown'
  }, id)
}

test.describe('agent additions', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page)
  })

  test('a layer an agent adds shows its placeholder first, then fades in', async ({ page }) => {
    const id = await page.evaluate(
      (card) => window.__e2e.agentCreate({ ...card, parentId: window.__e2e.ids.boardB }),
      CARD,
    )
    await frames(page, 3)
    // Hidden while an agent-coloured placeholder (fading in over 120 ms) marks its area.
    expect(await stagedState(page, id)).toBe('hidden')
    await page.waitForTimeout(150)
    expect(await stagedState(page, id)).toBe('hidden')
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(true)
    await page.screenshot({
      path: test.info().outputPath('incoming.png'),
      clip: { x: 540, y: 40, width: 320, height: 320 },
    })
    // Then the layer is shown and the placeholder is gone.
    await page.waitForTimeout(1100)
    expect(await stagedState(page, id)).toBe('shown')
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(false)
  })

  test('an edit by an agent flashes the layer without hiding it; a rename does not', async ({
    page,
  }) => {
    const id = await page.evaluate(
      (card) => window.__e2e.createNode({ ...card, parentId: window.__e2e.ids.boardB }),
      CARD,
    )
    await frames(page, 3)
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(false)
    await page.evaluate((nid) => window.__e2e.agentRename(nid, 'Hero card'), id)
    await page.waitForTimeout(200)
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(false)
    await page.evaluate((nid) => window.__e2e.agentSetStyle(nid, 'backgroundColor', '#ff9900'), id)
    await page.waitForTimeout(200)
    expect(await stagedState(page, id)).toBe('shown')
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(true)
    await page.waitForTimeout(1000)
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(false)
  })

  test('layers people add appear at once, without a placeholder', async ({ page }) => {
    const id = await page.evaluate(
      (card) => window.__e2e.createNode({ ...card, parentId: window.__e2e.ids.boardB }),
      CARD,
    )
    await frames(page, 3)
    expect(await stagedState(page, id)).toBe('shown')
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(false)
  })

  test("a collaborator's agent: staged only on an artboard an agent is working on", async ({
    page,
  }) => {
    const plain = await page.evaluate(
      (card) => window.__e2e.remoteCreate({ ...card, parentId: window.__e2e.ids.boardB }),
      CARD,
    )
    await frames(page, 3)
    expect(await stagedState(page, plain)).toBe('shown')
    await setAgents(page, [{ name: 'Claude Code', on: 'boardB' }])
    const staged = await page.evaluate(
      (card) =>
        window.__e2e.remoteCreate({
          ...card,
          parentId: window.__e2e.ids.boardB,
          styles: { ...card.styles, top: 120 },
        }),
      CARD,
    )
    await frames(page, 3)
    expect(await stagedState(page, staged)).toBe('hidden')
  })
})

test.describe('agent additions with prefers-reduced-motion', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await setup(page)
  })

  test('the layer shows at once; only the placeholder fades', async ({ page }) => {
    const id = await page.evaluate(
      (card) => window.__e2e.agentCreate({ ...card, parentId: window.__e2e.ids.boardB }),
      CARD,
    )
    await frames(page, 3)
    expect(await stagedState(page, id)).toBe('shown')
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(true)
    await page.waitForTimeout(700)
    expect(await hasAgentPixels(page, 568, 72, 6, 76)).toBe(false)
  })
})
