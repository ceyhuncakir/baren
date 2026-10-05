/**
 * What a comment request asks Claude Code to do (`agentRuns/runner.ts`): the task prompt built
 * from the comment, the system prompt addition for unattended runs and the `claude` arguments.
 * Pure: unit-tested without spawning anything.
 */
import type { AgentRunRequest } from '../../renderer/types/bridge'

export { RUN_AGENT_NAME, mentionsRunAgent } from '../../renderer/lib/agentRunTarget'

/** The only tools a run may use: the built-in MCP server's. */
export const RUN_ALLOWED_TOOLS = 'mcp__baren__*'

export const RUN_SYSTEM_PROMPT = [
  'You are running unattended: a Baren user asked you something in a design comment and nobody',
  'is watching this session. You can only use the baren MCP tools. Communicate with the people',
  'in the file through reply_to_comment on the thread you were given: they never see your other',
  'output. Never ask for confirmation: do the work, or reply with a short question when the',
  'request is unclear.',
].join(' ')

function quote(name: string): string {
  return JSON.stringify(name)
}

/** The task: where the comment is, what it says, and the steps to answer it. */
export function buildPrompt(req: AgentRunRequest): string {
  const where = [
    `File: ${quote(req.fileName)} (fileId: ${req.fileId})`,
    `Page: ${quote(req.pageName)}`,
    req.layer
      ? `Pinned on layer ${quote(req.layer.name)} (nodeId: ${req.layer.id})` +
        (req.artboard && req.artboard.id !== req.layer.id
          ? ` in artboard ${quote(req.artboard.name)} (nodeId: ${req.artboard.id})`
          : '')
      : 'Pinned on the page, not on a layer',
    `Comment thread: ${req.threadId}`,
  ]
  return [
    'You were mentioned in a comment in Baren, a design tool.',
    '',
    ...where,
    '',
    `${req.authorName} wrote:`,
    req.body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
    '',
    'Answer it:',
    '1. Load the guide once: get_guide({ topic: "baren-mcp-instructions" }).',
    `2. Read the whole thread for context: get_comments({ fileId: "${req.fileId}", threadId: "${req.threadId}", includeResolved: true }).`,
    '3. Look at what the comment points at (get_jsx, get_screenshot) before you change anything.',
    '4. Make the change on that file in small steps, check it with get_screenshot, then call finish_working_on_nodes.',
    '5. Reply in the thread with reply_to_comment: one or two sentences on what you changed. If the request is unclear or you could not do it, reply with a short question or the reason instead. Do not resolve the thread unless you were asked to.',
  ].join('\n')
}

export interface RunArgsInput {
  prompt: string
  /** A JSON file with the `baren` MCP server (URL and token). */
  mcpConfigPath: string
  /** Continue this thread's earlier Claude Code session. */
  resumeSessionId: string | null
}

/** `claude` arguments: print mode, only the baren MCP server and its tools, no prompts. */
export function runArgs(input: RunArgsInput): string[] {
  const args = [
    '-p',
    input.prompt,
    '--mcp-config',
    input.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    RUN_ALLOWED_TOOLS,
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt',
    RUN_SYSTEM_PROMPT,
    '--output-format',
    'stream-json',
    '--verbose',
  ]
  if (input.resumeSessionId !== null) args.push('--resume', input.resumeSessionId)
  return args
}

/** The MCP config a run loads: the built-in server over Streamable HTTP. */
export function mcpConfig(url: string, token: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        baren: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  )}\n`
}
