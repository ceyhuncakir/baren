import type { CommentAuthor, CommentMention, CommentMessage, CommentThread } from '@baren/schema'
import { describe, expect, it } from 'vitest'
import {
  activeMentionQuery,
  filterCandidates,
  insertMention,
  keptMentions,
  mentionCandidates,
  mentionSegments,
  newMentionsOf,
} from './mentions'
import {
  CommentReads,
  emptyReadState,
  isUnread,
  markRead,
  pruneReadState,
  unreadMention,
  unreadMessages,
} from './unread'

const me: CommentAuthor = { id: 'u1', name: 'Ana Lima', kind: 'user' }
const ben: CommentMention = { id: 'u2', name: 'Ben', kind: 'user' }
const bea: CommentMention = { id: 'u3', name: 'Bea Stone', kind: 'user' }
const claude: CommentMention = { id: 'agent:Claude Code', name: 'Claude Code', kind: 'agent' }

function msg(
  id: string,
  author: CommentAuthor,
  createdAt: number,
  mentions: CommentMention[] = [],
): CommentMessage {
  return { id, author, body: 'x', createdAt, editedAt: null, mentions }
}

function thread(id: string, messages: CommentMessage[]): CommentThread {
  return {
    id,
    pageId: 'p1',
    nodeId: null,
    x: 0,
    y: 0,
    worldX: 0,
    worldY: 0,
    createdAt: messages[0]?.createdAt ?? 0,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    messages,
  }
}

describe('typing a mention', () => {
  it('finds the @query at the caret, only after whitespace or at the start', () => {
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeMentionQuery('Hey @Be', 7)).toEqual({ start: 4, query: 'Be' })
    expect(activeMentionQuery('Hey @Be and', 7)).toEqual({ start: 4, query: 'Be' })
    expect(activeMentionQuery('mail@ex', 7)).toBeNull()
    expect(activeMentionQuery('Hey @Ben done', 13)).toBeNull()
  })

  it('suggests names starting with the query, then names with a word starting with it', () => {
    const all = [claude, bea, ben]
    expect(filterCandidates(all, 'b').map((c) => c.name)).toEqual(['Bea Stone', 'Ben'])
    expect(filterCandidates(all, 'st').map((c) => c.name)).toEqual(['Bea Stone'])
    expect(filterCandidates(all, 'code').map((c) => c.name)).toEqual(['Claude Code'])
    expect(filterCandidates(all, '')).toHaveLength(3)
    expect(filterCandidates(all, 'b', 1)).toHaveLength(1)
  })

  it('inserts the picked name and keeps only mentions still in the text', () => {
    expect(insertMention('Hey @Cl please', 4, 7, 'Claude Code')).toEqual({
      text: 'Hey @Claude Code please',
      caret: 17,
    })
    expect(insertMention('@B', 0, 2, 'Ben')).toEqual({ text: '@Ben ', caret: 5 })
    expect(keptMentions('@Ben and @Claude Code, look', [ben, claude, bea, ben])).toEqual([
      ben,
      claude,
    ])
    expect(keptMentions('@Benjamin', [ben])).toEqual([])
  })

  it('splits a body into text and recorded mentions only (longest name first)', () => {
    const named: CommentMention = { id: 'u4', name: 'Claude', kind: 'user' }
    expect(mentionSegments('@Claude Code and @Claude, not @Ben', [named, claude])).toEqual([
      { text: '@Claude Code', mention: claude },
      { text: ' and ' },
      { text: '@Claude', mention: named },
      { text: ', not @Ben' },
    ])
    expect(mentionSegments('mail@Ben.com', [ben])).toEqual([{ text: 'mail@Ben.com' }])
    expect(mentionSegments('plain', [])).toEqual([{ text: 'plain' }])
  })

  it('lists people present, agents, members, then past authors, without me or duplicates', () => {
    expect(
      mentionCandidates(me, {
        peers: [ben],
        agents: [claude],
        members: [{ ...me }, bea, ben],
        authors: [claude, { id: 'u5', name: 'Old Author', kind: 'user' }],
      }).map((c) => c.name),
    ).toEqual(['Ben', 'Claude Code', 'Bea Stone', 'Old Author'])
  })
})

describe('unread comments', () => {
  const benAuthor: CommentAuthor = { ...ben }

  it('counts messages of others after the baseline that were not seen', () => {
    const state = emptyReadState(100)
    const t = thread('t1', [msg('a', benAuthor, 50), msg('b', me, 150), msg('c', benAuthor, 200)])
    expect(unreadMessages(t, state, me).map((m) => m.id)).toEqual(['c'])
    expect(isUnread(t, state, me)).toBe(true)
    const read = markRead(state, t)
    expect(isUnread(t, read, me)).toBe(false)
    expect(markRead(read, t)).toBe(read)
    // A new reply makes it unread again; my own never does.
    const later = thread('t1', [...t.messages, msg('d', me, 300)])
    expect(isUnread(later, read, me)).toBe(false)
    // Seen ids, not times: a reply stamped earlier by a collaborator's slow clock still counts.
    const reply = thread('t1', [...later.messages, msg('e', benAuthor, 120)])
    expect(isUnread(reply, read, me)).toBe(true)
  })

  it('flags unread messages that mention me, and prunes deleted threads', () => {
    const state = emptyReadState(0)
    const t = thread('t1', [msg('a', benAuthor, 1, [{ ...me }])])
    const u = thread('t2', [msg('b', benAuthor, 1, [bea])])
    expect(unreadMention(t, state, me)).toBe(true)
    expect(unreadMention(u, state, me)).toBe(false)
    const read = markRead(markRead(state, t), u)
    expect(unreadMention(t, read, me)).toBe(false)
    expect(Object.keys(pruneReadState(read, [t]).seen)).toEqual(['t1'])
  })

  it('stores nothing and reads nothing as unread before the account is known', () => {
    const r = new CommentReads(null, Number.POSITIVE_INFINITY)
    const t = thread('t1', [msg('a', benAuthor, Date.now())])
    expect(isUnread(t, r.current, me)).toBe(false)
    let calls = 0
    const off = r.subscribe(() => calls++)
    r.markRead(t)
    expect(calls).toBe(1)
    off()
  })
})

describe('mention toasts', () => {
  it('reports new messages of others that mention me, once', () => {
    const benAuthor: CommentAuthor = { ...ben }
    const known = new Set<string>()
    const old = thread('t1', [msg('a', benAuthor, 1, [{ ...me }])])
    // The hook's first call only learns what exists (its result is ignored).
    expect(newMentionsOf([old], me, known)).toHaveLength(1)
    const next = thread('t1', [
      ...old.messages,
      msg('b', benAuthor, 2, [{ ...me }]),
      msg('c', me, 3, [{ ...me }]),
      msg('d', benAuthor, 4, [bea]),
    ])
    expect(newMentionsOf([next], me, known).map((x) => x.message.id)).toEqual(['b'])
    expect(newMentionsOf([next], me, known)).toEqual([])
  })
})
