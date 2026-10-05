/**
 * Claude Code's `--output-format stream-json` events, reduced to what a run shows: the session
 * id (to resume the thread's conversation later), the current activity ("Taking a screenshot")
 * and the final result. Unknown events and malformed lines are ignored.
 */

export interface StreamUpdate {
  sessionId?: string
  activity?: string
  result?: { ok: boolean; text: string }
}

const ACTIVITY: Record<string, string> = {
  get_guide: 'Reading the guide',
  get_comments: 'Reading the thread',
  get_basic_info: 'Looking at the file',
  get_selection: 'Looking at the selection',
  get_tree_summary: 'Reading the layers',
  get_children: 'Reading the layers',
  get_node_info: 'Reading a layer',
  find_nodes: 'Finding layers',
  get_jsx: 'Reading the design',
  get_computed_styles: 'Reading styles',
  get_tokens: 'Reading tokens',
  get_screenshot: 'Taking a screenshot',
  get_font_family_info: 'Checking fonts',
  write_html: 'Adding layers',
  update_styles: 'Changing styles',
  set_text_content: 'Editing text',
  rename_nodes: 'Renaming layers',
  duplicate_nodes: 'Duplicating layers',
  move_nodes: 'Moving layers',
  delete_nodes: 'Deleting layers',
  create_artboard: 'Creating an artboard',
  create_tokens: 'Adding tokens',
  set_tokens: 'Changing tokens',
  finish_working_on_nodes: 'Finishing up',
  reply_to_comment: 'Replying',
  resolve_comment: 'Resolving the thread',
}

/** "mcp__baren__get_screenshot" → "Taking a screenshot". */
export function activityOf(toolName: string): string {
  const short = toolName.startsWith('mcp__baren__') ? toolName.slice('mcp__baren__'.length) : null
  if (short === null) return 'Working'
  return ACTIVITY[short] ?? 'Working'
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** One stdout line of a run → what changed (empty object when nothing did). */
export function parseStreamLine(line: string): StreamUpdate {
  let event: Record<string, unknown> | null
  try {
    event = record(JSON.parse(line))
  } catch {
    return {}
  }
  if (!event) return {}
  const out: StreamUpdate = {}
  if (event['type'] === 'system' && event['subtype'] === 'init') {
    if (typeof event['session_id'] === 'string') out.sessionId = event['session_id']
    out.activity = 'Starting'
  } else if (event['type'] === 'assistant') {
    const content = record(event['message'])?.['content']
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = record(block)
        if (b?.['type'] === 'tool_use' && typeof b['name'] === 'string')
          out.activity = activityOf(b['name'])
        else if (b?.['type'] === 'thinking' || b?.['type'] === 'text') out.activity ??= 'Thinking'
      }
    }
  } else if (event['type'] === 'result') {
    const ok = event['subtype'] === 'success' && event['is_error'] !== true
    const text = typeof event['result'] === 'string' ? event['result'] : ''
    out.result = { ok, text }
  }
  return out
}
