/**
 * What an instance (or a node of instance content) overrides, for the inspector's Component
 * section ("2 overrides · Text, Fill", artboard 31) and the dots after overridden section
 * titles. Pure, unit-tested: works on resolved nodes (`ResolvedNode.overridden`).
 */
import { isTreeId, type ResolvedNode } from '@baren/schema'

/** Inspector section (or field) that shows a style key. */
export function sectionOfStyle(key: string): string {
  if (key.startsWith('--hidden-')) return sectionOfStyle(key.slice('--hidden-'.length))
  if (
    /^(backgroundColor|backgroundImage|background|backgroundSize|backgroundPosition|backgroundRepeat|color|fill|fillOpacity)$/.test(
      key,
    )
  )
    return 'Fill'
  if (key.startsWith('stroke')) return 'Stroke'
  if (/^border(TopLeft|TopRight|BottomLeft|BottomRight)?Radius$/.test(key)) return 'Radius'
  if (key === 'opacity' || key === 'mixBlendMode') return 'Blending'
  if (
    /^(font|lineHeight|letterSpacing|textAlign|textTransform|textDecoration|whiteSpace)/.test(key)
  )
    return 'Typography'
  if (key.startsWith('outline')) return 'Outline'
  if (key.startsWith('border')) return 'Border'
  if (key === 'boxShadow') return 'Shadow'
  if (key === 'filter' || key === 'backdropFilter') return 'Filters'
  if (key.startsWith('object')) return 'Image'
  return 'Layout'
}

/** Display order of override kinds (text first, then the inspector's section order). */
const KIND_ORDER = [
  'Text',
  'Visibility',
  'Image',
  'Layout',
  'Typography',
  'Radius',
  'Blending',
  'Fill',
  'Stroke',
  'Outline',
  'Border',
  'Shadow',
  'Filters',
]

export interface OverrideSummary {
  /** Overridden properties (style keys, text, visibility, image) in the subtree. */
  count: number
  /** Kinds in display order ("Text", "Fill", …). */
  kinds: string[]
}

/** Overrides of `ref` and everything below it in an expansion (`nodes`). */
export function summarizeOverrides(
  nodes: Readonly<Record<string, ResolvedNode>>,
  ref: string,
): OverrideSummary {
  const kinds = new Set<string>()
  let count = 0
  // An instance root (a real id) summarises its whole expansion; a virtual node its subtree.
  const all = isTreeId(ref)
  const prefix = `${ref}/`
  for (const [id, node] of Object.entries(nodes)) {
    if (!all && id !== ref && !id.startsWith(prefix)) continue
    const o = node.overridden
    if (!o) continue
    for (const key of o.styles) {
      count++
      kinds.add(sectionOfStyle(key))
    }
    if (o.text) {
      count++
      kinds.add('Text')
    }
    if (o.hidden) {
      count++
      kinds.add('Visibility')
    }
    if (o.assetId) {
      count++
      kinds.add('Image')
    }
  }
  return { count, kinds: KIND_ORDER.filter((k) => kinds.has(k)) }
}

/** Sections to mark with the override dot for the selected nodes (their own overrides). */
export function overriddenSections(nodes: readonly ResolvedNode[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const n of nodes) {
    const o = n.overridden
    if (!o) continue
    for (const key of o.styles) out.add(sectionOfStyle(key))
    if (o.text) out.add('Typography')
  }
  return out
}
