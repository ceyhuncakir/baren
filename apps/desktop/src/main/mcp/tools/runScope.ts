/**
 * A comment request's session (`RunScope`, `agentRuns/`): its `claude -p` run answers one
 * comment and reads text collaborators wrote, so it works on that comment's file only. File
 * navigation (list, open, create) and export (files on disk) are refused, a `fileId` must name
 * the comment's file, and a call without one goes to that file, never to the one the user is
 * looking at. Image sources are limited separately (`PUBLIC_SOURCES`, tools/host.ts).
 */
import type { McpToolName } from '../../../renderer/types/bridge'
import { ToolError } from '../format'
import type { RunScope } from '../security'
import { parseFileRef } from './context'
import { schemas } from './schemas'

/** The tools a comment request may call (a new tool stays out until it is added here). */
export const RUN_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>([
  'get_guide',
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
  'get_screenshot',
  'get_fill_image',
  'get_font_family_info',
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
  'finish_working_on_nodes',
  'get_comments',
  'reply_to_comment',
  'resolve_comment',
])

function takesFileId(name: McpToolName): boolean {
  const shape = (schemas[name] as { shape?: Record<string, unknown> }).shape
  return shape !== undefined && 'fileId' in shape
}

/** The arguments of a scoped call, `fileId` checked or filled in; throws when it is refused. */
export function scopedArgs(scope: RunScope, name: McpToolName, args: unknown): unknown {
  if (!RUN_TOOLS.has(name)) {
    throw new ToolError(
      'unsupported',
      `A comment request can't use ${name}: it works on the file of its comment only (fileId ${scope.fileId}).`,
    )
  }
  if (!takesFileId(name)) return args
  const raw = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  const given = raw['fileId']
  if (typeof given !== 'string' || given.trim() === '') return { ...raw, fileId: scope.fileId }
  if (parseFileRef(given)?.fileId !== scope.fileId) {
    throw new ToolError(
      'invalid_argument',
      `A comment request can only work on the file of its comment (fileId ${scope.fileId}).`,
    )
  }
  return args
}
