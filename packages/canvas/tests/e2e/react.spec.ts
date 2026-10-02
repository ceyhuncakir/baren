import { expect, test } from '@playwright/test'
import type {} from '../../bench/react.tsx'

test('DesignCanvas mounts once, forwards page changes and latest callbacks, and cleans up', async ({
  page,
}) => {
  await page.goto('/react.html')
  await page.waitForFunction(
    () => window.__react !== undefined && window.__react.state.ready.length === 1,
  )
  const r1 = await page.evaluate(() => {
    const s = window.__react.state
    return {
      roots: document.querySelectorAll('.ic-root').length,
      page: s.ref?.getPageId(),
      sameRef: s.ref === s.ready[0],
    }
  })
  expect(r1).toEqual({
    roots: 1,
    page: await page.evaluate(() => window.__react.page1),
    sameRef: true,
  })

  await page.evaluate(() => window.__react.setPage(window.__react.page2))
  await page.evaluate(() => window.__react.setLabel('b'))
  const r2 = await page.evaluate(() => {
    const s = window.__react.state
    const c = s.ref
    const top = c ? c.getPageId() : null
    const tops = c
      ? (window.__react.doc
          .getTree('nodes')
          .getNodeByID(top as `${number}@${number}`)
          ?.children()
          ?.map((n) => n.id) ?? [])
      : []
    c?.select(tops)
    return {
      page: top,
      created: s.ready.length,
      roots: document.querySelectorAll('.ic-root').length,
      last: s.selections.at(-1),
    }
  })
  expect(r2.page).toBe(await page.evaluate(() => window.__react.page2))
  expect(r2.created).toBe(1)
  expect(r2.roots).toBe(1)
  // The selection callback came from the latest render (label "b").
  expect(r2.last?.[0]).toBe('b')

  await page.evaluate(() => window.__react.unmount())
  const r3 = await page.evaluate(() => ({
    roots: document.querySelectorAll('.ic-root').length,
    ready: window.__react.state.ready.at(-1),
    ref: window.__react.state.ref,
  }))
  expect(r3).toEqual({ roots: 0, ready: null, ref: null })
})
