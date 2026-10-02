import { expect, test } from '@playwright/test'
import type { BenchReport, PhaseStats } from '../bench/main.ts'
import type {} from '../bench/overlay.ts'

/**
 * Scripted pan/zoom sessions on generated 20k- and 50k-node documents
 * (bench/index.html). One wheel event per animation frame goes through the
 * canvas's real input path. Reported per phase:
 * - work: main-thread time per frame (rAF callbacks + style/layout/paint/commit),
 *   measured from the rAF callback to a message task queued behind the frame;
 * - interval: rAF-to-rAF time with vsync and the frame-rate limit disabled
 *   (see playwright.config.ts), i.e. achievable frame rate;
 * - long tasks (> 50 ms) observed during the phase.
 *
 * Targets (ARCHITECTURE.md): pan/zoom ≥ 120 fps on 20k nodes, ≥ 60 fps on 50k.
 * Asserted on gesture phases: p95 work and p95 interval within the frame budget,
 * no long tasks. Settle phases (mounting real DOM after a gesture) are reported
 * and must not produce long tasks.
 */

const TARGETS: Record<string, { budgetMs: number; fps: number }> = {
  '20k': { budgetMs: 1000 / 120, fps: 120 },
  '50k': { budgetMs: 1000 / 60, fps: 60 },
  // Phase 3 (contract 9): instances of 12-node mains + vectors must meet the 20k budget.
  '20k-mixed': { budgetMs: 1000 / 120, fps: 120 },
}

function table(r: BenchReport): string {
  const head = [
    'phase',
    'kind',
    'frames',
    'work p50',
    'work p95',
    'work max',
    'int p50',
    'int p95',
    'fps p50',
    'long',
    'zoom',
    'live nodes',
    'lod',
  ]
  const rows = r.phases.map((p: PhaseStats) => [
    p.name,
    p.kind,
    String(p.frames),
    p.workP50.toFixed(2),
    p.workP95.toFixed(2),
    p.workMax.toFixed(2),
    p.intervalP50.toFixed(2),
    p.intervalP95.toFixed(2),
    p.kind === 'gesture' && p.intervalP50 > 0 ? String(Math.round(1000 / p.intervalP50)) : '-',
    `${p.longTasks}${p.longTasks ? ` (${p.longTaskMaxMs}ms)` : ''}`,
    String(p.zoom),
    String(p.mountedNodes),
    p.lod ? 'on' : 'off',
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)))
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')
  return [fmt(head), ...rows.map(fmt)].join('\n')
}

for (const preset of Object.keys(TARGETS)) {
  test(`pan/zoom ${preset} nodes`, async ({ page }, info) => {
    const target = TARGETS[preset] as { budgetMs: number; fps: number }
    await page.goto(`/index.html?preset=${preset}&hud=0`)
    await page.waitForFunction(() => window.__bench !== undefined)
    await page.evaluate(() => window.__bench.ready)
    const report = await page.evaluate(() => window.__bench.run())
    const text =
      `${report.nodes} nodes / ${report.artboards} artboards — generate ${report.generateMs} ms, ` +
      `createCanvas ${report.createCanvasMs} ms, first frame ${report.firstFrameMs} ms ` +
      `(viewport ${report.viewport.width}×${report.viewport.height}, target ${target.fps} fps = ${target.budgetMs.toFixed(2)} ms)\n` +
      table(report)
    console.log(`\n${text}\n`)
    await info.attach(`perf-${preset}.json`, {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    })
    await info.attach(`perf-${preset}.txt`, { body: text, contentType: 'text/plain' })

    for (const p of report.phases) {
      expect.soft(p.longTasks, `${p.name}: long tasks`).toBe(0)
      if (p.kind !== 'gesture') continue
      expect.soft(p.workP95, `${p.name}: p95 main-thread work`).toBeLessThanOrEqual(target.budgetMs)
      expect
        .soft(p.intervalP95, `${p.name}: p95 frame interval`)
        .toBeLessThanOrEqual(target.budgetMs)
    }
  })
}

test('reparent drop-target search ≤ 0.5 ms per pointer move at 20k nodes', async ({
  page,
}, info) => {
  await page.goto('/index.html?preset=20k&hud=0')
  await page.waitForFunction(() => window.__bench !== undefined)
  await page.evaluate(() => window.__bench.ready)
  // Mount artboards at 50 % (the reparent search runs over their rbush indexes).
  await page.evaluate(() => window.__bench.controller().setViewport({ x: 0, y: 0, zoom: 0.5 }))
  await page.waitForFunction(
    () => {
      const s = window.__bench.controller().getStats()
      return s.mountedNodes > 2000 && s.pendingWork === 0
    },
    undefined,
    { timeout: 30_000 },
  )
  const r = await page.evaluate(() => window.__bench.dropTargets(400))
  const text = `drop-target search (deep, ${r.calls} calls, ${r.mountedNodes} live nodes): p50 ${r.p50} ms, p95 ${r.p95} ms, max ${r.max} ms`
  console.log(`\n${text}\n`)
  await info.attach('drop-targets.txt', { body: text, contentType: 'text/plain' })
  expect(r.p95).toBeLessThanOrEqual(0.5)
})

test('component propagation: a main edit with ~1,000 loaded instances', async ({ page }, info) => {
  await page.goto('/index.html?preset=propagation&hud=0')
  await page.waitForFunction(() => window.__bench !== undefined)
  await page.evaluate(() => window.__bench.ready)
  const r = await page.evaluate(() => window.__bench.propagation())
  const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(2)).join(', ')
  const text =
    `${r.instances} instances loaded (${r.mountedNodes} live nodes)\n` +
    `style edit on the main → frame work ms: ${fmt(r.styleWorkMs)}\n` +
    `structural edit on the main → frame work ms: ${fmt(r.structuralWorkMs)}\n` +
    `keystroke in an instance text override → frame work ms: ${fmt(r.overrideTextWorkMs)}\n` +
    `keystroke in a plain text layer → frame work ms: ${fmt(r.plainTextWorkMs)}\n` +
    `instances updated in that frame: style ${r.verifiedStyle}, structural ${r.verifiedStructural}`
  console.log(`\n${text}\n`)
  await info.attach('propagation.txt', { body: text, contentType: 'text/plain' })
  expect(r.instances).toBeGreaterThanOrEqual(1000)
  // The timed frame really re-rendered every instance.
  expect(r.verifiedStyle).toBe(r.instances)
  expect(r.verifiedStructural).toBe(r.instances)
  const median = (xs: number[]): number =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
  expect.soft(median(r.styleWorkMs), 'style edit').toBeLessThanOrEqual(16)
  expect.soft(median(r.structuralWorkMs), 'structural edit').toBeLessThanOrEqual(50)
})

test('QA: main edits with 2,000 instances of a 50-node component', async ({ page }, info) => {
  await page.goto('/index.html?preset=propagation-2k&hud=0')
  await page.waitForFunction(() => window.__bench !== undefined)
  await page.evaluate(() => window.__bench.ready)
  const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(', ')
  const lines: string[] = []
  const reports = []
  // Zoom 1: the artboards around the viewport are live (400 instances); 0.27: the whole grid
  // is in view and the live-node cap (MAX_LIVE_NODES) keeps ~400 live, the rest stand-ins.
  for (const zoom of [1, 0.27]) {
    const r = await page.evaluate((z) => window.__bench.propagationLarge(z), zoom)
    reports.push(r)
    lines.push(
      `zoom ${r.zoom}: ${r.liveInstances}/${r.instances} instances live (${r.mountedNodes} live nodes)`,
      `  style edit on a main node  → frame work ${fmt(r.styleWorkMs)}; edit→paint ${fmt(r.styleLatencyMs)}`,
      `  text edit on a main node   → frame work ${fmt(r.textWorkMs)}; edit→paint ${fmt(r.textLatencyMs)}`,
      `  structural edit (add node) → frame work ${fmt(r.structuralWorkMs)}; edit→paint ${fmt(r.structuralLatencyMs)}`,
      `  keystroke in an override   → frame work ${fmt(r.overrideTextWorkMs)}`,
      `  updated in the timed frame: style ${r.verifiedStyle}, text ${r.verifiedText}, structural ${r.verifiedStructural}`,
    )
  }
  const text = lines.join('\n')
  console.log(`\n${text}\n`)
  await info.attach('propagation-2k.txt', { body: text, contentType: 'text/plain' })
  for (const r of reports) {
    expect(r.instances).toBe(2000)
    expect(r.liveInstances).toBeGreaterThanOrEqual(300)
    // Every live instance shows each edit in the very frame after it (no stragglers).
    expect(r.verifiedStyle).toBe(r.liveInstances)
    expect(r.verifiedText).toBe(r.liveInstances)
    expect(r.verifiedStructural).toBe(r.liveInstances)
  }
})

test('overlay technology: Canvas 2D vs SVG vs DOM (per-frame main-thread work)', async ({
  page,
}, info) => {
  await page.goto('/overlay.html')
  await page.waitForFunction(() => window.__overlayCompare !== undefined)
  const results = await page.evaluate(() => window.__overlayCompare.run())
  const text = results
    .map(
      (r) =>
        `${r.impl.padEnd(9)} work p50 ${r.workP50.toFixed(2)} ms  p95 ${r.workP95.toFixed(2)} ms  (${r.frames} frames)`,
    )
    .join('\n')
  console.log(
    `\noverlay comparison (49 labels, selection+handles+pill, hover, 8 remote cursors + selections)\n${text}\n`,
  )
  await info.attach('overlay-compare.txt', { body: text, contentType: 'text/plain' })
  expect(results).toHaveLength(3)
})

test('agent working edge: one overlay redraw ≤ 1 ms (Phase 4 §10.4)', async ({ page }, info) => {
  await page.goto('/overlay.html')
  await page.waitForFunction(() => window.__overlayCompare !== undefined)
  const r = await page.evaluate(() => window.__overlayCompare.agentRedraw())
  const text =
    `overlay redraw with one agent artboard (ring, glow, sweep, badge): p50 ${r.agentP50} ms, ` +
    `p95 ${r.agentP95} ms; without the agent p50 ${r.baseP50} ms, p95 ${r.baseP95} ms ` +
    `(${r.frames} frames)`
  console.log(`\n${text}\n`)
  await info.attach('agent-redraw.txt', { body: text, contentType: 'text/plain' })
  expect(r.agentP95).toBeLessThanOrEqual(1)
})
