/**
 * App-level keyboard shortcuts on Linux/Windows, where there is no native menu
 * to own accelerators (the HTML menus in artboards 09–12 only display
 * them). Handled in main via `before-input-event` so they work whatever has
 * focus in the page, and never reach the page (no double handling).
 * macOS gets the same actions from its native menu instead.
 */
export type AppShortcut =
  | 'newWindow'
  | 'quit'
  | 'reload'
  | 'forceReload'
  | 'toggleDevTools'
  | 'toggleFullScreen'
  | 'minimize'
  | 'closeWindow'

/** Structural subset of Electron's `Input` (before-input-event). */
export interface KeyInput {
  type: string
  key: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  isAutoRepeat?: boolean
}

export function matchAppShortcut(input: KeyInput): AppShortcut | null {
  if (input.type !== 'keyDown' || input.alt || input.meta || input.isAutoRepeat) return null
  const key = input.key.toLowerCase()
  if (key === 'f11' && !input.control && !input.shift) return 'toggleFullScreen'
  if (!input.control) return null
  if (input.shift) {
    if (key === 'n') return 'newWindow'
    if (key === 'r') return 'forceReload'
    if (key === 'i') return 'toggleDevTools'
    return null
  }
  if (key === 'q') return 'quit'
  if (key === 'r') return 'reload'
  if (key === 'm') return 'minimize'
  if (key === 'w') return 'closeWindow'
  return null
}
