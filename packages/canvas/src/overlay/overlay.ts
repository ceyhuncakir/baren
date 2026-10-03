import { frameCorners, type NodeFrame } from '@baren/schema'
import type { Guide } from '../math/snap.ts'
import { worldRectToScreen, worldToScreen } from '../math/viewport.ts'
import type { OverlayTheme, Point, Rect, Viewport } from '../types.ts'
import { agentMark } from './agentMark.ts'
import type { IncomingOverlay } from './incoming.ts'

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
 * Agents (Phase 4 contract §10.4): every artboard an MCP agent is working on gets a 2 px
 * --color-overlay-agent ring just outside it, a 4 px --color-agent-ring halo and a
 * --color-agent-glow glow (CSS `0 0 24px 2px`), plus an island fused to the ring's top edge and
 * right-aligned with it: the Baren medallion and the agents' names (only the medallion when the
 * artboard is narrower than the island).
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
  agent: '#D0391E',
  agentRing: 'rgba(208, 57, 30, 0.1)',
  agentGlow: 'rgba(208, 57, 30, 0.2)',
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
  /** Layers an agent just added: placeholders where they land (incoming.ts). */
  incoming: IncomingOverlay[]
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
    incoming: [],
  }
}

/** `color` fully transparent (same hue, so gradients fade without a grey fringe). */
function transparentOf(color: string): string {
  const c = color.trim()
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c)
  if (hex) return `#${hex[1]}00`
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c)
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0)` : 'rgba(0, 0, 0, 0)'
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
/* Agent island: a tab rising from the ring's top edge, flush with its outer right edge, radius 8
   on top and a concave 8 px fillet into the ring on the left; a 16 px medallion, 12/600 names. */
const ISLAND_HEIGHT = 24
const ISLAND_PAD_LEFT = 4
const ISLAND_PAD_RIGHT = 10
const ISLAND_MARK = 16
const ISLAND_GAP = 6
const ISLAND_RADIUS = 8
const ISLAND_FILLET = 8
const ISLAND_FONT_PX = 12
/** Shown in place of the medallion until it has decoded (the seal's cream). */
const MARK_FALLBACK = '#F5EFE5'
/** Space kept between a label's name and the island. */
const BADGE_MARGIN = 8
const AGENT_RING = 2
const AGENT_HALO = 4
/** Corner radius of an incoming-layer placeholder (screen px). */
const INCOMING_RADIUS = 6
/** CSS `0 0 24px 2px`: 24 px blur (σ 12) of the artboard grown by 2 px. */
const AGENT_GLOW_BLUR = 24
const AGENT_GLOW_SPREAD = 2
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
  private readonly onChange: (() => void) | null
  theme: OverlayTheme

  /**
   * `onChange` asks the host for a redraw when something the overlay reads by itself changed
   * (the agent medallion finished loading).
   */
  constructor(parent: HTMLElement, theme: Partial<OverlayTheme> = {}, onChange?: () => void) {
    this.parent = parent
    this.explicitTheme = theme
    this.onChange = onChange ?? null
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

  draw(m: OverlayModel): void {
    this.lastModel = m
    const { ctx, dpr } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const v = m.viewport

    this.drawLabels(m.labels, v)
    if (m.agents.length > 0) this.drawAgents(m.agents, v)
    if (m.incoming.length > 0) this.drawIncoming(m.incoming, v)

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
        room = Math.min(room, s.width - this.islandWidth(l.badge) - BADGE_MARGIN)
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

  private islandFont(): string {
    return `600 ${ISLAND_FONT_PX}px ${this.theme.fontFamily}`
  }

  /** Full width of an agent island with this text. */
  private islandWidth(text: string): number {
    return Math.round(
      ISLAND_PAD_LEFT +
        ISLAND_MARK +
        ISLAND_GAP +
        this.textWidth(text, this.islandFont()) +
        ISLAND_PAD_RIGHT,
    )
  }

  private drawAgents(agents: readonly AgentOverlay[], v: Viewport): void {
    for (const a of agents) {
      const s = worldRectToScreen(v, a.bounds)
      const x0 = this.snap(s.x)
      const y0 = this.snap(s.y)
      const x1 = this.snap(s.x + s.width)
      const y1 = this.snap(s.y + s.height)
      // Off screen (the glow and the island included): nothing to draw.
      const reach = AGENT_GLOW_BLUR + AGENT_GLOW_SPREAD + AGENT_RING + ISLAND_HEIGHT
      if (x1 < -reach || y1 < -reach || x0 > this.width + reach || y0 > this.height + reach)
        continue
      this.drawAgentEdge(x0, y0, x1, y1)
      this.drawIsland(a.badge, x0, x1, y0)
    }
  }

  /** Glow and halo outside the artboard (never over its content), then the ring. */
  private drawAgentEdge(x0: number, y0: number, x1: number, y1: number): void {
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

    // Halo (box-shadow 0 0 0 6px, translucent) around the ring (0 0 0 2px).
    const out = AGENT_RING + AGENT_HALO / 2
    ctx.strokeStyle = this.theme.agentRing
    ctx.lineWidth = AGENT_HALO
    ctx.strokeRect(x0 - out, y0 - out, w + 2 * out, h + 2 * out)
    ctx.strokeStyle = this.theme.agent
    ctx.lineWidth = AGENT_RING
    ctx.strokeRect(x0 - AGENT_RING / 2, y0 - AGENT_RING / 2, w + AGENT_RING, h + AGENT_RING)
  }

  /**
   * The island over the artboard's top-right corner: the medallion and the names, or only the
   * medallion when the artboard is narrower than the island; nothing on tiny artboards.
   */
  private drawIsland(text: string, x0: number, x1: number, y0: number): void {
    const { ctx } = this
    const compactWidth = 2 * ISLAND_PAD_LEFT + ISLAND_MARK
    const full = this.islandWidth(text)
    const room = x1 - x0 - ISLAND_FILLET
    if (room < compactWidth) return
    const compact = room < full
    const w = compact ? compactWidth : full
    const right = x1 + AGENT_RING
    const left = right - w
    const ringTop = y0 - AGENT_RING
    const top = ringTop - ISLAND_HEIGHT
    if (y0 < 0 || top > this.height || left - ISLAND_FILLET > this.width || right < 0) return

    ctx.fillStyle = this.theme.agent
    // The tab runs down through the ring band, so tab and ring read as one shape.
    ctx.beginPath()
    ctx.roundRect(left, top, w, ISLAND_HEIGHT + AGENT_RING, [ISLAND_RADIUS, ISLAND_RADIUS, 0, 0])
    ctx.fill()
    // Fillet: the ring's top edge curving up into the tab's left side.
    const f = ISLAND_FILLET
    ctx.beginPath()
    ctx.moveTo(left, ringTop - f)
    ctx.lineTo(left, ringTop)
    ctx.lineTo(left - f, ringTop)
    ctx.arc(left - f, ringTop - f, f, Math.PI / 2, 0, true)
    ctx.closePath()
    ctx.fill()

    const mx = left + ISLAND_PAD_LEFT
    const my = top + (ISLAND_HEIGHT - ISLAND_MARK) / 2
    const mark = agentMark(() => this.onChange?.())
    if (mark) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(mark, mx, my, ISLAND_MARK, ISLAND_MARK)
    } else {
      ctx.fillStyle = MARK_FALLBACK
      ctx.beginPath()
      ctx.arc(mx + ISLAND_MARK / 2, my + ISLAND_MARK / 2, ISLAND_MARK / 2, 0, 2 * Math.PI)
      ctx.fill()
    }
    if (compact) return
    ctx.font = this.islandFont()
    ctx.fillStyle = ON_ACCENT
    ctx.textBaseline = 'alphabetic'
    // 12 px text centred on the 24 px tab: baseline ≈ 16 px below its top for Inter.
    ctx.fillText(text, mx + ISLAND_MARK + ISLAND_GAP, top + 16)
  }

  /**
   * Where an agent's new layer lands: a rounded tint in --color-agent-ring with a
   * --color-overlay-agent outline, and while the layer is still hidden a --color-agent-glow
   * shimmer crossing it once, left to right.
   */
  private drawIncoming(items: readonly IncomingOverlay[], v: Viewport): void {
    const { ctx } = this
    for (const it of items) {
      if (it.alpha <= 0) continue
      const s = worldRectToScreen(v, it.bounds)
      if (s.x > this.width || s.y > this.height || s.x + s.width < 0 || s.y + s.height < 0) continue
      const x = this.snap(s.x)
      const y = this.snap(s.y)
      const w = Math.max(1, Math.round(s.width))
      const h = Math.max(1, Math.round(s.height))
      const r = Math.min(INCOMING_RADIUS, w / 2, h / 2)
      ctx.save()
      ctx.globalAlpha = it.alpha
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, r)
      ctx.fillStyle = this.theme.agentRing
      ctx.fill()
      if (it.shimmer !== null) {
        ctx.save()
        ctx.clip()
        const band = Math.max(48, w * 0.35)
        const bx = x - band + (w + band) * it.shimmer
        const g = ctx.createLinearGradient(bx, 0, bx + band, 0)
        const clear = transparentOf(this.theme.agentGlow)
        g.addColorStop(0, clear)
        g.addColorStop(0.5, this.theme.agentGlow)
        g.addColorStop(1, clear)
        ctx.fillStyle = g
        ctx.fillRect(bx, y, band, h)
        ctx.restore()
      }
      ctx.strokeStyle = this.theme.agent
      ctx.lineWidth = OUTLINE
      ctx.beginPath()
      ctx.roundRect(x + OUTLINE / 2, y + OUTLINE / 2, w - OUTLINE, h - OUTLINE, r)
      ctx.stroke()
      ctx.restore()
    }
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
    this.lastModel = null
    this.canvas.remove()
  }
}
