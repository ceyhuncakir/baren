/**
 * The inspector in comment mode: the current page's threads (open first, newest activity first;
 * resolved ones with "Show resolved", shared with the pins). A row centres the canvas on its pin
 * and opens the thread.
 */
import { InspectorSection, Switch } from '@baren/ui'
import { formatRelative, useNow } from '../../lib/relativeTime'
import {
  useCommentThreads,
  useEditor,
  useEditorState,
  useLayerTreeVersion,
} from '../session/context'
import { CommentAvatar } from './CommentParts'
import { centredOn, lastActivity, listOrder, pageThreads, pinWorld, preview } from './model'
import css from './Comments.module.css'

export function CommentsPanel() {
  const { store, canvas, tree } = useEditor()
  useLayerTreeVersion()
  const threads = useCommentThreads()
  const pageId = useEditorState((s) => s.pageId)
  const showResolved = useEditorState((s) => s.showResolvedComments)
  const openId = useEditorState((s) => s.openCommentId)
  const now = useNow()
  const rows = listOrder(pageThreads(threads, pageId, showResolved))
  const resolvedCount = pageThreads(threads, pageId, true).filter((t) => t.resolved).length

  const show = (id: string) => {
    const thread = threads.find((t) => t.id === id)
    const c = canvas.current
    if (thread && c) {
      const v = c.getViewport()
      const world = pinWorld(thread, (n) => c.getNodeBounds(n))
      c.setViewport(centredOn(world, v.width, v.height, v.zoom), { animate: true })
    }
    store.setState({ openCommentId: id })
  }

  return (
    <InspectorSection
      title="Comments"
      roomy
      actions={
        <label className={css.resolvedSwitch}>
          Show resolved
          <Switch
            checked={showResolved}
            label="Show resolved comments"
            onCheckedChange={(v) => store.setState({ showResolvedComments: v })}
          />
        </label>
      }
      data-testid="comments-panel"
    >
      {rows.length === 0 ? (
        <div className={css.empty}>
          {resolvedCount > 0 && !showResolved
            ? `No open comments on this page (${resolvedCount} resolved).`
            : 'No comments on this page yet. Click anywhere on the canvas to add one.'}
        </div>
      ) : (
        <div className={css.list} role="list">
          {rows.map((t) => {
            const first = t.messages[0]
            if (!first) return null
            const anchor = t.nodeId === null ? null : (tree.meta(t.nodeId)?.name ?? null)
            const replies = t.messages.length - 1
            return (
              <button
                key={t.id}
                type="button"
                role="listitem"
                className={`${css.row} ${t.resolved ? css.rowResolved : ''}`}
                aria-current={t.id === openId}
                onClick={() => show(t.id)}
              >
                <CommentAvatar author={first.author} size={22} />
                <span className={css.rowBody}>
                  <span className={css.rowTop}>
                    <span className={css.rowAuthor}>{first.author.name}</span>
                    <span className={css.time}>{formatRelative(lastActivity(t), now)}</span>
                  </span>
                  <span className={css.rowPreview}>{preview(first.body, 140)}</span>
                  <span className={css.rowFoot}>
                    {anchor && <span className={css.rowAnchor}>{anchor}</span>}
                    {replies > 0 && (
                      <span>
                        {replies} {replies === 1 ? 'reply' : 'replies'}
                      </span>
                    )}
                    {t.resolved && <span>Resolved</span>}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </InspectorSection>
  )
}
