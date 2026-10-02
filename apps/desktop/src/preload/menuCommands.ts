import { COMMAND_EVENT, NATIVE_EDIT_ACTIONS, type NativeEditAction } from './channels'
import type { TypedIpc } from './ipc'

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  '',
])

/** Structural view of the focused element (keeps the predicate testable without a DOM). */
export interface FocusLike {
  tagName: string
  isContentEditable?: boolean
  type?: string
  readOnly?: boolean
  disabled?: boolean
}

/** True when native text editing should handle edit commands (inputs, textareas, contenteditable). */
export function isEditableTarget(el: FocusLike | null | undefined): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toUpperCase()
  if (el.disabled || el.readOnly) return false
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.type ?? '').toLowerCase())
  return false
}

/** `edit.undo` → `undo`, …; null for commands that have no native editing equivalent. */
export function nativeEditActionFor(commandId: string): NativeEditAction | null {
  if (!commandId.startsWith('edit.')) return null
  const action = commandId.slice('edit.'.length)
  return (NATIVE_EDIT_ACTIONS as readonly string[]).includes(action)
    ? (action as NativeEditAction)
    : null
}

/**
 * macOS native menu → renderer. Edit commands go to the focused text field
 * when there is one (native undo/copy/paste must keep working in inputs);
 * everything else becomes an `baren:command` DOM event that the renderer
 * forwards to its command registry (`runCommand(event.detail)`).
 */
export function installMenuCommandForwarder(ipc: TypedIpc): () => void {
  return ipc.on('menu:command', (id) => {
    const action = nativeEditActionFor(id)
    if (action !== null && isEditableTarget(document.activeElement as FocusLike | null)) {
      ipc.send('edit:native', action)
      return
    }
    window.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: id }))
  })
}
