/**
 * Tools that run in the renderer hosting the file (contract §6): main validates, resolves the
 * file and image sources, forwards the call and formats the answer.
 */
import type { McpToolName } from '../../../renderer/types/bridge'
import {
  ToolError,
  batchFailed,
  errorLine,
  headerText,
  okResult,
  textBlock,
  type ToolResult,
} from '../format'
import type { ToolArgs } from './schemas'
import { TOOL_META } from './schemas'
import { OPEN_SOURCES, PUBLIC_SOURCES } from '../assets'
import type { SessionRef, ToolRuntime } from './context'

/** Tools forwarded to the host as they are. */
export const HOST_TOOLS = [
  'get_basic_info',
  'create_page',
  'rename_pages',
  'get_selection',
  'get_tree_summary',
  'get_children',
  'get_node_info',
  'find_nodes',
  'get_jsx',
  'get_computed_styles',
  'get_tokens',
  'create_tokens',
  'set_tokens',
  'create_artboard',
  'write_html',
  'update_styles',
  'set_text_content',
  'rename_nodes',
  'duplicate_nodes',
  'move_nodes',
  'delete_nodes',
  'get_comments',
  'reply_to_comment',
  'resolve_comment',
] as const satisfies readonly McpToolName[]

export type HostToolName = (typeof HOST_TOOLS)[number]

/** Keys whose non-empty value means "some entry succeeded" in a batch result (§4.9). */
const BATCH_SUCCESS: Partial<Record<HostToolName, readonly string[]>> = {
  rename_pages: ['renamed'],
  set_text_content: ['updated'],
  rename_nodes: ['renamed'],
  update_styles: ['updated'],
  delete_nodes: ['deleted', 'hidden'],
  move_nodes: ['moves'],
  duplicate_nodes: ['duplicates'],
  get_computed_styles: ['styles'],
}

/** create_tokens / set_tokens report `{ name, result: 'error' }` entries in `results`. */
function tokenBatchFailed(body: unknown): boolean {
  const results = (body as { results?: unknown } | null)?.results
  return (
    Array.isArray(results) &&
    results.length > 0 &&
    results.every((r) => (r as { result?: unknown } | null)?.result === 'error')
  )
}

const SIZE_VALUE = /^(\d+(\.\d+)?px|fit-content)$/

/** Tools whose `pageId` defaults to the page of a file URL (find_nodes' pageId narrows a search). */
const PAGE_DEFAULT_TOOLS: ReadonlySet<HostToolName> = new Set(['get_basic_info', 'create_artboard'])

/** Arguments sent to the host: fileId stripped, defaults applied, numbers clamped. */
export function hostArgs(
  tool: HostToolName,
  args: Record<string, unknown>,
  urlPageId: string | null,
): Record<string, unknown> {
  const { fileId: _fileId, ...rest } = args
  const out: Record<string, unknown> = { ...rest }
  // A page in the file URL (baren://file/<id>/<pageId>) is the default page.
  if (urlPageId !== null && out['pageId'] === undefined && PAGE_DEFAULT_TOOLS.has(tool)) {
    out['pageId'] = urlPageId
  }
  switch (tool) {
    case 'get_tree_summary': {
      const depth =
        typeof out['depth'] === 'number' && Number.isFinite(out['depth']) ? out['depth'] : 3
      out['depth'] = Math.min(10, Math.max(1, Math.floor(depth)))
      break
    }
    case 'get_jsx':
      out['format'] ??= 'tailwind'
      out['includeIds'] ??= false
      break
    case 'get_tokens':
      out['format'] ??= 'json'
      break
    case 'find_nodes':
      if (
        out['filters'] === undefined &&
        (out['textValue'] === undefined || out['textValue'] === '')
      ) {
        throw new ToolError('invalid_argument', 'Pass filters, textValue or both')
      }
      break
    case 'create_artboard': {
      const styles = (out['styles'] ?? {}) as Record<string, unknown>
      for (const key of ['width', 'height'] as const) {
        const v = String(styles[key] ?? '').trim()
        if (!SIZE_VALUE.test(v)) {
          throw new ToolError(
            'invalid_argument',
            `styles.${key} must be in px (e.g. "1440px") or "fit-content", not "${v.slice(0, 40)}"`,
          )
        }
      }
      break
    }
    default:
      break
  }
  return out
}

/** Collect image sources for the asset pre-resolution of §4.8. */
async function imageSources(
  rt: ToolRuntime,
  tool: HostToolName,
  args: Record<string, unknown>,
): Promise<string[]> {
  if (tool === 'write_html') return rt.env.collectHtmlSources(String(args['html'] ?? ''))
  if (tool === 'create_artboard') {
    return rt.env.collectStyleSources((args['styles'] ?? {}) as Record<string, unknown>)
  }
  if (tool === 'update_styles') {
    const updates = (args['updates'] ?? []) as { styles?: Record<string, unknown> }[]
    const all: string[] = []
    for (const u of updates) all.push(...(await rt.env.collectStyleSources(u.styles ?? {})))
    return [...new Set(all)]
  }
  return []
}

function timeoutFor(rt: ToolRuntime, tool: HostToolName): number {
  const d = rt.env.deadlines
  if (tool === 'write_html') return d.writeHtml
  return TOOL_META[tool].kind === 'write' ? d.write : d.read
}

/** Ids a write removed (their working indicators clear). */
function removedIds(tool: HostToolName, body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const b = body as Record<string, unknown>
  if (tool === 'delete_nodes' && Array.isArray(b['deleted'])) {
    return b['deleted'].filter((x): x is string => typeof x === 'string')
  }
  if (tool === 'write_html' && typeof b['replacedNodeId'] === 'string') return [b['replacedNodeId']]
  return []
}

export async function runHostTool(
  rt: ToolRuntime,
  session: SessionRef,
  tool: HostToolName,
  args: ToolArgs<HostToolName>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const raw = args as Record<string, unknown>
  const ref = await rt.resolveFile(raw['fileId'] as string | undefined)
  const write = TOOL_META[tool].kind === 'write'
  const forwarded = hostArgs(tool, raw, ref.pageId)
  const sources = await imageSources(rt, tool, forwarded)
  const assets =
    sources.length > 0
      ? await rt.env.resolveSources(sources, signal, session.scope ? PUBLIC_SOURCES : OPEN_SOURCES)
      : undefined
  const res = await rt.callHost(session, ref.fileId, tool, forwarded, {
    write,
    timeoutMs: timeoutFor(rt, tool),
    signal,
    ...(assets ? { assets } : {}),
  })
  const removed = removedIds(tool, res.result)
  if (removed.length > 0) rt.env.agents.forget(ref.fileId, removed)
  const success = BATCH_SUCCESS[tool]
  const failed =
    tool === 'create_tokens' || tool === 'set_tokens'
      ? tokenBatchFailed(res.result)
      : success
        ? batchFailed(res.result, success)
        : false
  const result = okResult(res.header, res.result)
  if (failed) result.isError = true
  return result
}

/** A host error with the file's header, in the two-block shape (header, then the error). */
export function hostErrorResult(
  rt: ToolRuntime,
  fileId: string | null,
  error: ToolError,
): ToolResult {
  const header = rt.headerFor(fileId)
  return {
    content: [
      ...(header ? [textBlock(headerText(header))] : []),
      textBlock(errorLine(error.code, error.message)),
    ],
    isError: true,
  }
}
