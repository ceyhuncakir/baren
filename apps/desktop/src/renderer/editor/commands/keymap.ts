/**
 * Editor keyboard shortcuts that neither the canvas (keyboard: 'canvas') nor the app
 * shell's command registry handle: zoom, structure commands, tools when the canvas is not
 * focused, and view toggles. Pure mapping, unit-tested.
 */
import type { EditorTool } from '../session/store'

export type EditorKeyAction =
  | { kind: 'zoomIn' | 'zoomOut' | 'zoom100' | 'zoomToFit' | 'zoomToSelection' }
  | { kind: 'duplicate' | 'bringToFront' | 'sendToBack' | 'addFlex' | 'wrapInFrame' }
  | { kind: 'copyHtml' | 'copyAgentContext' | 'rename' | 'toggleLock' | 'toggleHide' }
  | { kind: 'toggleClip' }
  | { kind: 'togglePixelGrid' | 'toggleRulers' | 'toggleOutline' | 'toggleLeftPanel' }
  | { kind: 'group' | 'ungroup' | 'createComponent' | 'detachInstance' | 'pasteInPlace' }
  | { kind: 'tool'; tool: EditorTool }

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const TOOL_KEYS: Record<string, EditorTool> = {
  v: 'select',
  h: 'hand',
  a: 'artboard',
  f: 'artboard',
  r: 'rectangle',
  t: 'text',
  p: 'pen',
  i: 'insert',
  k: 'component',
  g: 'generate',
}

export function editorKeyAction(e: KeyLike, platform: string): EditorKeyAction | null {
  const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (mod) {
    if (e.altKey && !e.shiftKey) {
      if (key === 'g' || e.code === 'KeyG') return { kind: 'wrapInFrame' }
      if (key === 'c' || e.code === 'KeyC') return { kind: 'copyHtml' }
      if (key === 'k' || e.code === 'KeyK') return { kind: 'createComponent' }
      if (key === 'b' || e.code === 'KeyB') return { kind: 'detachInstance' }
      return null
    }
    if (e.shiftKey && !e.altKey) {
      if (e.code === 'KeyL') return { kind: 'toggleLock' }
      if (e.code === 'KeyH') return { kind: 'toggleHide' }
      if (e.code === 'KeyG') return { kind: 'ungroup' }
      if (e.code === 'KeyV') return { kind: 'pasteInPlace' }
      if (e.code === 'KeyC') return { kind: 'copyAgentContext' }
      return null
    }
    if (e.altKey) return null
    if (key === '=' || key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd')
      return { kind: 'zoomIn' }
    if (key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') return { kind: 'zoomOut' }
    if (key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return { kind: 'zoom100' }
    if (key === 'd') return { kind: 'duplicate' }
    if (key === 'g' || e.code === 'KeyG') return { kind: 'group' }
    if (key === ']' || e.code === 'BracketRight') return { kind: 'bringToFront' }
    if (key === '[' || e.code === 'BracketLeft') return { kind: 'sendToBack' }
    if (key === "'" || e.code === 'Quote') return { kind: 'togglePixelGrid' }
    if (key === 'y') return { kind: 'toggleOutline' }
    if (key === '\\' || e.code === 'Backslash') return { kind: 'toggleLeftPanel' }
    return null
  }
  if (e.ctrlKey || e.metaKey) return null
  if (e.altKey) {
    if (!e.shiftKey && e.code === 'KeyC') return { kind: 'toggleClip' }
    return null
  }
  if (e.shiftKey) {
    if (e.code === 'Digit1') return { kind: 'zoomToFit' }
    if (e.code === 'Digit2') return { kind: 'zoomToSelection' }
    if (e.code === 'KeyA') return { kind: 'addFlex' }
    if (e.code === 'KeyR') return { kind: 'toggleRulers' }
    if (e.code === 'KeyI') return { kind: 'tool', tool: 'image' }
    return null
  }
  if (key === 'F2') return { kind: 'rename' }
  const tool = TOOL_KEYS[key]
  return tool ? { kind: 'tool', tool } : null
}

/** Targets that own their keyboard input. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
