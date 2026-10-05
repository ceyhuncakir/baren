/**
 * Unread comments: kept per user and per file on this computer (localStorage, next to the file's
 * editor preferences), never in the
 * document. A message is unread when someone else (a collaborator or an agent) wrote it, after
 * this user started tracking the file (`baseline`, so everything that existed before reads as
 * read), and its thread was not opened since: opening a thread records the message ids it showed.
 * Ids, not times, so collaborators' clocks do not matter.
 */
import type { CommentAuthor, CommentThread } from '@baren/schema'
import { useSyncExternalStore } from 'react'
import { isRecord, isStringArray, readPref, writePref } from '../lib/storage'
import type { EditorSession } from '../session/context'
import { mentionsAuthor } from './mentions'

export interface ReadState {
  /** Messages created before this (epoch ms) count as read. */
  baseline: number
  /** Thread id → ids of the messages seen in it. */
  seen: Record<string, string[]>
}

export function emptyReadState(now: number): ReadState {
  return { baseline: now, seen: {} }
}

/** The messages of a thread this user has not seen (theirs never count). */
export function unreadMessages(thread: CommentThread, state: ReadState, me: CommentAuthor) {
  const seen = state.seen[thread.id]
  return thread.messages.filter(
    (m) => m.author.id !== me.id && m.createdAt >= state.baseline && !(seen && seen.includes(m.id)),
  )
}

export function isUnread(thread: CommentThread, state: ReadState, me: CommentAuthor): boolean {
  return unreadMessages(thread, state, me).length > 0
}

/** True when an unread message of the thread mentions this user. */
export function unreadMention(thread: CommentThread, state: ReadState, me: CommentAuthor): boolean {
  return unreadMessages(thread, state, me).some((m) => mentionsAuthor(m, me))
}

/** The state after this user saw every message of `thread` (unchanged when nothing is new). */
export function markRead(state: ReadState, thread: CommentThread): ReadState {
  const before = state.seen[thread.id] ?? []
  const ids = thread.messages.map((m) => m.id)
  if (ids.every((id) => before.includes(id))) return state
  return { ...state, seen: { ...state.seen, [thread.id]: ids } }
}

/** Drop threads that no longer exist (keeps the stored state small). */
export function pruneReadState(state: ReadState, threads: readonly CommentThread[]): ReadState {
  const live = new Set(threads.map((t) => t.id))
  const seen: Record<string, string[]> = {}
  let dropped = false
  for (const [id, ids] of Object.entries(state.seen)) {
    if (live.has(id)) seen[id] = ids
    else dropped = true
  }
  return dropped ? { ...state, seen } : state
}

function isReadState(v: unknown): v is ReadState {
  return (
    isRecord(v) &&
    typeof v['baseline'] === 'number' &&
    Number.isFinite(v['baseline']) &&
    isRecord(v['seen']) &&
    Object.values(v['seen']).every(isStringArray)
  )
}

/** One user's read state for one file, persisted (debounced) and observable. */
export class CommentReads {
  private state: ReadState
  private version = 0
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly key: string | null,
    now: number = Date.now(),
  ) {
    const stored = key === null ? null : readPref(key, isReadState)
    this.state = stored ?? emptyReadState(now)
    if (stored === null && key !== null) writePref(key, this.state)
  }

  get current(): ReadState {
    return this.state
  }

  getVersion = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  markRead(thread: CommentThread): void {
    const next = markRead(this.state, thread)
    if (next === this.state) return
    this.update(next)
  }

  prune(threads: readonly CommentThread[]): void {
    const next = pruneReadState(this.state, threads)
    if (next !== this.state) this.update(next)
  }

  private update(next: ReadState): void {
    this.state = next
    this.version++
    for (const l of [...this.listeners]) l()
    if (this.key === null || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.key !== null) writePref(this.key, this.state)
    }, 300)
  }
}

const reads = new WeakMap<EditorSession, Map<string, CommentReads>>()
/** Before the account loads nobody is known yet: nothing is unread, nothing is stored. */
const NOT_LOADED = new CommentReads(null, Number.POSITIVE_INFINITY)

/** The read state of the session's file for this user (one per user, kept for the session). */
export function commentReads(session: EditorSession, me: CommentAuthor): CommentReads {
  if (!session.store.getState().accountLoaded) return NOT_LOADED
  let byUser = reads.get(session)
  if (!byUser) {
    byUser = new Map()
    reads.set(session, byUser)
  }
  let r = byUser.get(me.id)
  if (!r) {
    r = new CommentReads(`comments.read.${session.fileId}.${me.id}`)
    byUser.set(me.id, r)
  }
  return r
}

/** Re-renders when the read state changes; returns it. */
export function useCommentReads(reads: CommentReads): ReadState {
  useSyncExternalStore(reads.subscribe, reads.getVersion, reads.getVersion)
  return reads.current
}
