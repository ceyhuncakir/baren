/**
 * Small, failure-tolerant wrapper around localStorage for UI preferences (last route,
 * recents order, view mode, dismissed cards). Never used for secrets: the session token
 * lives in the bridge (safeStorage).
 *
 * In design-fixture mode everything stays in memory so fixture renders are deterministic.
 */
import { isDesignFixture } from './fixture'

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createMemoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

function pickStore(): KeyValueStore {
  if (isDesignFixture || typeof window === 'undefined') return createMemoryStore()
  try {
    const probe = '__baren_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return createMemoryStore()
  }
}

const store: KeyValueStore = pickStore()

const PREFIX = 'baren.'

export function readString(key: string): string | null {
  try {
    return store.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function writeString(key: string, value: string | null): void {
  try {
    if (value === null) store.removeItem(PREFIX + key)
    else store.setItem(PREFIX + key, value)
  } catch {
    // Quota or privacy mode: preferences are best effort.
  }
}

/** Reads JSON and validates its shape; anything unexpected reads as null. */
export function readJson<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  const raw = readString(key)
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    return isValid(value) ? value : null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown): void {
  writeString(key, value === null || value === undefined ? null : JSON.stringify(value))
}

export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
