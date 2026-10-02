/**
 * "Selection colors" (artboard 06): every color used inside the selection, grouped by
 * value (token or literal), with the number of layers using it. Editing one rewrites
 * every occurrence. Pure, unit-tested.
 */
import type { DesignNode, StylePatch, Styles } from '@baren/schema'
import { colorKey, findColors, replaceColor, type ColorValue } from './colors'

/** Style properties that can carry colors. Composite ones are scanned for fragments. */
const COLOR_PROPS = [
  'backgroundColor',
  'backgroundImage',
  'background',
  'color',
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'outline',
  'outlineColor',
  'boxShadow',
  'textShadow',
  'fill',
  'stroke',
] as const

export interface SelectionColor {
  key: string
  color: ColorValue
  /** Number of layers using this color (each layer counted once). */
  count: number
  /** Layer ids using it (for "select layers"). */
  nodeIds: string[]
}

/** Colors used by one node's styles, deduplicated by key. */
export function colorsOfStyles(styles: Styles): Map<string, ColorValue> {
  const out = new Map<string, ColorValue>()
  for (const prop of COLOR_PROPS) {
    const v = styles[prop]
    if (typeof v !== 'string') continue
    for (const f of findColors(v)) {
      // A fully transparent literal is not a color anyone wants to edit.
      if (f.color.kind === 'literal' && f.color.alpha === 0) continue
      out.set(colorKey(f.color), f.color)
    }
  }
  return out
}

/**
 * Aggregate over nodes (typically every node in the selected subtrees). Sorted by usage,
 * most used first; ties keep first-seen order.
 */
export function aggregateColors(nodes: Iterable<DesignNode>): SelectionColor[] {
  const byKey = new Map<string, SelectionColor>()
  for (const node of nodes) {
    if (node.type === 'page') continue
    for (const [key, color] of colorsOfStyles(node.styles)) {
      let entry = byKey.get(key)
      if (!entry) {
        entry = { key, color, count: 0, nodeIds: [] }
        byKey.set(key, entry)
      }
      entry.count++
      entry.nodeIds.push(node.id)
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count)
}

/** Style patch for `styles` replacing every occurrence of color `fromKey` with `to`. */
export function replaceColorPatch(styles: Styles, fromKey: string, to: string): StylePatch {
  const patch: StylePatch = {}
  for (const prop of COLOR_PROPS) {
    const v = styles[prop]
    if (typeof v !== 'string') continue
    const next = replaceColor(v, fromKey, to)
    if (next !== v) patch[prop] = next
  }
  return patch
}
