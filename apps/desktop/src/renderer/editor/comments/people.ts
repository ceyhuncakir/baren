/**
 * Who a comment can @mention: collaborators in the file now (presence), agents working in it,
 * Claude Code when comment requests can run on this computer (`agentRun.ts`), the members of the
 * file's team (loaded once per session from the server; the design fixture's share model in
 * fixture mode) and everyone who commented in the file before.
 */
import type { CommentAuthor, CommentMention, CommentThread } from '@baren/schema'
import { useEffect, useMemo, useState } from 'react'
import { api, loadShareModel } from '../collab/account'
import { RUN_AGENT_NAME } from '../../lib/agentRunTarget'
import { canRunAgent, useAgentRunnerStatus } from '../../state/agentRuns'
import { useCommentThreads, useEditor, useEditorState } from '../session/context'
import type { EditorSession } from '../session/context'
import { agentMentionId, mentionCandidates } from './mentions'

const teamMembers = new WeakMap<EditorSession, Promise<CommentMention[]>>()

/** The file's team members (empty for a file that is not in a team, or offline). */
function loadMembers(session: EditorSession): Promise<CommentMention[]> {
  const cached = teamMembers.get(session)
  if (cached) return cached
  const { identity } = session.store.getState()
  const load = async (): Promise<CommentMention[]> => {
    if (session.fixture.enabled) {
      const model = await loadShareModel(session.fixture, session.file, identity, session.teams)
      return model.people
        .filter((p) => !p.isSelf)
        .map((p) => ({ id: p.id, name: p.name, kind: 'user' as const }))
    }
    const teamId = session.file?.teamId ?? null
    if (teamId === null) return []
    const members = await api().teams.members(teamId)
    return members.map((m) => ({ id: m.userId, name: m.name, kind: 'user' as const }))
  }
  const pending = load().catch(() => [])
  // Retry on the next use when it failed or the account was not loaded yet.
  void pending.then((list) => {
    if (list.length === 0) teamMembers.delete(session)
  })
  teamMembers.set(session, pending)
  return pending
}

function pastAuthors(threads: readonly CommentThread[]): CommentMention[] {
  const out: CommentMention[] = []
  for (const t of threads) for (const m of t.messages) out.push({ ...m.author })
  return out.reverse()
}

/** Mentionable people and agents for this user, people in the file first. */
export function useMentionCandidates(me: CommentAuthor): CommentMention[] {
  const session = useEditor()
  const peers = useEditorState((s) => s.peers)
  const agents = useEditorState((s) => s.agents)
  const accountLoaded = useEditorState((s) => s.accountLoaded)
  const threads = useCommentThreads()
  const runnable = canRunAgent(useAgentRunnerStatus())
  const [members, setMembers] = useState<CommentMention[]>([])

  useEffect(() => {
    if (!accountLoaded) return
    let alive = true
    void loadMembers(session).then((list) => alive && setMembers(list))
    return () => {
      alive = false
    }
  }, [session, accountLoaded])

  return useMemo(
    () =>
      mentionCandidates(me, {
        peers: peers.map((p) => ({ id: p.userId, name: p.name, kind: 'user' })),
        agents: [
          ...agents.map((a) => ({
            id: agentMentionId(a.name),
            name: a.name,
            kind: 'agent' as const,
          })),
          ...(runnable
            ? [{ id: agentMentionId(RUN_AGENT_NAME), name: RUN_AGENT_NAME, kind: 'agent' as const }]
            : []),
        ],
        members,
        authors: pastAuthors(threads),
      }),
    [me, peers, agents, runnable, members, threads],
  )
}
