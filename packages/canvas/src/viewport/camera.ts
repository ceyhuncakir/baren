import { clampZoom, easeOutCubic, interpolateViewport } from '../math/viewport.ts'
import type { Viewport } from '../types.ts'

/** A viewport gesture is considered settled this long after the last input. */
export const SETTLE_MS = 140
export const ZOOM_ANIM_MS = 220
/** During a zoom-out gesture, re-raster once zoom drops below this fraction of the raster scale. */
export const RERASTER_OUT_FACTOR = 0.5

/**
 * Viewport state: the current camera, smooth zoom animations, gesture-settle
 * detection and management of the world layer's raster scale.
 */
export class Camera {
  private v: Viewport
  /** The world transform needs re-applying. */
  dirty = true
  private anim: { from: Viewport; to: Viewport; start: number } | null = null
  private lastInput = -Infinity
  private rasterZoom: number
  private rerasterPhase = 0

  constructor(
    initial: Viewport,
    private readonly onChange: (v: Viewport) => void,
  ) {
    this.v = initial
    this.rasterZoom = initial.zoom
  }

  get viewport(): Viewport {
    return this.v
  }

  get animating(): boolean {
    return this.anim !== null
  }

  /** Zoom the camera is heading to (the animation target while animating). */
  get targetZoom(): number {
    return this.anim?.to.zoom ?? this.v.zoom
  }

  get rerasterPending(): boolean {
    return this.rerasterPhase !== 0
  }

  /**
   * Jump to `v` (zoom clamped, size kept). `input` marks gesture input: it
   * cancels animations and keeps the camera "gesturing" until it settles.
   */
  set(v: Viewport, input: boolean): void {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return
    this.v = { ...v, zoom: clampZoom(v.zoom), width: this.v.width, height: this.v.height }
    this.dirty = true
    if (input) {
      this.anim = null
      this.lastInput = performance.now()
    }
    this.onChange(this.v)
  }

  animateTo(to: Viewport): void {
    const target = { ...to, zoom: clampZoom(to.zoom), width: this.v.width, height: this.v.height }
    this.anim = { from: this.v, to: target, start: performance.now() }
  }

  resize(width: number, height: number): boolean {
    if (width === this.v.width && height === this.v.height) return false
    this.v = { ...this.v, width, height }
    this.dirty = true
    this.onChange(this.v)
    return true
  }

  /** Advance a running animation to time `now`. */
  step(now: number): void {
    const a = this.anim
    if (!a) return
    const t = Math.min(1, Math.max(0, (now - a.start) / ZOOM_ANIM_MS))
    this.v = t >= 1 ? a.to : interpolateViewport(a.from, a.to, easeOutCubic(t))
    this.dirty = true
    this.onChange(this.v)
    if (t >= 1) {
      this.anim = null
      this.lastInput = now
    }
  }

  isGesturing(now: number, pointerGesture: boolean): boolean {
    return this.anim !== null || pointerGesture || now - this.lastInput < SETTLE_MS
  }

  /**
   * During gestures the world layer keeps `will-change: transform`, so pan
   * and zoom only re-composite the existing raster. Once settled at a new
   * zoom, dropping and restoring the hint makes Chromium re-raster crisply.
   * Zooming far out while the old (larger) raster scale is kept would make the
   * compositor raster a huge area at that scale and exceed its tile memory, so
   * that case re-rasters mid-gesture once zoom halves. Zooming in only blurs
   * (few tiles) until the settle re-raster.
   */
  updateRaster(world: HTMLElement, gesturing: boolean): void {
    if (this.rerasterPhase === 1) {
      world.style.willChange = ''
      this.rerasterPhase = 0
      this.rasterZoom = this.v.zoom
      return
    }
    const zoomedFarOut = this.v.zoom < this.rasterZoom * RERASTER_OUT_FACTOR
    if ((!gesturing && this.rasterZoom !== this.v.zoom) || (gesturing && zoomedFarOut)) {
      world.style.willChange = 'auto'
      this.rerasterPhase = 1
    }
  }

  /** Treat the current zoom as already rasterised (initial mount). */
  markRasterised(): void {
    this.rasterZoom = this.v.zoom
  }
}
