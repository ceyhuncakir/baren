import { UndoManager } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  SchemaError,
  addCommentMessage,
  createCommentThread,
  createNode,
  deleteCommentMessage,
  deleteCommentThread,
  editCommentMessage,
  getCommentThread,
  getCommentThreads,
  moveCommentThread,
  setCommentResolved,
  setStyles,
  subscribeNodes,
  transact,
  type CommentAuthor,
  type NodeChangeBatch,
} from '../src/index.ts'
import { docWithPage, flushEvents, sync, twoPeers } from './helpers.ts'

const ana: CommentAuthor = { id: 'u1', name: 'Ana', kind: 'user' }
const ben: CommentAuthor = { id: 'u2', name: 'Ben', kind: 'user' }
const agent: CommentAuthor = { id: 'agent:Claude Code', name: 'Claude Code', kind: 'agent' }

function pin(pageId: string, nodeId: string | null = null) {
  return { pageId, nodeId, x: 10, y: 20, worldX: 110, worldY: 220 }
}

describe('comment threads', () => {
  it('creates a thread with its first message, then replies in order', () => {
    const { doc, pageId } = docWithPage()
    const board = createNode(doc, { type: 'frame', parentId: pageId, name: 'Board' })
    const id = createCommentThread(doc, {
      ...pin(pageId, board),
      author: ana,
      body: '  Tighten this spacing  ',
      now: 100,
    })
    addCommentMessage(doc, id, { author: agent, body: 'Done: gap is 16px now.', now: 300 })
    addCommentMessage(doc, id, { author: ben, body: 'Agreed', now: 200 })
    const thread = getCommentThread(doc, id)
    expect(thread).toMatchObject({
      id,
      pageId,
      nodeId: board,
      x: 10,
      y: 20,
      worldX: 110,
      worldY: 220,
      createdAt: 100,
      resolved: false,
      resolvedBy: null,
    })
    expect(thread?.messages.map((m) => [m.author.name, m.author.kind, m.body])).toEqual([
      ['Ana', 'user', 'Tighten this spacing'],
      ['Ben', 'user', 'Agreed'],
      ['Claude Code', 'agent', 'Done: gap is 16px now.'],
    ])
    expect(getCommentThreads(doc).map((t) => t.id)).toEqual([id])
  })

  it('edits, resolves, reopens, moves and deletes', () => {
    const { doc, pageId } = docWithPage()
    const id = createCommentThread(doc, { ...pin(pageId), author: ana, body: 'First', now: 1 })
    const reply = addCommentMessage(doc, id, { author: ben, body: 'Second', now: 2 })
    editCommentMessage(doc, id, reply, 'Second, edited', 5)
    expect(getCommentThread(doc, id)?.messages[1]).toMatchObject({
      body: 'Second, edited',
      editedAt: 5,
    })

    setCommentResolved(doc, id, true, 'Ben', 9)
    expect(getCommentThread(doc, id)).toMatchObject({
      resolved: true,
      resolvedBy: 'Ben',
      resolvedAt: 9,
    })
    setCommentResolved(doc, id, false)
    expect(getCommentThread(doc, id)).toMatchObject({ resolvedBy: null, resolvedAt: null })

    moveCommentThread(doc, id, { pageId, nodeId: null, x: 5, y: 6, worldX: 5, worldY: 6 })
    expect(getCommentThread(doc, id)).toMatchObject({ nodeId: null, x: 5, worldY: 6 })

    deleteCommentMessage(doc, id, reply)
    expect(getCommentThread(doc, id)?.messages).toHaveLength(1)
    // Deleting the first message deletes the thread.
    deleteCommentMessage(doc, id, getCommentThread(doc, id)!.messages[0]!.id)
    expect(getCommentThread(doc, id)).toBeUndefined()
    deleteCommentThread(doc, id) // already gone: no-op
  })

  it('rejects empty or oversized bodies, bad positions and unknown threads', () => {
    const { doc, pageId } = docWithPage()
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof SchemaError ? error.code : 'other'
      }
      return null
    }
    expect(code(() => createCommentThread(doc, { ...pin(pageId), author: ana, body: '  ' }))).toBe(
      'invalid-comment',
    )
    expect(
      code(() =>
        createCommentThread(doc, { ...pin(pageId), author: ana, body: 'x'.repeat(10_001) }),
      ),
    ).toBe('invalid-comment')
    expect(
      code(() =>
        createCommentThread(doc, { ...pin(pageId), x: Number.NaN, author: ana, body: 'x' }),
      ),
    ).toBe('invalid-comment')
    expect(code(() => addCommentMessage(doc, 'nope', { author: ana, body: 'x' }))).toBe(
      'comment-not-found',
    )
    expect(getCommentThreads(doc)).toEqual([])
  })

  it('reports changed threads in change batches', async () => {
    const { doc, pageId } = docWithPage()
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (b) => batches.push(b))
    const id = transact(
      doc,
      () => createCommentThread(doc, { ...pin(pageId), author: ana, body: 'Hi' }),
      { origin: 'comment:create' },
    )
    await flushEvents()
    addCommentMessage(doc, id, { author: ben, body: 'Hello' })
    await flushEvents()
    deleteCommentThread(doc, id)
    await flushEvents()
    expect(batches.map((b) => b.comments)).toEqual([[id], [id], [id]])
    expect(batches[0]?.origin).toBe('comment:create')
    expect(batches.every((b) => b.changes.length === 0)).toBe(true)
  })

  it('merges concurrent replies and resolutions from two peers', () => {
    const { a, b, pageId } = twoPeers()
    const id = createCommentThread(a, { ...pin(pageId), author: ana, body: 'Thoughts?', now: 1 })
    sync(a, b)
    addCommentMessage(a, id, { author: ana, body: 'From A', now: 2 })
    addCommentMessage(b, id, { author: ben, body: 'From B', now: 3 })
    setCommentResolved(b, id, true, 'Ben', 4)
    sync(a, b)
    for (const doc of [a, b]) {
      const t = getCommentThread(doc, id)!
      expect(t.messages.map((m) => m.body)).toEqual(['Thoughts?', 'From A', 'From B'])
      expect(t.resolved).toBe(true)
    }
  })

  it('stays out of design undo when committed with a comment: origin', () => {
    const { doc, pageId } = docWithPage()
    const board = createNode(doc, { type: 'frame', parentId: pageId, name: 'Board' })
    const undo = new UndoManager(doc, { excludeOriginPrefixes: ['comment'] })
    transact(doc, () => setStyles(doc, board, { width: 300 }), { origin: 'editor:inspector' })
    transact(
      doc,
      () => createCommentThread(doc, { ...pin(pageId, board), author: ana, body: 'Keep me' }),
      { origin: 'comment:create' },
    )
    undo.undo()
    expect(getCommentThreads(doc)).toHaveLength(1)
  })
})
