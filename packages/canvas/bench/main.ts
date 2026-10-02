import {
  benchDocNodeCount,
  createComponent,
  createEmptyDoc,
  createInstance,
  createNode,
  docGeometry,
  generateBenchDoc,
  getChildIds,
  getNode,
  listComponents,
  resetOverrides,
  setStyle,
  setText,
  setTextAt,
  toSnapshot,
  transact,
  type BenchDocOptions,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { createCanvas, type CanvasController } from '../src/index.ts'
import { loadFonts } from './fonts.ts'

/**
 * Canvas perf bench. `?preset=20k|50k|20k-mixed|propagation|propagation-2k` (or
 * `?artboards=&nodes=`), `?hud=0` hides the HUD. `window.__bench.run()` plays a scripted
 * pan/zoom session by dispatching one wheel event per animation frame through the real input
 * path and reports per-phase frame timings. `propagation()` times main-component edits with
 * ~1,000 loaded instances; `propagationLarge(zoom)` does the same for 2,000 instances of a
 * 50-node component (QA); `dropTargets()` times the reparent drop-target search.
 */

type Preset = Pick<BenchDocOptions, 'artboards' | 'nodesPerArtboard' | 'components' | 'vectors'>

const PRESETS: Record<string, Preset> = {
  '20k': { artboards: 40, nodesPerArtboard: 500 },
  '50k': { artboards: 100, nodesPerArtboard: 500 },
  // Contract 9: ~10 % of leaves are instances of 12-node mains, 5 % 8-point vectors.
  '20k-mixed': {
    artboards: 40,
    nodesPerArtboard: 500,
    components: { mains: 10, everyNth: 10 },
    vectors: { everyNth: 20 },
  },
  // Every leaf an instance of one main: 3 × 48 sections × 7 = 1,008 instances, all loaded.
  propagation: { artboards: 3, nodesPerArtboard: 384, components: { mains: 1, everyNth: 1 } },
}

/** QA: 2,000 instances of one 50-node main (20 artboards × 100 instances). */
const LARGE = { artboards: 20, perArtboard: 100, cols: 10, w: 96, h: 56, gap: 4, pad: 8 }

/**
 * The `propagation-2k` document: a "Tile" main (root + 7 rows × (5 rects + 1 text) = 50
 * nodes) on its own artboard and 2,000 absolutely positioned instances of it in 20 artboards
 * laid out 5 × 4, so all of them are live at 27 % zoom.
 */
function largeComponentDoc(): LoroDoc {
  const doc = createEmptyDoc('Bench 2k instances', { peerId: 1 })
  const pageId = getChildIds(doc, null)[0] as string
  transact(
    doc,
    () => {
      const tile = createNode(doc, {
        type: 'frame',
        parentId: pageId,
        name: 'Tile',
        styles: {
          left: 0,
          top: -200,
          width: LARGE.w,
          height: LARGE.h,
          backgroundColor: '#FFFFFF',
          overflow: 'hidden',
        },
      })
      for (let r = 0; r < 7; r++) {
        const row = createNode(doc, {
          type: 'frame',
          parentId: tile,
          name: `Row ${r}`,
          styles: { position: 'absolute', left: 2, top: 2 + r * 7.5, width: 92, height: 7 },
        })
        for (let k = 0; k < 5; k++) {
          createNode(doc, {
            type: 'rect',
            parentId: row,
            name: `Cell ${k}`,
            styles: {
              position: 'absolute',
              left: k * 10,
              top: 1,
              width: 8,
              height: 5,
              backgroundColor: '#C7CEDB',
            },
          })
        }
        createNode(doc, {
          type: 'text',
          parentId: row,
          name: 'Label',
          text: `row ${r}`,
          styles: {
            position: 'absolute',
            left: 52,
            top: 0,
            fontFamily: 'Inter',
            fontSize: '6px',
            lineHeight: '7px',
            color: '#33405A',
          },
        })
      }
      createComponent(doc, [tile], docGeometry(doc))
      const key = getNode(doc, tile)?.componentKey as string
      const abW = LARGE.cols * LARGE.w + (LARGE.cols - 1) * LARGE.gap + 2 * LARGE.pad
      const rows = Math.ceil(LARGE.perArtboard / LARGE.cols)
      const abH = rows * LARGE.h + (rows - 1) * LARGE.gap + 2 * LARGE.pad
      for (let a = 0; a < LARGE.artboards; a++) {
        const board = createNode(doc, {
          type: 'frame',
          parentId: pageId,
          name: `Board ${a + 1}`,
          styles: {
            left: (a % 5) * (abW + 30),
            top: Math.floor(a / 5) * (abH + 30),
            width: abW,
            height: abH,
            backgroundColor: '#F4F6FA',
          },
        })
        for (let i = 0; i < LARGE.perArtboard; i++) {
          createInstance(doc, {
            componentKey: key,
            parentId: board,
            styles: {
              position: 'absolute',
              left: LARGE.pad + (i % LARGE.cols) * (LARGE.w + LARGE.gap),
              top: LARGE.pad + Math.floor(i / LARGE.cols) * (LARGE.h + LARGE.gap),
            },
          })
        }
      }
    },
    { origin: 'bench' },
  )
  return doc
}

const params = new URLSearchParams(location.search)
const presetName = params.get('preset') ?? '20k'
const preset = PRESETS[presetName] ?? PRESETS['20k']!
const artboards = Number(params.get('artboards') ?? preset.artboards)
const nodesPerArtboard = Number(params.get('nodes') ?? preset.nodesPerArtboard)
const showHud = params.get('hud') !== '0'
const docOptions: BenchDocOptions = {
  artboards,
  nodesPerArtboard,
  ...(preset.components ? { components: preset.components } : {}),
  ...(preset.vectors ? { vectors: preset.vectors } : {}),
}

export interface PhaseStats {
  name: string
  kind: 'gesture' | 'settle'
  frames: number
  /** Main-thread time per frame: rAF callbacks + style/layout/paint/commit (ms). */
  workP50: number
  workP95: number
  workMax: number
  /** rAF-to-rAF interval (ms); capped by vsync unless the browser runs uncapped. */
  intervalP50: number
  intervalP95: number
  longTasks: number
  longTaskMaxMs: number
  zoom: number
  mountedNodes: number
  mountedArtboards: number
  thumbnails: number
  lod: boolean
}

export interface BenchReport {
  nodes: number
  artboards: number
  generateMs: number
  createCanvasMs: number
  firstFrameMs: number
  viewport: { width: number; height: number }
  phases: PhaseStats[]
}

export interface PropagationReport {
  instances: number
  mountedNodes: number
  /** Main-thread work of the frame that applies a style edit on the main (ms). */
  styleWorkMs: number[]
  /** Same for a structural edit (a node added to the main). */
  structuralWorkMs: number[]
  /** Same for a text override typed into one instance, and a plain text edit. */
  overrideTextWorkMs: number[]
  plainTextWorkMs: number[]
  /** Instances whose rendered dot / child count matched the edits right after each frame. */
  verifiedStyle: number
  verifiedStructural: number
}

export interface LargePropagationReport {
  zoom: number
  /** Instances in the document / with live DOM in the measured frames. */
  instances: number
  liveInstances: number
  mountedNodes: number
  /** Frame work (rAF → after paint) of the frame applying the edit, and the full latency
   *  from the edit call to that frame's paint (includes the commit and Loro events). */
  styleWorkMs: number[]
  styleLatencyMs: number[]
  textWorkMs: number[]
  textLatencyMs: number[]
  structuralWorkMs: number[]
  structuralLatencyMs: number[]
  overrideTextWorkMs: number[]
  /** Live instances showing each edit right after its frame. */
  verifiedStyle: number
  verifiedText: number
  verifiedStructural: number
}

export interface DropTargetReport {
  calls: number
  mountedNodes: number
  p50: number
  p95: number
  max: number
}

interface BenchApi {
  ready: Promise<void>
  controller: () => CanvasController
  run: () => Promise<BenchReport>
  propagation: () => Promise<PropagationReport>
  propagationLarge: (zoom: number) => Promise<LargePropagationReport>
  dropTargets: (calls?: number) => Promise<DropTargetReport>
  report: BenchReport | null
}

declare global {
  interface Window {
    __bench: BenchApi
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round((sorted[i] as number) * 1000) / 1000
}

const nextFrame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r))

const stage = document.getElementById('stage') as HTMLDivElement
const hud = document.getElementById('hud') as HTMLPreElement
let controller: CanvasController | null = null
let benchDoc: LoroDoc | null = null
const timings = { generateMs: 0, createCanvasMs: 0, firstFrameMs: 0 }

async function setup(): Promise<void> {
  await loadFonts()
  const t0 = performance.now()
  const doc = presetName === 'propagation-2k' ? largeComponentDoc() : generateBenchDoc(docOptions)
  benchDoc = doc
  const t1 = performance.now()
  const pageId = getChildIds(doc, null)[0]
  if (!pageId) throw new Error('bench doc has no page')
  controller = createCanvas({ container: stage, doc, pageId, viewport: 'fit' })
  const t2 = performance.now()
  await nextFrame()
  await nextFrame()
  timings.generateMs = Math.round(t1 - t0)
  timings.createCanvasMs = Math.round(t2 - t1)
  timings.firstFrameMs = Math.round(performance.now() - t1)
  if (showHud) startHud()
}

function startHud(): void {
  let last = performance.now()
  let frames = 0
  let fps = 0
  const loop = (): void => {
    frames++
    const now = performance.now()
    if (now - last >= 500) {
      fps = (frames * 1000) / (now - last)
      frames = 0
      last = now
      const c = controller
      if (c) {
        const s = c.getStats()
        const v = c.getViewport()
        hud.textContent =
          `${benchDocNodeCount(docOptions)} nodes · ${fps.toFixed(0)} fps\n` +
          `zoom ${(v.zoom * 100).toFixed(1)}% · lod ${s.lod ? 'on' : 'off'}\n` +
          `live ${s.mountedArtboards} ab / ${s.mountedNodes} nodes · thumbs ${s.thumbnails}`
      }
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

// -----------------------------------------------------------------------------
// Scripted session
// -----------------------------------------------------------------------------

type WheelInit = { deltaX?: number; deltaY?: number; ctrlKey?: boolean }

interface GestureStep {
  kind: 'gesture'
  name: string
  frames: number
  event: (i: number, zoom: number) => WheelInit | null
}
interface SettleStep {
  kind: 'settle'
  name: string
  ms: number
}
type Step = GestureStep | SettleStep

/** Wheel deltaY (ctrl) that multiplies zoom by `factor` (inverse of wheelZoomFactor). */
function zoomDelta(factor: number): number {
  return -Math.log2(factor) / 0.01
}

/** Zoom from the current value to `target` over `frames` frames. */
function zoomTo(name: string, target: number, frames: number): GestureStep {
  return {
    kind: 'gesture',
    name,
    frames,
    event: (i, zoom) => {
      const remaining = frames - i
      if (remaining <= 0) return null
      const f = Math.pow(target / zoom, 1 / remaining)
      return { ctrlKey: true, deltaY: Math.max(-32, Math.min(32, zoomDelta(f))) }
    },
  }
}

/** Oscillating pan (screen px per frame) whose cumulative offset stays within ±amplitude. */
function sway(amplitude: number, period: number): (i: number) => WheelInit {
  const k = (2 * Math.PI) / period
  return (i) => ({
    deltaX: amplitude * k * Math.cos(i * k),
    deltaY: 0.6 * amplitude * k * Math.sin(i * k),
  })
}

// Pans oscillate around the content centre so every phase stays over artboards.
const SCRIPT: Step[] = [
  { kind: 'settle', name: 'settle-fit', ms: 2500 },
  { kind: 'gesture', name: 'pan-overview', frames: 240, event: sway(300, 240) },
  zoomTo('zoom-in-to-100%', 1, 150),
  { kind: 'gesture', name: 'pan-100%-unmounted', frames: 240, event: sway(1800, 240) },
  { kind: 'settle', name: 'settle-100%', ms: 2500 },
  { kind: 'gesture', name: 'pan-100%-mounted', frames: 240, event: sway(1200, 240) },
  zoomTo('zoom-out-to-2%', 0.02, 150),
  { kind: 'settle', name: 'settle-2%', ms: 2500 },
  { kind: 'gesture', name: 'pan-2%', frames: 240, event: sway(300, 240) },
  zoomTo('zoom-in-to-50%', 0.5, 150),
  { kind: 'settle', name: 'settle-50%', ms: 3000 },
  { kind: 'gesture', name: 'pan-50%-mounted', frames: 240, event: sway(1200, 240) },
]

function observeLongTasks(): { stop: () => number[] } {
  const durations: number[] = []
  let obs: PerformanceObserver | null = null
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) durations.push(e.duration)
    })
    obs.observe({ type: 'longtask', buffered: false })
  } catch {
    obs = null
  }
  return {
    stop: () => {
      if (obs) {
        for (const e of obs.takeRecords()) durations.push(e.duration)
        obs.disconnect()
      }
      return durations
    },
  }
}

async function runStep(c: CanvasController, root: HTMLElement, step: Step): Promise<PhaseStats> {
  const rect = root.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const work: number[] = []
  const intervals: number[] = []
  const channel = new MessageChannel()
  channel.port1.onmessage = (m: MessageEvent<number>): void => {
    work.push(performance.now() - m.data)
  }
  const lt = observeLongTasks()
  let frames = 0
  await new Promise<void>((resolve) => {
    let lastTs = 0
    const start = performance.now()
    const tick = (ts: number): void => {
      const t = performance.now()
      if (lastTs) intervals.push(ts - lastTs)
      lastTs = ts
      if (step.kind === 'gesture') {
        if (frames >= step.frames) {
          resolve()
          return
        }
        const init = step.event(frames, c.getViewport().zoom)
        if (init) {
          root.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: cx,
              clientY: cy,
              deltaMode: 0,
              deltaX: init.deltaX ?? 0,
              deltaY: init.deltaY ?? 0,
              ctrlKey: init.ctrlKey ?? false,
            }),
          )
        }
      } else if (t - start >= step.ms) {
        resolve()
        return
      }
      frames++
      channel.port2.postMessage(t)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  // Let the last frame's message arrive.
  await new Promise((r) => setTimeout(r, 0))
  const long = lt.stop()
  channel.port1.close()
  const s = c.getStats()
  return {
    name: step.name,
    kind: step.kind,
    frames,
    workP50: percentile(work, 50),
    workP95: percentile(work, 95),
    workMax: percentile(work, 100),
    intervalP50: percentile(intervals, 50),
    intervalP95: percentile(intervals, 95),
    longTasks: long.length,
    longTaskMaxMs: Math.round(Math.max(0, ...long)),
    zoom: Math.round(c.getViewport().zoom * 1000) / 1000,
    mountedNodes: s.mountedNodes,
    mountedArtboards: s.mountedArtboards,
    thumbnails: s.thumbnails,
    lod: s.lod,
  }
}

async function run(): Promise<BenchReport> {
  await api.ready
  const c = controller
  const root = stage.querySelector<HTMLElement>('.ic-root')
  if (!c || !root) throw new Error('canvas not mounted')
  hud.style.display = 'none'
  const phases: PhaseStats[] = []
  for (const step of SCRIPT) phases.push(await runStep(c, root, step))
  const v = c.getViewport()
  const report: BenchReport = {
    nodes: benchDocNodeCount(docOptions),
    artboards,
    ...timings,
    viewport: { width: v.width, height: v.height },
    phases,
  }
  api.report = report
  hud.style.display = ''
  return report
}

/** Main-thread work of the next frame after `edit()` (rAF start → after paint). */
function frameWorkAfter(edit: () => void): Promise<number> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = (m: MessageEvent<number>): void => {
      channel.port1.close()
      resolve(Math.round((performance.now() - m.data) * 100) / 100)
    }
    // Registered before the edit: Loro delivers change events synchronously on commit, so
    // the canvas requests its frame inside `edit()`. Registering first makes this callback
    // run before the canvas's in that frame, so the measurement covers the canvas's work.
    requestAnimationFrame(() => channel.port2.postMessage(performance.now()))
    edit()
  })
}

async function settled(c: CanvasController): Promise<void> {
  for (let i = 0; i < 600; i++) {
    await nextFrame()
    if (c.getStats().pendingWork === 0 && i > 10) {
      await new Promise((r) => setTimeout(r, 200))
      await nextFrame()
      if (c.getStats().pendingWork === 0) return
    }
  }
}

async function propagation(): Promise<PropagationReport> {
  await api.ready
  const c = controller
  const doc = benchDoc
  if (!c || !doc) throw new Error('not ready')
  await settled(c)
  const main = listComponents(doc)[0]
  if (!main) throw new Error('bench doc has no component')
  const mainNode = getNode(doc, main.mainId)
  const row = mainNode?.children.map((id) => getNode(doc, id)).find((n) => n?.name === 'Row')
  const dot = row?.children[0]
  const title = mainNode?.children[0]
  if (!mainNode || !dot || !title) throw new Error('unexpected main structure')
  const virtual = [...document.querySelectorAll('[data-nid*="/"]')].map(
    (el) => el.getAttribute('data-nid') as string,
  )
  const report: PropagationReport = {
    instances: new Set(virtual.map((v) => v.split('/')[0])).size,
    mountedNodes: c.getStats().mountedNodes,
    styleWorkMs: [],
    structuralWorkMs: [],
    overrideTextWorkMs: [],
    plainTextWorkMs: [],
    verifiedStyle: 0,
    verifiedStructural: 0,
  }
  const dotKey = getNode(doc, dot)?.nodeKey as string
  const instanceIds = [...new Set(virtual.map((v) => v.split('/')[0] as string))]
  /** Instances whose rendered dot has `color` (checked right after the edit's frame). */
  const countColored = (color: string): number =>
    instanceIds.filter((id) => {
      const el = document.querySelector<HTMLElement>(`[data-nid="${id}/${dotKey}"]`)
      return el?.style.backgroundColor === color
    }).length
  const countChildren = (n: number): number =>
    instanceIds.filter(
      (id) => document.querySelector(`[data-nid="${id}"]`)?.childElementCount === n,
    ).length
  // Typing: one keystroke into an instance's title override vs into a plain text layer.
  const titleKey = getNode(doc, title)?.nodeKey as string
  const firstInstance = virtual[0]?.split('/')[0] as string
  const section = getNode(doc, firstInstance)?.parentId as string
  const plain = transact(
    doc,
    () =>
      createNode(doc, {
        type: 'text',
        parentId: section,
        name: 'Plain',
        text: 'Plain',
        styles: { fontFamily: 'Inter', fontSize: '13px', lineHeight: '18px' },
      }),
    { origin: 'bench' },
  )
  await settled(c)
  for (let i = 0; i < 5; i++) {
    const text = `Typed ${'x'.repeat(i + 1)}`
    report.overrideTextWorkMs.push(
      await frameWorkAfter(() =>
        setTextAt(doc, `${firstInstance}/${titleKey}`, text, { origin: 'bench' }),
      ),
    )
    await settled(c)
    report.plainTextWorkMs.push(
      await frameWorkAfter(() =>
        transact(doc, () => setText(doc, plain, text), { origin: 'bench' }),
      ),
    )
    await settled(c)
  }
  const colors = ['#FF0000', '#00AA00', '#0000FF', '#FFAA00', '#AA00FF']
  const rgb = [
    'rgb(255, 0, 0)',
    'rgb(0, 170, 0)',
    'rgb(0, 0, 255)',
    'rgb(255, 170, 0)',
    'rgb(170, 0, 255)',
  ]
  for (let i = 0; i < 5; i++) {
    report.styleWorkMs.push(
      await frameWorkAfter(() =>
        transact(doc, () => setStyle(doc, dot, 'backgroundColor', colors[i] as string), {
          origin: 'bench',
        }),
      ),
    )
    report.verifiedStyle = countColored(rgb[i] as string)
    await settled(c)
  }
  const children0 = mainNode.children.length
  for (let i = 0; i < 3; i++) {
    report.structuralWorkMs.push(
      await frameWorkAfter(() =>
        transact(
          doc,
          () =>
            createNode(doc, {
              type: 'rect',
              parentId: main.mainId,
              name: `Added ${i}`,
              styles: { width: 20, height: 4, backgroundColor: '#141414' },
            }),
          { origin: 'bench' },
        ),
      ),
    )
    report.verifiedStructural = countChildren(children0 + i + 1)
    await settled(c)
  }
  return report
}

/** Frame work and edit → painted latency of the frame that follows `edit()`. */
function timedEdit(edit: () => void): Promise<{ work: number; latency: number }> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let frameStart = 0
    channel.port1.onmessage = (): void => {
      channel.port1.close()
      const end = performance.now()
      resolve({
        work: Math.round((end - frameStart) * 100) / 100,
        latency: Math.round((end - t0) * 100) / 100,
      })
    }
    // Before the edit (see frameWorkAfter): this callback runs first in the next frame.
    requestAnimationFrame(() => {
      frameStart = performance.now()
      channel.port2.postMessage(0)
    })
    const t0 = performance.now()
    edit()
  })
}

/**
 * QA: main edits with 2,000 instances of a 50-node component (`?preset=propagation-2k`),
 * viewed at `zoom` from the top-left of the instance grid (0.27: all 2,000 live; 1: one
 * artboard, the others unloaded). Every edit is checked on the live instances right after
 * the timed frame.
 */
async function propagationLarge(zoom: number): Promise<LargePropagationReport> {
  await api.ready
  const c = controller
  const doc = benchDoc
  if (!c || !doc) throw new Error('not ready')
  c.setViewport({ x: -10, y: -10, zoom })
  await settled(c)
  const main = listComponents(doc)[0]
  if (!main) throw new Error('no component')
  const root = getNode(doc, main.mainId)
  const row0 = getNode(doc, root?.children[0] as string)
  const cell = row0?.children[0] as string
  const label = row0?.children[5] as string
  const cellKey = getNode(doc, cell)?.nodeKey as string
  const labelKey = getNode(doc, label)?.nodeKey as string
  const instances = Object.values(toSnapshot(doc).nodes).filter((n) => n.type === 'instance')
  const live = instances
    .map((n) => n.id)
    .filter((id) => document.querySelector(`[data-nid="${id}"]`) !== null)
  const report: LargePropagationReport = {
    zoom,
    instances: instances.length,
    liveInstances: live.length,
    mountedNodes: c.getStats().mountedNodes,
    styleWorkMs: [],
    styleLatencyMs: [],
    textWorkMs: [],
    textLatencyMs: [],
    structuralWorkMs: [],
    structuralLatencyMs: [],
    overrideTextWorkMs: [],
    verifiedStyle: 0,
    verifiedText: 0,
    verifiedStructural: 0,
  }
  const colored = (rgb: string): number =>
    live.filter(
      (id) =>
        document.querySelector<HTMLElement>(`[data-nid="${id}/${cellKey}"]`)?.style
          .backgroundColor === rgb,
    ).length
  const texted = (t: string): number =>
    live.filter((id) => document.querySelector(`[data-nid="${id}/${labelKey}"]`)?.textContent === t)
      .length
  const colors: [string, string][] = [
    ['#FF0000', 'rgb(255, 0, 0)'],
    ['#00AA00', 'rgb(0, 170, 0)'],
    ['#0000FF', 'rgb(0, 0, 255)'],
    ['#FFAA00', 'rgb(255, 170, 0)'],
    ['#AA00FF', 'rgb(170, 0, 255)'],
  ]
  for (const [hex, rgb] of colors) {
    const t = await timedEdit(() =>
      transact(doc, () => setStyle(doc, cell, 'backgroundColor', hex), { origin: 'bench' }),
    )
    report.styleWorkMs.push(t.work)
    report.styleLatencyMs.push(t.latency)
    report.verifiedStyle = colored(rgb)
    await settled(c)
  }
  for (let i = 0; i < 5; i++) {
    const text = `edit ${i}`
    const t = await timedEdit(() =>
      transact(doc, () => setText(doc, label, text), { origin: 'bench' }),
    )
    report.textWorkMs.push(t.work)
    report.textLatencyMs.push(t.latency)
    report.verifiedText = texted(text)
    await settled(c)
  }
  for (let i = 0; i < 5; i++) {
    const t = await timedEdit(() =>
      setTextAt(doc, `${live[0]}/${labelKey}`, `typed ${'x'.repeat(i + 1)}`, { origin: 'bench' }),
    )
    report.overrideTextWorkMs.push(t.work)
    await settled(c)
  }
  // Leave no override behind (a later run checks main text edits on every live instance).
  resetOverrides(doc, live[0] as string, { origin: 'bench' })
  await settled(c)
  const row = root?.children[1] as string
  const before = getNode(doc, row)?.children.length ?? 0
  for (let i = 0; i < 3; i++) {
    const t = await timedEdit(() =>
      transact(
        doc,
        () =>
          createNode(doc, {
            type: 'rect',
            parentId: row,
            name: `Added ${i}`,
            styles: {
              position: 'absolute',
              left: 80 + i * 3,
              top: 1,
              width: 2,
              height: 5,
              backgroundColor: '#141414',
            },
          }),
        { origin: 'bench' },
      ),
    )
    report.structuralWorkMs.push(t.work)
    report.structuralLatencyMs.push(t.latency)
    const rowKey = getNode(doc, row)?.nodeKey as string
    report.verifiedStructural = live.filter(
      (id) =>
        document.querySelector(`[data-nid="${id}/${rowKey}"]`)?.childElementCount ===
        before + i + 1,
    ).length
    await settled(c)
  }
  return report
}

async function dropTargets(calls = 400): Promise<DropTargetReport> {
  await api.ready
  const c = controller
  const root = stage.querySelector<HTMLElement>('.ic-root')
  if (!c || !root) throw new Error('not ready')
  const r = root.getBoundingClientRect()
  let seed = 1
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const times: number[] = []
  for (let i = 0; i < calls; i++) {
    const client = { clientX: r.left + rand() * r.width, clientY: r.top + rand() * r.height }
    const t0 = performance.now()
    c.dropTargetAt(client, { deep: true })
    times.push(performance.now() - t0)
  }
  c.dropTargetAt(null)
  return {
    calls,
    mountedNodes: c.getStats().mountedNodes,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: percentile(times, 100),
  }
}

const api: BenchApi = {
  ready: setup(),
  controller: () => {
    if (!controller) throw new Error('not ready')
    return controller
  },
  run,
  propagation,
  propagationLarge,
  dropTargets,
  report: null,
}
window.__bench = api
