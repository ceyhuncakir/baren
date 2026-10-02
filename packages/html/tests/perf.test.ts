/**
 * Performance of a 2,000-element write_html in Node.
 *
 * - parse + normalise (`parseHtml`, all of this package's own work before Loro): ≤ 50 ms, for
 *   realistic agent HTML (styles repeat across rows) and for HTML whose every style is unique.
 * - apply (`applyHtml` inside one `transact`): Loro WASM writes dominate (~5 µs per map set),
 *   so it is measured against creating the same nodes with plain `createNode` (the floor) and
 *   must stay within 1.25× of it.
 * - `toJsx` of the result (both formats): ≤ 50 ms.
 *
 * Budgets are checked on the best of several runs after a warm-up (other test files run in
 * parallel workers); medians are reported too. `BAREN_PERF_OUT=<file>` writes the numbers.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { createNode, getChildIds, transact, type Styles } from '@baren/schema'
import { applyHtml, parseHtml, toJsx, type IrNode } from '../src/index.ts'
import { context, resolved, setup } from './helpers.ts'

const ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5v14"/></svg>'

/** 40 settings rows of 50 layers each (+ the list) = 2,001 layers (2,641 elements with svg paths). */
function realisticHtml(unique: boolean): string {
  const u = (i: number, j: number): string => (unique ? ` ; min-width: ${i * 50 + j}px` : '')
  let rows = ''
  for (let i = 0; i < 40; i++) {
    let row = `<div layer-name="Row ${i}" style="display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 20px; border-top: 1px solid var(--color-border)${u(i, 0)}">`
    let n = 1
    for (let g = 0; g < 8; g++) {
      row += `<div style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px; background-color: var(--color-muted)${u(i, n++)}">`
      row += ICON.replace('<svg ', `<svg style="flex-shrink: 0${u(i, n++)}" `)
      row += `<p style="font-family: Inter; font-size: 13px; line-height: 18px; color: var(--color-foreground)${u(i, n++)}">Item ${i}.${g} &amp; more</p>`
      row += `<span style="font-family: 'JetBrains Mono'; font-size: 11px; color: var(--color-foreground-muted); padding: 0 4px${u(i, n++)}">${g * 7}</span>`
      row += `<div style="width: 8px; height: 8px; border-radius: 9999px; background: #16A34A; flex-shrink: 0${u(i, n++)}"></div>`
      row += `<button style="display: flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--color-border); border-radius: 6px; font-size: 12px${u(i, n++)}">Edit</button>`
      row += '</div>'
    }
    row += `<img src="/Users/ana/brand/logo.png" style="width: 24px; height: 24px; border-radius: 50%${u(i, n++)}">`
    rows += `${row}</div>`
  }
  return `<div layer-name="List" style="display: flex; flex-direction: column; width: 960px; background: #fff">${rows}</div>`
}

function count(nodes: readonly IrNode[]): number {
  let n = 0
  const stack = [...nodes]
  for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
    n++
    if (c.kind === 'frame') stack.push(...c.children)
  }
  return n
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] as number
}

/** Median and best of `runs` timings (the best is the least disturbed by other test workers). */
function time(fn: () => void, runs = 9, warmup = 2): { median: number; best: number } {
  for (let i = 0; i < warmup; i++) fn()
  const out: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    out.push(performance.now() - t0)
  }
  return { median: median(out), best: Math.min(...out) }
}

const r1 = (n: number): number => Math.round(n * 10) / 10

const results: Record<string, number | number[]> = {}

describe('2,000-element write_html', () => {
  const tokens = { '--color-border': { type: 'color', value: '#E5E5E5' } }
  test.each([
    ['realistic (repeated styles)', false],
    ['every style unique', true],
  ] as const)('parseHtml: %s ≤ 50 ms', (label, unique) => {
    const html = realisticHtml(unique)
    const parsed = parseHtml(html, { tokens })
    expect(parsed.nodeCount).toBe(2001)
    expect(count(parsed.roots)).toBe(parsed.nodeCount)
    const t = time(() => parseHtml(html, { tokens }))
    results[`parse ${label}, median / best (ms)`] = [r1(t.median), r1(t.best)]
    expect(t.best).toBeLessThan(50)
  })

  test('applyHtml costs at most 1.25× creating the same nodes with plain createNode', () => {
    const html = realisticHtml(false)
    const parsed = parseHtml(html, { tokens })
    const fresh = () => {
      const { doc, pageId } = setup()
      const board = createNode(doc, {
        type: 'frame',
        parentId: pageId,
        styles: { left: 0, top: 0, width: 1440, height: 900, display: 'flex' },
      })
      return { doc, board }
    }
    const apply = (): number => {
      const { doc, board } = fresh()
      const ctx = context(doc)
      const t0 = performance.now()
      transact(
        doc,
        () => applyHtml(doc, parsed, { mode: 'insert-children', targetId: board }, ctx),
        { origin: 'agent:write_html' },
      )
      const ms = performance.now() - t0
      expect(getChildIds(doc, board)).toHaveLength(1)
      doc.free()
      return ms
    }
    const baseline = (): number => {
      const { doc, board } = fresh()
      const t0 = performance.now()
      transact(doc, () => {
        const make = (n: IrNode, parent: string): void => {
          const styles: Styles = {}
          for (const [k, v] of Object.entries(n.styles)) if (v !== null) styles[k] = v
          const type = n.kind === 'clone' ? 'frame' : n.kind
          const input: Parameters<typeof createNode>[1] = {
            type,
            parentId: parent,
            name: n.name ?? 'x',
            styles,
          }
          if (n.kind === 'text') input.text = n.text
          if (n.kind === 'svg') input.svg = n.markup
          if (n.kind === 'image') input.assetId = 'a'.repeat(64)
          const id = createNode(doc, input)
          if (n.kind === 'frame') for (const c of n.children) make(c, id)
        }
        for (const r of parsed.roots) make(r, board)
      })
      const ms = performance.now() - t0
      doc.free()
      return ms
    }
    // Interleaved, so both see the same WASM heap and GC pressure.
    baseline()
    apply()
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < 7; i++) {
      b.push(baseline())
      a.push(apply())
    }
    results['apply 2,001 nodes, median (ms)'] = Math.round(median(a) * 10) / 10
    results['createNode floor for the same nodes, median (ms)'] = Math.round(median(b) * 10) / 10
    results['apply / floor'] = Math.round((median(a) / median(b)) * 100) / 100
    expect(median(a)).toBeLessThan(median(b) * 1.25 + 5)
  }, 120_000)

  test('toJsx of the 2,001-node result ≤ 50 ms per format', () => {
    const { doc, pageId } = setup()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 1440, height: 900, display: 'flex' },
    })
    const ctx = context(doc)
    const parsed = parseHtml(realisticHtml(false), { tokens })
    const r = transact(doc, () =>
      applyHtml(doc, parsed, { mode: 'insert-children', targetId: board }, ctx),
    )
    const root = r.created[0] as string
    const nodes = resolved(doc, root)
    for (const format of ['inline-styles', 'tailwind'] as const) {
      const t = time(() => toJsx(nodes, root, { format, tokens }))
      results[`toJsx ${format}, median / best (ms)`] = [r1(t.median), r1(t.best)]
      expect(t.best).toBeLessThan(50)
    }
    const out = process.env['BAREN_PERF_OUT']
    if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
  })
})
