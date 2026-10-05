/**
 * Comment hooks shared by the canvas layer, the Comments list and the tool rail: who "me" is, my
 * read state for this file, and the "<name> mentioned you" toast.
 */
import type { CommentAuthor } from '@baren/schema'
import { toast } from '@baren/ui'
import { useEffect, useMemo } from 'react'
import { useEditor, useEditorState } from '../session/context'
import { newMentionsOf } from './mentions'
import { commentAuthor } from './model'
import { revealThread } from './reveal'
import { commentReads, type CommentReads } from './unread'

/** The author of this user's comments (stable while the identity is). */
export function useCommentAuthor(): CommentAuthor {
  const identity = useEditorState((s) => s.identity)
  return useMemo(() => commentAuthor(identity), [identity])
}

/** This user's read state for the file (nothing is unread before the account loads). */
export function useReads(me: CommentAuthor): CommentReads {
  const session = useEditor()
  const accountLoaded = useEditorState((s) => s.accountLoaded)
  return useMemo(() => commentReads(session, me), [session, me, accountLoaded])
}

/**
 * While the file is open: a toast for each new message that mentions this user, from a
 * collaborator or an agent ("View" shows the thread). Messages that existed when the file opened
 * (or the account loaded) never toast; the unread markers cover them.
 */
export function useMentionToasts(me: CommentAuthor): void {
  const session = useEditor()
  const accountLoaded = useEditorState((s) => s.accountLoaded)
  useEffect(() => {
    if (!accountLoaded || session.headless) return
    const known = new Set<string>()
    newMentionsOf(session.comments.getSnapshot(), me, known)
    return session.comments.subscribe(() => {
      for (const { threadId, message } of newMentionsOf(
        session.comments.getSnapshot(),
        me,
        known,
      )) {
        toast(`${message.author.name} mentioned you`, {
          actionLabel: 'View',
          onAction: () => revealThread(session, threadId),
          duration: 8000,
        })
      }
    })
  }, [session, me, accountLoaded])
}
