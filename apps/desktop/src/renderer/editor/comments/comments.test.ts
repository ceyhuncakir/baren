import {
  createEmptyDoc,
  createNode,
  getChildIds,
  getCommentThread,
  type CommentAuthor,
  type CommentThread,
} from '@baren/schema'
import { UndoManager } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { editorKeyAction } from '../commands/keymap'
import { CommentsWatcher, DocEvents } from '../session/docEvents'
import {
  centredOn,
  commentAuthor,
  isOwnMessage,
  lastActivity,
  listOrder,
  openCount,
  pageThreads,
  pinAt,
  pinWorld,
  preview,
} from './model'
import { COMMENT_ORIGIN, postReply, postThread, resolveThread } from './ops'
import { placeCard, placePin } from './pinLayout'

const ana: CommentAuthor = { id: 'u1', name: 'Ana', kind: 'user' }

function thread(over: Partial<CommentThread> & Pick<CommentThread, 'id'>): CommentThread {
  return {
    pageId: 'p1',
    nodeId: null,
    x: 0,
    y: 0,
    worldX: 0,
    worldY: 0,
    createdAt: 1,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    messages: [{ id: 'm', author: ana, body: 'Hi', createdAt: 1, editedAt: null, mentions: [] }],
    ...over,
  }
}

describe('comment authors', () => {
  it('uses the signed-in user, else "You" for a local file', () => {
    expect(commentAuthor({ userId: 'u9', name: 'Maya', email: null })).toEqual({
      id: 'u9',
      name: 'Maya',
      kind: 'user',
    })
    expect(commentAuthor(null)).toEqual({ id: 'local', name: 'You', kind: 'user' })
    expect(commentAuthor({ userId: null, name: '', email: null }).name).toBe('You')
  })

  it("lets people edit their own messages, never an agent's", () => {
    const msg = (author: CommentAuthor) => ({
      id: 'm',
      author,
      body: 'x',
      createdAt: 1,
      editedAt: null,
      mentions: [],
    })
    expect(isOwnMessage(msg(ana), ana)).toBe(true)
    expect(isOwnMessage(msg({ ...ana, id: 'u2' }), ana)).toBe(false)
    expect(isOwnMessage(msg({ id: 'u1', name: 'Claude', kind: 'agent' }), ana)).toBe(false)
  })
})

describe('pin placement', () => {
  const bounds =
    (rects: Record<string, { x: number; y: number; width: number; height: number }>) =>
    (id: string) =>
      rects[id] ?? null

  it('pins on the deepest layer with bounds, offset from its top-left', () => {
    const pin = pinAt(
      { x: 130, y: 260 },
      ['board', 'card', 'title'],
      'p1',
      bounds({
        board: { x: 0, y: 0, width: 800, height: 600 },
        card: { x: 100, y: 200, width: 200, height: 120 },
      }),
    )
    // "title" has no bounds (unmeasured): its parent card takes the pin.
    expect(pin).toEqual({ pageId: 'p1', nodeId: 'card', x: 30, y: 60, worldX: 130, worldY: 260 })
    expect(pinAt({ x: 5, y: 6 }, null, 'p1', bounds({}))).toEqual({
      pageId: 'p1',
      nodeId: null,
      x: 5,
      y: 6,
      worldX: 5,
      worldY: 6,
    })
  })

  it('follows its layer when it moves and falls back to where it was when it is gone', () => {
    const t = { nodeId: 'card', x: 30, y: 60, worldX: 130, worldY: 260 }
    expect(pinWorld(t, bounds({ card: { x: 500, y: 0, width: 10, height: 10 } }))).toEqual({
      x: 530,
      y: 60,
    })
    expect(pinWorld(t, bounds({}))).toEqual({ x: 130, y: 260 })
    expect(pinWorld({ ...t, nodeId: null }, bounds({}))).toEqual({ x: 130, y: 260 })
  })

  it('puts the bubble on the point and the card beside it, inside the canvas', () => {
    expect(placePin({ x: 100, y: 100 }, {} as HTMLElement, { width: 1000, height: 800 })).toEqual({
      x: 100,
      y: 68,
    })
    const card = { offsetWidth: 300, offsetHeight: 200 } as HTMLElement
    const layer = { width: 1000, height: 800 }
    expect(placeCard({ x: 100, y: 100 }, card, layer)).toEqual({ x: 142, y: 68 })
    // Near the right edge: to the left of the pin.
    expect(placeCard({ x: 900, y: 100 }, card, layer)).toEqual({ x: 590, y: 68 })
    // Near the bottom: lifted to stay inside.
    expect(placeCard({ x: 100, y: 790 }, card, layer).y).toBe(592)
  })

  it('centres the camera on a pin at the current zoom', () => {
    expect(centredOn({ x: 500, y: 300 }, 1000, 800, 2)).toEqual({ x: 250, y: 100 })
  })
})

describe('comment lists', () => {
  const a = thread({ id: 'a', createdAt: 1 })
  const b = thread({
    id: 'b',
    messages: [
      { id: 'm1', author: ana, body: 'Old', createdAt: 2, editedAt: null, mentions: [] },
      { id: 'm2', author: ana, body: 'Newest reply', createdAt: 50, editedAt: null, mentions: [] },
    ],
  })
  const c = thread({ id: 'c', resolved: true, createdAt: 99 })
  const other = thread({ id: 'd', pageId: 'p2' })

  it('filters by page and resolution, open threads first by newest activity', () => {
    expect(pageThreads([a, b, c, other], 'p1', false).map((t) => t.id)).toEqual(['a', 'b'])
    expect(pageThreads([a, b, c, other], 'p1', true).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(listOrder([c, a, b]).map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(lastActivity(b)).toBe(50)
    expect(openCount([a, b, c, other], 'p1')).toBe(2)
  })

  it('previews one line, cut with an ellipsis', () => {
    expect(preview('  Line one\n\nline   two ')).toBe('Line one line two')
    expect(preview('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('comment writes', () => {
  it('commit with a comment: origin that design undo skips, and reach the watcher', async () => {
    const doc = createEmptyDoc('c', { peerId: 1 })
    const page = getChildIds(doc, null)[0] as string
    const board = createNode(doc, { type: 'frame', parentId: page, name: 'Board' })
    const events = new DocEvents(doc)
    const watcher = new CommentsWatcher(events)
    let notified = 0
    const off = watcher.subscribe(() => notified++)
    const undo = new UndoManager(doc, { excludeOriginPrefixes: [COMMENT_ORIGIN] })

    const id = postThread(
      doc,
      { pageId: page, nodeId: board, x: 1, y: 2, worldX: 1, worldY: 2 },
      ana,
      'Hello',
    )
    postReply(doc, id, ana, 'Again')
    resolveThread(doc, id, true, 'Ana')
    await new Promise((r) => setTimeout(r, 0))
    expect(notified).toBeGreaterThanOrEqual(1)
    expect(watcher.getSnapshot().map((t) => [t.id, t.messages.length, t.resolved])).toEqual([
      [id, 2, true],
    ])
    expect(undo.canUndo()).toBe(false)
    expect(getCommentThread(doc, id)?.resolvedBy).toBe('Ana')
    off()
    events.dispose()
  })

  it('toggles comment mode with C', () => {
    const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
      editorKeyAction(
        {
          key: k,
          code: `Key${k.toUpperCase()}`,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          ...extra,
        },
        'linux',
      )
    expect(key('c')).toEqual({ kind: 'toggleComments' })
    expect(key('c', { ctrlKey: true })).not.toEqual({ kind: 'toggleComments' })
  })
})
