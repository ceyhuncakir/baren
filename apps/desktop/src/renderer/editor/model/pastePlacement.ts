/**
 * Where a paste lands (contract §7.4): the world offset applied to the copied roots' frames.
 * Pure, unit-tested.
 *
 * - Paste in place: (0, 0), the exact copied world position.
 * - Paste here (context menu): the copied bounds' top-left at the clicked point.
 * - Paste: same file and the copied bounds still visible → (+24, +24) — unless the target is
 *   a frame or group that the shifted copy would miss; otherwise a page target centres the
 *   copy on the viewport and a frame/group target centres it in the target's box, with the
 *   top-left clamped inside the box.
 */
export interface PlacementRect {
  x: number
  y: number
  width: number
  height: number
}

export type PasteMode = 'paste' | 'inPlace' | 'here'

export interface PasteTranslateInput {
  mode: PasteMode
  /** World AABB of the copied roots (`payload.bounds`). */
  bounds: PlacementRect | null
  /** The payload was copied from this file. */
  sameFile: boolean
  /** Visible world rectangle. */
  viewport: PlacementRect | null
  /** World AABB of a frame/group target; null for the page. */
  target: PlacementRect | null
  /** World point of "Paste here". */
  point?: { x: number; y: number } | null
}

export const PASTE_OFFSET = 24

function intersects(a: PlacementRect, b: PlacementRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function pasteTranslate(input: PasteTranslateInput): { dx: number; dy: number } {
  const { bounds, viewport, target } = input
  if (!bounds || input.mode === 'inPlace') return { dx: 0, dy: 0 }
  if (input.mode === 'here' && input.point) {
    return { dx: input.point.x - bounds.x, dy: input.point.y - bounds.y }
  }
  if (input.sameFile && viewport && intersects(bounds, viewport)) {
    const shifted = { ...bounds, x: bounds.x + PASTE_OFFSET, y: bounds.y + PASTE_OFFSET }
    if (!target || intersects(shifted, target)) return { dx: PASTE_OFFSET, dy: PASTE_OFFSET }
  }
  if (!target) {
    if (!viewport) return { dx: 0, dy: 0 }
    const cx = viewport.x + viewport.width / 2
    const cy = viewport.y + viewport.height / 2
    return {
      dx: Math.round(cx - (bounds.x + bounds.width / 2)),
      dy: Math.round(cy - (bounds.y + bounds.height / 2)),
    }
  }
  const x = Math.max(target.x, target.x + (target.width - bounds.width) / 2)
  const y = Math.max(target.y, target.y + (target.height - bounds.height) / 2)
  return { dx: Math.round(x - bounds.x), dy: Math.round(y - bounds.y) }
}

/**
 * The flow index of a paste/insert: right after the last selected sibling inside `parent`,
 * else undefined (append).
 */
export function indexAfterSelection(
  children: readonly string[],
  selection: readonly string[],
): number | undefined {
  let best = -1
  for (const id of selection) best = Math.max(best, children.indexOf(id))
  return best === -1 ? undefined : best + 1
}
