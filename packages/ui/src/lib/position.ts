/**
 * Pure placement math for floating layers (menus, submenus, popovers, context menus).
 * Everything works in viewport (client) coordinates and never touches the DOM, so it
 * is unit-tested and cheap to call once per open.
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'end'
export type Placement = `${Side}-${Align}`

/** Minimum distance kept between a floating layer and the viewport edge. */
export const VIEWPORT_MARGIN = 4

function clamp(value: number, min: number, max: number): number {
  // If the layer is larger than the viewport, pin it to the start edge.
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Context menus open with their top-left corner at the cursor. When that would overflow,
 * they flip to the other side of the cursor (like native menus), then clamp.
 */
export function placeAtPoint(
  point: Point,
  size: Size,
  viewport: Size,
  margin: number = VIEWPORT_MARGIN,
): Point {
  let x = point.x
  let y = point.y
  if (x + size.width > viewport.width - margin) x = point.x - size.width
  if (y + size.height > viewport.height - margin) y = point.y - size.height
  return {
    x: clamp(x, margin, viewport.width - margin - size.width),
    y: clamp(y, margin, viewport.height - margin - size.height),
  }
}

export interface SubmenuOptions {
  /** Horizontal overlap with the parent menu (default 4px). */
  overlap?: number
  /** Parent menu padding; the submenu shifts up by it so first items line up (default 6px). */
  padding?: number
  margin?: number
}

/**
 * Submenus open to the right of the parent menu, overlapping it by `overlap`, with their
 * first item level with the trigger item. They flip to the left when there is no room.
 */
export function placeSubmenu(
  triggerItem: Box,
  parentMenu: Box,
  size: Size,
  viewport: Size,
  options: SubmenuOptions = {},
): Point & { side: 'left' | 'right' } {
  const overlap = options.overlap ?? 4
  const padding = options.padding ?? 6
  const margin = options.margin ?? VIEWPORT_MARGIN
  const rightX = parentMenu.left + parentMenu.width - overlap
  const leftX = parentMenu.left + overlap - size.width
  let side: 'left' | 'right' = 'right'
  let x = rightX
  if (rightX + size.width > viewport.width - margin && leftX >= margin) {
    side = 'left'
    x = leftX
  }
  let y = triggerItem.top - padding
  if (y + size.height > viewport.height - margin) {
    // Align the bottom of the submenu with the bottom of the trigger instead.
    y = triggerItem.top + triggerItem.height + padding - size.height
  }
  return {
    side,
    x: clamp(x, margin, viewport.width - margin - size.width),
    y: clamp(y, margin, viewport.height - margin - size.height),
  }
}

export interface AnchorOptions {
  placement?: Placement
  /** Gap between the anchor and the layer along the main axis. */
  offset?: number
  /** Shift along the cross axis (positive moves toward the end). */
  alignOffset?: number
  margin?: number
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function mainAxisPosition(side: Side, anchor: Box, size: Size, offset: number): number {
  switch (side) {
    case 'bottom':
      return anchor.top + anchor.height + offset
    case 'top':
      return anchor.top - offset - size.height
    case 'right':
      return anchor.left + anchor.width + offset
    case 'left':
      return anchor.left - offset - size.width
  }
}

function fits(side: Side, pos: number, size: Size, viewport: Size, margin: number): boolean {
  if (side === 'bottom') return pos + size.height <= viewport.height - margin
  if (side === 'top') return pos >= margin
  if (side === 'right') return pos + size.width <= viewport.width - margin
  return pos >= margin
}

/**
 * Anchored placement (dropdowns, popovers, select menus): `bottom-start` puts the layer
 * under the anchor with left edges aligned. The main axis flips when the preferred side
 * does not fit and the opposite side does; the cross axis is clamped into the viewport.
 */
export function placeAnchored(
  anchor: Box,
  size: Size,
  viewport: Size,
  options: AnchorOptions = {},
): Point & { placement: Placement } {
  const placement = options.placement ?? 'bottom-start'
  const offset = options.offset ?? 4
  const alignOffset = options.alignOffset ?? 0
  const margin = options.margin ?? VIEWPORT_MARGIN
  const [preferredSide, align] = placement.split('-') as [Side, Align]

  let side = preferredSide
  let main = mainAxisPosition(side, anchor, size, offset)
  if (!fits(side, main, size, viewport, margin)) {
    const flipped = OPPOSITE[side]
    const flippedMain = mainAxisPosition(flipped, anchor, size, offset)
    if (fits(flipped, flippedMain, size, viewport, margin)) {
      side = flipped
      main = flippedMain
    }
  }

  const vertical = side === 'top' || side === 'bottom'
  let cross: number
  if (vertical) {
    cross =
      align === 'start'
        ? anchor.left + alignOffset
        : anchor.left + anchor.width - size.width - alignOffset
  } else {
    cross =
      align === 'start'
        ? anchor.top + alignOffset
        : anchor.top + anchor.height - size.height - alignOffset
  }

  const x = vertical ? cross : main
  const y = vertical ? main : cross
  return {
    placement: `${side}-${align}`,
    x: clamp(x, margin, viewport.width - margin - size.width),
    y: clamp(y, margin, viewport.height - margin - size.height),
  }
}

/** DOMRect → Box without keeping the live object around. */
export function toBox(rect: { left: number; top: number; width: number; height: number }): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}
