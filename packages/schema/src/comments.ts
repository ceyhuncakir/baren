/**
 * Comments: threads pinned to a layer (or a point on a page). They live in the document's root
 * map `comments`, so they sync to every collaborator with the rest of the file, work offline and
 * are readable by agents through the MCP host.
 *
 * ```
 * comments: LoroMap
 *   <threadId>: mergeable LoroMap {
 *     pageId: string
 *     nodeId: string | null      the layer the pin sits on (null: on the page)
 *     x, y: number               offset from that layer's top-left, world px (page position when
 *                                nodeId is null)
 *     worldX, worldY: number     page position when pinned or last moved (where the pin goes if
 *                                its layer is deleted)
 *     createdAt: number          epoch ms
 *     resolved: boolean
 *     resolvedBy?: string        display name
 *     resolvedAt?: number
 *     messages: mergeable LoroMap {
 *       <messageId>: mergeable LoroMap {
 *         authorId, authorName: string, authorKind: 'user' | 'agent',
 *         body: string, createdAt: number, editedAt?: number
 *       }
 *     }
 *   }
 * ```
 *
 * Messages are keyed by id rather than listed, so concurrent replies from several peers merge;
 * they are ordered by `createdAt` (then id). The first message opens the thread: deleting it
 * deletes the thread. Every helper commits unless it runs inside `transact`; editors commit
 * comment changes with a `comment:` origin so design undo never touches them.
 */
import { LoroMap, type LoroDoc } from 'loro-crdt'
import { autoCommit, commentsMap } from './doc.ts'
import { SchemaError } from './errors.ts'
import { newCommentId } from './ids.ts'

export const MAX_COMMENT_LENGTH = 10_000
const MAX_AUTHOR_FIELD = 256

export interface CommentAuthor {
  /** User id, `agent:<name>` for agents, or `local` in a file that is not shared. */
  id: string
  name: string
  kind: 'user' | 'agent'
}

export interface CommentMessage {
  id: string
  author: CommentAuthor
  body: string
  createdAt: number
  editedAt: number | null
}

export interface CommentThread {
  id: string
  pageId: string
  nodeId: string | null
  x: number
  y: number
  worldX: number
  worldY: number
  createdAt: number
  resolved: boolean
  resolvedBy: string | null
  resolvedAt: number | null
  /** Oldest first; the first one opened the thread. */
  messages: CommentMessage[]
}

export interface CommentPin {
  pageId: string
  nodeId: string | null
  x: number
  y: number
  /** The pin's page position now. */
  worldX: number
  worldY: number
}

function invalid(message: string): never {
  throw new SchemaError('invalid-comment', message)
}

function checkBody(body: string): string {
  const text = body.trim()
  if (text === '') invalid('A comment needs some text')
  if (text.length > MAX_COMMENT_LENGTH)
    invalid(`Comments are at most ${MAX_COMMENT_LENGTH} characters`)
  return text
}

function checkAuthor(author: CommentAuthor): void {
  if (author.kind !== 'user' && author.kind !== 'agent') invalid('Unknown author kind')
  for (const v of [author.id, author.name]) {
    if (typeof v !== 'string' || v === '' || v.length > MAX_AUTHOR_FIELD)
      invalid('A comment author needs an id and a name')
  }
}

function checkPin(pin: CommentPin): void {
  if (typeof pin.pageId !== 'string' || pin.pageId === '') invalid('A comment needs a page')
  if (pin.nodeId !== null && (typeof pin.nodeId !== 'string' || pin.nodeId === ''))
    invalid('Invalid comment layer')
  for (const v of [pin.x, pin.y, pin.worldX, pin.worldY]) {
    if (!Number.isFinite(v)) invalid('Comment positions must be finite numbers')
  }
}

function setPin(entry: LoroMap, pin: CommentPin): void {
  entry.set('pageId', pin.pageId)
  entry.set('nodeId', pin.nodeId)
  entry.set('x', pin.x)
  entry.set('y', pin.y)
  entry.set('worldX', pin.worldX)
  entry.set('worldY', pin.worldY)
}

function threadMap(doc: LoroDoc, threadId: string): LoroMap {
  const entry = commentsMap(doc).get(threadId)
  if (!(entry instanceof LoroMap)) {
    throw new SchemaError('comment-not-found', `Comment thread not found: ${threadId}`)
  }
  return entry
}

function writeMessage(
  thread: LoroMap,
  id: string,
  author: CommentAuthor,
  body: string,
  now: number,
): void {
  const msg = thread.ensureMergeableMap('messages').ensureMergeableMap(id)
  msg.set('authorId', author.id)
  msg.set('authorName', author.name)
  msg.set('authorKind', author.kind)
  msg.set('body', body)
  msg.set('createdAt', now)
}

/** Start a thread with its first message; returns the thread id. */
export function createCommentThread(
  doc: LoroDoc,
  input: CommentPin & { author: CommentAuthor; body: string; now?: number },
): string {
  checkPin(input)
  checkAuthor(input.author)
  const body = checkBody(input.body)
  const now = input.now ?? Date.now()
  const id = newCommentId()
  const entry = commentsMap(doc).ensureMergeableMap(id)
  setPin(entry, input)
  entry.set('createdAt', now)
  entry.set('resolved', false)
  writeMessage(entry, newCommentId(), input.author, body, now)
  autoCommit(doc)
  return id
}

/** Reply in a thread; returns the message id. Replying does not reopen a resolved thread. */
export function addCommentMessage(
  doc: LoroDoc,
  threadId: string,
  input: { author: CommentAuthor; body: string; now?: number },
): string {
  const thread = threadMap(doc, threadId)
  checkAuthor(input.author)
  const body = checkBody(input.body)
  const id = newCommentId()
  writeMessage(thread, id, input.author, body, input.now ?? Date.now())
  autoCommit(doc)
  return id
}

function messageMap(doc: LoroDoc, threadId: string, messageId: string): LoroMap {
  const messages = threadMap(doc, threadId).get('messages')
  const msg = messages instanceof LoroMap ? messages.get(messageId) : undefined
  if (!(msg instanceof LoroMap)) {
    throw new SchemaError('comment-not-found', `Comment not found: ${messageId}`)
  }
  return msg
}

export function editCommentMessage(
  doc: LoroDoc,
  threadId: string,
  messageId: string,
  body: string,
  now: number = Date.now(),
): void {
  const msg = messageMap(doc, threadId, messageId)
  const text = checkBody(body)
  if (msg.get('body') === text) return
  msg.set('body', text)
  msg.set('editedAt', now)
  autoCommit(doc)
}

/** Delete one message; deleting the thread's first message deletes the whole thread. */
export function deleteCommentMessage(doc: LoroDoc, threadId: string, messageId: string): void {
  messageMap(doc, threadId, messageId)
  const thread = getCommentThread(doc, threadId)
  if (thread?.messages[0]?.id === messageId) {
    deleteCommentThread(doc, threadId)
    return
  }
  const messages = threadMap(doc, threadId).get('messages') as LoroMap
  messages.delete(messageId)
  autoCommit(doc)
}

export function deleteCommentThread(doc: LoroDoc, threadId: string): void {
  const map = commentsMap(doc)
  if (map.get(threadId) === undefined) return
  map.delete(threadId)
  autoCommit(doc)
}

export function setCommentResolved(
  doc: LoroDoc,
  threadId: string,
  resolved: boolean,
  by: string | null = null,
  now: number = Date.now(),
): void {
  const thread = threadMap(doc, threadId)
  if (thread.get('resolved') === resolved) return
  thread.set('resolved', resolved)
  if (resolved) {
    if (by !== null) thread.set('resolvedBy', by)
    thread.set('resolvedAt', now)
  } else {
    thread.delete('resolvedBy')
    thread.delete('resolvedAt')
  }
  autoCommit(doc)
}

/** Move a pin (another layer, another spot, or onto the page). */
export function moveCommentThread(doc: LoroDoc, threadId: string, pin: CommentPin): void {
  checkPin(pin)
  setPin(threadMap(doc, threadId), pin)
  autoCommit(doc)
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function decodeMessage(id: string, raw: unknown): CommentMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const body = typeof m['body'] === 'string' ? m['body'] : null
  const authorId = str(m['authorId'])
  if (body === null || authorId === null) return null
  return {
    id,
    author: {
      id: authorId,
      name: str(m['authorName']) ?? 'Someone',
      kind: m['authorKind'] === 'agent' ? 'agent' : 'user',
    },
    body,
    createdAt: num(m['createdAt']),
    editedAt: typeof m['editedAt'] === 'number' ? m['editedAt'] : null,
  }
}

/** Decode one thread from its JSON; null when it is malformed or has no messages. */
export function decodeCommentThread(id: string, raw: unknown): CommentThread | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  const pageId = str(t['pageId'])
  if (pageId === null) return null
  const rawMessages = t['messages']
  const messages =
    typeof rawMessages === 'object' && rawMessages !== null
      ? Object.entries(rawMessages as Record<string, unknown>)
          .map(([mid, m]) => decodeMessage(mid, m))
          .filter((m): m is CommentMessage => m !== null)
          .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : []
  if (messages.length === 0) return null
  const x = num(t['x'])
  const y = num(t['y'])
  return {
    id,
    pageId,
    nodeId: str(t['nodeId']),
    x,
    y,
    worldX: num(t['worldX'], x),
    worldY: num(t['worldY'], y),
    createdAt: num(t['createdAt'], messages[0]!.createdAt),
    resolved: t['resolved'] === true,
    resolvedBy: str(t['resolvedBy']),
    resolvedAt: typeof t['resolvedAt'] === 'number' ? t['resolvedAt'] : null,
    messages,
  }
}

/** Every thread, oldest first. */
export function getCommentThreads(doc: LoroDoc): CommentThread[] {
  const json = commentsMap(doc).toJSON() as Record<string, unknown>
  return Object.entries(json)
    .map(([id, raw]) => decodeCommentThread(id, raw))
    .filter((t): t is CommentThread => t !== null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
}

export function getCommentThread(doc: LoroDoc, threadId: string): CommentThread | undefined {
  const entry = commentsMap(doc).get(threadId)
  if (!(entry instanceof LoroMap)) return undefined
  return decodeCommentThread(threadId, entry.toJSON()) ?? undefined
}
