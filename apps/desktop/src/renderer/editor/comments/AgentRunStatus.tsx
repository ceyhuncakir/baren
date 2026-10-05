/**
 * A thread's comment request to Claude Code, under its messages: working (with what it is doing
 * and Stop), failed (why, and Retry), stopped, or done without a reply. Nothing once Claude Code
 * replied: its message is the answer.
 */
import type { CommentThread } from '@baren/schema'
import { Button, Spinner } from '@baren/ui'
import { bridge } from '../../lib/bridge'
import { RUN_AGENT_NAME } from '../../lib/agentRunTarget'
import { isRunning, useThreadRun } from '../../state/agentRuns'
import { useEditor } from '../session/context'
import { maybeRunAgent } from './agentRun'
import css from './Comments.module.css'

export function AgentRunStatus({ thread }: { thread: CommentThread }) {
  const session = useEditor()
  const run = useThreadRun(session.fileId, thread.id)
  if (run === null) return null
  if (isRunning(run)) {
    return (
      <div className={css.runStatus} data-state="working" role="status">
        <Spinner size={12} />
        <span className={css.runText}>
          {RUN_AGENT_NAME} is working
          {run.activity && <span className={css.runActivity}> · {run.activity}</span>}
        </span>
        <Button
          variant="link-muted"
          size={28}
          textSize={12}
          onClick={() => void bridge.agentRuns.stop(run.id)}
        >
          Stop
        </Button>
      </div>
    )
  }
  const replied = thread.messages.some(
    (m) =>
      m.author.kind === 'agent' && m.author.name === RUN_AGENT_NAME && m.createdAt >= run.startedAt,
  )
  if (run.state === 'done') {
    if (replied) return null
    return (
      <div className={css.runStatus} data-state="done" role="status">
        <span className={css.runText}>{RUN_AGENT_NAME} finished without replying.</span>
      </div>
    )
  }
  if (run.state === 'stopped') {
    return (
      <div className={css.runStatus} data-state="stopped" role="status">
        <span className={css.runText}>You stopped {RUN_AGENT_NAME}.</span>
      </div>
    )
  }
  const asked = thread.messages.find((m) => m.id === run.messageId)
  return (
    <div className={css.runStatus} data-state="failed" role="status">
      <span className={css.runText}>
        {RUN_AGENT_NAME} couldn't finish
        {run.error && <span className={css.runError}>{run.error}</span>}
      </span>
      {asked && (
        <Button
          variant="link-muted"
          size={28}
          textSize={12}
          onClick={() =>
            maybeRunAgent(session, thread, asked.id, asked.author.name, asked.body, asked.mentions)
          }
        >
          Retry
        </Button>
      )}
    </div>
  )
}
