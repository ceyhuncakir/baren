/**
 * Tool rail actions. Canvas tools (pen included) go to the controller (the store mirrors them
 * through `onToolChange`); the image tool opens a file picker and inserts image layers
 * (editor/images/insert.ts); the component tool (K) opens the component picker (32).
 */
import { toast } from '@baren/ui'
import { pickAndInsertImages } from '../images/insert'
import type { EditorSession } from '../session/context'
import { canEdit, isViewer } from '../session/readOnly'
import type { CanvasTool, EditorTool } from '../session/store'

const CANVAS_TOOLS: ReadonlySet<EditorTool> = new Set([
  'select',
  'hand',
  'artboard',
  'rectangle',
  'text',
  'pen',
])

export function isCanvasTool(tool: EditorTool): tool is CanvasTool {
  return CANVAS_TOOLS.has(tool)
}

const UNAVAILABLE: Partial<Record<EditorTool, string>> = {
  generate: 'Generate',
}

/** Tools that only look around; every other tool adds to the document. */
const VIEW_TOOLS: ReadonlySet<EditorTool> = new Set(['select', 'hand'])

export function runTool(session: EditorSession, tool: EditorTool): void {
  // A viewer (or a version preview) keeps select and hand; the canvas refuses the rest anyway.
  if (!VIEW_TOOLS.has(tool) && !canEdit(session)) return
  if (isCanvasTool(tool)) {
    // A canvas tool leaves comment mode (as in other design tools).
    session.store.setState({ tool, commentMode: false })
    session.canvas.current?.setTool(tool)
    session.canvas.current?.focus()
    return
  }
  if (tool === 'image') {
    void pickAndInsertImage(session)
    return
  }
  if (tool === 'insert') {
    session.store.setState({ insertOpen: true })
    return
  }
  if (tool === 'component') {
    session.store.setState((s) => ({ componentPickerOpen: !s.componentPickerOpen }))
    return
  }
  const what = UNAVAILABLE[tool]
  if (what) toast(`${what} isn't available yet.`)
}

/**
 * Comment mode (C, the rail's comment button): click the canvas to pin a comment. Viewers read
 * comments (pins, threads) but cannot write them: the server rejects their document updates.
 */
export function toggleCommentMode(session: EditorSession): void {
  const s = session.store.getState()
  if (!s.commentMode && isViewer(session, s)) {
    toast("Viewers can't comment. Ask an editor of this file for edit access.")
    return
  }
  session.store.setState({
    commentMode: !s.commentMode,
    openCommentId: null,
    // Comments and version history share the inspector.
    ...(!s.commentMode ? { historyOpen: false, previewVersionId: null } : {}),
  })
}

/** Tool-rail image button / Insert → Image…: pick files and insert them as layers. */
export function pickAndInsertImage(session: EditorSession): Promise<void> {
  if (!canEdit(session)) return Promise.resolve()
  return pickAndInsertImages(session)
}
