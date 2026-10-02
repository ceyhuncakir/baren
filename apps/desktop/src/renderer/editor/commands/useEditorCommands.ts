/**
 * Wires the editor into the app: registers edit.* / view.* handlers in the shared command
 * registry (so the HTML menu bar and the shell's shortcuts drive the editor), and handles
 * the editor-only shortcuts at window level.
 */
import { useEffect } from 'react'
import { bridge } from '../../lib/bridge'
import { registerCommand, type CommandId } from '../../lib/commands'
import type { EditorSession } from '../session/context'
import { useEditorState } from '../session/context'
import { editorKeyAction, isEditableTarget, type EditorKeyAction } from './keymap'
import { runTool } from './tools'

function useRegistered(id: CommandId, enabled: boolean, run: () => void): void {
  useEffect(() => {
    if (!enabled) return
    return registerCommand(id, run)
    // `run` closes over the stable session only.
  }, [id, enabled])
}

export function useEditorCommands(session: EditorSession): void {
  const { actions, store } = session
  const canUndo = useEditorState((s) => s.canUndo)
  const canRedo = useEditorState((s) => s.canRedo)
  const hasSelection = useEditorState((s) => s.selection.length > 0)
  const selection = useEditorState((s) => s.selection)
  // Re-evaluated when the selection changes (types come from the resolver).
  const info = actions.info(selection)
  const structural = info.real.length > 0 && !info.virtual

  useRegistered('edit.undo', canUndo, () => actions.undo())
  useRegistered('edit.redo', canRedo, () => actions.redo())
  useRegistered('edit.cut', hasSelection, () => void actions.cut())
  useRegistered('edit.copy', hasSelection, () => void actions.copy())
  useRegistered('edit.paste', true, () => void actions.paste())
  useRegistered('edit.delete', hasSelection, () => actions.delete())
  useRegistered('edit.selectAll', true, () => actions.selectAll())
  useRegistered('view.zoomIn', true, () => actions.zoomIn())
  useRegistered('view.zoomOut', true, () => actions.zoomOut())
  useRegistered('view.zoomToFit', true, () => actions.zoomToFit())
  useRegistered('view.zoom100', true, () => actions.zoom100())
  useRegistered('edit.pasteInPlace', true, () => void actions.pasteInPlace())
  useRegistered('edit.duplicate', hasSelection, () => actions.duplicate())
  useRegistered('object.group', structural, () => void actions.group())
  useRegistered('object.ungroup', info.groups.length > 0, () => void actions.ungroup())
  useRegistered('object.createComponent', structural, () => void actions.createComponent())
  useRegistered(
    'object.detachInstance',
    info.instances.length > 0,
    () => void actions.detachInstance(),
  )
  useRegistered('object.resetOverrides', info.overridable.length > 0, () =>
    actions.resetOverrides(),
  )
  useRegistered('object.goToMainComponent', info.overridable.length > 0, () =>
    actions.goToMainComponent(),
  )

  useEffect(() => {
    const run = (a: EditorKeyAction): void => {
      switch (a.kind) {
        case 'zoomIn':
          return actions.zoomIn()
        case 'zoomOut':
          return actions.zoomOut()
        case 'zoom100':
          return actions.zoom100()
        case 'zoomToFit':
          return actions.zoomToFit()
        case 'zoomToSelection':
          return actions.zoomToSelection()
        case 'duplicate':
          return actions.duplicate()
        case 'bringToFront':
          return actions.bringToFront()
        case 'sendToBack':
          return actions.sendToBack()
        case 'addFlex':
          return actions.addFlex()
        case 'wrapInFrame':
          return actions.wrapInFrame()
        case 'copyHtml':
          return void actions.copyAs('html')
        case 'rename':
          return actions.rename()
        case 'toggleLock':
          return actions.toggleLock()
        case 'toggleHide':
          return actions.toggleHide()
        case 'toggleClip':
          return actions.toggleClip()
        case 'togglePixelGrid':
        case 'toggleRulers':
        case 'toggleOutline': {
          const key =
            a.kind === 'togglePixelGrid'
              ? 'pixelGrid'
              : a.kind === 'toggleRulers'
                ? 'rulers'
                : 'outline'
          store.setState((s) => ({ viewToggles: { ...s.viewToggles, [key]: !s.viewToggles[key] } }))
          return
        }
        case 'toggleLeftPanel':
          store.setState((s) => ({ leftPanelOpen: !s.leftPanelOpen }))
          return
        case 'group':
          return void actions.group()
        case 'ungroup':
          return void actions.ungroup()
        case 'createComponent':
          return void actions.createComponent()
        case 'detachInstance':
          return void actions.detachInstance()
        case 'pasteInPlace':
          return void actions.pasteInPlace()
        case 'tool':
          return runTool(session, a.tool)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isEditableTarget(e.target)) return
      // Menus own their keys while open.
      if (
        (e.target as HTMLElement | null)?.closest?.(
          '[role="menu"], [role="dialog"], [role="menubar"]',
        )
      )
        return
      const action = editorKeyAction(e, bridge.platform)
      if (!action) return
      if (action.kind === 'tool' && e.repeat) return
      e.preventDefault()
      run(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions, session, store])
}
