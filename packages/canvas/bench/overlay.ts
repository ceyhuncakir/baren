import {
  DEFAULT_THEME,
  Overlay,
  emptyOverlayModel,
  type OverlayModel,
} from '../src/overlay/overlay.ts'
import type { Viewport } from '../src/types.ts'

/**
 * Overlay technology comparison: the same per-frame overlay content (artboard
 * labels, a selection box with handles and size pill, hover outline, remote
 * cursors with name pills and remote selections) drawn while the viewport pans
 * and zooms, by (a) the Canvas 2D overlay used in production, (b) SVG elements
 * updated through attributes, (c) absolutely positioned DOM elements updated
 * through transforms. Reports main-thread work per frame.
 */

const host = document.getElementById('host') as HTMLDivElement
const W = 1440
const H = 900
const LABELS = 49
const REMOTES = 8

function model(v: Viewport): OverlayModel {
  const m = emptyOverlayModel(v)
  for (let i = 0; i < LABELS; i++) {
    const x = (i % 7) * 1600
    const y = Math.floor(i / 7) * 1060
    m.labels.push({
      id: String(i),
      name: `Artboard ${i + 1} — Components`,
      bounds: { x, y, width: 1440, height: 900 },
      active: i === 3,
    })
  }
  m.selectionBox = { x: 4800, y: 0, width: 1440, height: 900 }
  m.selectionRects = [m.selectionBox]
  m.handles = true
  m.sizeLabel = '1440 × Fit'
  m.hover = { x: 1600, y: 1060, width: 1440, height: 900 }
  for (let i = 0; i < REMOTES; i++) {
    m.remotes.push({
      name: `Peer ${i}`,
      color: '#E5484D',
      cursor: { x: 800 + i * 900, y: 500 + i * 300 },
      rects: [{ x: (i % 7) * 1600, y: 2120, width: 1440, height: 900 }],
      ghosts: [],
    })
  }
  return m
}

interface Impl {
  draw(m: OverlayModel): void
  dispose(): void
}

function canvasImpl(): Impl {
  const o = new Overlay(host)
  o.resize(W, H, window.devicePixelRatio || 1)
  return { draw: (m) => o.draw(m), dispose: () => o.dispose() }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgImpl(): Impl {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(H))
  svg.style.cssText =
    'position:absolute;left:0;top:0;pointer-events:none;font:11px Inter, sans-serif'
  host.appendChild(svg)
  const mk = (tag: string, attrs: Record<string, string>): SVGElement => {
    const el = document.createElementNS(SVG_NS, tag)
    for (const k in attrs) el.setAttribute(k, attrs[k] as string)
    svg.appendChild(el)
    return el
  }
  const labels = Array.from({ length: LABELS }, () => mk('text', { fill: '#666' }))
  const outlines = Array.from({ length: 2 + REMOTES }, () =>
    mk('rect', { fill: 'none', stroke: DEFAULT_THEME.selection, 'stroke-width': '1.5' }),
  )
  const handles = Array.from({ length: 4 }, () =>
    mk('rect', { width: '6', height: '6', fill: '#fff', stroke: DEFAULT_THEME.selection }),
  )
  const pill = mk('rect', { height: '18', rx: '4', fill: DEFAULT_THEME.selection })
  const pillText = mk('text', { fill: '#fff' })
  const cursors = Array.from({ length: REMOTES }, () =>
    mk('path', {
      d: 'M0 0L0 15L4 11.5L7 18L9.5 17L6.5 10.5L11.5 10.5Z',
      fill: '#E5484D',
      stroke: '#fff',
    }),
  )
  const names = Array.from({ length: REMOTES }, () => mk('text', { fill: '#E5484D' }))
  return {
    draw(m) {
      const v = m.viewport
      const sx = (x: number): number => (x - v.x) * v.zoom
      const sy = (y: number): number => (y - v.y) * v.zoom
      m.labels.forEach((l, i) => {
        const t = labels[i] as SVGElement
        t.setAttribute('x', String(sx(l.bounds.x)))
        t.setAttribute('y', String(sy(l.bounds.y) - 8))
        if (t.textContent !== l.name) t.textContent = l.name
      })
      const rects = [m.selectionBox, m.hover, ...m.remotes.flatMap((r) => r.rects)]
      rects.forEach((r, i) => {
        const el = outlines[i]
        if (!r || !el) return
        el.setAttribute('x', String(sx(r.x)))
        el.setAttribute('y', String(sy(r.y)))
        el.setAttribute('width', String(r.width * v.zoom))
        el.setAttribute('height', String(r.height * v.zoom))
      })
      const b = m.selectionBox
      if (b) {
        const pts = [
          [b.x, b.y],
          [b.x + b.width, b.y],
          [b.x, b.y + b.height],
          [b.x + b.width, b.y + b.height],
        ]
        pts.forEach(([x, y], i) => {
          handles[i]?.setAttribute('x', String(sx(x as number) - 3))
          handles[i]?.setAttribute('y', String(sy(y as number) - 3))
        })
        pill.setAttribute('x', String(sx(b.x + b.width / 2) - 30))
        pill.setAttribute('y', String(sy(b.y + b.height) + 7))
        pill.setAttribute('width', '60')
        pillText.setAttribute('x', String(sx(b.x + b.width / 2) - 24))
        pillText.setAttribute('y', String(sy(b.y + b.height) + 20))
        pillText.textContent = m.sizeLabel
      }
      m.remotes.forEach((r, i) => {
        if (!r.cursor) return
        cursors[i]?.setAttribute('transform', `translate(${sx(r.cursor.x)} ${sy(r.cursor.y)})`)
        names[i]?.setAttribute('x', String(sx(r.cursor.x) + 12))
        names[i]?.setAttribute('y', String(sy(r.cursor.y) + 30))
        if (names[i] && names[i].textContent !== r.name) names[i].textContent = r.name
      })
    },
    dispose: () => svg.remove(),
  }
}

function domImpl(): Impl {
  const layer = document.createElement('div')
  layer.style.cssText =
    'position:absolute;inset:0;pointer-events:none;font:11px Inter, sans-serif;contain:strict'
  host.appendChild(layer)
  const mk = (css: string, text = ''): HTMLDivElement => {
    const el = document.createElement('div')
    el.style.cssText = `position:absolute;left:0;top:0;${css}`
    el.textContent = text
    layer.appendChild(el)
    return el
  }
  const labels = Array.from({ length: LABELS }, () => mk('color:#666;white-space:nowrap'))
  const outlines = Array.from({ length: 2 + REMOTES }, () =>
    mk(`outline:1.5px solid ${DEFAULT_THEME.selection}`),
  )
  const handles = Array.from({ length: 4 }, () =>
    mk(
      `width:6px;height:6px;box-sizing:border-box;background:#fff;border:1px solid ${DEFAULT_THEME.selection}`,
    ),
  )
  const pill = mk(
    `height:18px;line-height:18px;padding:0 6px;border-radius:4px;background:${DEFAULT_THEME.selection};color:#fff`,
  )
  const cursors = Array.from({ length: REMOTES }, () =>
    mk(
      'width:12px;height:18px;background:#E5484D;clip-path:polygon(0 0,0 83%,33% 64%,58% 100%,79% 94%,54% 58%,96% 58%)',
    ),
  )
  const names = Array.from({ length: REMOTES }, () =>
    mk(
      'height:18px;line-height:18px;padding:0 6px;border-radius:4px;background:#E5484D;color:#fff',
    ),
  )
  const place = (el: HTMLElement, x: number, y: number): void => {
    el.style.transform = `translate(${x}px, ${y}px)`
  }
  return {
    draw(m) {
      const v = m.viewport
      const sx = (x: number): number => (x - v.x) * v.zoom
      const sy = (y: number): number => (y - v.y) * v.zoom
      m.labels.forEach((l, i) => {
        const el = labels[i] as HTMLDivElement
        place(el, sx(l.bounds.x), sy(l.bounds.y) - 19)
        el.style.maxWidth = `${l.bounds.width * v.zoom}px`
        if (el.textContent !== l.name) el.textContent = l.name
      })
      const rects = [m.selectionBox, m.hover, ...m.remotes.flatMap((r) => r.rects)]
      rects.forEach((r, i) => {
        const el = outlines[i]
        if (!r || !el) return
        place(el, sx(r.x), sy(r.y))
        el.style.width = `${r.width * v.zoom}px`
        el.style.height = `${r.height * v.zoom}px`
      })
      const b = m.selectionBox
      if (b) {
        const pts = [
          [b.x, b.y],
          [b.x + b.width, b.y],
          [b.x, b.y + b.height],
          [b.x + b.width, b.y + b.height],
        ]
        pts.forEach(
          ([x, y], i) => handles[i] && place(handles[i], sx(x as number) - 3, sy(y as number) - 3),
        )
        place(pill, sx(b.x + b.width / 2) - 30, sy(b.y + b.height) + 7)
        if (pill.textContent !== m.sizeLabel) pill.textContent = m.sizeLabel
      }
      m.remotes.forEach((r, i) => {
        if (!r.cursor) return
        if (cursors[i]) place(cursors[i], sx(r.cursor.x), sy(r.cursor.y))
        if (names[i]) {
          place(names[i], sx(r.cursor.x) + 10, sy(r.cursor.y) + 18)
          if (names[i].textContent !== r.name) names[i].textContent = r.name
        }
      })
    },
    dispose: () => layer.remove(),
  }
}

export interface OverlayCompareResult {
  impl: string
  frames: number
  workP50: number
  workP95: number
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return (
    Math.round((s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0) * 100) / 100
  )
}

async function measure(name: string, impl: Impl, frames = 300): Promise<OverlayCompareResult> {
  const work: number[] = []
  const ch = new MessageChannel()
  ch.port1.onmessage = (m: MessageEvent<number>): void => {
    work.push(performance.now() - m.data)
  }
  await new Promise<void>((resolve) => {
    let i = 0
    const tick = (): void => {
      if (i >= frames) {
        resolve()
        return
      }
      const t = performance.now()
      // Pan + gentle zoom so every element moves every frame.
      const zoom = 0.12 + 0.02 * Math.sin(i / 30)
      impl.draw(
        model({
          x: -200 + 400 * Math.sin(i / 50),
          y: -200 + 300 * Math.cos(i / 40),
          zoom,
          width: W,
          height: H,
        }),
      )
      ch.port2.postMessage(t)
      i++
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await new Promise((r) => setTimeout(r, 20))
  ch.port1.close()
  impl.dispose()
  return { impl: name, frames, workP50: pct(work, 50), workP95: pct(work, 95) }
}

async function run(): Promise<OverlayCompareResult[]> {
  const out: OverlayCompareResult[] = []
  // Warm up fonts/JIT once per implementation, then measure.
  for (const [name, make] of [
    ['canvas2d', canvasImpl],
    ['svg', svgImpl],
    ['dom', domImpl],
  ] as const) {
    await measure(name, make(), 30)
    out.push(await measure(name, make()))
  }
  return out
}

export interface AgentRedrawResult {
  frames: number
  /** Synchronous Overlay.draw time per frame (ms) with one agent artboard on screen. */
  agentP50: number
  agentP95: number
  /** The same scene without the agent (labels only), for the delta. */
  baseP50: number
  baseP95: number
}

/**
 * Phase 4 §10.4 budget: with one agent artboard visible (ring, halo, glow, island — the
 * pricing artboard of 35 at 100 %) one overlay redraw stays ≤ 1 ms.
 */
async function agentRedraw(frames = 240): Promise<AgentRedrawResult> {
  const o = new Overlay(host)
  o.resize(W, H, window.devicePixelRatio || 1)
  const v: Viewport = { x: -252, y: -146, zoom: 1, width: W, height: H }
  const scene = (agent: boolean): OverlayModel => {
    const m = emptyOverlayModel(v)
    const bounds = { x: 0, y: 0, width: 600, height: 454 }
    m.labels.push({
      id: 'pricing',
      name: 'Pricing — Desktop',
      bounds,
      active: false,
      ...(agent ? { badge: 'Claude Code' } : {}),
    })
    m.labels.push({
      id: 'main',
      name: 'Button / Primary',
      bounds: { x: -212, y: 0, width: 168, height: 44 },
      active: false,
      component: true,
    })
    if (agent) m.agents.push({ id: 'pricing', bounds, badge: 'Claude Code' })
    return m
  }
  const time = async (agent: boolean, n: number): Promise<number[]> => {
    const out: number[] = []
    await new Promise<void>((resolve) => {
      let i = 0
      const tick = (): void => {
        if (i >= n) {
          resolve()
          return
        }
        const t = performance.now()
        o.draw(scene(agent))
        out.push(performance.now() - t)
        i++
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return out
  }
  await time(true, 30)
  const agent = await time(true, frames)
  const base = await time(false, frames)
  o.dispose()
  return {
    frames,
    agentP50: pct(agent, 50),
    agentP95: pct(agent, 95),
    baseP50: pct(base, 50),
    baseP95: pct(base, 95),
  }
}

declare global {
  interface Window {
    __overlayCompare: {
      run: () => Promise<OverlayCompareResult[]>
      agentRedraw: (frames?: number) => Promise<AgentRedrawResult>
    }
  }
}
window.__overlayCompare = { run, agentRedraw }
