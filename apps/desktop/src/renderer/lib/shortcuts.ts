/**
 * Keyboard shortcuts written once in a canonical form ("Mod+Shift+N", "Delete", "F11"),
 * displayed per platform ("Ctrl+Shift+N" on Linux/Windows as in the HTML menus, "⇧⌘N" on
 * macOS) and matched against KeyboardEvents. `Mod` is Ctrl, or ⌘ on macOS.
 */
import type { Platform } from '../types/bridge'

export interface ParsedShortcut {
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** Normalised key: single characters lower-cased ("n", ",", "/"), names as written ("Delete", "F11"). */
  key: string
}

const MODIFIERS = new Set(['mod', 'ctrl', 'shift', 'alt'])

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split('+')
  // "Mod++" would mean the plus key; not used, but keep the parser honest.
  const rawKey = shortcut.endsWith('++') ? '+' : (parts[parts.length - 1] ?? '')
  const mods = new Set(
    parts
      .slice(0, shortcut.endsWith('++') ? -2 : -1)
      .map((p) => p.trim().toLowerCase())
      .filter((p) => MODIFIERS.has(p)),
  )
  return {
    mod: mods.has('mod'),
    ctrl: mods.has('ctrl'),
    shift: mods.has('shift'),
    alt: mods.has('alt'),
    key: rawKey.length === 1 ? rawKey.toLowerCase() : rawKey,
  }
}

const KEY_LABELS: Record<string, string> = {
  Delete: 'Del',
  Backspace: '⌫',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

const MAC_KEY_LABELS: Record<string, string> = {
  Delete: '⌦',
  Escape: '⎋',
}

/** Display label, e.g. "Ctrl+Shift+N" (Linux/Windows) or "⇧⌘N" (macOS). */
export function formatShortcut(shortcut: string, platform: Platform): string {
  const s = parseShortcut(shortcut)
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key
  if (platform === 'darwin') {
    const label = MAC_KEY_LABELS[key] ?? KEY_LABELS[key] ?? key
    return `${s.ctrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}${label}`
  }
  const parts: string[] = []
  if (s.mod || s.ctrl) parts.push('Ctrl')
  if (s.alt) parts.push('Alt')
  if (s.shift) parts.push('Shift')
  parts.push(KEY_LABELS[key] ?? key)
  return parts.join('+')
}

/** Minimal event shape so matching is testable without a DOM. */
export interface KeyEventLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** Key of the event, independent of Shift and keyboard layout for letters and digits. */
function eventKey(e: KeyEventLike): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5)
  if (e.code === 'Comma') return ','
  if (e.code === 'Slash') return '/'
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

export function matchesShortcut(e: KeyEventLike, s: ParsedShortcut, platform: Platform): boolean {
  const mac = platform === 'darwin'
  const wantCtrl = s.ctrl || (s.mod && !mac)
  const wantMeta = s.mod && mac
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta) return false
  if (e.shiftKey !== s.shift || e.altKey !== s.alt) return false
  return eventKey(e) === s.key
}

/** True when the event target edits text: shortcuts then belong to the field. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return !target.readOnly
  if (target instanceof HTMLInputElement) {
    const nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']
    return !target.readOnly && !nonText.includes(target.type)
  }
  return false
}
