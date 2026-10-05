/**
 * The canvas column: @baren/canvas mounted once per document, the empty-page hint (04)
 * and a floating panel toggle when the left panel is hidden. All canvas callbacks write
 * narrowly into the UI store; React never re-renders the canvas itself. Image files
 * dragged over the column highlight the artboard they would land in and are inserted
 * at the drop point; components dragged from the Components panel or the picker highlight
 * the deepest frame that can take them (no component cycles) and become instances there.
 * The visible world rectangle goes to collaborators as presence, and following a collaborator
 * (`collab/follow`) drives the camera from theirs. The canvas is read-only for a viewer of a
 * shared file and while a version preview covers it (`session/readOnly`).
 */
import type {
  CanvasController,
  ContextMenuRequest,
  HistoryState,
  Tool,
  Viewport,
} from '@baren/canvas'
import { DesignCanvas } from '@baren/canvas/react'
import { EmptyCanvasHint } from '@baren/ui'
import { useCallback, useEffect, useMemo, useRef, type DragEvent } from 'react'
import { wouldCreateCycleForKeys } from '@baren/schema'
import { resolveCanvasAsset } from '../../lib/assets'
import { FollowOverlay } from '../collab/FollowOverlay'
import { CommentsLayer } from '../comments/CommentsLayer'
import { VersionPreview } from '../history/VersionPreview'
import { COMMENT_ORIGIN } from '../comments/ops'
import { visibleWorldRect } from '../collab/follow'
import { useFollow } from '../collab/useFollow'
import { useSpotlight } from '../collab/useSpotlight'
import { draggedComponent, endComponentDrag } from '../components/componentDrag'
import { dragHasFiles, imageFilesOf, insertImageFiles } from '../images/insert'
import { PREVIEW_ORIGIN_PREFIX } from '../model/previewEdits'
import { PanelToggle } from '../LeftPanel'
import { useEditor, useEditorState, useLayerTreeVersion } from '../session/context'
import { useReadOnly } from '../session/readOnly'
import { sameIds } from '../session/store'
import css from '../Editor.module.css'

/**
 * Not undoable (contract §8.1): remote/sync, fixtures, inspector previews, derived refits, and
 * comments (`comment:*`: Ctrl+Z undoes design edits, never a comment) and the version list
 * (`version:*`; a restore itself is `editor:restore`, an ordinary undo step).
 */
const UNDO_EXCLUDE = [
  'remote',
  'sync',
  'bench',
  'fixture',
  PREVIEW_ORIGIN_PREFIX,
  'derived',
  COMMENT_ORIGIN,
  'version',
]
/** DesignCanvas defaults to `position: relative`; the canvas fills the column instead. */
const CANVAS_STYLE = { position: 'absolute', inset: 0 } as const
/** Viewport events during gestures: presence rate (30 Hz), so followers move smoothly. */
const VIEWPORT_EMIT_MS = 33

export function CanvasArea() {
  const session = useEditor()
  const { store, tree, doc } = session
  const pageId = useEditorState((s) => s.pageId)
  const leftOpen = useEditorState((s) => s.leftPanelOpen)
  const readOnly = useReadOnly()
  useLayerTreeVersion()
  const empty = tree.children(pageId).length === 0
  const visited = useRef(new Set<string>())
  const follow = useFollow(session)
  useSpotlight(session)

  // The initial viewport applies only to the page the canvas is created with.
  const initialViewport = useMemo(() => session.initialViewports[pageId] ?? ('fit' as const), [doc])

  const onReady = useCallback(
    (controller: CanvasController | null) => {
      session.canvas.current = controller
      if (!controller) return
      visited.current.add(controller.getPageId())
      store.setState({ zoom: controller.getViewport().zoom, tool: controller.getTool() })
      session.presence.setViewport(visibleWorldRect(controller.getViewport()))
      controller.focus()
    },
    [session, store],
  )

  // First visit of another page in this session: restore its remembered viewport.
  useEffect(() => {
    const canvas = session.canvas.current
    if (!canvas || visited.current.has(pageId)) return
    visited.current.add(pageId)
    const v = session.initialViewports[pageId]
    if (v) canvas.setViewport(v, { animate: false })
    store.setState({ zoom: canvas.getViewport().zoom })
  }, [pageId, session, store])

  // After the page effects above: a page switch made by following gets its camera now.
  useEffect(() => follow.onCanvasPage(), [pageId, follow])

  const onSelectionChange = useCallback(
    (ids: string[]) => {
      if (!sameIds(store.getState().selection, ids)) store.setState({ selection: ids })
      session.presence.setSelection(ids)
    },
    [session, store],
  )
  const onHoverChange = useCallback(
    (id: string | null) => {
      if (store.getState().hoveredId !== id) store.setState({ hoveredId: id })
    },
    [store],
  )
  const onViewportChange = useCallback(
    (v: Viewport) => {
      if (store.getState().zoom !== v.zoom) store.setState({ zoom: v.zoom })
      session.rememberViewport(store.getState().pageId, v)
      session.presence.setViewport(visibleWorldRect(v))
      follow.onViewport(v)
    },
    [session, store, follow],
  )
  // A tool picked on the canvas (V, R, …) leaves comment mode, like the rail's tools.
  const onToolChange = useCallback(
    (tool: Tool) => store.setState({ tool, commentMode: false }),
    [store],
  )
  const onHistoryChange = useCallback(
    (h: HistoryState) => store.setState({ canUndo: h.canUndo, canRedo: h.canRedo }),
    [store],
  )
  const onContextMenu = useCallback(
    (r: ContextMenuRequest) =>
      store.setState({
        contextMenu: { x: r.clientX, y: r.clientY, source: 'canvas', world: r.world },
      }),
    [store],
  )
  const onTextEditChange = useCallback(
    (id: string | null) => store.setState({ editingTextId: id }),
    [store],
  )
  const onVectorEditChange = useCallback(
    (id: string | null) => store.setState({ editingVectorId: id }),
    [store],
  )

  // File drag and drop: one hit test per animation frame while dragging.
  const dragFrame = useRef(0)
  const lastDrag = useRef<{ clientX: number; clientY: number } | null>(null)
  const dragKey = useRef<string | null>(null)
  const onDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const canvas = session.canvas.current
      if (!canvas || canvas.isReadOnly()) return
      const component = draggedComponent(e.dataTransfer)
      if (component === null && !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      lastDrag.current = { clientX: e.clientX, clientY: e.clientY }
      dragKey.current = component
      if (dragFrame.current) return
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = 0
        const at = lastDrag.current
        if (!at) return
        const key = dragKey.current
        if (key === null) session.canvas.current?.dropTargetAt(at)
        else
          session.canvas.current?.dropTargetAt(at, {
            deep: true,
            accept: (parentId) => !wouldCreateCycleForKeys(session.doc, [key], parentId),
          })
      })
    },
    [session],
  )
  const endDrag = useCallback(() => {
    lastDrag.current = null
    if (dragFrame.current) cancelAnimationFrame(dragFrame.current)
    dragFrame.current = 0
    session.canvas.current?.dropTargetAt(null)
  }, [session])
  const onDragLeave = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const next = e.relatedTarget as Node | null
      if (!next || !e.currentTarget.contains(next)) endDrag()
    },
    [endDrag],
  )
  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const canvas = session.canvas.current
      if (!canvas) return
      const component = draggedComponent(e.dataTransfer)
      if (component !== null) {
        e.preventDefault()
        endDrag()
        endComponentDrag()
        if (!canvas.isReadOnly()) {
          session.actions.insertInstance(component, { clientX: e.clientX, clientY: e.clientY })
        }
        return
      }
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      endDrag()
      const files = imageFilesOf(e.dataTransfer)
      if (files.length === 0 || canvas.isReadOnly()) return
      const r = e.currentTarget.getBoundingClientRect()
      const world = canvas.screenToCanvas({ x: e.clientX - r.left, y: e.clientY - r.top })
      void insertImageFiles(session, files, { world })
    },
    [session, endDrag],
  )
  useEffect(() => endDrag, [endDrag])

  return (
    <div
      className={css.canvasArea}
      ref={(el) => void (session.canvasEl.current = el)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <DesignCanvas
        className={css.canvas}
        style={CANVAS_STYLE}
        doc={doc}
        pageId={pageId}
        viewport={initialViewport}
        readOnly={readOnly}
        viewportChangeThrottleMs={VIEWPORT_EMIT_MS}
        keyboard="canvas"
        undoExcludeOriginPrefixes={UNDO_EXCLUDE}
        resolveAsset={resolveCanvasAsset}
        onReady={onReady}
        onSelectionChange={onSelectionChange}
        onHoverChange={onHoverChange}
        onViewportChange={onViewportChange}
        onToolChange={onToolChange}
        onHistoryChange={onHistoryChange}
        onContextMenu={onContextMenu}
        onTextEditChange={onTextEditChange}
        onVectorEditChange={onVectorEditChange}
        onCursorMove={session.presence.setCursor}
        onTransientChange={session.presence.setTransient}
      />
      {empty && <EmptyCanvasHint className={css.emptyHint} />}
      <CommentsLayer />
      <FollowOverlay />
      <VersionPreview />
      {!leftOpen && <PanelToggle floating />}
    </div>
  )
}
