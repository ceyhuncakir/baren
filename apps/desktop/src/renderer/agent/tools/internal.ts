/**
 * Requests main sends to a host that are not MCP tools (contract §4.6, §11.4): release, flush,
 * render_job, node_image, plus the host half of open_file. artboards_of is in `read.ts`.
 */
import {
  getTokens,
  isAssetHash,
  sanitizeSvgMarkup,
  toRenderSubtree,
  vectorToSvgMarkup,
  type ResolvedNode,
  type Token,
} from '@baren/schema'
import { sniffImageMime } from '../../lib/assets'
import type { RenderJob } from '../../types/bridge'
import { AgentToolError } from '../errors'
import { html } from '../html'
import { requireRef, resolveRef } from '../model'
import { pageArg, str, reqStr, type HostEnv, type ToolCall, type ToolOutput } from '../context'
import { inheritedStyles } from './code'
import { assertNotPage, basicInfo, nodeImage } from './read'

export async function release(call: ToolCall): Promise<ToolOutput> {
  if (call.env.release) await call.env.release()
  else await call.env.flush?.()
  return { result: { released: true } }
}

export async function flush(call: ToolCall): Promise<ToolOutput> {
  await call.env.flush?.()
  return { result: { flushed: true } }
}

/** Without main's `firstOpen` flag, a session this young counts as just opened. */
export const OPEN_PAGE_WINDOW_MS = 15_000

/**
 * The host half of open_file (contract §6.4): main has shown the file; `pageId` switches the
 * user's page only when this open created the window (`firstOpen`), never otherwise. The body is
 * get_basic_info's for that page.
 */
export function openFile(call: ToolCall): ToolOutput {
  const { env } = call
  const pageId = str(call.args, 'pageId')
  const flag = call.args['firstOpen']
  const first =
    typeof flag === 'boolean'
      ? flag
      : (env.age?.() ?? Number.POSITIVE_INFINITY) < OPEN_PAGE_WINDOW_MS
  const page = pageId === undefined || pageId === '' ? undefined : pageArg(env, pageId)
  if (page !== undefined && first && env.setPage && !env.headless) env.setPage(page)
  return { result: basicInfo(env, page) }
}

// ---------------------------------------------------------------------------
// render_job
// ---------------------------------------------------------------------------

const TOKEN_VAR_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/

/** A literal value through `var()` references (≤ 8 hops). */
export function resolveVarValue(value: string, tokens: Record<string, Token>): string {
  let v = value.trim()
  for (let i = 0; i < 8; i++) {
    const m = TOKEN_VAR_RE.exec(v)
    if (!m) break
    const t = tokens[m[1] as string]
    v = (t ? String(t.value) : (m[2] ?? '')).trim()
  }
  return v
}

/** Background colour of a node's own styles (resolved through tokens), or null. */
function backgroundColorOf(node: ResolvedNode, tokens: Record<string, Token>): string | null {
  const raw = node.styles['backgroundColor'] ?? node.styles['background']
  if (typeof raw !== 'string') return null
  const v = resolveVarValue(raw, tokens)
  return html.parseCssColor(v) ? v : null
}

/**
 * Screenshot compositing colour (contract §9.1): the node's own opaque background, else the
 * nearest ancestor's background colour, else the page background, else white.
 */
export function screenshotBackground(env: HostEnv, ref: string): string {
  const tokens = getTokens(env.doc)
  const node = resolveRef(env, ref)
  if (!node) return '#FFFFFF'
  const own = backgroundColorOf(node, tokens)
  if (own && (html.parseCssColor(own)?.a ?? 0) >= 1) return own
  for (let cur = node.parentId; cur !== null;) {
    const p = resolveRef(env, cur)
    if (!p) break
    if (p.type === 'page') {
      const bg = p.background ? resolveVarValue(p.background, tokens) : null
      return bg && html.parseCssColor(bg) ? bg : '#FFFFFF'
    }
    const c = backgroundColorOf(p, tokens)
    if (c) return c
    cur = p.parentId
  }
  return '#FFFFFF'
}

/** The rendered node ids (hidden descendants excluded; the root renders even when hidden). */
function renderedIds(nodes: Record<string, ResolvedNode>, rootId: string): string[] {
  const out: string[] = []
  const stack = [rootId]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    const n = nodes[id]
    if (!n || (id !== rootId && n.hidden === true)) continue
    out.push(id)
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as string)
  }
  return out
}

export function buildRenderJob(
  env: HostEnv,
  nodeId: string,
  purpose: 'screenshot' | 'export' | 'styles',
): RenderJob {
  const node = requireRef(env, nodeId)
  assertNotPage(node, purpose === 'export' ? 'export' : 'get_screenshot')
  const sub = toRenderSubtree(env.doc, nodeId, env.resolver)
  if (!sub) throw new AgentToolError('node_not_found', `Node ${JSON.stringify(nodeId)} not found.`)
  const nodes: Record<string, ResolvedNode> = { ...sub.nodes }
  const root = nodes[nodeId]
  // The agent asked for this node: it renders even when hidden (its hidden descendants do not).
  if (root?.hidden === true) nodes[nodeId] = { ...root, hidden: false }
  const g = env.geometry.fields(nodeId)
  const size = g.width !== null && g.height !== null ? { width: g.width, height: g.height } : null
  const tokens = getTokens(env.doc)
  const background = purpose === 'screenshot' ? screenshotBackground(env, nodeId) : null
  const inherited = inheritedStyles(env, nodeId)
  const stage = html.renderStage(nodes, nodeId, {
    tokens,
    inherited,
    size,
    background,
    assetUrl: (hash) => `baren-asset://${hash}`,
  })
  const inheritedOut: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(inherited)) inheritedOut[k] = v
  return {
    nodeId,
    stage,
    width: size?.width ?? null,
    height: size?.height ?? null,
    background,
    inherited: inheritedOut,
    ids: renderedIds(nodes, nodeId),
  }
}

export function renderJob(call: ToolCall): ToolOutput {
  const nodeId = reqStr(call.args, 'nodeId')
  const p = str(call.args, 'purpose')
  const purpose = p === 'export' || p === 'styles' ? p : 'screenshot'
  return { result: buildRenderJob(call.env, nodeId, purpose) }
}

// ---------------------------------------------------------------------------
// node_image
// ---------------------------------------------------------------------------

export async function nodeImageTool(call: ToolCall): Promise<ToolOutput> {
  const { env } = call
  const nodeId = reqStr(call.args, 'nodeId')
  const node = requireRef(env, nodeId)
  if (node.type === 'svg') {
    return { result: { svg: sanitizeSvgMarkup(node.svg ?? '') } }
  }
  if (node.type === 'vector') {
    return { result: { svg: vectorToSvgMarkup(node, getTokens(env.doc)) } }
  }
  const image = nodeImage(node)
  if (!image || !isAssetHash(image.assetId)) {
    throw new AgentToolError(
      'invalid_target',
      `${node.type === 'page' ? 'A page' : `"${node.name}"`} has no image (an image layer or an image fill).`,
    )
  }
  const bytes = await env.assets.get(image.assetId).catch(() => null)
  const out: Record<string, unknown> = { assetId: image.assetId }
  const mime = bytes ? sniffImageMime(bytes) : null
  if (mime) out['mime'] = mime
  if (image.name) out['name'] = image.name
  return { result: out }
}
