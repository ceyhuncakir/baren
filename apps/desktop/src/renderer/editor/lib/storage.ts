/**
 * Small, failure-tolerant localStorage helpers for per-file editor preferences
 * (expanded layers, viewport, panel state). Storage may be unavailable or full;
 * every call degrades to "nothing stored".
 */

const PREFIX = 'baren.editor.'

export function readPref<T>(key: string, guard: (value: unknown) => value is T): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    if (raw === null) return null
    const value: unknown = JSON.parse(raw)
    return guard(value) ? value : null
  } catch {
    return null
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(PREFIX + key)
    else window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Quota exceeded or storage disabled: preferences are best effort.
  }
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
