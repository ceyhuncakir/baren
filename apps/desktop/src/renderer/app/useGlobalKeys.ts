/**
 * Window-level keyboard handling:
 *  - app shortcuts (menuModel.SHORTCUTS), one listener for the whole app;
 *  - Alt pressed and released alone focuses the menu bar (Windows/Linux convention);
 *    Escape or Alt again returns focus to where it was.
 */
import { useEffect } from 'react'
import { bridge, isMockBridge } from '../lib/bridge'
import { isCommandEnabled, isCommandId } from '../lib/commands'
import {
  isEditableTarget,
  matchesShortcut,
  parseShortcut,
  type ParsedShortcut,
} from '../lib/shortcuts'
import { runAppAction } from './actions'
import { SHORTCUTS, type ShortcutBinding } from './menuModel'

const PARSED: ReadonlyArray<{ binding: ShortcutBinding; parsed: ParsedShortcut }> = SHORTCUTS.map(
  (binding) => ({ binding, parsed: parseShortcut(binding.shortcut) }),
)

function findBinding(e: KeyboardEvent): ShortcutBinding | null {
  for (const { binding, parsed } of PARSED)
    if (matchesShortcut(e, parsed, bridge.platform)) return binding
  return null
}

/** A modal dialog owns the keyboard: nothing behind it may react to shortcuts. */
function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

function handleShortcut(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.repeat) return
  const binding = findBinding(e)
  if (!binding) return
  if (binding.scope !== 'main' && modalOpen()) return
  switch (binding.scope) {
    case 'main':
      // Electron's main process owns these keys; only the browser mock binds them here.
      if (!isMockBridge) return
      break
    case 'edit':
      // Text fields keep native undo/cut/copy/paste/select-all/delete.
      if (isEditableTarget(e.target)) return
      if (!isCommandId(binding.action) || !isCommandEnabled(binding.action)) return
      break
    case 'app':
      break
  }
  if (runAppAction(binding.action)) e.preventDefault()
}

const MENUBAR_ITEM = '[role="menubar"] [data-menubar-item]'

function menubarItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(MENUBAR_ITEM))
}

export function useGlobalKeys(): void {
  useEffect(() => {
    let altAlone = false
    let restoreFocus: HTMLElement | null = null

    const inMenubar = () => {
      const active = document.activeElement
      return active instanceof HTMLElement && active.matches(MENUBAR_ITEM)
    }

    const leaveMenubar = () => {
      const target = restoreFocus
      restoreFocus = null
      if (target?.isConnected) target.focus({ preventScroll: true })
      else (document.activeElement as HTMLElement | null)?.blur()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      altAlone = e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey
      if (e.key === 'Escape' && inMenubar() && !e.defaultPrevented) {
        e.preventDefault()
        leaveMenubar()
        return
      }
      handleShortcut(e)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !altAlone) return
      altAlone = false
      if (bridge.platform === 'darwin') return
      e.preventDefault()
      if (inMenubar()) {
        leaveMenubar()
        return
      }
      const first = menubarItems()[0]
      if (!first) return
      const active = document.activeElement
      restoreFocus = active instanceof HTMLElement && active !== document.body ? active : null
      first.focus({ preventScroll: true })
    }

    // Alt+click and Alt+Tab (the window loses focus) are not "Alt alone".
    const cancelAlt = () => {
      altAlone = false
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', cancelAlt, true)
    window.addEventListener('blur', cancelAlt)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', cancelAlt, true)
      window.removeEventListener('blur', cancelAlt)
    }
  }, [])
}
