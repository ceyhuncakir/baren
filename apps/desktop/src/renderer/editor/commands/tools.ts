/**
 * Tool rail actions. Canvas tools (pen included) go to the controller (the store mirrors them
 * through `onToolChange`); the image tool opens a file picker and inserts image layers
 * (editor/images/insert.ts); the component tool (K) opens the component picker (32).
 */
import { toast } from '@baren/ui'
import { pickAndInsertImages } from '../images/insert'
import type { EditorSession } from '../session/context'
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

export function runTool(session: EditorSession, tool: EditorTool): void {
  if (isCanvasTool(tool)) {
    session.store.setState({ tool })
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

/** Tool-rail image button / Insert → Image…: pick files and insert them as layers. */
export function pickAndInsertImage(session: EditorSession): Promise<void> {
  return pickAndInsertImages(session)
}
