/**
 * Keeps DOM elements (comment pins, the open thread, the composer) glued to world points of the
 * canvas: one requestAnimationFrame loop, running only while something is registered, converts
 * world → screen with the canvas camera and writes an element's position only when its screen
 * position changed. Pins therefore follow pans, zooms and layout changes of their layer in the
 * same frame the canvas moves.
 *
 * The position goes in the `translate` property, not `transform`: CSS applies `translate` before
 * `scale`, so a pin's hover `scale` grows it in place. With the position in `transform`, `scale`
 * scaled the offset too and the pin jumped away from the pointer.
 */
import type { CanvasController, Point } from '@baren/canvas'
import { useCallback, useRef } from 'react'

export interface LayerSize {
  width: number
  height: number
}

/** Top-left of the element for its anchor's screen point (layer coordinates). */
export type Placement = (screen: Point, el: HTMLElement, layer: LayerSize) => Point

interface Entry {
  el: HTMLElement
  world: () => Point | null
  place: Placement
  last: string
}

export class PinLayout {
  private readonly entries = new Map<string, Entry>()
  private frame = 0

  constructor(
    private readonly canvas: () => CanvasController | null,
    private readonly layer: () => HTMLElement | null,
  ) {}

  /** Register (`el`) or drop (`null`) the element for `key`; placed at once, before paint. */
  set(key: string, el: HTMLElement | null, world: () => Point | null, place: Placement): void {
    if (el === null) {
      this.entries.delete(key)
      if (this.entries.size === 0) this.stop()
      return
    }
    const entry: Entry = { el, world, place, last: '' }
    this.entries.set(key, entry)
    this.update(entry, this.size())
    if (this.frame === 0) this.frame = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    this.entries.clear()
    this.stop()
  }

  private stop(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private size(): LayerSize {
    const layer = this.layer()
    return { width: layer?.clientWidth ?? 0, height: layer?.clientHeight ?? 0 }
  }

  private readonly tick = (): void => {
    this.frame = 0
    if (this.entries.size === 0) return
    const size = this.size()
    for (const entry of this.entries.values()) this.update(entry, size)
    this.frame = requestAnimationFrame(this.tick)
  }

  private update(entry: Entry, size: LayerSize): void {
    const canvas = this.canvas()
    const world = canvas ? entry.world() : null
    if (!canvas || !world) {
      if (entry.last !== 'hidden') entry.el.style.visibility = 'hidden'
      entry.last = 'hidden'
      return
    }
    const p = entry.place(canvas.canvasToScreen(world), entry.el, size)
    const t = `${Math.round(p.x)}px ${Math.round(p.y)}px`
    if (t === entry.last) return
    if (entry.last === '' || entry.last === 'hidden') entry.el.style.visibility = ''
    entry.el.style.translate = t
    entry.last = t
  }
}

/**
 * A ref callback that keeps `el` placed by `layout` for `key`; `world` and `place` may change
 * every render (the latest ones are used).
 */
export function usePinned(
  layout: PinLayout,
  key: string,
  world: () => Point | null,
  place: Placement,
): (el: HTMLElement | null) => void {
  const latest = useRef({ world, place })
  latest.current = { world, place }
  return useCallback(
    (el: HTMLElement | null) =>
      layout.set(
        key,
        el,
        () => latest.current.world(),
        (s, e, l) => latest.current.place(s, e, l),
      ),
    [layout, key],
  )
}

/** Pins: the bubble's bottom-left corner sits on the point. */
export const PIN_SIZE = 32
export const placePin: Placement = (s) => ({ x: s.x, y: s.y - PIN_SIZE })

const GAP = 10
const EDGE = 8

/** A card beside a pin: to its right, or its left near the right edge; kept inside the layer. */
export const placeCard: Placement = (s, el, layer) => {
  const w = el.offsetWidth
  const h = el.offsetHeight
  let x = s.x + PIN_SIZE + GAP
  if (x + w > layer.width - EDGE) x = Math.max(EDGE, s.x - w - GAP)
  const y = Math.min(Math.max(EDGE, s.y - PIN_SIZE), Math.max(EDGE, layer.height - h - EDGE))
  return { x, y }
}
