/**
 * Comment tools: get_comments (read), reply_to_comment and resolve_comment (writes). Comments
 * are threads collaborators pin on layers (`@baren/schema` comments); agents read them to see
 * feedback, reply when they addressed it and resolve it when it is handled.
 *
 * The writes commit with a `comment:` origin instead of `agent:<tool>`: the user's design undo
 * excludes comment changes, so Ctrl+Z never takes an agent's reply back. They touch no artboard
 * (no "working" badge for a reply).
 */
import {
  addCommentMessage,
  getChildIds,
  getCommentThread,
  getCommentThreads,
  getNode,
  setCommentResolved,
  transact,
  type CommentAuthor,
  type CommentThread,
} from '@baren/schema'
import { AgentToolError } from '../errors'
import { round2 } from '../geometry'
import { artboardOfRef, displayName, requireRef, resolveRef } from '../model'
import {
  bool,
  pageArg,
  reqStr,
  str,
  type HostEnv,
  type ToolCall,
  type ToolOutput,
} from '../context'

/** Origin prefix of comment commits (excluded from the editor's undo). */
export const COMMENT_ORIGIN_PREFIX = 'comment:'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Where the pin is now: its layer's top-left plus the offset, else its saved page position. */
function pinPosition(env: HostEnv, t: CommentThread): { x: number; y: number } {
  if (t.nodeId !== null && resolveRef(env, t.nodeId)) {
    const g = env.geometry.fields(t.nodeId)
    if (g.worldX !== null && g.worldY !== null) {
      return { x: round2(g.worldX + t.x), y: round2(g.worldY + t.y) }
    }
  }
  return { x: round2(t.worldX), y: round2(t.worldY) }
}

function ref(env: HostEnv, id: string | null): { id: string; name: string } | null {
  if (id === null) return null
  const node = resolveRef(env, id)
  return node ? { id, name: displayName(env, node) } : null
}

/**
 * A thread as agents see it (get_comments, reply_to_comment, resolve_comment). `you`: the calling
 * agent's comment identity (`agent:<name>`); messages that @mention it get `mentionsYou`, and so
 * does the thread. Messages list their mentions only when they have some.
 */
export function threadOut(
  env: HostEnv,
  t: CommentThread,
  you: string | null = null,
): Record<string, unknown> {
  const layer = ref(env, t.nodeId)
  const artboardId = layer === null ? null : artboardOfRef(env, layer.id)
  let mentionsYou = false
  const messages = t.messages.map((m) => {
    const out: Record<string, unknown> = {
      id: m.id,
      author: { name: m.author.name, kind: m.author.kind },
      body: m.body,
      createdAt: iso(m.createdAt),
      edited: m.editedAt !== null,
    }
    if (m.mentions.length > 0) {
      out['mentions'] = m.mentions.map((x) => ({ name: x.name, kind: x.kind }))
      if (you !== null && m.mentions.some((x) => x.id === you)) {
        out['mentionsYou'] = true
        mentionsYou = true
      }
    }
    return out
  })
  const out: Record<string, unknown> = {
    id: t.id,
    status: t.resolved ? 'resolved' : 'open',
    page: { id: t.pageId, name: getNode(env.doc, t.pageId)?.name ?? '' },
    layer,
    artboard: ref(env, artboardId),
    position: pinPosition(env, t),
    messages,
  }
  if (mentionsYou) out['mentionsYou'] = true
  if (t.resolved) {
    if (t.resolvedBy !== null) out['resolvedBy'] = t.resolvedBy
    if (t.resolvedAt !== null) out['resolvedAt'] = iso(t.resolvedAt)
  }
  return out
}

/** The artboard a thread's layer is on, or null (pinned on the page, or its layer is gone). */
export function threadArtboard(env: HostEnv, t: CommentThread): string | null {
  return t.nodeId !== null && resolveRef(env, t.nodeId) ? artboardOfRef(env, t.nodeId) : null
}

/** True when `id` is `ancestor` or inside it. */
function within(env: HostEnv, id: string, ancestor: string): boolean {
  let cur: string | null = id
  for (let guard = 0; cur !== null && guard < 10_000; guard++) {
    if (cur === ancestor) return true
    cur = resolveRef(env, cur)?.parentId ?? null
  }
  return false
}

// ---------------------------------------------------------------------------
// get_comments
// ---------------------------------------------------------------------------

export function getComments(call: ToolCall): ToolOutput {
  const { env, args } = call
  const pageId = str(args, 'pageId')
  const nodeId = str(args, 'nodeId')
  const includeResolved = bool(args, 'includeResolved') === true
  const threadId = str(args, 'threadId')
  const page = pageId === undefined || pageId === '' ? null : pageArg(env, pageId)
  const node = nodeId === undefined || nodeId === '' ? null : requireRef(env, nodeId)
  const pageOrder = new Map(getChildIds(env.doc, null).map((id, i) => [id, i]))
  const threads = getCommentThreads(env.doc).filter((t) => {
    if (threadId !== undefined && threadId !== '' && t.id !== threadId) return false
    if (!includeResolved && t.resolved) return false
    if (page !== null && t.pageId !== page) return false
    if (node !== null) {
      if (node.type === 'page') return t.pageId === node.id
      return t.nodeId !== null && within(env, t.nodeId, node.id)
    }
    return true
  })
  threads.sort(
    (a, b) =>
      (pageOrder.get(a.pageId) ?? Number.MAX_SAFE_INTEGER) -
        (pageOrder.get(b.pageId) ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
  )
  const touched = new Set<string>()
  for (const t of threads) {
    const board = threadArtboard(env, t)
    if (board !== null) touched.add(board)
  }
  return {
    result: {
      count: threads.length,
      threads: threads.map((t) => threadOut(env, t, agentAuthor(call).id)),
    },
    touched: [...touched],
  }
}

/** `{ open, resolved }` for the file and open threads per artboard (get_basic_info). */
export function commentCounts(env: HostEnv): {
  open: number
  resolved: number
  openByArtboard: Map<string, number>
} {
  let open = 0
  let resolved = 0
  const openByArtboard = new Map<string, number>()
  for (const t of getCommentThreads(env.doc)) {
    if (t.resolved) {
      resolved++
      continue
    }
    open++
    const board = threadArtboard(env, t)
    if (board !== null) openByArtboard.set(board, (openByArtboard.get(board) ?? 0) + 1)
  }
  return { open, resolved, openByArtboard }
}

// ---------------------------------------------------------------------------
// reply_to_comment, resolve_comment
// ---------------------------------------------------------------------------

function requireThread(env: HostEnv, threadId: string): CommentThread {
  const thread = getCommentThread(env.doc, threadId)
  if (!thread) {
    throw new AgentToolError(
      'comment_not_found',
      `Comment thread ${JSON.stringify(threadId)} not found. get_comments lists the threads (it was deleted, or pass includeResolved: true for resolved ones).`,
    )
  }
  return thread
}

/** One transaction with origin `comment:<action>` (not undoable by the user's design undo). */
function commitComment<T>(call: ToolCall, action: string, fn: () => T): T {
  if (call.signal.aborted) throw new AgentToolError('cancelled', 'The request was cancelled.')
  return transact(call.env.doc, fn, { origin: `${COMMENT_ORIGIN_PREFIX}${action}` })
}

function agentName(call: ToolCall): string {
  return call.agent?.name || 'Agent'
}

export function agentAuthor(call: ToolCall): CommentAuthor {
  const name = agentName(call)
  return { id: `agent:${name}`, name, kind: 'agent' }
}

export function replyToComment(call: ToolCall): ToolOutput {
  const { env, args } = call
  const threadId = reqStr(args, 'threadId')
  const body = reqStr(args, 'body')
  requireThread(env, threadId)
  const messageId = commitComment(call, 'agent-reply', () =>
    addCommentMessage(env.doc, threadId, { author: agentAuthor(call), body }),
  )
  return {
    result: {
      messageId,
      thread: threadOut(env, requireThread(env, threadId), agentAuthor(call).id),
    },
  }
}

export function resolveComment(call: ToolCall): ToolOutput {
  const { env, args } = call
  const threadId = reqStr(args, 'threadId')
  const resolved = bool(args, 'resolved') ?? true
  const thread = requireThread(env, threadId)
  if (thread.resolved !== resolved) {
    commitComment(call, resolved ? 'agent-resolve' : 'agent-reopen', () =>
      setCommentResolved(env.doc, threadId, resolved, agentName(call)),
    )
  }
  return { result: { thread: threadOut(env, requireThread(env, threadId), agentAuthor(call).id) } }
}
