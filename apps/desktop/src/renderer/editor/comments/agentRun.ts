/**
 * Comment requests to Claude Code from the editor: a comment the user posts that @mentions
 * Claude Code is handed to a background run (`bridge.agentRuns`, `main/agentRuns`) that answers
 * in the thread. Only the asker's own app starts it; collaborators see the agent work through
 * its MCP presence like any agent.
 */
import type { CommentMention, CommentThread } from '@baren/schema'
import { toast } from '@baren/ui'
import { mentionsRunAgent } from '../../lib/agentRunTarget'
import { bridge } from '../../lib/bridge'
import { canRunAgent, receiveRun, useAgentRuns } from '../../state/agentRuns'
import type { AgentRunRequest } from '../../types/bridge'
import type { EditorSession } from '../session/context'

function ref(session: EditorSession, id: string | null): { id: string; name: string } | null {
  if (id === null) return null
  const meta = session.tree.meta(id)
  return meta ? { id, name: meta.name } : null
}

/** What the run needs: the file, the page, the layer and artboard the thread is pinned on. */
export function runRequest(
  session: EditorSession,
  thread: CommentThread,
  messageId: string,
  authorName: string,
  body: string,
): AgentRunRequest {
  const layer = ref(session, thread.nodeId)
  const artboard = layer ? ref(session, session.tree.topLevelOf(layer.id)) : null
  return {
    fileId: session.fileId,
    fileName: session.docName.getSnapshot(),
    pageName: session.tree.meta(thread.pageId)?.name ?? '',
    threadId: thread.id,
    messageId,
    authorName,
    body,
    layer,
    artboard,
  }
}

/**
 * After the user posted a message: when it mentions Claude Code and runs are possible, start
 * one for its thread. Failures (off, not installed, busy, MCP off) become a toast.
 */
export function maybeRunAgent(
  session: EditorSession,
  thread: CommentThread | undefined,
  messageId: string,
  authorName: string,
  body: string,
  mentions: readonly CommentMention[],
): void {
  if (!thread || session.headless || !mentionsRunAgent(mentions)) return
  const status = useAgentRuns.getState().status
  if (!canRunAgent(status)) {
    toast(
      status?.claudePath === null
        ? "Claude Code isn't installed on this computer, so it can't answer comments."
        : 'Comment requests to Claude Code are off in Preferences.',
    )
    return
  }
  void bridge.agentRuns
    .start(runRequest(session, thread, messageId, authorName, body))
    .then(receiveRun)
    .catch((error: unknown) =>
      toast(error instanceof Error ? error.message : "Couldn't ask Claude Code."),
    )
}
