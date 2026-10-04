/**
 * Comments in the editor, the parts without DOM: who writes them, where a click pins one, where
 * a pin sits now, and which threads the canvas and the Comments list show (and in what order).
 * The data model is `@baren/schema` comments (the document's `comments` map).
 */
import type { Point, Rect } from '@baren/canvas'
import type { CommentAuthor, CommentMessage, CommentPin, CommentThread } from '@baren/schema'
import type { Identity } from '../session/store'

/** The signed-in user, or "You" in a file nobody else sees (not shared, signed out). */
export function commentAuthor(identity: Identity | null): CommentAuthor {
  if (identity?.userId)
    return { id: identity.userId, name: identity.name || 'Someone', kind: 'user' }
  return { id: 'local', name: identity?.name || 'You', kind: 'user' }
}

/** Messages this author may edit and delete: their own (agents' messages belong to agents). */
export function isOwnMessage(message: CommentMessage, author: CommentAuthor): boolean {
  return message.author.kind === 'user' && message.author.id === author.id
}

/**
 * The pin for a click at `world`: on the deepest layer under it (`path`, top-level first, from
 * the canvas's `nodePathAt`), offset from that layer's top-left; on the page when there is no
 * layer or its bounds are unknown.
 */
export function pinAt(
  world: Point,
  path: readonly string[] | null,
  pageId: string,
  bounds: (id: string) => Rect | null,
): CommentPin {
  for (let i = (path?.length ?? 0) - 1; i >= 0; i--) {
    const id = path![i] as string
    const b = bounds(id)
    if (!b) continue
    return {
      pageId,
      nodeId: id,
      x: world.x - b.x,
      y: world.y - b.y,
      worldX: world.x,
      worldY: world.y,
    }
  }
  return { pageId, nodeId: null, x: world.x, y: world.y, worldX: world.x, worldY: world.y }
}

/** Where a thread's pin is now: on its layer when that layer has bounds, else where it was. */
export function pinWorld(
  thread: Pick<CommentThread, 'nodeId' | 'x' | 'y' | 'worldX' | 'worldY'>,
  bounds: (id: string) => Rect | null,
): Point {
  const b = thread.nodeId === null ? null : bounds(thread.nodeId)
  if (b) return { x: b.x + thread.x, y: b.y + thread.y }
  return { x: thread.worldX, y: thread.worldY }
}

/** The last message's time (a thread's activity). */
export function lastActivity(thread: CommentThread): number {
  return thread.messages.at(-1)?.createdAt ?? thread.createdAt
}

/** Threads of a page, resolved ones only when asked for. */
export function pageThreads(
  threads: readonly CommentThread[],
  pageId: string,
  showResolved: boolean,
): CommentThread[] {
  return threads.filter((t) => t.pageId === pageId && (showResolved || !t.resolved))
}

/** The Comments list: open threads first, then by newest activity. */
export function listOrder(threads: readonly CommentThread[]): CommentThread[] {
  return [...threads].sort(
    (a, b) =>
      Number(a.resolved) - Number(b.resolved) ||
      lastActivity(b) - lastActivity(a) ||
      (a.id < b.id ? -1 : 1),
  )
}

/** Open threads on a page (the tool rail badge). */
export function openCount(threads: readonly CommentThread[], pageId: string): number {
  let n = 0
  for (const t of threads) if (t.pageId === pageId && !t.resolved) n++
  return n
}

/** One line of a message for lists: whitespace collapsed, cut at `max` characters. */
export function preview(body: string, max = 80): string {
  const line = body.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/**
 * The camera that centres `world` in a `width`×`height` canvas at `zoom` (the Comments list
 * jumping to a pin).
 */
export function centredOn(
  world: Point,
  width: number,
  height: number,
  zoom: number,
): { x: number; y: number } {
  return { x: world.x - width / 2 / zoom, y: world.y - height / 2 / zoom }
}
