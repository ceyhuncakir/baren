/**
 * Comment writes from the editor. Each is one commit with a `comment:` origin, which the canvas's
 * undo manager excludes (CanvasArea `UNDO_EXCLUDE`): Ctrl+Z undoes design edits, never comments.
 * Comments reach collaborators with the document's live sync.
 */
import {
  addCommentMessage,
  createCommentThread,
  deleteCommentMessage,
  editCommentMessage,
  setCommentResolved,
  transact,
  type CommentAuthor,
  type CommentMention,
  type CommentPin,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

/** Commit origin prefix of every comment write. */
export const COMMENT_ORIGIN = 'comment'

export function postThread(
  doc: LoroDoc,
  pin: CommentPin,
  author: CommentAuthor,
  body: string,
  mentions: readonly CommentMention[] = [],
): string {
  return transact(doc, () => createCommentThread(doc, { ...pin, author, body, mentions }), {
    origin: `${COMMENT_ORIGIN}:create`,
  })
}

export function postReply(
  doc: LoroDoc,
  threadId: string,
  author: CommentAuthor,
  body: string,
  mentions: readonly CommentMention[] = [],
): string {
  return transact(doc, () => addCommentMessage(doc, threadId, { author, body, mentions }), {
    origin: `${COMMENT_ORIGIN}:reply`,
  })
}

export function resolveThread(doc: LoroDoc, threadId: string, resolved: boolean, by: string): void {
  transact(doc, () => setCommentResolved(doc, threadId, resolved, by), {
    origin: `${COMMENT_ORIGIN}:${resolved ? 'resolve' : 'reopen'}`,
  })
}

export function editMessage(
  doc: LoroDoc,
  threadId: string,
  messageId: string,
  body: string,
  mentions?: readonly CommentMention[],
): void {
  transact(doc, () => editCommentMessage(doc, threadId, messageId, body, Date.now(), mentions), {
    origin: `${COMMENT_ORIGIN}:edit`,
  })
}

/** Deleting a thread's first message deletes the thread. */
export function deleteMessage(doc: LoroDoc, threadId: string, messageId: string): void {
  transact(doc, () => deleteCommentMessage(doc, threadId, messageId), {
    origin: `${COMMENT_ORIGIN}:delete`,
  })
}
