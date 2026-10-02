import { frameCorners, type NodeFrame } from '@baren/schema'
import type { Guide } from '../math/snap.ts'
import { worldRectToScreen, worldToScreen } from '../math/viewport.ts'
import type { OverlayTheme, Point, Rect, Viewport } from '../types.ts'

/**
 * Screen-space overlay drawn with Canvas 2D: artboard labels, hover and
 * selection outlines, resize handles, the size pill, marquee, snapping guides,
 * insertion indicator, drawing preview and remote cursors/selections.
 *
 * One canvas redraw per frame costs well under a millisecond for typical
 * scenes and never touches layout, unlike an SVG/DOM overlay whose elements
 * would need per-frame attribute writes plus style/layout/paint.
 * Values follow artboards 05/06/14: selection #2F80FF 1.5px outline,
 * 6×6 white handles with a 1px blue border, an 18px blue size pill (11px/500
 * white text, radius 4) 7px below the box, 11px labels 5px above artboards.
 *
 * Agents (Phase 4 contract §10.4, artboard 35): every artboard an MCP agent is working on gets
 * a 2 px ring in --color-agent-ring just outside it, a --color-agent-glow glow (CSS
 * `0 0 18px 2px`), a bright sweep travelling clockwise around the ring (one lap per 2.4 s; a
 * static 1.5 px --color-overlay-agent ring under prefers-reduced-motion) and one
 * "<name> is working" badge right-aligned in its label row. While a sweep is on screen
 * `animating` is true and the controller redraws the overlay at ≤ 30 fps.
 *
 * Colours are app chrome and follow the host's theme: unless the host passes them in
 * `theme`, they are read from CSS custom properties (THEME_VARS) on the canvas container,
 * and re-read when `<html>`'s `data-theme` or `class` changes. Hosts without those
 * properties get DEFAULT_THEME (the light values).
 */

export const DEFAULT_THEME: OverlayTheme = {
  selection: '#2F80FF',
  handleFill: '#FFFFFF',
  label: '#666666',
  labelActive: '#2F80FF',
  snap: '#FF3B5C',
  marqueeFill: 'rgba(47, 128, 255, 0.08)',
  component: '#7B4DFF',
  agent: '#D21F75',
  agentRing: 'rgba(210, 31, 117, 0.32)',
  agentGlow: 'rgba(210, 31, 117, 0.18)',
  fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
}

/** CSS custom properties that theme the overlay (@baren/ui tokens.css, "canvas chrome"). */
export const THEME_VARS = {
  selection: '--color-overlay-selection',
  handleFill: '--color-overlay-handle',
  label: '--color-overlay-label',
  labelActive: '--color-overlay-label-active',
  snap: '--color-overlay-snap',
  marqueeFill: '--color-overlay-marquee',
  component: '--color-overlay-component',
  agent: '--color-overlay-agent',
  agentRing: '--color-agent-ring',
  agentGlow: '--color-agent-glow',
} as const satisfies Partial<Record<keyof OverlayTheme, string>>

const THEMED_KEYS = Object.keys(THEME_VARS) as (keyof typeof THEME_VARS)[]

/** Text and strokes on the selection / collaborator colours: white in every theme. */
const ON_ACCENT = '#FFFFFF'

export interface OverlayLabel {
  id: string
  name: string
  /** World bounds of the artboard. */
  bounds: Rect
  active: boolean
  /** Main component: drawn with the component icon and colour. */
  component?: boolean
  /** An agent works on this artboard: the name leaves room for this badge text. */
  badge?: string
}

/** An artboard an agent is working on (screen-space ring, glow, sweep and badge). */
export interface AgentOverlay {
  id: string
  /** World bounds of the artboard. */
  bounds: Rect
  /** "Claude Code is working". */
  badge: string
}

export interface RemoteOverlay {
  name: string
  color: string
  cursor: Point | null
  rects: (Rect | NodeFrame)[]
  ghosts: Rect[]
}

/** The pen tool's path being drawn (world coordinates). */
export interface PenOverlay {
  points: { x: number; y: number; in?: Point; out?: Point }[]
  /** Rubber band end (pointer), null while it is outside the canvas. */
  pointer: Point | null
  /** The pointer is over the first point (clicking closes the path). */
  closing: boolean
}

/** Vector edit mode (world coordinates). */
export interface VectorEditOverlay {
  /** The edited path (local px of `frame`), outlined in the selection colour. */
  path: { d: string; frame: NodeFrame } | null
  anchors: { p: Point; selected: boolean }[]
  handles: { anchor: Point; handle: Point }[]
  /** Where a click would insert a point. */
  insert: Point | null
}

export interface OverlayModel {
  viewport: Viewport
  labels: OverlayLabel[]
  hover: Rect | NodeFrame | null
  /** Individual outlines (shown for multi-selection). */
  selectionRects: (Rect | NodeFrame)[]
  selectionBox: Rect | null
  /** Outline + handles: the rotated frame of a single selected node, else `selectionBox`. */
  selectionFrame: NodeFrame | null
  sizeLabel: string | null
  handles: boolean
  editing: Rect | NodeFrame | null
  marquee: Rect | null
  guides: readonly Guide[]
  insertion: { a: Point; b: Point } | null
  draft: Rect | null
  draftLabel: string | null
  /** Drop target (files, reparent): tinted and outlined. */
  drop: Rect | NodeFrame | null
  /** Live rotation angle pill next to the pointer (screen position). */
  angle: { text: string; at: Point } | null
  pen: PenOverlay | null
  vector: VectorEditOverlay | null
  /** Selection drawn in the component colour (mains, instances, their content). */
  componentAccent: boolean
  /** The main of a selected instance: a 1 px component-colour outline 2 px outside it. */
  mainOutline: Rect | NodeFrame | null
  remotes: RemoteOverlay[]
  /** Visible artboards with working agents. */
  agents: AgentOverlay[]
}

export function emptyOverlayModel(viewport: Viewport): OverlayModel {
  return {
    viewport,
    labels: [],
    hover: null,
    selectionRects: [],
    selectionBox: null,
    selectionFrame: null,
    sizeLabel: null,
    handles: false,
    editing: null,
    marquee: null,
    guides: [],
    insertion: null,
    draft: null,
    draftLabel: null,
    drop: null,
    angle: null,
    pen: null,
    vector: null,
    componentAccent: false,
    mainOutline: null,
    remotes: [],
    agents: [],
  }
}

/* ---------------------------------------------------------------- agent sweep */

/** One lap of the sweep (ms, linear). */
export const AGENT_SWEEP_PERIOD_MS = 2400
/** Fade lengths behind and ahead of the sweep's head, as shares of the ring's perimeter. */
const SWEEP_TRAIL = 0.125
const SWEEP_LEAD = 0.085

interface SweepGlobals {
  /**
   * Test-only (visual tests, design review): a fixed sweep phase in [0, 1) — 0 puts the head
   * on the top-right corner as drawn in artboard 35 — instead of the clock. A frozen sweep
   * does not animate.
   */
  __barenAgentSweepPhase?: number
}

let reducedMotionQuery: MediaQueryList | null | undefined

function reducedMotion(): MediaQueryList | null {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  }
  return reducedMotionQuery
}

/**
 * The sweep's phase now (0 = head on the artboard's top-right corner, increasing clockwise),
 * `null` when there is no sweep (reduced motion), and whether it moves.
 */
export function agentSweep(now: number): { phase: number | null; moving: boolean } {
  if (reducedMotion()?.matches) return { phase: null, moving: false }
  const fixed = (globalThis as SweepGlobals).__barenAgentSweepPhase
  if (typeof fixed === 'number' && Number.isFinite(fixed)) {
    return { phase: ((fixed % 1) + 1) % 1, moving: false }
  }
  return { phase: (now / AGENT_SWEEP_PERIOD_MS) % 1, moving: true }
}

/** `color` (hex or rgb[a]) with its alpha multiplied by `alpha`, as rgba(); null if unparsable. */
export function withAlpha(color: string, alpha: number): string | null {
  const c = color.trim()
  let r: number
  let g: number
  let b: number
  let a = 1
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c)
  if (hex) {
    let h = hex[1] as string
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('')
    if (h.length !== 6 && h.length !== 8) return null
    r = parseInt(h.slice(0, 2), 16)
    g = parseInt(h.slice(2, 4), 16)
    b = parseInt(h.slice(4, 6), 16)
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255
  } else {
    const fn = /^rgba?\(([^)]+)\)$/i.exec(c)
    if (!fn) return null
    const parts = (fn[1] as string).split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    ;[r, g, b] = parts.slice(0, 3).map((p) => Number.parseFloat(p)) as [number, number, number]
    if (parts[3] !== undefined) {
      const p = parts[3]
      a = p.endsWith('%') ? Number.parseFloat(p) / 100 : Number.parseFloat(p)
    }
    if (![r, g, b, a].every(Number.isFinite)) return null
  }
  const out = Math.max(0, Math.min(1, a * alpha))
  return `rgba(${r}, ${g}, ${b}, ${Math.round(out * 1000) / 1000})`
}

/** Screen corners of a world rect or frame. */
function screenCorners(v: Viewport, r: Rect | NodeFrame): Point[] {
  const f = 'rotation' in r ? r : { ...r, rotation: 0 }
  return frameCorners(f).map((p) => worldToScreen(v, p))
}

function isRotated(r: Rect | NodeFrame): r is NodeFrame {
  return 'rotation' in r && r.rotation !== 0
}

const LABEL_LINE = 14
const LABEL_GAP = 5
/* Agent badge (35): an 18 px pill whose bottom is 6 px above the artboard, right-aligned to
   its right edge; padding 0 6 0 5, a 10 px sparkle, gap 4, 11/500 text. */
const BADGE_HEIGHT = 18
const BADGE_GAP = 6
const BADGE_PAD_LEFT = 5
const BADGE_PAD_RIGHT = 6
const BADGE_ICON = 10
const BADGE_ICON_GAP = 4
/** Space kept between a label's name and the badge. */
const BADGE_MARGIN = 8
const AGENT_RING = 2
const AGENT_RING_STATIC = 1.5
/** CSS `0 0 18px 2px`: 18 px blur (σ 9) of the artboard grown by 2 px. */
const AGENT_GLOW_BLUR = 18
const AGENT_GLOW_SPREAD = 2
/** The agent sparkle (lucide sparkle) on a 24 px grid. */
const SPARKLE_PATH =
  'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z'
const LABEL_FONT_PX = 11
const PILL_HEIGHT = 18
const PILL_PAD = 6
const PILL_GAP = 7
const PILL_RADIUS = 4
const HANDLE = 6
const OUTLINE = 1.5
const ANCHOR = 6
const HANDLE_DOT = 5
const MIN_LABEL_WIDTH = 16
const LABEL_ICON = 11
/**
 * Main-component labels show the whole name (artboards 31–33), not one truncated to the
 * main's width; only names longer than this many screen px are cut.
 */
const COMPONENT_LABEL_MAX = 320

/** Screen rect of an artboard label (for hit testing), relative to the overlay. */
export interface LabelBox {
  id: string
  rect: Rect
}

export class Overlay {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private width = 0
  private height = 0
  private dpr = 1
  private labelBoxes: LabelBox[] = []
  private readonly truncCache = new Map<string, string>()
  private readonly widthCache = new Map<string, number>()
  private readonly parent: HTMLElement
  private readonly explicitTheme: Partial<OverlayTheme>
  private readonly themeObserver: MutationObserver | null = null
  private lastModel: OverlayModel | null = null
  private sparkle: Path2D | null = null
  private readonly onChange: (() => void) | null
  private readonly motionQuery: MediaQueryList | null
  private readonly onMotionChange = () => this.onChange?.()
  theme: OverlayTheme
  /** The last draw showed a moving agent sweep: the host keeps redrawing (≤ 30 fps). */
  animating = false

  /**
   * `onChange` asks the host for a redraw when something the overlay reads by itself changed
   * (reduced motion turned on or off).
   */
  constructor(parent: HTMLElement, theme: Partial<OverlayTheme> = {}, onChange?: () => void) {
    this.parent = parent
    this.explicitTheme = theme
    this.onChange = onChange ?? null
    this.motionQuery = reducedMotion()
    this.motionQuery?.addEventListener?.('change', this.onMotionChange)
    this.theme = this.resolveTheme()
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'ic-overlay'
    const ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: false })
    if (!ctx) throw new Error('Canvas 2D is not available')
    this.ctx = ctx
    parent.appendChild(this.canvas)
    const html = parent.ownerDocument.documentElement
    if (typeof MutationObserver === 'function') {
      this.themeObserver = new MutationObserver(() => this.refreshTheme())
      this.themeObserver.observe(html, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      })
    }
  }

  /** DEFAULT_THEME, then the host's CSS custom properties, then explicit options. */
  private resolveTheme(): OverlayTheme {
    const theme: OverlayTheme = { ...DEFAULT_THEME }
    const host = this.parent.parentElement ?? this.parent.ownerDocument.documentElement
    const view = host.ownerDocument.defaultView
    if (view && host.isConnected) {
      const cs = view.getComputedStyle(host)
      for (const key of THEMED_KEYS) {
        const value = cs.getPropertyValue(THEME_VARS[key]).trim()
        if (value) theme[key] = value
      }
    }
    return { ...theme, ...this.explicitTheme }
  }

  /** Re-reads the themed colours (the app theme changed) and repaints with the last model. */
  refreshTheme(): void {
    const next = this.resolveTheme()
    if (THEMED_KEYS.every((key) => next[key] === this.theme[key])) return
    this.theme = next
    if (this.lastModel) this.draw(this.lastModel)
  }

  resize(width: number, height: number, dpr: number): void {
    if (width === this.width && height === this.height && dpr === this.dpr) return
    this.width = width
    this.height = height
    this.dpr = dpr
    this.canvas.width = Math.max(1, Math.round(width * dpr))
    this.canvas.height = Math.max(1, Math.round(height * dpr))
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
  }

  /** Fonts changed (e.g. the bundled Inter finished loading): drop text metrics. */
  resetTextCache(): void {
    this.truncCache.clear()
    this.widthCache.clear()
  }

  labelAt(p: Point): string | null {
    for (let i = this.labelBoxes.length - 1; i >= 0; i--) {
      const b = this.labelBoxes[i] as LabelBox
      if (
        p.x >= b.rect.x &&
        p.x <= b.rect.x + b.rect.width &&
        p.y >= b.rect.y &&
        p.y <= b.rect.y + b.rect.height
      )
        return b.id
    }
    return null
  }

  draw(m: OverlayModel, now: number = performance.now()): void {
    this.lastModel = m
    const { ctx, dpr } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const v = m.viewport

    this.drawLabels(m.labels, v)
    this.animating = false
    if (m.agents.length > 0) this.drawAgents(m.agents, v, now)

    for (const r of m.remotes) {
      for (const rect of r.rects) this.outlineAny(v, rect, r.color, OUTLINE)
      ctx.setLineDash([4, 3])
      for (const rect of r.ghosts) this.outline(worldRectToScreen(v, rect), r.color, 1)
      ctx.setLineDash([])
    }

    const accent = m.componentAccent ? this.theme.component : this.theme.selection
    if (m.hover) this.outlineAny(v, m.hover, this.theme.selection, OUTLINE)

    if (m.drop) {
      ctx.fillStyle = this.theme.marqueeFill
      if (isRotated(m.drop)) {
        this.polygon(screenCorners(v, m.drop))
        ctx.fill()
      } else {
        const r = worldRectToScreen(v, m.drop)
        ctx.fillRect(r.x, r.y, r.width, r.height)
      }
      this.outlineAny(v, m.drop, this.theme.selection, 2)
    }

    if (m.mainOutline) {
      // 1 px, 2 px outside the main's box (artboard 31).
      const f = m.mainOutline
      const pad = 2 / v.zoom
      const out =
        'rotation' in f
          ? {
              ...f,
              x: f.x - pad,
              y: f.y - pad,
              width: f.width + 2 * pad,
              height: f.height + 2 * pad,
            }
          : { x: f.x - pad, y: f.y - pad, width: f.width + 2 * pad, height: f.height + 2 * pad }
      this.outlineAny(v, out, this.theme.component, 1)
    }

    if (m.selectionRects.length > 1) {
      for (const rect of m.selectionRects) this.outlineAny(v, rect, accent, 1)
    }
    if (m.editing) this.outlineAny(v, m.editing, this.theme.selection, OUTLINE)
    if (m.selectionBox) {
      const box = worldRectToScreen(v, m.selectionBox)
      const frame = m.selectionFrame
      if (frame && frame.rotation !== 0) {
        const corners = screenCorners(v, frame)
        this.outlinePolygon(corners, accent, OUTLINE)
        if (m.handles) this.drawRotatedHandles(corners, frame.rotation, accent)
      } else {
        this.outline(box, accent, OUTLINE)
        if (m.handles) this.drawHandles(box, accent)
      }
      if (m.sizeLabel) this.drawPill(m.sizeLabel, box, accent)
    }

    if (m.insertion) {
      const a = worldToScreen(v, m.insertion.a)
      const b = worldToScreen(v, m.insertion.b)
      ctx.strokeStyle = this.theme.selection
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    if (m.guides.length > 0) this.drawGuides(m.guides, v)

    if (m.marquee) {
      const r = worldRectToScreen(v, m.marquee)
      ctx.fillStyle = this.theme.marqueeFill
      ctx.fillRect(r.x, r.y, r.width, r.height)
      ctx.strokeStyle = this.theme.selection
      ctx.lineWidth = 1
      ctx.strokeRect(
        this.snap(r.x) + 0.5 / dpr,
        this.snap(r.y) + 0.5 / dpr,
        Math.round(r.width * dpr) / dpr,
        Math.round(r.height * dpr) / dpr,
      )
    }

    if (m.draft) {
      const r = worldRectToScreen(v, m.draft)
      this.outline(r, this.theme.selection, OUTLINE)
      if (m.draftLabel) this.drawPill(m.draftLabel, r, this.theme.selection)
    }

    if (m.vector) this.drawVectorEdit(m.vector, v)
    if (m.pen) this.drawPen(m.pen, v)
    if (m.angle) this.drawPillAt(m.angle.text, m.angle.at, this.theme.selection)

    for (const r of m.remotes)
      if (r.cursor) this.drawCursor(worldToScreen(v, r.cursor), r.name, r.color)
  }

  private snap(x: number): number {
    return Math.round(x * this.dpr) / this.dpr
  }

  private polygon(pts: readonly Point[]): void {
    const { ctx } = this
    ctx.beginPath()
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.closePath()
  }

  private outlinePolygon(pts: readonly Point[], color: string, width: number): void {
    const { ctx } = this
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineJoin = 'miter'
    this.polygon(pts)
    ctx.stroke()
  }

  /** Outline of a world rect, or of a rotated frame as a polygon. */
  private outlineAny(v: Viewport, r: Rect | NodeFrame, color: string, width: number): void {
    if (isRotated(r)) this.outlinePolygon(screenCorners(v, r), color, width)
    else this.outline(worldRectToScreen(v, r), color, width)
  }

  /** A CSS-like outline: `width` px drawn just outside the box. */
  private outline(r: Rect, color: string, width: number): void {
    const { ctx } = this
    const x0 = this.snap(r.x)
    const y0 = this.snap(r.y)
    const x1 = this.snap(r.x + r.width)
    const y1 = this.snap(r.y + r.height)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.strokeRect(x0 - width / 2, y0 - width / 2, x1 - x0 + width, y1 - y0 + width)
  }

  private drawHandles(box: Rect, color: string = this.theme.selection): void {
    const { ctx } = this
    const corners: [number, number][] = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ]
    ctx.lineWidth = 1
    for (const [cx, cy] of corners) {
      const x = this.snap(cx - HANDLE / 2)
      const y = this.snap(cy - HANDLE / 2)
      ctx.fillStyle = this.theme.handleFill
      ctx.fillRect(x, y, HANDLE, HANDLE)
      ctx.strokeStyle = color
      ctx.strokeRect(x + 0.5, y + 0.5, HANDLE - 1, HANDLE - 1)
    }
  }

  /** Corner handles of a rotated box, rotated with it. */
  private drawRotatedHandles(corners: readonly Point[], rotation: number, color: string): void {
    const { ctx } = this
    ctx.lineWidth = 1
    for (const c of corners) {
      ctx.save()
      ctx.translate(c.x, c.y)
      ctx.rotate((rotation * Math.PI) / 180)
      ctx.fillStyle = this.theme.handleFill
      ctx.fillRect(-HANDLE / 2, -HANDLE / 2, HANDLE, HANDLE)
      ctx.strokeStyle = color
      ctx.strokeRect(-HANDLE / 2 + 0.5, -HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1)
      ctx.restore()
    }
  }

  /** A square anchor (vector points), filled when selected. */
  private drawAnchor(p: Point, selected: boolean): void {
    const { ctx } = this
    const x = this.snap(p.x - ANCHOR / 2)
    const y = this.snap(p.y - ANCHOR / 2)
    ctx.fillStyle = selected ? this.theme.selection : this.theme.handleFill
    ctx.fillRect(x, y, ANCHOR, ANCHOR)
    ctx.strokeStyle = this.theme.selection
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, ANCHOR - 1, ANCHOR - 1)
  }

  /** A Bézier handle: a line from the anchor and a 5 px circle. */
  private drawHandleDot(anchor: Point, handle: Point): void {
    const { ctx } = this
    ctx.strokeStyle = this.theme.selection
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(anchor.x, anchor.y)
    ctx.lineTo(handle.x, handle.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(handle.x, handle.y, HANDLE_DOT / 2, 0, Math.PI * 2)
    ctx.fillStyle = this.theme.handleFill
    ctx.fill()
    ctx.stroke()
  }

  private drawVectorEdit(m: VectorEditOverlay, v: Viewport): void {
    if (m.path) {
      const { ctx } = this
      const f = m.path.frame
      const c = worldToScreen(v, { x: f.x + f.width / 2, y: f.y + f.height / 2 })
      ctx.save()
      try {
        ctx.translate(c.x, c.y)
        if (f.rotation) ctx.rotate((f.rotation * Math.PI) / 180)
        ctx.scale(v.zoom, v.zoom)
        ctx.translate(-f.width / 2, -f.height / 2)
        ctx.lineWidth = 1 / v.zoom
        ctx.strokeStyle = this.theme.selection
        ctx.stroke(new Path2D(m.path.d))
      } catch {
        // Invalid path data: skip the outline.
      } finally {
        ctx.restore()
      }
    }
    for (const h of m.handles)
      this.drawHandleDot(worldToScreen(v, h.anchor), worldToScreen(v, h.handle))
    for (const a of m.anchors) this.drawAnchor(worldToScreen(v, a.p), a.selected)
    if (m.insert) {
      const p = worldToScreen(v, m.insert)
      const { ctx } = this
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = this.theme.selection
      ctx.fill()
    }
  }

  private drawPen(m: PenOverlay, v: Viewport): void {
    const { ctx } = this
    const pts = m.points.map((p) => ({
      p: worldToScreen(v, p),
      in: p.in ? worldToScreen(v, p.in) : null,
      out: p.out ? worldToScreen(v, p.out) : null,
    }))
    const first = pts[0]
    if (!first) return
    ctx.strokeStyle = this.theme.selection
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(first.p.x, first.p.y)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as (typeof pts)[number]
      const b = pts[i] as (typeof pts)[number]
      if (a.out || b.in) {
        const c1 = a.out ?? a.p
        const c2 = b.in ?? b.p
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.p.x, b.p.y)
      } else ctx.lineTo(b.p.x, b.p.y)
    }
    const last = pts[pts.length - 1] as (typeof pts)[number]
    if (m.pointer) {
      const to = m.closing ? first.p : worldToScreen(v, m.pointer)
      if (last.out) ctx.quadraticCurveTo(last.out.x, last.out.y, to.x, to.y)
      else ctx.lineTo(to.x, to.y)
    }
    ctx.stroke()
    for (const pt of pts.slice(-1)) {
      if (pt.in) this.drawHandleDot(pt.p, pt.in)
      if (pt.out) this.drawHandleDot(pt.p, pt.out)
    }
    pts.forEach((pt, i) => this.drawAnchor(pt.p, i === 0 && m.closing))
  }

  private textWidth(text: string, font: string): number {
    const key = `${font}\u0000${text}`
    let w = this.widthCache.get(key)
    if (w === undefined) {
      this.ctx.font = font
      w = this.ctx.measureText(text).width
      if (this.widthCache.size > 5000) this.widthCache.clear()
      this.widthCache.set(key, w)
    }
    return w
  }

  /** Truncate with an ellipsis to fit `max` px (cached per name and width bucket). */
  private truncate(text: string, max: number, font: string): string {
    const bucket = Math.floor(max / 4) * 4
    const key = `${text}\u0000${bucket}`
    const cached = this.truncCache.get(key)
    if (cached !== undefined) return cached
    let out = text
    if (this.textWidth(text, font) > bucket) {
      let lo = 0
      let hi = text.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (this.textWidth(`${text.slice(0, mid)}…`, font) <= bucket) lo = mid
        else hi = mid - 1
      }
      out = lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : ''
    }
    if (this.truncCache.size > 5000) this.truncCache.clear()
    this.truncCache.set(key, out)
    return out
  }

  private drawLabels(labels: readonly OverlayLabel[], v: Viewport): void {
    const { ctx } = this
    const font = `400 ${LABEL_FONT_PX}px ${this.theme.fontFamily}`
    const componentFont = `500 ${LABEL_FONT_PX}px ${this.theme.fontFamily}`
    ctx.textBaseline = 'alphabetic'
    this.labelBoxes = []
    for (const l of labels) {
      const s = worldRectToScreen(v, l.bounds)
      if (s.width < MIN_LABEL_WIDTH) continue
      const f = l.component ? componentFont : font
      const icon = l.component ? LABEL_ICON + 4 : 0
      ctx.font = f
      let room = l.component ? Math.max(s.width, COMPONENT_LABEL_MAX) : s.width
      if (l.badge !== undefined)
        room = Math.min(room, s.width - this.badgeWidth(l.badge) - BADGE_MARGIN)
      const text = this.truncate(l.name, Math.max(0, room - icon), f)
      if (!text) continue
      const top = s.y - LABEL_GAP - LABEL_LINE
      if (top > this.height || s.x > this.width || s.x + s.width < 0 || top + LABEL_LINE < 0)
        continue
      const color = l.component
        ? this.theme.component
        : l.active
          ? this.theme.labelActive
          : this.theme.label
      ctx.fillStyle = color
      if (l.component) this.drawComponentIcon(this.snap(s.x), this.snap(top + 1.5), color)
      // 11px text on a 14px line: baseline ≈ 11px below the line top for Inter.
      ctx.fillText(text, this.snap(s.x + icon), this.snap(top + 11))
      this.labelBoxes.push({
        id: l.id,
        rect: {
          x: s.x,
          y: top,
          width: Math.min(room, icon + this.textWidth(text, f)),
          height: LABEL_LINE,
        },
      })
    }
  }

  /* ---------------------------------------------------------------- agents */

  private badgeFont(): string {
    return `500 ${LABEL_FONT_PX}px ${this.theme.fontFamily}`
  }

  /** Full width of an agent badge with this text. */
  private badgeWidth(text: string): number {
    return Math.round(
      BADGE_PAD_LEFT +
        BADGE_ICON +
        BADGE_ICON_GAP +
        this.textWidth(text, this.badgeFont()) +
        BADGE_PAD_RIGHT,
    )
  }

  private drawAgents(agents: readonly AgentOverlay[], v: Viewport, now: number): void {
    const { ctx } = this
    const sweep = agentSweep(now)
    for (const a of agents) {
      const s = worldRectToScreen(v, a.bounds)
      const x0 = this.snap(s.x)
      const y0 = this.snap(s.y)
      const x1 = this.snap(s.x + s.width)
      const y1 = this.snap(s.y + s.height)
      // Off screen (the glow included): nothing to draw.
      const reach = AGENT_GLOW_BLUR + AGENT_GLOW_SPREAD + BADGE_GAP + BADGE_HEIGHT
      if (x1 < -reach || y1 < -reach || x0 > this.width + reach || y0 > this.height + reach)
        continue
      this.drawAgentEdge(x0, y0, x1, y1, sweep.phase)
      if (sweep.moving) this.animating = true
      this.drawBadge(a.badge, x0, x1, y0)
    }
    ctx.globalAlpha = 1
  }

  /** Glow and ring outside the artboard (never over its content), then the sweep. */
  private drawAgentEdge(x0: number, y0: number, x1: number, y1: number, phase: number | null) {
    const { ctx, dpr } = this
    const w = x1 - x0
    const h = y1 - y0
    ctx.save()
    // Clip to everything outside the artboard, as CSS clips an outer box-shadow.
    ctx.beginPath()
    ctx.rect(0, 0, this.width, this.height)
    ctx.rect(x0, y0, w, h)
    ctx.clip('evenodd')
    // Glow: the shadow of a rect drawn far off-canvas, offset back onto the artboard.
    const away = this.width + this.height + 4 * AGENT_GLOW_BLUR + 1000
    ctx.shadowColor = this.theme.agentGlow
    ctx.shadowBlur = AGENT_GLOW_BLUR * dpr
    ctx.shadowOffsetX = away * dpr
    ctx.shadowOffsetY = 0
    ctx.fillStyle = '#000'
    const sp = AGENT_GLOW_SPREAD
    ctx.fillRect(x0 - sp - away, y0 - sp, w + 2 * sp, h + 2 * sp)
    ctx.restore()

    // Ring: 2 px just outside (box-shadow 0 0 0 2px); static 1.5 px accent with reduced motion.
    const ring = phase === null ? AGENT_RING_STATIC : AGENT_RING
    ctx.strokeStyle = phase === null ? this.theme.agent : this.theme.agentRing
    ctx.lineWidth = ring
    ctx.strokeRect(x0 - ring / 2, y0 - ring / 2, w + ring, h + ring)
    if (phase !== null)
      this.drawSweep(x0 - ring / 2, y0 - ring / 2, w + ring, h + ring, ring, phase)
  }

  /**
   * The bright segment on the ring: full --color-overlay-agent at the head, fading linearly to
   * transparent over SWEEP_TRAIL of the perimeter behind it and SWEEP_LEAD ahead. Perimeter
   * positions start at the top-right corner and run clockwise (right, bottom, left, top).
   */
  private drawSweep(x: number, y: number, w: number, h: number, lw: number, phase: number) {
    const { ctx } = this
    const P = 2 * (w + h)
    if (P <= 0) return
    const head = phase * P
    const pieces: [number, number, number, number][] = [
      // [from, to, alpha at from, alpha at to]
      [head - SWEEP_TRAIL * P, head, 0, 1],
      [head, head + SWEEP_LEAD * P, 1, 0],
    ]
    // Sides as [start, end] perimeter positions and their start point / direction.
    const sides: { a: number; b: number; px: number; py: number; dx: number; dy: number }[] = [
      { a: 0, b: h, px: x + w, py: y, dx: 0, dy: 1 },
      { a: h, b: h + w, px: x + w, py: y + h, dx: -1, dy: 0 },
      { a: h + w, b: 2 * h + w, px: x, py: y + h, dx: 0, dy: -1 },
      { a: 2 * h + w, b: P, px: x, py: y, dx: 1, dy: 0 },
    ]
    ctx.lineWidth = lw
    ctx.lineCap = 'butt'
    for (const [from, to, af, at] of pieces) {
      for (const shift of [-P, 0, P]) {
        const lo = from + shift
        const hi = to + shift
        for (const side of sides) {
          const s0 = Math.max(lo, side.a)
          const s1 = Math.min(hi, side.b)
          if (s1 - s0 <= 0.01) continue
          const alpha = (p: number) => af + ((at - af) * (p - lo)) / (hi - lo)
          const c0 = withAlpha(this.theme.agent, alpha(s0))
          const c1 = withAlpha(this.theme.agent, alpha(s1))
          const ax = side.px + side.dx * (s0 - side.a)
          const ay = side.py + side.dy * (s0 - side.a)
          const bx = side.px + side.dx * (s1 - side.a)
          const by = side.py + side.dy * (s1 - side.a)
          if (c0 && c1) {
            const g = ctx.createLinearGradient(ax, ay, bx, by)
            g.addColorStop(0, c0)
            g.addColorStop(1, c1)
            ctx.strokeStyle = g
          } else {
            ctx.strokeStyle = this.theme.agent
            ctx.globalAlpha = (alpha(s0) + alpha(s1)) / 2
          }
          // A piece that ends on a corner covers the corner square too.
          const ext = s1 >= side.b - 0.01 ? lw / 2 : 0
          ctx.beginPath()
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx + side.dx * ext, by + side.dy * ext)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }
    }
  }

  /** "<name> is working", right-aligned to the artboard; a sparkle-only chip when narrow. */
  private drawBadge(text: string, x0: number, x1: number, y0: number): void {
    const { ctx } = this
    const full = this.badgeWidth(text)
    const compact = x1 - x0 < full
    const w = compact ? BADGE_HEIGHT : full
    const x = this.snap(x1 - w)
    const y = this.snap(y0 - BADGE_GAP - BADGE_HEIGHT)
    if (y + BADGE_HEIGHT < 0 || y > this.height || x > this.width || x + w < 0) return
    ctx.fillStyle = this.theme.agent
    ctx.beginPath()
    ctx.roundRect(x, y, w, BADGE_HEIGHT, PILL_RADIUS)
    ctx.fill()
    const iconX = compact ? x + (BADGE_HEIGHT - BADGE_ICON) / 2 : x + BADGE_PAD_LEFT
    this.drawSparkle(iconX, y + (BADGE_HEIGHT - BADGE_ICON) / 2, BADGE_ICON)
    if (compact) return
    ctx.font = this.badgeFont()
    ctx.fillStyle = ON_ACCENT
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, x + BADGE_PAD_LEFT + BADGE_ICON + BADGE_ICON_GAP, y + 13)
  }

  private drawSparkle(x: number, y: number, size: number): void {
    const { ctx } = this
    this.sparkle ??= typeof Path2D === 'function' ? new Path2D(SPARKLE_PATH) : null
    if (!this.sparkle) return
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(size / 24, size / 24)
    ctx.fillStyle = ON_ACCENT
    ctx.fill(this.sparkle)
    ctx.restore()
  }

  /** The main-component mark: four filled diamonds in an 11 px square. */
  private drawComponentIcon(x: number, y: number, color: string): void {
    const { ctx } = this
    const c = LABEL_ICON / 2
    const r = 2.6
    ctx.fillStyle = color
    for (const [dx, dy] of [
      [0, -3],
      [3, 0],
      [0, 3],
      [-3, 0],
    ] as const) {
      const cx = x + c + dx
      const cy = y + c + dy
      ctx.beginPath()
      ctx.moveTo(cx, cy - r)
      ctx.lineTo(cx + r, cy)
      ctx.lineTo(cx, cy + r)
      ctx.lineTo(cx - r, cy)
      ctx.closePath()
      ctx.fill()
    }
  }

  /** A pill (size-pill style) with its top-left 12 px right/below `at`. */
  private drawPillAt(text: string, at: Point, color: string): void {
    const { ctx } = this
    const font = `500 ${LABEL_FONT_PX}px ${this.theme.fontFamily}`
    const w = Math.ceil(this.textWidth(text, font) + PILL_PAD * 2)
    const x = this.snap(Math.min(at.x + 12, this.width - w - 2))
    const y = this.snap(Math.min(at.y + 12, this.height - PILL_HEIGHT - 2))
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(x, y, w, PILL_HEIGHT, PILL_RADIUS)
    ctx.fill()
    ctx.font = font
    ctx.fillStyle = ON_ACCENT
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, x + PILL_PAD, y + 13)
  }

  private drawPill(text: string, box: Rect, color: string): void {
    const { ctx } = this
    const font = `500 ${LABEL_FONT_PX}px ${this.theme.fontFamily}`
    const tw = this.textWidth(text, font)
    const w = Math.ceil(tw + PILL_PAD * 2)
    const x = this.snap(box.x + box.width / 2 - w / 2)
    const y = this.snap(box.y + box.height + PILL_GAP)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(x, y, w, PILL_HEIGHT, PILL_RADIUS)
    ctx.fill()
    ctx.font = font
    ctx.fillStyle = ON_ACCENT
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, x + PILL_PAD, y + 13)
  }

  private drawGuides(guides: readonly Guide[], v: Viewport): void {
    const { ctx } = this
    ctx.strokeStyle = this.theme.snap
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const g of guides) {
      if (g.axis === 'x') {
        const x = this.snap((g.pos - v.x) * v.zoom) + 0.5 / this.dpr
        ctx.moveTo(x, (g.start - v.y) * v.zoom)
        ctx.lineTo(x, (g.end - v.y) * v.zoom)
      } else {
        const y = this.snap((g.pos - v.y) * v.zoom) + 0.5 / this.dpr
        ctx.moveTo((g.start - v.x) * v.zoom, y)
        ctx.lineTo((g.end - v.x) * v.zoom, y)
      }
    }
    ctx.stroke()
  }

  private drawCursor(p: Point, name: string, color: string): void {
    const { ctx } = this
    ctx.save()
    ctx.translate(Math.round(p.x), Math.round(p.y))
    ctx.beginPath()
    // Classic pointer arrow, tip at (0, 0).
    ctx.moveTo(0, 0)
    ctx.lineTo(0, 15)
    ctx.lineTo(4, 11.5)
    ctx.lineTo(7, 18)
    ctx.lineTo(9.5, 17)
    ctx.lineTo(6.5, 10.5)
    ctx.lineTo(11.5, 10.5)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = ON_ACCENT
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    ctx.stroke()
    const font = `500 ${LABEL_FONT_PX}px ${this.theme.fontFamily}`
    const w = Math.ceil(this.textWidth(name, font) + PILL_PAD * 2)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(10, 18, w, PILL_HEIGHT, PILL_RADIUS)
    ctx.fill()
    ctx.font = font
    ctx.fillStyle = ON_ACCENT
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(name, 10 + PILL_PAD, 18 + 13)
    ctx.restore()
  }

  dispose(): void {
    this.themeObserver?.disconnect()
    this.motionQuery?.removeEventListener?.('change', this.onMotionChange)
    this.lastModel = null
    this.canvas.remove()
  }
}
