/**
 * Editor layout: left panel 240 · tool rail 44 · canvas · inspector 264, plus the
 * floating context menu. Hooks wire commands and collaboration. (The MCP "Connect your agent"
 * dialog is app-level: `openDialog({ kind: 'mcp' })`, app/McpConnectDialog.tsx.)
 */
import { CanvasArea } from './canvas/CanvasArea'
import { EditorContextMenu } from './canvas/EditorContextMenu'
import { EditorToolRail } from './chrome/EditorToolRail'
import { useCollaboration } from './collab/useCollaboration'
import { useEditorCommands } from './commands/useEditorCommands'
import { Inspector } from './inspector/Inspector'
import { LeftPanel } from './LeftPanel'
import { useEditor, useEditorState, useSelectedNodes } from './session/context'
import css from './Editor.module.css'

/** Command registrations follow the selection; kept out of the layout so it never re-renders. */
function EditorCommands() {
  const session = useEditor()
  useSelectedNodes()
  useEditorCommands(session)
  return null
}

export function EditorLayout() {
  const session = useEditor()
  const leftOpen = useEditorState((s) => s.leftPanelOpen)
  useCollaboration(session)
  return (
    <div className={css.editor} data-testid="editor">
      <EditorCommands />
      {leftOpen && <LeftPanel />}
      <EditorToolRail />
      <CanvasArea />
      <Inspector />
      <EditorContextMenu />
    </div>
  )
}
