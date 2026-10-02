/**
 * Render stage (contract §4.7, §11.4–11.5): the HTML and CSS the off-screen render window
 * puts in a shadow root to screenshot, export or measure one node — the exporter's HTML
 * (`renderSubtreeHtml`, with `data-node-id`s) plus the canvas base rules, a wrapper carrying
 * the inherited text styles and the background, the measured size and the upright root.
 *
 * The render page's shadow host should carry `data-design-content` so the app's light design
 * tokens apply to documents that use them without defining them (the file's own tokens are
 * declared on `:host` here and win).
 */
import {
  ASSET_URL_PREFIX,
  assetRefsInValue,
  cssDeclarationValue,
  cssPropertyName,
  formatCssNumber,
  isAssetHash,
  isTokenName,
  readRotation,
  renderSubtreeHtml,
  rotateOnlyTransform,
} from '@baren/schema'
import type { ResolvedNode, StyleValue, Styles, Token } from '@baren/schema'
import { isSafeCssValue } from './css/safe.ts'
import { escapeAttr } from './svg.ts'
import type { RenderStage, StageOptions } from './types.ts'

/**
 * What canvas content inherits: the app body's text styles (packages/ui global.css), except the
 * line height, which the document scope resets to `normal` (packages/ui tokens.css §4).
 */
const CANVAS_DEFAULTS =
  "font-family:'Inter Variable',Inter,sans-serif;font-size:13px;line-height:normal;color:#1A1A1A;" +
  'font-synthesis:none;text-rendering:geometricPrecision;-webkit-font-smoothing:antialiased;'

function declarations(styles: Styles): string {
  let out = ''
  for (const key of Object.keys(styles).sort()) {
    const name = cssPropertyName(key)
    const v = styles[key] as StyleValue
    const value = name === null ? null : cssDeclarationValue(key, v)
    if (name !== null && value !== null) out += `${name}:${value};`
  }
  return out
}

function tokensCss(tokens: Record<string, Token>): string {
  let decls = ''
  for (const name of Object.keys(tokens).sort()) {
    if (!isTokenName(name)) continue
    const t = tokens[name] as Token
    const value = typeof t.value === 'number' ? formatCssNumber(t.value) : t.value.trim()
    if (value === '' || value.includes(';') || !isSafeCssValue(value)) continue
    decls += `${name}:${value};`
  }
  return decls === '' ? '' : `:host{${decls}}\n`
}

/** Asset URLs used by the subtree (image layers and image fills), in document order. */
function assetUrls(
  nodes: Record<string, ResolvedNode>,
  rootId: string,
  url: (hash: string) => string,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (hash: string): void => {
    const u = url(hash)
    if (!seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  const stack = [rootId]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    const n = nodes[id]
    if (!n || (n.hidden === true && id !== rootId)) continue
    if (n.type === 'image' && isAssetHash(n.assetId)) add(n.assetId)
    for (const k of ['backgroundImage', 'background'])
      for (const h of assetRefsInValue(n.styles[k])) add(h)
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as string)
  }
  return out
}

const cssString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Build the stage for `rootId` (contract §11.4). */
export function renderStage(
  nodes: Record<string, ResolvedNode>,
  rootId: string,
  opts: StageOptions,
): RenderStage {
  const root = nodes[rootId]
  if (!root) throw new Error(`Node ${rootId} is not in the subtree`)
  const url = opts.assetUrl ?? ((h: string) => `${ASSET_URL_PREFIX}${h}`)
  const body = renderSubtreeHtml(nodes, rootId, { includeIds: true, assetUrl: url })

  const inherited = declarations(opts.inherited ?? {})
  const background =
    opts.background && isSafeCssValue(opts.background) && !opts.background.includes(';')
      ? `background:${opts.background};`
      : 'background:transparent;'
  const sel = `[data-baren-stage]>[data-node-id=${cssString(rootId)}]`
  let upright =
    'position:relative!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;margin:0!important;rotate:none!important;'
  if (readRotation(root.styles) !== 0 && rotateOnlyTransform(root.styles['transform']) !== null)
    upright += 'transform:none!important;'
  if (opts.size) {
    upright += `width:${formatCssNumber(opts.size.width)}px!important;height:${formatCssNumber(opts.size.height)}px!important;`
  }
  const css =
    tokensCss(opts.tokens) +
    `[data-baren-stage]{all:initial;display:block;position:relative;width:max-content;height:max-content;${CANVAS_DEFAULTS}${background}${inherited}}\n` +
    '[data-baren-stage] [data-node-id]{box-sizing:border-box;}\n' +
    '[data-baren-stage] :is(p,h1,h2,h3)[data-node-id]{white-space:pre-wrap;}\n' +
    '[data-baren-stage] img[data-node-id]{display:block;}\n' +
    `${sel}{${upright}}\n`
  const html = `<div data-baren-stage data-root-id="${escapeAttr(rootId)}">\n${body}</div>`
  return { html, css, assetUrls: assetUrls(nodes, rootId, url) }
}
