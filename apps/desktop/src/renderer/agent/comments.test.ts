/**
 * Comment tools against real Loro documents: get_comments (filters, positions, order),
 * get_basic_info counts, reply_to_comment / resolve_comment (agent author, `comment:` origin
 * outside design undo, no working artboards, read-only refusal, unknown threads).
 */
import {
  createCommentThread,
  createEmptyDoc,
  createNode,
  deleteNode,
  getChildIds,
  getCommentThread,
  setCommentResolved,
  setStyles,
  transact,
  type CommentAuthor,
} from '@baren/schema'
import { UndoManager } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { dispatch, ok, testEnv } from './testing'

const ana: CommentAuthor = { id: 'u1', name: 'Ana', kind: 'user' }

function setup() {
  const doc = createEmptyDoc('Test', { peerId: 9 })
  const page = getChildIds(doc, null)[0] as string
  const board = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Pricing',
    styles: { left: 100, top: 50, width: 400, height: 300 },
  })
  const button = createNode(doc, {
    type: 'frame',
    parentId: board,
    name: 'Buy button',
    styles: { position: 'absolute', left: 20, top: 30, width: 120, height: 40 },
  })
  const other = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Checkout',
    styles: { left: 600, top: 50, width: 400, height: 300 },
  })
  const page2 = createNode(doc, { type: 'page', parentId: null, name: 'Page 2' })
  const onButton = createCommentThread(doc, {
    pageId: page,
    nodeId: button,
    x: 5,
    y: 6,
    worldX: 0,
    worldY: 0,
    author: ana,
    body: 'Make this the brand red',
    now: Date.UTC(2026, 9, 4, 10),
  })
  const onBoard = createCommentThread(doc, {
    pageId: page,
    nodeId: board,
    x: 0,
    y: 0,
    worldX: 100,
    worldY: 50,
    author: ana,
    body: 'Too much copy here',
    now: Date.UTC(2026, 9, 4, 9),
  })
  const onOther = createCommentThread(doc, {
    pageId: page,
    nodeId: other,
    x: 10,
    y: 10,
    worldX: 610,
    worldY: 60,
    author: ana,
    body: 'Looks good',
    now: Date.UTC(2026, 9, 4, 8),
  })
  setCommentResolved(doc, onOther, true, 'Ana', Date.UTC(2026, 9, 4, 11))
  const onPage2 = createCommentThread(doc, {
    pageId: page2,
    nodeId: null,
    x: 7,
    y: 8,
    worldX: 7,
    worldY: 8,
    author: ana,
    body: 'Add a second page of plans?',
    now: Date.UTC(2026, 9, 4, 7),
  })
  return { doc, page, page2, board, button, other, onButton, onBoard, onOther, onPage2 }
}

interface ThreadOut {
  id: string
  status: string
  page: { id: string; name: string }
  layer: { id: string; name: string } | null
  artboard: { id: string; name: string } | null
  position: { x: number; y: number }
  messages: {
    author: { name: string; kind: string }
    body: string
    createdAt: string
    edited: boolean
  }[]
  resolvedBy?: string
  resolvedAt?: string
}

describe('get_comments', () => {
  it('lists open threads by page order, then age, with layer, artboard and pin position', async () => {
    const s = setup()
    const env = testEnv(s.doc)
    const body = await ok<{ count: number; threads: ThreadOut[] }>(env, 'get_comments')
    expect(body.count).toBe(3)
    expect(body.threads.map((t) => t.id)).toEqual([s.onBoard, s.onButton, s.onPage2])
    const button = body.threads[1] as ThreadOut
    expect(button).toMatchObject({
      status: 'open',
      page: { id: s.page, name: 'Page 1' },
      layer: { id: s.button, name: 'Buy button' },
      artboard: { id: s.board, name: 'Pricing' },
      // Buy button at (100 + 20, 50 + 30), plus the pin offset (5, 6).
      position: { x: 125, y: 86 },
      messages: [
        {
          author: { name: 'Ana', kind: 'user' },
          body: 'Make this the brand red',
          createdAt: '2026-10-04T10:00:00.000Z',
          edited: false,
        },
      ],
    })
    expect(body.threads[2]).toMatchObject({ layer: null, artboard: null, position: { x: 7, y: 8 } })
  })

  it('lists the people and agents a message mentions, and flags mentions of the caller', async () => {
    const s = setup()
    const asked = createCommentThread(s.doc, {
      pageId: s.page,
      nodeId: s.button,
      x: 0,
      y: 0,
      worldX: 0,
      worldY: 0,
      author: ana,
      body: '@Test can you tighten this? cc @Ben',
      mentions: [
        { id: 'agent:Test', name: 'Test', kind: 'agent' },
        { id: 'u2', name: 'Ben', kind: 'user' },
      ],
    })
    const body = await ok<{ threads: Record<string, unknown>[] }>(testEnv(s.doc), 'get_comments')
    const thread = body.threads.find((t) => t['id'] === asked) as Record<string, unknown>
    expect(thread['mentionsYou']).toBe(true)
    expect((thread['messages'] as Record<string, unknown>[])[0]).toMatchObject({
      mentions: [
        { name: 'Test', kind: 'agent' },
        { name: 'Ben', kind: 'user' },
      ],
      mentionsYou: true,
    })
    // Threads without mentions carry neither field.
    const plain = body.threads.find((t) => t['id'] === s.onButton) as Record<string, unknown>
    expect(plain['mentionsYou']).toBeUndefined()
    expect((plain['messages'] as Record<string, unknown>[])[0]).not.toHaveProperty('mentions')
  })

  it('filters by page, by layer subtree and includes resolved threads on request', async () => {
    const s = setup()
    const env = testEnv(s.doc)
    const ids = async (args: Record<string, unknown>) =>
      (await ok<{ threads: ThreadOut[] }>(env, 'get_comments', args)).threads.map((t) => t.id)
    expect(await ids({ pageId: s.page2 })).toEqual([s.onPage2])
    expect(await ids({ nodeId: s.board })).toEqual([s.onBoard, s.onButton])
    expect(await ids({ nodeId: s.button })).toEqual([s.onButton])
    expect(await ids({ nodeId: s.other })).toEqual([])
    expect(await ids({ nodeId: s.other, includeResolved: true })).toEqual([s.onOther])
    expect(await ids({ nodeId: s.page2 })).toEqual([s.onPage2])
    expect(await ids({ threadId: s.onButton })).toEqual([s.onButton])
    expect(await ids({ threadId: s.onOther })).toEqual([])
    expect(await ids({ threadId: s.onOther, includeResolved: true })).toEqual([s.onOther])
    const resolved = (
      await ok<{ threads: ThreadOut[] }>(env, 'get_comments', { includeResolved: true })
    ).threads.find((t) => t.id === s.onOther)
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolvedBy: 'Ana',
      resolvedAt: '2026-10-04T11:00:00.000Z',
    })
    const missing = await dispatch(env, 'get_comments', { nodeId: 'nope' })
    expect(missing.ok ? null : missing.error.code).toBe('node_not_found')
    const badPage = await dispatch(env, 'get_comments', { pageId: s.board })
    expect(badPage.ok ? null : badPage.error.code).toBe('page_not_found')
  })

  it('falls back to the saved page position when the layer is gone', async () => {
    const s = setup()
    deleteNode(s.doc, s.board)
    const env = testEnv(s.doc)
    const t = (await ok<{ threads: ThreadOut[] }>(env, 'get_comments')).threads.find(
      (x) => x.id === s.onBoard,
    )
    expect(t).toMatchObject({ layer: null, artboard: null, position: { x: 100, y: 50 } })
  })

  it('get_basic_info counts comments for the file and open ones per artboard', async () => {
    const s = setup()
    const info = await ok<{
      comments: { open: number; resolved: number }
      artboards: { id: string; openComments?: number }[]
    }>(testEnv(s.doc), 'get_basic_info')
    expect(info.comments).toEqual({ open: 3, resolved: 1 })
    expect(info.artboards.find((a) => a.id === s.board)?.openComments).toBe(2)
    expect(info.artboards.find((a) => a.id === s.other)).not.toHaveProperty('openComments')
  })
})

describe('reply_to_comment and resolve_comment', () => {
  it('replies as the agent, outside design undo, without working artboards', async () => {
    const s = setup()
    const env = testEnv(s.doc)
    const undo = new UndoManager(s.doc, { excludeOriginPrefixes: ['comment'] })
    transact(s.doc, () => setStyles(s.doc, s.button, { width: 140 }), {
      origin: 'agent:update_styles',
    })
    const res = await dispatch(env, 'reply_to_comment', {
      threadId: s.onButton,
      body: '  Done: it uses var(--color-brand) now.  ',
    })
    if (!res.ok) throw new Error(res.error.message)
    expect(res.touched).toBeUndefined()
    const out = res.result as { messageId: string; thread: ThreadOut }
    expect(out.thread.messages.at(-1)).toMatchObject({
      author: { name: 'Test', kind: 'agent' },
      body: 'Done: it uses var(--color-brand) now.',
    })
    expect(getCommentThread(s.doc, s.onButton)?.messages.at(-1)).toMatchObject({
      id: out.messageId,
      author: { id: 'agent:Test', name: 'Test', kind: 'agent' },
    })
    // The user's Ctrl+Z takes back the style change, never the reply.
    undo.undo()
    expect(getCommentThread(s.doc, s.onButton)?.messages).toHaveLength(2)
  })

  it('resolves and reopens with the agent as resolver', async () => {
    const s = setup()
    const env = testEnv(s.doc)
    const resolved = await ok<{ thread: ThreadOut }>(env, 'resolve_comment', {
      threadId: s.onButton,
    })
    expect(resolved.thread).toMatchObject({ status: 'resolved', resolvedBy: 'Test' })
    // Resolving again is a no-op, not an error.
    await ok(env, 'resolve_comment', { threadId: s.onButton, resolved: true })
    const reopened = await ok<{ thread: ThreadOut }>(env, 'resolve_comment', {
      threadId: s.onButton,
      resolved: false,
    })
    expect(reopened.thread.status).toBe('open')
    expect(reopened.thread).not.toHaveProperty('resolvedBy')
  })

  it('refuses unknown threads, empty replies and viewers', async () => {
    const s = setup()
    const env = testEnv(s.doc)
    const unknown = await dispatch(env, 'reply_to_comment', { threadId: 'nope', body: 'Hi' })
    expect(unknown.ok ? null : unknown.error.code).toBe('comment_not_found')
    const unknownResolve = await dispatch(env, 'resolve_comment', { threadId: 'nope' })
    expect(unknownResolve.ok ? null : unknownResolve.error.code).toBe('comment_not_found')
    const empty = await dispatch(env, 'reply_to_comment', { threadId: s.onButton, body: '   ' })
    expect(empty.ok ? null : empty.error.code).toBe('invalid_argument')
    const viewer = testEnv(s.doc, { readOnly: true })
    const refused = await dispatch(viewer, 'reply_to_comment', { threadId: s.onButton, body: 'Hi' })
    expect(refused.ok ? null : refused.error.code).toBe('read_only')
    expect(getCommentThread(s.doc, s.onButton)?.messages).toHaveLength(1)
  })
})
