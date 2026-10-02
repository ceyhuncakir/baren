/**
 * Relative timestamps as written in the artboards: "just now", "4 minutes ago",
 * "2 hours ago", "28 days ago". Never switches to months, so days run up to a year.
 */
import { useSyncExternalStore } from 'react'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const YEAR = 365 * DAY

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

export function formatRelative(then: number, now: number): string {
  const diff = Math.max(0, now - then)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), 'minute')
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour')
  if (diff < YEAR) return plural(Math.floor(diff / DAY), 'day')
  return plural(Math.floor(diff / YEAR), 'year')
}

/** "Edited 4 minutes ago" (file cards, 01). */
export function formatEdited(updatedAt: number, now: number): string {
  return `Edited ${formatRelative(updatedAt, now)}`
}

/** "Mar 4, 2026" — absolute dates for the list view. */
export function formatDate(at: number): string {
  return new Date(at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/* ---- One shared ticker for every relative label (one timer, not one per card) ---- */

const TICK_MS = 30_000
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

const getNow = () => now

/** Current time, refreshed every 30 s for every subscriber at once. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow)
}
