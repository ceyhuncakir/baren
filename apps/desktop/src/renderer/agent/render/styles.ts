/**
 * Browser-computed styles (get_computed_styles `resolved: true`, contract §6.14): every CSS
 * property whose computed value differs from an empty reference `div` in the same stage, with
 * camelCase keys, plus the laid-out `width`/`height`. Used by the render window
 * (`stage_styles`) and, as a fallback, in the host's own isolated stage.
 */
import { getTokens, renderSubtreeHtml, toRenderSubtree, type ResolvedNode } from '@baren/schema'
import { assetUrl } from '../../lib/assets'
import type { ResolvedStylesProbe } from '../context'
import type { DocContext } from '../model'
import { bodyTextStyles, MAX_MEASURE_NODES, type StageHost } from '../measure'

/** Size-derived duplicates that would only repeat width/height in other words. */
const SKIP = new Set([
  'block-size',
  'inline-size',
  'min-block-size',
  'min-inline-size',
  'max-block-size',
  'max-inline-size',
  'perspective-origin',
  'transform-origin',
])

function camel(prop: string): string {
  if (prop.startsWith('-webkit-'))
    return `Webkit${camel(prop.slice(8)).replace(/^./, (c) => c.toUpperCase())}`
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function px(n: number): string {
  const r = Math.round(n * 100) / 100
  return `${r === 0 ? 0 : r}px`
}

/** Computed styles of `el` that differ from `ref`'s, plus its laid-out size. */
export function computedDiff(el: Element, ref: Element): Record<string, string> {
  const cs = getComputedStyle(el)
  const rs = getComputedStyle(ref)
  const out: Record<string, string> = {}
  for (let i = 0; i < cs.length; i++) {
    const prop = cs.item(i)
    if (!prop || prop.startsWith('--') || SKIP.has(prop)) continue
    const v = cs.getPropertyValue(prop)
    if (v !== rs.getPropertyValue(prop)) out[camel(prop)] = v
  }
  const r = el.getBoundingClientRect()
  out['width'] = px(r.width)
  out['height'] = px(r.height)
  return out
}

/** Resolved styles of `ids` from a rendered stage (`data-node-id` elements under `root`). */
export function stageComputedStyles(
  root: ParentNode & Node,
  ids: readonly string[],
): Record<string, Record<string, string>> {
  const ref = document.createElement('div')
  root.appendChild(ref)
  try {
    const out: Record<string, Record<string, string>> = {}
    for (const id of ids) {
      const el = (root as ParentNode).querySelector(`[data-node-id="${CSS.escape(id)}"]`)
      if (el) out[id] = computedDiff(el, ref)
    }
    return out
  } finally {
    ref.remove()
  }
}

/** The host-side probe: the artboard laid out in the isolated stage (like the measurer). */
export function createResolvedStylesProbe(ctx: DocContext, stage: StageHost): ResolvedStylesProbe {
  return (artboardId, ids) => {
    if (typeof document === 'undefined') return null
    const sub = toRenderSubtree(ctx.doc, artboardId, ctx.resolver)
    if (!sub || Object.keys(sub.nodes).length > MAX_MEASURE_NODES) return null
    const nodes: Record<string, ResolvedNode> = sub.nodes
    const markup = renderSubtreeHtml(nodes, artboardId, {
      includeIds: true,
      assetUrl: (hash) => assetUrl(hash),
    })
    const wrapper = stage.open()
    wrapper.style.cssText = 'position:absolute;left:0;top:0;width:max-content;'
    for (const [name, value] of Object.entries(bodyTextStyles()))
      wrapper.style.setProperty(name, value)
    for (const [name, token] of Object.entries(getTokens(ctx.doc))) {
      wrapper.style.setProperty(name, String(token.value))
    }
    wrapper.innerHTML = markup
    try {
      return stageComputedStyles(wrapper, ids)
    } finally {
      stage.clear()
    }
  }
}
