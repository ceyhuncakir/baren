/**
 * Registers every tool of contract §6 on a session's `McpServer` and dispatches calls: main
 * tools, host tools and pixel tools. Every failure becomes an `Error [code]: …` tool result.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolName } from '../../../renderer/types/bridge'
import { isToolError, resultFromError, resultSize, type ToolResult } from '../format'
import { parseFileRef, type SessionRef, type ToolRuntime } from './context'
import { HOST_TOOLS, runHostTool, type HostToolName } from './host'
import { createFile, finishWorking, getGuide, listFiles, openFile } from './main'
import { scopedArgs } from './runScope'
import {
  exportNodes,
  getComputedStyles,
  getFillImage,
  getFontFamilyInfo,
  getScreenshot,
} from './pixels'
import { TOOL_META, TOOL_NAMES, annotationsFor, schemas, type ToolArgs } from './schemas'

const HOST_TOOL_SET: ReadonlySet<string> = new Set(HOST_TOOLS)

/** The file a call is about (its `fileId`, else the default file), for error headers and logs. */
function targetFile(rt: ToolRuntime, args: unknown, session?: SessionRef): string | null {
  if (session?.scope) return session.scope.fileId
  const v = (args as { fileId?: unknown } | null)?.fileId
  if (typeof v !== 'string' || v.trim() === '') return rt.env.hosts.defaultFileId()
  return parseFileRef(v)?.fileId ?? null
}

/** Run one tool call (already validated by the SDK against the zod schema). */
export async function callTool(
  rt: ToolRuntime,
  session: SessionRef,
  name: McpToolName,
  given: unknown,
  signal: AbortSignal,
): Promise<ToolResult> {
  const started = Date.now()
  let result: ToolResult
  let args = given
  try {
    rt.agentOf(session)
    // A comment request's session: its own file only (runScope.ts).
    if (session.scope) args = scopedArgs(session.scope, name, args)
    switch (name) {
      case 'get_guide':
        result = getGuide(rt, args as ToolArgs<'get_guide'>)
        rt.env.agents.noteCall(session.sessionId, null, null)
        break
      case 'list_files':
        result = await listFiles(rt, args as ToolArgs<'list_files'>)
        rt.env.agents.noteCall(session.sessionId, null, null)
        break
      case 'create_file':
        result = await createFile(rt, session, args as ToolArgs<'create_file'>, signal)
        break
      case 'open_file':
        result = await openFile(rt, session, args as ToolArgs<'open_file'>, signal)
        break
      case 'finish_working_on_nodes':
        result = await finishWorking(
          rt,
          session,
          args as ToolArgs<'finish_working_on_nodes'>,
          signal,
        )
        break
      case 'get_screenshot':
        result = await getScreenshot(rt, session, args as ToolArgs<'get_screenshot'>, signal)
        break
      case 'get_fill_image':
        result = await getFillImage(rt, session, args as ToolArgs<'get_fill_image'>, signal)
        break
      case 'get_font_family_info':
        result = await getFontFamilyInfo(rt, args as ToolArgs<'get_font_family_info'>, signal)
        rt.env.agents.noteCall(session.sessionId, null, null)
        break
      case 'get_computed_styles':
        result = await getComputedStyles(
          rt,
          session,
          args as ToolArgs<'get_computed_styles'>,
          signal,
        )
        break
      case 'export':
        result = await exportNodes(rt, session, args as ToolArgs<'export'>, signal)
        break
      default:
        if (!HOST_TOOL_SET.has(name)) throw new Error(`Unknown tool ${name}`)
        result = await runHostTool(
          rt,
          session,
          name as HostToolName,
          args as ToolArgs<HostToolName>,
          signal,
        )
    }
  } catch (error) {
    if (!isToolError(error)) rt.env.log.error(`tool ${name} failed`, error)
    result = resultFromError(error, rt.headerFor(targetFile(rt, args, session)))
  }
  rt.env.log.debug('tool call', {
    tool: name,
    file: targetFile(rt, args, session),
    ms: Date.now() - started,
    outcome: result.isError
      ? (/^Error \[([a-z_]+)\]/.exec(lastText(result))?.[1] ?? 'error')
      : 'ok',
    bytes: resultSize(result),
  })
  return result
}

function lastText(result: ToolResult): string {
  for (let i = result.content.length - 1; i >= 0; i--) {
    const c = result.content[i]
    if (c?.type === 'text') return c.text
  }
  return ''
}

/** Register every §6 tool on `server` for one MCP session. */
export function registerTools(server: McpServer, rt: ToolRuntime, session: SessionRef): void {
  for (const name of TOOL_NAMES) {
    const meta = TOOL_META[name]
    // One generic registration per tool; the SDK validates `args` against the schema first.
    const register = server.registerTool.bind(server) as (
      name: string,
      config: {
        title: string
        description: string
        inputSchema: unknown
        annotations: Record<string, unknown>
      },
      cb: (args: unknown, extra: { signal: AbortSignal }) => Promise<ToolResult>,
    ) => unknown
    register(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: schemas[name],
        annotations: annotationsFor(name),
      },
      (args, extra) => callTool(rt, session, name, args, extra.signal),
    )
  }
}
