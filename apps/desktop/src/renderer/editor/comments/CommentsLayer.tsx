/**
 * Comments over the canvas, in comment mode only: a pin per thread of the current page (open
 * ones, plus resolved ones when "Show resolved" is on; unread ones marked, "@" when they mention
 * you), the open thread's card, and in comment mode the click that pins a new comment on the layer under
 * the pointer with its composer. Pins and cards stay glued to the canvas through `PinLayout`.
 *
 * Comment-mode clicks are taken in the capture phase on the canvas column, so the canvas neither
 * selects nor edits; the wheel, hover highlights and middle-button or Space panning still reach
 * it.
 */
import { getCommentThread, type CommentPin, type CommentThread } from '@baren/schema'
import { CheckIcon } from '@baren/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useCommentThreads, useEditorState } from '../session/context'
import { useViewer } from '../session/readOnly'
import { CommentAvatar, CommentInput } from './CommentParts'
import { CommentThreadCard, tryWrite } from './CommentThreadCard'
import { useCommentAuthor, useMentionToasts, useReads } from './hooks'
import { pageThreads, pinAt, pinWorld } from './model'
import { isRunning, useThreadRun } from '../../state/agentRuns'
import { maybeRunAgent } from './agentRun'
import { postThread } from './ops'
import { useMentionCandidates } from './people'
import { PinLayout, placeCard, placePin, usePinned } from './pinLayout'
import { isUnread, unreadMention, useCommentReads } from './unread'
import css from './Comments.module.css'

function Pin({
  layout,
  thread,
  open,
  unread,
  mentioned,
  onOpen,
}: {
  layout: PinLayout
  thread: CommentThread
  open: boolean
  /** Someone else wrote in it since this user last opened it. */
  unread: boolean
  /** An unread message in it mentions this user. */
  mentioned: boolean
  onOpen(): void
}) {
  const { canvas, fileId } = useEditor()
  const working = isRunning(useThreadRun(fileId, thread.id))
  const ref = usePinned(
    layout,
    `pin:${thread.id}`,
    () => pinWorld(thread, (id) => canvas.current?.getNodeBounds(id) ?? null),
    placePin,
  )
  const first = thread.messages[0]
  if (!first) return null
  const replies = thread.messages.length - 1
  return (
    <button
      ref={ref}
      type="button"
      className={css.pin}
      data-comment-ui=""
      data-open={open || undefined}
      data-working={working || undefined}
      data-resolved={thread.resolved || undefined}
      data-unread={unread || undefined}
      aria-label={`Comment by ${first.author.name}${replies > 0 ? `, ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}${thread.resolved ? ', resolved' : ''}${mentioned ? ', mentions you' : unread ? ', unread' : ''}`}
      onClick={onOpen}
    >
      <CommentAvatar author={first.author} size={22} />
      {mentioned ? (
        <span className={css.pinMention} aria-hidden="true">
          @
        </span>
      ) : (
        unread && <span className={css.pinUnread} aria-hidden="true" />
      )}
      {replies > 0 && <span className={css.pinCount}>{thread.messages.length}</span>}
      {thread.resolved && (
        <span className={css.pinResolved}>
          <CheckIcon size={9} strokeWidth={3} />
        </span>
      )}
    </button>
  )
}

export function CommentsLayer() {
  const session = useEditor()
  const { store, doc, canvas, canvasEl, tree } = session
  const threads = useCommentThreads()
  const pageId = useEditorState((s) => s.pageId)
  const commentMode = useEditorState((s) => s.commentMode)
  const showResolved = useEditorState((s) => s.showResolvedComments)
  const openId = useEditorState((s) => s.openCommentId)
  const viewer = useViewer()
  const layerRef = useRef<HTMLDivElement>(null)
  const layout = useMemo(
    () =>
      new PinLayout(
        () => canvas.current,
        () => layerRef.current,
      ),
    [canvas],
  )
  useEffect(() => () => layout.dispose(), [layout])

  const [draft, setDraft] = useState<CommentPin | null>(null)
  const draftText = useRef('')
  const me = useCommentAuthor()
  const reads = useReads(me)
  const readState = useCommentReads(reads)
  const candidates = useMentionCandidates(me)
  useMentionToasts(me)
  const canWrite = !viewer && canvas.current?.isReadOnly() !== true

  // Forget read marks of deleted threads.
  useEffect(() => reads.prune(threads), [reads, threads])

  const pins = commentMode ? pageThreads(threads, pageId, showResolved) : []
  const open = commentMode
    ? (threads.find((t) => t.id === openId && t.pageId === pageId) ?? null)
    : null

  // The open thread disappears with its page or when a collaborator deletes it.
  useEffect(() => {
    if (openId !== null && open === null) store.setState({ openCommentId: null })
  }, [openId, open, store])
  // Leaving comment mode closes the open thread and drops the unsent comment (and the page too).
  useEffect(() => {
    if (commentMode) return
    setDraft(null)
    if (store.getState().openCommentId !== null) store.setState({ openCommentId: null })
  }, [commentMode, store])
  useEffect(() => setDraft(null), [pageId])

  // Comment mode: the cursor and the click that pins a comment.
  useEffect(() => {
    const el = canvasEl.current
    if (!el || !commentMode) return
    el.classList.add(css.commentCursor as string)
    let space = false
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') space = e.type === 'keydown'
    }
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (target?.closest('[data-comment-ui]')) return
      // Middle-button and Space panning stay the canvas's.
      if (e.button !== 0 || space) return
      e.preventDefault()
      e.stopPropagation()
      const c = canvas.current
      if (!c) return
      // An open card or a started comment closes first (an unsent text is kept).
      if (store.getState().openCommentId !== null) {
        store.setState({ openCommentId: null })
        return
      }
      if (draftText.current.trim() !== '') return
      const r = el.getBoundingClientRect()
      const world = c.screenToCanvas({ x: e.clientX - r.left, y: e.clientY - r.top })
      draftText.current = ''
      setDraft(
        pinAt(world, c.nodePathAt(world), store.getState().pageId, (id) => c.getNodeBounds(id)),
      )
    }
    const swallow = (e: Event) => {
      if (!(e.target as Element | null)?.closest('[data-comment-ui]')) e.stopPropagation()
    }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('dblclick', swallow, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      el.classList.remove(css.commentCursor as string)
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('dblclick', swallow, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [canvas, canvasEl, commentMode, store])

  // Outside the canvas column, a click closes the open card.
  useEffect(() => {
    if (openId === null) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (target?.closest('[data-comment-ui], [role="menu"], [role="dialog"]')) return
      if (canvasEl.current?.contains(target) && store.getState().commentMode) return
      store.setState({ openCommentId: null })
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [openId, canvasEl, store])

  // Escape: the open card, then comment mode. Text fields (they cancel their own edit or
  // draft), menus and dialogs handle it themselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target as Element | null
      if (
        target?.closest?.('textarea, input, [role="menu"], [role="dialog"]:not([data-comment-ui])')
      )
        return
      const s = store.getState()
      if (s.openCommentId !== null) store.setState({ openCommentId: null })
      else if (draft !== null) setDraft(null)
      else if (s.commentMode) store.setState({ commentMode: false })
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [draft, store])

  const draftPinRef = usePinned(
    layout,
    'draft:pin',
    () => (draft ? { x: draft.worldX, y: draft.worldY } : null),
    placePin,
  )
  const draftCardRef = usePinned(
    layout,
    'draft:card',
    () => (draft ? { x: draft.worldX, y: draft.worldY } : null),
    placeCard,
  )
  const openCardRef = usePinned(
    layout,
    'open:card',
    () => (open ? pinWorld(open, (id) => canvas.current?.getNodeBounds(id) ?? null) : null),
    placeCard,
  )

  const anchorName = (nodeId: string | null) =>
    nodeId === null ? null : (tree.meta(nodeId)?.name ?? null)

  return (
    <div ref={layerRef} className={css.layer} data-testid="comments-layer">
      {pins.map((t) => (
        <Pin
          key={t.id}
          layout={layout}
          thread={t}
          open={t.id === openId}
          unread={isUnread(t, readState, me)}
          mentioned={unreadMention(t, readState, me)}
          onOpen={() => {
            setDraft(null)
            store.setState({ openCommentId: t.id === openId ? null : t.id })
          }}
        />
      ))}
      {open && !pins.includes(open) && (
        // A resolved thread opened from the list while resolved pins are hidden.
        <Pin
          layout={layout}
          thread={open}
          open
          unread={false}
          mentioned={false}
          onOpen={() => store.setState({ openCommentId: null })}
        />
      )}
      {draft && (
        <>
          <div ref={draftPinRef} className={css.pin} data-comment-ui="" data-open="">
            <CommentAvatar author={me} size={22} />
          </div>
          <div
            ref={draftCardRef}
            className={css.card}
            role="dialog"
            aria-label="New comment"
            data-comment-ui=""
          >
            <div className={`${css.composer} ${css.composerAlone}`}>
              <CommentInput
                placeholder={
                  draft.nodeId && anchorName(draft.nodeId)
                    ? `Comment on ${anchorName(draft.nodeId)}`
                    : 'Add a comment'
                }
                submitLabel="Post"
                hint="Enter to post · @ to mention"
                candidates={candidates}
                autoFocus
                onTextChange={(t) => (draftText.current = t)}
                onSubmit={(text, mentions) => {
                  let id: string | null = null
                  const ok = tryWrite(() => {
                    id = postThread(doc, draft, me, text, mentions)
                  })
                  if (!ok || id === null) return false
                  draftText.current = ''
                  setDraft(null)
                  store.setState({ openCommentId: id })
                  const thread = getCommentThread(doc, id)
                  const first = thread?.messages[0]
                  if (first) maybeRunAgent(session, thread, first.id, me.name, text, mentions)
                }}
                onCancel={() => {
                  draftText.current = ''
                  setDraft(null)
                }}
              />
            </div>
          </div>
        </>
      )}
      {open && (
        <CommentThreadCard
          key={open.id}
          thread={open}
          anchorName={anchorName(open.nodeId)}
          me={me}
          canWrite={canWrite}
          candidates={candidates}
          reads={reads}
          onClose={() => store.setState({ openCommentId: null })}
          cardRef={openCardRef}
        />
      )}
    </div>
  )
}
