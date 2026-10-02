/**
 * Tiny command registry so the HTML menu bar (screens) can drive whatever
 * currently handles a command (the editor, a focused text field, ...).
 *
 * Registrations stack per id: the most recent registration handles the
 * command, and unregistering restores the previous one. A command is enabled
 * while at least one handler is registered.
 */
import { useCallback, useSyncExternalStore } from 'react'

export const COMMAND_IDS = [
  'edit.undo',
  'edit.redo',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  'edit.delete',
  'edit.selectAll',
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomToFit',
  'view.zoom100',
  // Phase 3 (docs/phase3/contract.md §8.3): registered by the editor; the HTML menu bar does
  // not show them yet, the macOS native menu and later menus can drive them.
  'edit.pasteInPlace',
  'edit.duplicate',
  'object.group',
  'object.ungroup',
  'object.createComponent',
  'object.detachInstance',
  'object.resetOverrides',
  'object.goToMainComponent',
  // Help menu links. Registered by the app shell; also sent by the macOS native menu
  // (desktop-shell) as `baren:command` events.
  'help.documentation',
  'help.videoTutorials',
  'help.releaseNotes',
  'help.discord',
  'help.slack',
  'help.reddit',
  'help.twitter',
] as const

export type CommandId = (typeof COMMAND_IDS)[number]

const COMMAND_ID_SET: ReadonlySet<string> = new Set(COMMAND_IDS)

/** Narrows an untrusted string (e.g. an `baren:command` event detail) to a CommandId. */
export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && COMMAND_ID_SET.has(value)
}
export type CommandHandler = () => void

interface Registration {
  readonly handler: CommandHandler
}

const stacks = new Map<CommandId, Registration[]>()
const listeners = new Map<CommandId, Set<() => void>>()

function notify(id: CommandId): void {
  const set = listeners.get(id)
  if (set) for (const listener of [...set]) listener()
}

/** Register a handler; returns an idempotent unregister function. */
export function registerCommand(id: CommandId, handler: CommandHandler): () => void {
  const registration: Registration = { handler }
  let stack = stacks.get(id)
  if (!stack) {
    stack = []
    stacks.set(id, stack)
  }
  stack.push(registration)
  notify(id)
  let active = true
  return () => {
    if (!active) return
    active = false
    const current = stacks.get(id)
    if (!current) return
    const index = current.lastIndexOf(registration)
    if (index !== -1) current.splice(index, 1)
    if (current.length === 0) stacks.delete(id)
    notify(id)
  }
}

/** Run the active handler. Returns false when nothing handles the command. */
export function runCommand(id: CommandId): boolean {
  const stack = stacks.get(id)
  const top = stack?.[stack.length - 1]
  if (!top) return false
  top.handler()
  return true
}

export function isCommandEnabled(id: CommandId): boolean {
  return (stacks.get(id)?.length ?? 0) > 0
}

/** Low-level subscription (fires on every register/unregister of `id`). */
export function subscribeCommand(id: CommandId, listener: () => void): () => void {
  let set = listeners.get(id)
  if (!set) {
    set = new Set()
    listeners.set(id, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(id)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(id)
  }
}

/** React hook: re-renders only when the command's enabled state flips. */
export function useCommandEnabled(id: CommandId): boolean {
  const subscribe = useCallback((cb: () => void) => subscribeCommand(id, cb), [id])
  const getSnapshot = useCallback(() => isCommandEnabled(id), [id])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
