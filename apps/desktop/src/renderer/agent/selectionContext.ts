/**
 * "Copy as → Agent context" (Ctrl/⌘+Shift+C): the selected layers as text for a coding agent's
 * prompt (Claude Code, Cursor, Codex, …), so the agent knows exactly which part of the design
 * the user means. Each layer gets where it is (file, page, path), what it is (type, size) and
 * its JSX (get_jsx's inline-styles output, with node ids), plus the `fileId` / `nodeId` the
 * Baren MCP tools take, so a connected agent reads or edits exactly these layers. An agent
 * without the MCP server still gets the layers' code.
 *
 * Loaded on demand (it pulls in `@baren/html` with the agent runtime). No DOM: unit-tested in
 * Node.
 */
import { getNode, getTokens, toRenderSubtree, type NodeFrame } from '@baren/schema'
import { html } from './html'
import {
  componentName,
  displayName,
  mainComponentOf,
  pageOfRef,
  resolveRef,
  type DocContext,
} from './model'
import { inheritedStyles } from './tools/code'

/** Layers described in full; the rest are counted. */
export const MAX_NODES = 30
/** JSX longer than this is replaced by an outline of the layer's children. */
export const MAX_NODE_JSX = 8_000
/** JSX of all layers together. */
export const MAX_TOTAL_JSX = 24_000
/** Children listed in an outline. */
const MAX_OUTLINE = 20

export interface SelectionContextInput {
  ctx: DocContext
  /** Selected layers (real or virtual ids), without layers inside other selected ones. */
  refs: readonly string[]
  fileId: string
  fileName: string
  /** World frame of a layer as the canvas measured it (null: no size is written). */
  frameOf?: (ref: string) => Pick<NodeFrame, 'width' | 'height' | 'rotation'> | null
}

export function selectionContext(input: SelectionContextInput): string {
  const { ctx, refs } = input
  const nodes = refs.filter((ref) => {
    const n = resolveRef(ctx, ref)
    return n !== undefined && n.type !== 'page'
  })
  const page = nodes[0] === undefined ? null : pageOfRef(ctx, nodes[0])
  const pageName = page === null ? '' : (getNode(ctx.doc, page)?.name ?? '')
  const out = [
    `<baren-selection file="${attr(input.fileName)}" fileId="${attr(input.fileId)}"${
      pageName ? ` page="${attr(pageName)}"` : ''
    }>`,
    'Layers selected in the Baren design tool. With the Baren MCP server connected, pass fileId and a nodeId (the data-node-id of any element below) to its tools (get_node_info, get_screenshot, get_jsx, update_styles, …) to read or edit exactly these layers.',
  ]
  let budget = MAX_TOTAL_JSX
  for (const ref of nodes.slice(0, MAX_NODES)) {
    out.push(nodeOpenTag(input, ref, page))
    const jsx = layerJsx(ctx, ref)
    if (jsx !== null && jsx.length <= Math.min(MAX_NODE_JSX, budget)) {
      out.push(jsx)
      budget -= jsx.length
    } else {
      out.push(...outline(input, ref, jsx))
    }
    out.push('</node>')
  }
  const more = nodes.length - MAX_NODES
  if (more > 0) out.push(`… and ${more} more selected layer${more === 1 ? '' : 's'}.`)
  out.push('</baren-selection>')
  return out.join('\n')
}

function nodeOpenTag(input: SelectionContextInput, ref: string, page: string | null): string {
  const { ctx } = input
  const node = resolveRef(ctx, ref)
  if (!node) return `<node nodeId="${attr(ref)}">`
  let tag = `<node nodeId="${attr(ref)}" name="${attr(displayName(ctx, node))}" type="${componentName(ctx, node)}"`
  if (node.type === 'instance' || node.source) {
    const main = mainComponentOf(ctx, node)
    const key = node.type === 'instance' ? 'instanceOf' : 'insideInstanceOf'
    if (main?.name) tag += ` ${key}="${attr(main.name)}"`
  }
  tag += ` path="${attr(layerPath(ctx, ref))}"`
  const otherPage = pageOfRef(ctx, ref)
  if (otherPage !== page && otherPage !== null)
    tag += ` page="${attr(getNode(ctx.doc, otherPage)?.name ?? '')}"`
  const frame = input.frameOf?.(ref) ?? null
  if (frame) {
    tag += ` size="${Math.round(frame.width)}×${Math.round(frame.height)}"`
    if (frame.rotation) tag += ` rotation="${Math.round(frame.rotation * 100) / 100}°"`
  }
  return `${tag}>`
}

/** Layer names from the artboard down to `ref`: "Landing / Hero / Heading". */
function layerPath(ctx: DocContext, ref: string): string {
  const names: string[] = []
  let cur: string | null = ref
  for (let guard = 0; cur !== null && guard < 1_000; guard++) {
    const node = resolveRef(ctx, cur)
    if (!node || node.type === 'page') break
    names.push(displayName(ctx, node) || componentName(ctx, node))
    cur = node.parentId
  }
  return names.reverse().join(' / ')
}

/** get_jsx's inline-styles output with node ids, without its `( … )` wrapper; null on failure. */
function layerJsx(ctx: DocContext, ref: string): string | null {
  try {
    const sub = toRenderSubtree(ctx.doc, ref, ctx.resolver)
    if (!sub) return null
    const jsx = html.toJsx(sub.nodes, ref, {
      format: 'inline-styles',
      tokens: getTokens(ctx.doc),
      inherited: inheritedStyles(ctx, ref),
      includeIds: true,
    })
    return jsx
      .split('\n')
      .slice(1, -1)
      .map((line) => line.replace(/^ {4}/, ''))
      .join('\n')
  } catch {
    return null
  }
}

/** Instead of JSX that is too long: its size and the layer's direct children. */
function outline(input: SelectionContextInput, ref: string, jsx: string | null): string[] {
  const { ctx } = input
  const lines = [
    jsx === null
      ? 'Its code is not available here; get_jsx returns it.'
      : `Its JSX (${Math.ceil(jsx.length / 1024)} KB) is too long to include here; get_jsx returns it.`,
  ]
  const children = resolveRef(ctx, ref)?.children ?? []
  if (children.length === 0) return lines
  lines.push('Children:')
  for (const id of children.slice(0, MAX_OUTLINE)) {
    const child = resolveRef(ctx, id)
    if (!child) continue
    const frame = input.frameOf?.(id) ?? null
    const size = frame ? `, ${Math.round(frame.width)}×${Math.round(frame.height)}` : ''
    lines.push(
      `- ${displayName(ctx, child) || componentName(ctx, child)} (${componentName(ctx, child)}${size}) nodeId=${id}`,
    )
  }
  if (children.length > MAX_OUTLINE) lines.push(`- … ${children.length - MAX_OUTLINE} more`)
  return lines
}

function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
}
