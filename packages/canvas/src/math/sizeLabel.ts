import type { NodeType, Styles } from '@baren/schema'

export type SizeMode = 'fixed' | 'hug' | 'fill' | 'fit'

export interface SizeContext {
  type: NodeType
  /** A direct child of the page (artboard or top-level layer). */
  isTop: boolean
  /** The parent's main axis when it is a flex container. */
  parentFlexDirection?: 'row' | 'column' | null
}

const INTRINSIC = new Set(['auto', 'fit-content', 'max-content', 'min-content'])
const NUMERIC = /^-?\d+(\.\d+)?(px)?$/

/** How a node is sized along one axis, for the "1440 × Fit" / "Hug × 16" label. */
export function sizeMode(styles: Styles, axis: 'width' | 'height', ctx: SizeContext): SizeMode {
  const v = styles[axis]
  if (typeof v === 'number') return 'fixed'
  if (typeof v === 'string') {
    const s = v.trim()
    if (NUMERIC.test(s)) return 'fixed'
    if (s === '100%' || s === 'stretch' || s === '-webkit-fill-available') return 'fill'
    if (INTRINSIC.has(s)) return ctx.isTop ? 'fit' : 'hug'
    return 'fixed'
  }
  if (ctx.isTop) return 'fit'
  const main =
    ctx.parentFlexDirection === 'row'
      ? 'width'
      : ctx.parentFlexDirection === 'column'
        ? 'height'
        : null
  const grow = Number(styles['flexGrow'] ?? 0)
  if (main === axis && grow > 0) return 'fill'
  if (ctx.type === 'text' && axis === 'height') return 'fixed'
  return 'hug'
}

function formatPx(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function part(mode: SizeMode, measured: number): string {
  switch (mode) {
    case 'fixed':
      return formatPx(measured)
    case 'hug':
      return 'Hug'
    case 'fill':
      return 'Fill'
    case 'fit':
      return 'Fit'
  }
}

/** Label text shown under the selection, e.g. `1440 × Fit`. */
export function sizeLabel(
  styles: Styles,
  measured: { width: number; height: number },
  ctx: SizeContext,
): string {
  return `${part(sizeMode(styles, 'width', ctx), measured.width)} × ${part(sizeMode(styles, 'height', ctx), measured.height)}`
}

/** Label for a multi-selection or a rectangle being drawn: measured numbers only. */
export function plainSizeLabel(size: { width: number; height: number }): string {
  return `${formatPx(size.width)} × ${formatPx(size.height)}`
}
