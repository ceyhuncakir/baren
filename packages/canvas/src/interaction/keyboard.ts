import type { KeyboardMode, Tool } from '../types.ts'

export type KeyCommand =
  | { kind: 'tool'; tool: Tool }
  | { kind: 'nudge'; dx: number; dy: number }
  | { kind: 'delete' }
  | { kind: 'duplicate' }
  | { kind: 'escape' }
  | { kind: 'enter' }
  | { kind: 'selectParent' }
  | { kind: 'selectAll' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'zoomIn' }
  | { kind: 'zoomOut' }
  | { kind: 'zoom100' }
  | { kind: 'zoomFit' }
  | { kind: 'zoomSelection' }

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  a: 'artboard',
  f: 'artboard',
  r: 'rectangle',
  t: 'text',
  p: 'pen',
}

const HOST_COMMANDS: ReadonlySet<KeyCommand['kind']> = new Set([
  'undo',
  'redo',
  'zoomIn',
  'zoomOut',
  'zoom100',
  'zoomFit',
  'zoomSelection',
  'selectAll',
])

/**
 * Map a key event to a canvas command (common design-tool shortcuts). `mode`
 * `canvas` leaves undo/redo/zoom/select-all to the host's command registry.
 */
export function keyToCommand(e: KeyLike, mode: KeyboardMode): KeyCommand | null {
  if (mode === 'none') return null
  const cmd = map(e)
  if (cmd && mode === 'canvas' && HOST_COMMANDS.has(cmd.kind)) return null
  return cmd
}

function map(e: KeyLike): KeyCommand | null {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (mod) {
    if (e.altKey) return null
    if (key === 'z') return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
    if (key === 'y' && !e.shiftKey) return { kind: 'redo' }
    if (key === 'd' && !e.shiftKey) return { kind: 'duplicate' }
    if (key === 'a' && !e.shiftKey) return { kind: 'selectAll' }
    if (key === '=' || key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd')
      return { kind: 'zoomIn' }
    if (key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') return { kind: 'zoomOut' }
    if (key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return { kind: 'zoom100' }
    return null
  }
  if (e.altKey) return null
  if (e.shiftKey && e.code === 'Digit1') return { kind: 'zoomFit' }
  if (e.shiftKey && e.code === 'Digit2') return { kind: 'zoomSelection' }
  const step = e.shiftKey ? 10 : 1
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'nudge', dx: -step, dy: 0 }
    case 'ArrowRight':
      return { kind: 'nudge', dx: step, dy: 0 }
    case 'ArrowUp':
      return { kind: 'nudge', dx: 0, dy: -step }
    case 'ArrowDown':
      return { kind: 'nudge', dx: 0, dy: step }
    case 'Delete':
    case 'Backspace':
      return { kind: 'delete' }
    case 'Escape':
      return { kind: 'escape' }
    case 'Enter':
      return e.shiftKey ? { kind: 'selectParent' } : { kind: 'enter' }
    default:
      break
  }
  if (!e.shiftKey) {
    const tool = TOOL_KEYS[key]
    if (tool) return { kind: 'tool', tool }
  }
  return null
}

/** True for targets that own their keyboard input (inputs, textareas, other contenteditables). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
