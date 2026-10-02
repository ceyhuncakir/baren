import type { Rect } from '../types.ts'

/**
 * CSS image placement math for LOD thumbnails: `object-fit`/`object-position` for image
 * layers and `background-size`/`-position`/`-repeat` for image fills, from computed style
 * strings. Pure (unit-tested); results are destination rects in the box's coordinates
 * (callers clip to the box).
 */

interface Offset {
  /** Fraction of the free space (percentages and keywords). */
  frac: number
  /** Plus a fixed length in px. */
  px: number
}

const KEYWORD: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }

function parseOffset(token: string | undefined): Offset {
  if (token === undefined) return { frac: 0.5, px: 0 }
  const k = KEYWORD[token]
  if (k !== undefined) return { frac: k, px: 0 }
  const n = Number.parseFloat(token)
  if (!Number.isFinite(n)) return { frac: 0.5, px: 0 }
  return token.endsWith('%') ? { frac: n / 100, px: 0 } : { frac: 0, px: n }
}

/** `"50% 50%"`, `"10px 0px"`, `"left top"` → x/y offsets (computed values are 2 tokens). */
export function parsePosition(value: string): { x: Offset; y: Offset } {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  // A lone vertical keyword ("top") applies to y.
  if (parts.length === 1 && (parts[0] === 'top' || parts[0] === 'bottom'))
    return { x: parseOffset('center'), y: parseOffset(parts[0]) }
  return { x: parseOffset(parts[0]), y: parseOffset(parts[1] ?? 'center') }
}

function place(free: number, o: Offset): number {
  return free * o.frac + o.px
}

/** Destination rect of an image layer's pixels inside `box` (object-fit/object-position). */
export function fitImage(iw: number, ih: number, box: Rect, fit: string, position: string): Rect {
  let w = box.width
  let h = box.height
  if (iw > 0 && ih > 0 && fit !== 'fill') {
    const contain = Math.min(box.width / iw, box.height / ih)
    const s =
      fit === 'cover'
        ? Math.max(box.width / iw, box.height / ih)
        : fit === 'contain'
          ? contain
          : fit === 'scale-down'
            ? Math.min(1, contain)
            : fit === 'none'
              ? 1
              : -1
    if (s > 0) {
      w = iw * s
      h = ih * s
    }
  }
  if (w === box.width && h === box.height) return { ...box }
  const p = parsePosition(position)
  return {
    x: box.x + place(box.width - w, p.x),
    y: box.y + place(box.height - h, p.y),
    width: w,
    height: h,
  }
}

function sizeComponent(token: string | undefined, area: number): number | null {
  if (token === undefined || token === 'auto') return null
  const n = Number.parseFloat(token)
  if (!Number.isFinite(n) || n <= 0) return null
  return token.endsWith('%') ? (area * n) / 100 : n
}

/** Tile size for a computed `background-size` over `area`. */
export function backgroundTileSize(
  iw: number,
  ih: number,
  area: Rect,
  size: string,
): { width: number; height: number } {
  const v = size.trim()
  if (v === 'cover' || v === 'contain') {
    const s =
      v === 'cover'
        ? Math.max(area.width / iw, area.height / ih)
        : Math.min(area.width / iw, area.height / ih)
    return { width: iw * s, height: ih * s }
  }
  const [a, b] = v.split(/\s+/)
  const w = sizeComponent(a, area.width)
  const h = sizeComponent(b, area.height)
  if (w !== null && h !== null) return { width: w, height: h }
  if (w !== null) return { width: w, height: (w * ih) / iw }
  if (h !== null) return { width: (h * iw) / ih, height: h }
  return { width: iw, height: ih }
}

/**
 * Destination rects of an image fill's tiles over `area` (the element's border box).
 * At most `maxTiles` (repeats beyond that are dropped; thumbnails are tiny).
 */
export function backgroundTiles(
  iw: number,
  ih: number,
  area: Rect,
  size: string,
  position: string,
  repeat: string,
  maxTiles: number,
): Rect[] {
  if (!(iw > 0 && ih > 0) || area.width <= 0 || area.height <= 0) return []
  const tile = backgroundTileSize(iw, ih, area, size)
  if (!(tile.width > 0.01 && tile.height > 0.01)) return []
  const p = parsePosition(position)
  const x0 = area.x + place(area.width - tile.width, p.x)
  const y0 = area.y + place(area.height - tile.height, p.y)
  const parts = repeat.trim().split(/\s+/)
  let rx: boolean
  let ry: boolean
  if (parts.length >= 2) {
    rx = parts[0] !== 'no-repeat'
    ry = parts[1] !== 'no-repeat'
  } else {
    const r = parts[0] ?? 'repeat'
    rx = r === 'repeat' || r === 'repeat-x' || r === 'space' || r === 'round'
    ry = r === 'repeat' || r === 'repeat-y' || r === 'space' || r === 'round'
  }
  const startX = rx ? x0 - Math.ceil((x0 - area.x) / tile.width) * tile.width : x0
  const startY = ry ? y0 - Math.ceil((y0 - area.y) / tile.height) * tile.height : y0
  const endX = rx ? area.x + area.width : x0 + tile.width
  const endY = ry ? area.y + area.height : y0 + tile.height
  const out: Rect[] = []
  for (let y = startY; y < endY - 1e-6; y += tile.height) {
    for (let x = startX; x < endX - 1e-6; x += tile.width) {
      out.push({ x, y, width: tile.width, height: tile.height })
      if (out.length >= maxTiles) return out
    }
  }
  return out
}
