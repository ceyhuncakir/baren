/**
 * DOM measurement of one artboard for agent geometry (`geometry.ts`): the resolved subtree is
 * rendered with the schema's HTML exporter (`renderSubtreeHtml`, ids included) into a hidden,
 * isolated shadow root that follows the canvas's rules (border-box everywhere, text
 * `pre-wrap`, block images, the body's inherited text styles, the file's tokens as custom
 * properties), laid out once and read back. Independent of the canvas viewport, so off-screen
 * and virtualised artboards measure exactly like visible ones.
 */
import {
  getTokens,
  readRotation,
  renderSubtreeHtml,
  toRenderSubtree,
  type ResolvedNode,
} from '@baren/schema'
import { assetUrl } from '../lib/assets'
import type { ArtboardMeasure, MeasuredBox, Measurer } from './geometry'
import type { DocContext } from './model'

/** Larger artboards are not measured (their layout-dependent values stay null). */
export const MAX_MEASURE_NODES = 20_000

/** Canvas conventions the exported HTML does not carry (packages/canvas baseCss + global.css). */
export const STAGE_BASE_CSS = `
*,*::before,*::after{box-sizing:border-box;}
*{margin:0;}
[data-node-id]{box-sizing:border-box;}
p[data-node-id],h1[data-node-id],h2[data-node-id],h3[data-node-id]{white-space:pre-wrap;}
img{display:block;}
svg{display:block;flex-shrink:0;}
`

/** Inherited text styles of the document body (what canvas content inherits). */
export const BODY_TEXT_PROPERTIES = [
  'font-family',
  'font-size',
  'line-height',
  'color',
  'font-synthesis',
  'text-rendering',
  '-webkit-font-smoothing',
  'letter-spacing',
  'font-weight',
  'font-style',
] as const

export function bodyTextStyles(): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof document === 'undefined' || !document.body) return out
  const cs = getComputedStyle(document.body)
  for (const p of BODY_TEXT_PROPERTIES) {
    const v = cs.getPropertyValue(p)
    if (v) out[p] = v
  }
  // The canvas's document scope (`.ic-root`, packages/ui tokens.css §4) resets the chrome's
  // 16px line height: text without its own line height uses the font's normal one.
  out['line-height'] = 'normal'
  return out
}

/** A hidden, isolated host for static layouts (one per window). */
export class StageHost {
  private host: HTMLDivElement | null = null
  wrapper: HTMLDivElement | null = null

  /** The wrapper to render into (created on first use, emptied by `clear`). */
  open(): HTMLDivElement {
    if (this.wrapper?.isConnected) return this.wrapper
    const host = document.createElement('div')
    host.setAttribute('data-agent-stage', '')
    host.setAttribute('aria-hidden', 'true')
    Object.assign(host.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      overflow: 'hidden',
      visibility: 'hidden',
      pointerEvents: 'none',
      contain: 'strict',
      zIndex: '-1',
    })
    const root = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STAGE_BASE_CSS
    root.appendChild(style)
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'position:absolute;left:0;top:0;width:max-content;'
    root.appendChild(wrapper)
    document.body.appendChild(host)
    this.host = host
    this.wrapper = wrapper
    return wrapper
  }

  clear(): void {
    if (this.wrapper) this.wrapper.replaceChildren()
  }

  dispose(): void {
    this.host?.remove()
    this.host = null
    this.wrapper = null
  }
}

/** Accumulated rotation of `ref` relative to `rootId` (exclusive), from resolved styles. */
function relativeRotation(
  nodes: Record<string, ResolvedNode>,
  ref: string,
  rootId: string,
): number {
  let deg = 0
  for (let cur: string | null = ref; cur !== null && cur !== rootId;) {
    const n: ResolvedNode | undefined = nodes[cur]
    if (!n) break
    deg += readRotation(n.styles)
    cur = n.parentId
  }
  return deg
}

/** The DOM measurer of a host window. */
export function createDomMeasurer(ctx: DocContext, stage = new StageHost()): Measurer {
  return {
    measure(artboardId: string): ArtboardMeasure | null {
      if (typeof document === 'undefined') return null
      const sub = toRenderSubtree(ctx.doc, artboardId, ctx.resolver)
      if (!sub) return null
      const count = Object.keys(sub.nodes).length
      if (count > MAX_MEASURE_NODES) return null
      const root = sub.nodes[artboardId]
      if (!root) return null
      // Laid out unrotated: positions are artboard-local.
      const nodes: Record<string, ResolvedNode> = { ...sub.nodes }
      const rootStyles = { ...root.styles }
      delete rootStyles['rotate']
      nodes[artboardId] = { ...root, styles: rootStyles }
      const markup = renderSubtreeHtml(nodes, artboardId, {
        includeIds: true,
        assetUrl: (hash) => assetUrl(hash),
      })
      const wrapper = stage.open()
      wrapper.style.cssText = 'position:absolute;left:0;top:0;width:max-content;'
      for (const [name, value] of Object.entries(bodyTextStyles())) {
        wrapper.style.setProperty(name, value)
      }
      for (const [name, token] of Object.entries(getTokens(ctx.doc))) {
        wrapper.style.setProperty(name, String(token.value))
      }
      wrapper.innerHTML = markup
      try {
        const rootEl = wrapper.querySelector(`[data-node-id="${CSS.escape(artboardId)}"]`)
        if (!rootEl) return null
        const rr = rootEl.getBoundingClientRect()
        const out = new Map<string, MeasuredBox>()
        for (const el of wrapper.querySelectorAll('[data-node-id]')) {
          const id = el.getAttribute('data-node-id')
          if (id === null || id === artboardId) continue
          const r = el.getBoundingClientRect()
          const rotation = relativeRotation(nodes, id, artboardId)
          let width = r.width
          let height = r.height
          if (rotation !== 0) {
            const cs = getComputedStyle(el)
            const w = parseFloat(cs.width)
            const h = parseFloat(cs.height)
            if (Number.isFinite(w)) width = w
            if (Number.isFinite(h)) height = h
          }
          out.set(id, {
            cx: r.left + r.width / 2 - rr.left,
            cy: r.top + r.height / 2 - rr.top,
            width,
            height,
            rotation,
          })
        }
        return { width: rr.width, height: rr.height, nodes: out }
      } finally {
        stage.clear()
      }
    },
  }
}
