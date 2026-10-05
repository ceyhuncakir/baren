/**
 * The agent comment requests go to: a comment that @mentions it starts a background run
 * (`main/agentRuns`). Shared by main and the editor; pure.
 */

/** Claude Code's display name in MCP presence and comment mentions. */
export const RUN_AGENT_NAME = 'Claude Code'

/** True when a comment's mentions address the agent comment requests go to. */
export function mentionsRunAgent(mentions: readonly { name: string; kind: string }[]): boolean {
  return mentions.some(
    (m) => m.kind === 'agent' && m.name.toLowerCase() === RUN_AGENT_NAME.toLowerCase(),
  )
}
