/**
 * Window title shown centered in the title bar ("Recents", "Team › Members", the file name).
 * The shell derives it from the route; a screen (the editor, after a rename) can override it
 * with useWindowTitle(). document.title follows.
 */
import { useEffect, useSyncExternalStore } from 'react'

let override: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function setWindowTitleOverride(title: string | null): void {
  if (override === title) return
  override = title
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getOverride = () => override

export function useWindowTitleOverride(): string | null {
  return useSyncExternalStore(subscribe, getOverride, getOverride)
}

/** Overrides the title bar text while the calling component is mounted. */
export function useWindowTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return
    setWindowTitleOverride(title)
    return () => setWindowTitleOverride(null)
  }, [title])
}
