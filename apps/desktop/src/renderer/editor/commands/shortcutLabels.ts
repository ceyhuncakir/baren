/**
 * Shortcut labels as the menus write them ("Ctrl+Shift+L" on Linux/Windows, "⇧⌘L" on macOS).
 * Shortcuts are written canonically with `Mod` = Ctrl (⌘ on macOS).
 */

const MAC_SYMBOL: Record<string, string> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
}

/** OS of this window (the same value the bridge reports as `platform`). */
export function currentPlatform(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Mac|iPhone|iPad/.test(ua)) return 'darwin'
  if (/Windows/.test(ua)) return 'win32'
  return 'linux'
}

export function formatShortcut(shortcut: string, platform: string = currentPlatform()): string {
  // Written as "Mod+=" / "Mod+-": a literal "+" key never occurs.
  const parts = shortcut.split('+')
  if (platform !== 'darwin') return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+')
  const order = ['Ctrl', 'Alt', 'Shift', 'Mod']
  const mods = parts.slice(0, -1).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const key = parts[parts.length - 1] ?? ''
  return mods.map((m) => MAC_SYMBOL[m] ?? m).join('') + (key === 'Delete' ? '⌫' : key)
}
