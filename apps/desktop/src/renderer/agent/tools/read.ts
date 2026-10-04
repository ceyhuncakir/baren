/**
 * Read tools (contract §6.2, §6.8–§6.11): get_basic_info, get_selection, get_tree_summary,
 * get_children, get_node_info. find_nodes lives in `find.ts`. Never change the document.
 */
import {
  getChildIds,
  getNode,
  getTokens,
  isAssetHash,
  assetRefsInValue,
  isMainComponent,
  isTreeId,
  listComponents,
  nodesTree,
  readRotation,
  type ResolvedNode,
  type Token,
} from '@baren/schema'
import { LoroMap } from 'loro-crdt'
import { AgentToolError } from '../errors'
import { commentCounts } from './comments'
import {
  artboardOfRef,
  childRefs,
  componentName,
  displayName,
  isArtboardNode,
  mainComponentOf,
  pageOfRef,
  requireRef,
  resolveRef,
} from '../model'
import { num, pageArg, reqStr, str, type HostEnv, type ToolCall, type ToolOutput } from '../context'

export function fileUrl(fileId: string, pageId: string): string {
  return `baren://file/${fileId}/${pageId}`
}

/** Token names in theme-panel order (`order`), then by name. */
export function orderedTokenNames(
  tokens: Record<string, Token>,
  orders: Readonly<Record<string, number>>,
): string[] {
  return Object.keys(tokens).sort((a, b) => {
    const oa = orders[a] ?? Number.POSITIVE_INFINITY
    const ob = orders[b] ?? Number.POSITIVE_INFINITY
    if (oa !== ob) return oa < ob ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

// ---------------------------------------------------------------------------
// Font families
// ---------------------------------------------------------------------------

const GENERIC_FAMILIES: Record<string, string> = {
  'system-ui': 'System Sans-Serif',
  '-apple-system': 'System Sans-Serif',
  blinkmacsystemfont: 'System Sans-Serif',
  'sans-serif': 'System Sans-Serif',
  'ui-sans-serif': 'System Sans-Serif',
  serif: 'System Serif',
  'ui-serif': 'System Serif',
  monospace: 'System Monospace',
  'ui-monospace': 'System Monospace',
}

/** Split on top-level commas (outside quotes and parentheses). */
export function splitTopLevel(value: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

/** The first family of a font stack (tokens resolved, generic names → "System …"). */
export function fontFamilyName(
  value: string,
  tokens: Record<string, Token>,
  depth = 0,
): string | null {
  if (depth > 8) return null
  const first = (splitTopLevel(value.trim())[0] ?? '').trim()
  const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(first)
  if (m) {
    const t = tokens[m[1] as string]
    const next = t ? String(t.value) : (m[2] ?? '')
    return next.trim() === '' ? null : fontFamilyName(next, tokens, depth + 1)
  }
  const name = first.replace(/^['"]|['"]$/g, '').trim()
  if (name === '' || name.startsWith('var(')) return null
  return GENERIC_FAMILIES[name.toLowerCase()] ?? name
}

interface DocScan {
  nodeCount: number
  families: Map<string, number>
  instanceCounts: Record<string, number>
}

/**
 * One pass over the document: node count, font families in styles, instances per key. Served
 * from the document mirror when it is ready or warming (finishing a warm-up on the spot costs
 * about one Loro walk, and every later read is then cheap: an agent calling back to back leaves
 * no idle time for the warm-up to finish on its own); before the first warm-up, straight from
 * the Loro tree (cheaper than building the whole mirror on the spot).
 */
function scanDoc(env: HostEnv, tokens: Record<string, Token>): DocScan {
  const families = new Map<string, number>()
  const instanceCounts: Record<string, number> = {}
  let nodeCount = 0
  const visit = (type: unknown, fontFamily: unknown, componentKey: unknown) => {
    if (type === 'page') return
    nodeCount++
    if (typeof fontFamily === 'string') {
      const name = fontFamilyName(fontFamily, tokens)
      if (name) families.set(name, (families.get(name) ?? 0) + 1)
    }
    if (type === 'instance' && typeof componentKey === 'string') {
      instanceCounts[componentKey] = (instanceCounts[componentKey] ?? 0) + 1
    }
  }
  if (env.index.isReady() || env.index.isWarming()) {
    for (const n of env.index.map().values()) visit(n.type, n.styles['fontFamily'], n.componentKey)
  } else {
    for (const node of nodesTree(env.doc).getNodes({ withDeleted: false })) {
      const data = node.data
      const type = data.get('type')
      const styles = data.get('styles')
      visit(
        type,
        styles instanceof LoroMap ? styles.get('fontFamily') : undefined,
        type === 'instance' ? data.get('componentKey') : undefined,
      )
    }
  }
  for (const [name, token] of Object.entries(tokens)) {
    const isFamily =
      token.type === 'fontFamily' ||
      (name.startsWith('--font-') && !name.startsWith('--font-weight-'))
    if (!isFamily || typeof token.value !== 'string') continue
    const family = fontFamilyName(token.value, tokens)
    if (family && !families.has(family)) families.set(family, 0)
  }
  return { nodeCount, families, instanceCounts }
}

// ---------------------------------------------------------------------------
// get_basic_info
// ---------------------------------------------------------------------------

export function basicInfo(env: HostEnv, pageIdArg: string | undefined): Record<string, unknown> {
  const pageId = pageArg(env, pageIdArg)
  const page = requireRef(env, pageId)
  const tokens = getTokens(env.doc)
  const scan = scanDoc(env, tokens)
  const comments = commentCounts(env)
  const artboards: Record<string, unknown>[] = []
  for (const id of getChildIds(env.doc, pageId)) {
    const node = resolveRef(env, id)
    if (!node || !isArtboardNode(node)) continue
    const g = env.geometry.fields(id)
    const board: Record<string, unknown> = {
      id,
      name: displayName(env, node),
      component: componentName(env, node),
      childCount: childRefs(env, id).length,
      width: g.width,
      height: g.height,
      worldX: g.worldX,
      worldY: g.worldY,
    }
    // Only when there are some: most artboards have none (tokens matter on big files).
    const open = comments.openByArtboard.get(id)
    if (open !== undefined) board['openComments'] = open
    artboards.push(board)
  }
  const orders = env.tokenOrders()
  const counts = scan.instanceCounts
  return {
    fileName: env.fileName(),
    pageName: page.name,
    pageId,
    url: fileUrl(env.fileId, pageId),
    rootNodeId: pageId,
    nodeCount: scan.nodeCount,
    artboardCount: artboards.length,
    artboards,
    pages: getChildIds(env.doc, null).map((id) => ({
      id,
      name: getNode(env.doc, id)?.name ?? '',
      isActive: env.isViewing(id),
    })),
    fontFamilies: [...scan.families.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name]) => name),
    tokens: {
      items: orderedTokenNames(tokens, orders).map((name) => ({
        name,
        value: (tokens[name] as Token).value,
      })),
    },
    components: listComponents(env.doc).map((c) => ({
      key: c.key,
      name: c.name,
      mainId: c.mainId,
      instanceCount: counts[c.key] ?? 0,
    })),
    // Every page; read them with get_comments.
    comments: { open: comments.open, resolved: comments.resolved },
  }
}

export function getBasicInfo(call: ToolCall): ToolOutput {
  return { result: basicInfo(call.env, str(call.args, 'pageId')) }
}

// ---------------------------------------------------------------------------
// get_selection
// ---------------------------------------------------------------------------

export function getSelection(call: ToolCall): ToolOutput {
  const { env } = call
  const selectedNodes: Record<string, unknown>[] = []
  const touched = new Set<string>()
  for (const id of env.selection()) {
    const node = resolveRef(env, id)
    if (!node) continue
    const g = env.geometry.fields(id)
    const artboardId = artboardOfRef(env, id)
    const board = artboardId === null ? undefined : resolveRef(env, artboardId)
    if (artboardId !== null) touched.add(artboardId)
    selectedNodes.push({
      id,
      name: displayName(env, node),
      component: componentName(env, node),
      width: g.width,
      height: g.height,
      artboardId,
      artboardName: board ? displayName(env, board) : null,
    })
  }
  return { result: { selectedNodes, count: selectedNodes.length }, touched: [...touched] }
}

// ---------------------------------------------------------------------------
// get_tree_summary
// ---------------------------------------------------------------------------

export const SUMMARY_MAX_LINES = 2000
const TEXT_PREVIEW = 60

function sizeText(v: number | null): string {
  return v === null ? '?' : String(Math.round(v))
}

/** One summary line (contract §6.9 format), without indentation. */
export function summaryLine(env: HostEnv, node: ResolvedNode, atLimit: boolean): string {
  const g = env.geometry.fields(node.id)
  let line = `${componentName(env, node)} "${displayName(env, node)}" (${node.id}) ${sizeText(g.width)}×${sizeText(g.height)}`
  if (node.type === 'text') {
    line += ` "${(node.text ?? '').slice(0, TEXT_PREVIEW).replace(/\r?\n/g, '⏎')}"`
  }
  const kids = node.type === 'page' ? getChildIds(env.doc, node.id) : node.children
  if (atLimit && kids.length > 0) line += ` (${kids.length} children)`
  if (node.hidden === true) line += ' [hidden]'
  if (node.type === 'instance') {
    const main = mainComponentOf(env, node)
    if (main) line += ` → Component "${main.name}"`
  }
  return line
}

/** Text outline of `ref`'s subtree (a page summarises its artboards), `depth` levels. */
export function treeSummary(
  env: HostEnv,
  ref: string,
  depth: number,
  maxLines = SUMMARY_MAX_LINES,
): string {
  const root = requireRef(env, ref)
  const lines: string[] = []
  let skipped = 0
  const starts: { ref: string; level: number }[] =
    root.type === 'page'
      ? getChildIds(env.doc, root.id).map((id) => ({ ref: id, level: 1 }))
      : [{ ref, level: 1 }]
  const stack = [...starts].reverse()
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const node = resolveRef(env, item.ref)
    if (!node) continue
    const atLimit = item.level >= depth
    if (lines.length < maxLines) {
      lines.push(`${'  '.repeat(item.level - 1)}${summaryLine(env, node, atLimit)}`)
    } else skipped++
    if (atLimit) continue
    const kids = childRefs(env, node.id)
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ ref: kids[i] as string, level: item.level + 1 })
    }
  }
  if (skipped > 0) lines.push(`… truncated (${skipped} more nodes)`)
  return lines.join('\n')
}

export function getTreeSummary(call: ToolCall): ToolOutput {
  const { env, args } = call
  const nodeId = reqStr(args, 'nodeId')
  const depth = Math.min(10, Math.max(1, Math.trunc(num(args, 'depth') ?? 3)))
  const summary = treeSummary(env, nodeId, depth)
  const node = requireRef(env, nodeId)
  const touched =
    node.type === 'page'
      ? getChildIds(env.doc, nodeId)
      : [artboardOfRef(env, nodeId)].filter((x): x is string => x !== null)
  return { result: { summary, nodeId, depth }, touched: node.type === 'page' ? [] : touched }
}

// ---------------------------------------------------------------------------
// get_children
// ---------------------------------------------------------------------------

export function childEntry(env: HostEnv, id: string): Record<string, unknown> | null {
  const node = resolveRef(env, id)
  if (!node) return null
  const g = env.geometry.fields(id)
  return {
    id,
    name: displayName(env, node),
    component: componentName(env, node),
    childCount: childRefs(env, id).length,
    worldX: g.worldX,
    worldY: g.worldY,
    x: g.x,
    y: g.y,
    width: g.width,
    height: g.height,
  }
}

export function getChildren(call: ToolCall): ToolOutput {
  const { env, args } = call
  const nodeId = reqStr(args, 'nodeId')
  const node = requireRef(env, nodeId)
  const children = childRefs(env, nodeId)
    .map((id) => childEntry(env, id))
    .filter((x): x is Record<string, unknown> => x !== null)
  const board = node.type === 'page' ? null : artboardOfRef(env, nodeId)
  return { result: { children, count: children.length }, touched: board ? [board] : [] }
}

// ---------------------------------------------------------------------------
// get_node_info
// ---------------------------------------------------------------------------

/** The image of an image layer, or the first image fill's asset. */
export function nodeImage(node: ResolvedNode): { assetId: string; name: string | null } | null {
  if (node.type === 'image' && node.assetId !== undefined && isAssetHash(node.assetId)) {
    return { assetId: node.assetId, name: node.assetName ?? null }
  }
  for (const key of ['backgroundImage', 'background']) {
    const v = node.styles[key]
    const refs = assetRefsInValue(v)
    if (refs[0] !== undefined) return { assetId: refs[0], name: node.assetName ?? null }
  }
  return null
}

function overridesOf(node: ResolvedNode): string[] | null {
  const o = node.overridden
  if (!o) return node.source || node.type === 'instance' ? [] : null
  const out = [...o.styles].sort()
  if (o.text) out.push('text')
  if (o.hidden) out.push('hidden')
  if (o.assetId) out.push('assetId')
  return out
}

export function nodeInfo(env: HostEnv, nodeId: string): Record<string, unknown> {
  const node = requireRef(env, nodeId)
  const g = env.geometry.fields(nodeId)
  const kids = childRefs(env, nodeId)
  const pageId = pageOfRef(env, nodeId)
  return {
    id: nodeId,
    name: displayName(env, node),
    component: componentName(env, node),
    width: g.width,
    height: g.height,
    worldX: g.worldX,
    worldY: g.worldY,
    x: g.x,
    y: g.y,
    rotation: node.type === 'page' ? 0 : readRotation(node.styles),
    isVisible: node.hidden !== true,
    isLocked: node.locked === true,
    parentId: node.parentId,
    childIds: [...kids],
    childCount: kids.length,
    artboardId: node.type === 'page' ? null : artboardOfRef(env, nodeId),
    pageId,
    textContent: node.type === 'text' ? (node.text ?? '') : null,
    image: nodeImage(node),
    mainComponent:
      node.type === 'instance' || node.source !== undefined ? mainComponentOf(env, node) : null,
    isMainComponent: isTreeId(nodeId) && isMainComponent(env.doc, nodeId),
    overrides: overridesOf(node),
  }
}

export function getNodeInfo(call: ToolCall): ToolOutput {
  const nodeId = reqStr(call.args, 'nodeId')
  const info = nodeInfo(call.env, nodeId)
  const board = info['artboardId']
  return { result: info, touched: typeof board === 'string' ? [board] : [] }
}

/** `artboards_of` (internal): each id → its artboard (null for pages and unknown ids). */
export function artboardsOf(call: ToolCall): ToolOutput {
  const ids = Array.isArray(call.args['nodeIds']) ? call.args['nodeIds'] : []
  const artboards: Record<string, string | null> = {}
  for (const id of ids) {
    if (typeof id !== 'string') continue
    artboards[id] = resolveRef(call.env, id) ? artboardOfRef(call.env, id) : null
  }
  return { result: { artboards } }
}

export function assertNotPage(node: ResolvedNode, what: string): void {
  if (node.type === 'page') {
    throw new AgentToolError('invalid_target', `${what} does not work on a page; pass a layer id.`)
  }
}
