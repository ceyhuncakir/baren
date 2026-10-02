import { expect, test, type Page } from '@playwright/test'
import { frames, setup } from './helpers.ts'

/**
 * Integration (Phase 3): the style-only propagation fast path. A main edit that only restyles
 * main content patches the changed node of every instance (`resolver.stylePaths` +
 * `resolveStyles` + `Scene.patchStyles`) instead of re-expanding each instance; the result
 * must be exactly what a fresh instance renders, overrides included.
 *
 * Fixture: bench/e2e.ts (`p3`): the "Card" main (Title, Bar) and two instances in Board I.
 */

type P3 = Window['__e2e']['p3']

async function p3(page: Page): Promise<P3> {
  return page.evaluate(() => window.__e2e.p3)
}

/** The rendered DOM under an instance, ids relative to the instance (placement ignored). */
function shapeOf(page: Page, id: string) {
  return page.evaluate((inst) => {
    const root = window.__e2e.elementOf(inst)
    if (!root) return null
    const walk = (el: Element): unknown => ({
      nid: (el.getAttribute('data-nid') ?? '').slice(inst.length),
      tag: el.tagName,
      style: (el.getAttribute('style') ?? '')
        .split(';')
        .map((x) => x.trim())
        .filter((x) => x !== '' && !/^(left|top|position)\s*:/.test(x))
        .sort()
        .join(';'),
      text: el.classList.contains('ic-text') ? el.textContent : null,
      children: [...el.children].filter((c) => c.hasAttribute('data-nid')).map(walk),
    })
    return walk(root)
  }, id)
}

test.beforeEach(async ({ page }) => {
  await setup(page)
})

test('style-only main edits patch instances in place, without re-expanding them', async ({
  page,
}) => {
  const n = await p3(page)
  await page.evaluate(() => window.__e2e.phase3(-50, 750, 1))
  await frames(page, 3)
  const barKey = await page.evaluate((id) => window.__e2e.node(id)?.nodeKey as string, n.cardBar)
  // Count expansions of the two instances (the full path expands each of them).
  await page.evaluate(
    ([a, b]) => {
      // The controller's resolver (an implementation detail, not on the public interface).
      const r = (
        window.__e2e.canvas() as unknown as {
          resolver: { expandInstance(id: string): unknown }
        }
      ).resolver
      const original = r.expandInstance.bind(r)
      const w = window as unknown as { __expanded: number }
      w.__expanded = 0
      r.expandInstance = (id: string) => {
        if (id === a || id === b) w.__expanded++
        return original(id)
      }
    },
    [n.inst1, n.inst2] as const,
  )
  const expanded = () =>
    page.evaluate(() => (window as unknown as { __expanded: number }).__expanded)
  const bar = (inst: string) =>
    page.evaluate((id) => {
      const el = window.__e2e.elementOf(id) as HTMLElement | null
      return el
        ? {
            color: getComputedStyle(el).backgroundColor,
            opacity: getComputedStyle(el).opacity,
            width: el.getBoundingClientRect().width,
          }
        : null
    }, `${inst}/${barKey}`)
  const expectLikeFresh = async (label: string) => {
    const fresh = await page.evaluate(
      ([key, board]) =>
        window.__e2e.makeInstance(key as string, board as string, {
          position: 'absolute',
          left: 20,
          top: 160,
        }),
      [n.componentKey, n.boardI] as const,
    )
    await frames(page, 4)
    const want = await shapeOf(page, fresh)
    expect(want, label).not.toBeNull()
    expect(await shapeOf(page, n.inst1), `${label}: inst1`).toEqual(want)
    await page.evaluate((id) => window.__e2e.deleteNode(id), fresh)
    await frames(page, 2)
  }

  // 1. A colour on the main's Bar: both instances repaint, no instance is re-expanded.
  await page.evaluate((id) => window.__e2e.setStyle(id, 'backgroundColor', '#00AA00'), n.cardBar)
  await frames(page, 2)
  expect(await expanded()).toBe(0)
  expect((await bar(n.inst1))?.color).toBe('rgb(0, 170, 0)')
  expect((await bar(n.inst2))?.color).toBe('rgb(0, 170, 0)')
  await expectLikeFresh('colour')

  // 2. An override on inst2's Bar survives the next main edit (opacity).
  await page.evaluate(
    (ref) => window.__e2e.setStylesAt(ref, { backgroundColor: '#0000FF' }),
    `${n.inst2}/${barKey}`,
  )
  await frames(page, 2)
  const before = await expanded()
  await page.evaluate((id) => window.__e2e.setStyle(id, 'opacity', 0.5), n.cardBar)
  await frames(page, 2)
  expect(await expanded()).toBe(before)
  expect(await bar(n.inst1)).toMatchObject({ color: 'rgb(0, 170, 0)', opacity: '0.5' })
  expect(await bar(n.inst2)).toMatchObject({ color: 'rgb(0, 0, 255)', opacity: '0.5' })
  await expectLikeFresh('opacity')

  // 3. A size change goes the same way and is re-measured (layout keys bump the artboard).
  await page.evaluate((id) => window.__e2e.setStyle(id, 'width', 150), n.cardBar)
  await frames(page, 3)
  expect(await expanded()).toBe(before)
  expect((await bar(n.inst1))?.width).toBe(150)
  const bounds = await page.evaluate(
    (ref) => window.__e2e.canvas().getNodeBounds(ref),
    `${n.inst2}/${barKey}`,
  )
  expect(bounds?.width).toBe(150)
  await expectLikeFresh('width')

  // 4. Removing a style and restyling the main root (path '').
  await page.evaluate((id) => window.__e2e.setStyle(id, 'opacity', null), n.cardBar)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
  await page.evaluate((id) => window.__e2e.setStyle(id, 'backgroundColor', '#FFEEAA'), n.card)
  await frames(page, 3)
  expect(await bar(n.inst1)).toMatchObject({ opacity: '1' })
  expect(
    await page.evaluate(
      (id) => getComputedStyle(window.__e2e.elementOf(id) as HTMLElement).backgroundColor,
      n.inst1,
    ),
  ).toBe('rgb(255, 238, 170)')
  await expectLikeFresh('root and removal')
})
