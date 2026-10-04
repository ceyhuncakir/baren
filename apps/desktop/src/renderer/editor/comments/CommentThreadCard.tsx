/**
 * The open comment thread, beside its pin: the messages (author, time, "edited", agents marked),
 * a reply field, Resolve / Reopen, and Edit / Delete on the user's own messages. Deleting the
 * first message deletes the thread, after a confirmation.
 */
import {
  CheckIcon,
  DropdownMenu,
  IconButton,
  MenuItem,
  MoreHorizontalIcon,
  XIcon,
  toast,
} from '@baren/ui'
import type { CommentAuthor, CommentMessage, CommentThread } from '@baren/schema'
import { useRef, useState, type Ref } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { formatRelative, useNow } from '../../lib/relativeTime'
import { useEditor } from '../session/context'
import { CommentAvatar, CommentInput } from './CommentParts'
import { isOwnMessage } from './model'
import { deleteMessage, editMessage, postReply, resolveThread } from './ops'
import css from './Comments.module.css'

/** Run a comment write; a failure (e.g. a collaborator deleted the thread) becomes a toast. */
export function tryWrite(write: () => void): boolean {
  try {
    write()
    return true
  } catch (error) {
    toast(
      `Couldn't update the comment: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    return false
  }
}

interface MessageProps {
  thread: CommentThread
  message: CommentMessage
  me: CommentAuthor
  canWrite: boolean
  now: number
  onDeleteThread(): void
}

function Message({ thread, message, me, canWrite, now, onDeleteThread }: MessageProps) {
  const { doc } = useEditor()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)
  const own = canWrite && isOwnMessage(message, me)
  const first = thread.messages[0]?.id === message.id
  return (
    <div className={css.message}>
      <CommentAvatar author={message.author} size={22} />
      <div className={css.messageBody}>
        <div className={css.messageMeta}>
          <span className={css.author}>{message.author.name}</span>
          {message.author.kind === 'agent' && <span className={css.agentTag}>agent</span>}
          <span className={css.time} title={new Date(message.createdAt).toLocaleString()}>
            {formatRelative(message.createdAt, now)}
            {message.editedAt !== null && ' · edited'}
          </span>
          {own && !editing && (
            <>
              <IconButton
                ref={menuRef}
                label="Comment actions"
                size={22}
                radius="sm"
                className={css.messageMenu}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <MoreHorizontalIcon size={14} />
              </IconButton>
              <DropdownMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                anchorRef={menuRef}
                placement="bottom-end"
                width={160}
                aria-label="Comment actions"
              >
                <MenuItem onSelect={() => setEditing(true)}>Edit</MenuItem>
                <MenuItem
                  destructive
                  onSelect={() =>
                    first
                      ? onDeleteThread()
                      : tryWrite(() => deleteMessage(doc, thread.id, message.id))
                  }
                >
                  {first ? 'Delete thread…' : 'Delete'}
                </MenuItem>
              </DropdownMenu>
            </>
          )}
        </div>
        {editing ? (
          <div className={css.composer} style={{ padding: 0, border: 0 }}>
            <CommentInput
              placeholder="Edit comment"
              submitLabel="Save"
              initial={message.body}
              autoFocus
              onSubmit={(text) => {
                const ok = tryWrite(() => editMessage(doc, thread.id, message.id, text))
                if (ok) setEditing(false)
                return ok
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : (
          <div className={css.text}>{message.body}</div>
        )}
      </div>
    </div>
  )
}

export interface CommentThreadCardProps {
  thread: CommentThread
  /** The pinned layer's name ("on Hero"), when it still exists. */
  anchorName: string | null
  me: CommentAuthor
  /** False for viewers: they read comments but cannot write. */
  canWrite: boolean
  onClose(): void
  cardRef: Ref<HTMLDivElement>
}

export function CommentThreadCard({
  thread,
  anchorName,
  me,
  canWrite,
  onClose,
  cardRef,
}: CommentThreadCardProps) {
  const { doc } = useEditor()
  const now = useNow()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const toggleResolved = () =>
    tryWrite(() => resolveThread(doc, thread.id, !thread.resolved, me.name))
  return (
    <div
      ref={cardRef}
      className={css.card}
      role="dialog"
      aria-label="Comment thread"
      data-comment-ui=""
    >
      <div className={css.cardHeader}>
        <span className={css.cardTitle}>
          Comment
          {anchorName && <span className={css.cardAnchor}> on {anchorName}</span>}
        </span>
        {canWrite && (
          <IconButton
            label={thread.resolved ? 'Reopen' : 'Resolve'}
            size={26}
            radius="sm"
            active={thread.resolved}
            onClick={toggleResolved}
          >
            <CheckIcon size={14} strokeWidth={2} />
          </IconButton>
        )}
        <IconButton label="Close" size={26} radius="sm" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </div>
      {thread.resolved && (
        <div className={css.resolvedBanner}>
          <CheckIcon size={12} strokeWidth={2.25} />
          Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}
          {thread.resolvedAt !== null ? ` ${formatRelative(thread.resolvedAt, now)}` : ''}
        </div>
      )}
      <div className={css.messages}>
        {thread.messages.map((m) => (
          <Message
            key={m.id}
            thread={thread}
            message={m}
            me={me}
            canWrite={canWrite}
            now={now}
            onDeleteThread={() => setConfirmDelete(true)}
          />
        ))}
      </div>
      {canWrite ? (
        <div className={css.composer}>
          <CommentInput
            placeholder="Reply"
            submitLabel="Reply"
            hint="Enter to send"
            onSubmit={(text) => tryWrite(() => postReply(doc, thread.id, me, text))}
            onCancel={onClose}
          />
        </div>
      ) : (
        <div className={css.viewerNote}>Viewers can read comments but not reply.</div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this thread?"
        description="The comment and every reply are deleted for everyone. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const first = thread.messages[0]
          if (first && tryWrite(() => deleteMessage(doc, thread.id, first.id))) onClose()
        }}
      />
    </div>
  )
}
