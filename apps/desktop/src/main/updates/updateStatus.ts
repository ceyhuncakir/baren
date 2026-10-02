/**
 * The auto-update state machine (`UpdateStatus`, ARCHITECTURE.md "Auto-update"), as a pure
 * reducer over electron-updater's events:
 *
 *   idle | none | error ──checking──▶ checking ──available──▶ available ──progress──▶ downloading
 *                                        │                        └────────downloaded─────────┐
 *                                        └──not-available──▶ none        downloading ──downloaded──▶ ready
 *   any (but disabled) ──error──▶ error
 *
 * `disabled` is terminal. `ready` ignores later check/progress noise (the downloaded update
 * stays installable) but reports errors (e.g. a failed install).
 */
import type { UpdateState, UpdateStatus } from '../../renderer/types/bridge'

export type { UpdateState, UpdateStatus }

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'not-available' }
  | { type: 'error'; message: string }

export const IDLE: UpdateStatus = Object.freeze({ state: 'idle' })
export const DISABLED: UpdateStatus = Object.freeze({ state: 'disabled' })

/** States in which a new check would be redundant (one is running, or an update is pending). */
const BUSY: ReadonlySet<UpdateState> = new Set(['checking', 'available', 'downloading', 'ready'])

/** States a check ends in. */
const SETTLED: ReadonlySet<UpdateState> = new Set(['ready', 'none', 'error', 'disabled'])

export function isBusy(status: UpdateStatus): boolean {
  return BUSY.has(status.state)
}

export function isSettled(status: UpdateStatus): boolean {
  return SETTLED.has(status.state)
}

const MAX_ERROR_LENGTH = 300

/** One readable line from an updater error (electron-updater messages can embed stacks/bodies). */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw.split('\n').find((l) => l.trim() !== '') ?? 'Unknown error'
  const trimmed = line.trim()
  return trimmed.length > MAX_ERROR_LENGTH ? `${trimmed.slice(0, MAX_ERROR_LENGTH - 1)}…` : trimmed
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.floor(percent)))
}

function withVersion(status: UpdateStatus, version: string | undefined): UpdateStatus {
  return version === undefined ? status : { ...status, version }
}

export function nextStatus(current: UpdateStatus, event: UpdaterEvent): UpdateStatus {
  if (current.state === 'disabled') return current
  if (current.state === 'ready' && event.type !== 'downloaded' && event.type !== 'error') {
    return current
  }
  switch (event.type) {
    case 'checking':
      return { state: 'checking' }
    case 'available':
      return { state: 'available', version: event.version }
    case 'progress':
      return withVersion(
        { state: 'downloading', progress: clampPercent(event.percent) },
        current.version,
      )
    case 'downloaded':
      return { state: 'ready', version: event.version }
    case 'not-available':
      return { state: 'none' }
    case 'error':
      return withVersion({ state: 'error', error: event.message }, current.version)
  }
}

export function sameStatus(a: UpdateStatus, b: UpdateStatus): boolean {
  return (
    a.state === b.state &&
    a.version === b.version &&
    a.progress === b.progress &&
    a.error === b.error
  )
}
