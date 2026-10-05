/**
 * Version history, the pure parts: how a version is labelled, how the panel groups versions
 * (named versions, then automatic checkpoints by day) and when opening a file records a
 * checkpoint. The schema side is `@baren/schema` versions.
 */
import {
  changedSinceVersion,
  getChildIds,
  getVersions,
  type DocVersion,
  type VersionReason,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

/** Origins of version-list commits: design undo excludes them (CanvasArea's UNDO_EXCLUDE). */
export const VERSION_ORIGIN_PREFIX = 'version:'
/** The restore itself: an ordinary, undoable design change. */
export const RESTORE_ORIGIN = 'editor:restore'

/** What the panel shows as a version's title. */
export function versionLabel(v: Pick<DocVersion, 'name' | 'reason' | 'author'>): string {
  if (v.name !== '') return v.name
  return autoLabel(v.reason, v.author.name)
}

function autoLabel(reason: VersionReason, author: string): string {
  switch (reason) {
    case 'agent':
      return `Before ${author}'s edits`
    case 'restore':
      return 'Before a restore'
    case 'session':
      return `Opened by ${author}`
    default:
      return 'Autosave'
  }
}

/** The title of a checkpoint taken before restoring `v`. */
export function beforeRestoreName(v: Pick<DocVersion, 'name' | 'reason' | 'author'>): string {
  return `Before restoring “${versionLabel(v)}”`
}

/** The title of a checkpoint taken before an agent's writes. */
export function beforeAgentName(agent: string): string {
  return `Before ${agent}'s edits`
}

export interface VersionGroup {
  key: string
  title: string
  versions: DocVersion[]
}

function dayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today", "Yesterday", or a date ("Oct 2", with the year when it is not this year). */
export function dayTitle(ms: number, now: number): string {
  const day = dayStart(ms)
  const today = dayStart(now)
  if (day === today) return 'Today'
  if (day === today - 86_400_000 || today - day === 86_400_000) return 'Yesterday'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Named versions first (newest first), then automatic checkpoints grouped by day. */
export function groupVersions(versions: readonly DocVersion[], now: number): VersionGroup[] {
  const sorted = [...versions].sort((a, b) => b.createdAt - a.createdAt)
  const named = sorted.filter((v) => !v.auto)
  const groups: VersionGroup[] = []
  if (named.length > 0) groups.push({ key: 'named', title: 'Named versions', versions: named })
  for (const v of sorted) {
    if (!v.auto) continue
    const key = `day:${dayStart(v.createdAt)}`
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = { key, title: dayTitle(v.createdAt, now), versions: [] }
      groups.push(group)
    }
    group.versions.push(v)
  }
  return groups
}

/** A clock time for a row ("14:05"), with the date when it is not today. */
export function versionTime(ms: number, now: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return dayStart(ms) === dayStart(now) ? time : `${dayTitle(ms, now)}, ${time}`
}

/**
 * Opening a file records a checkpoint when its design changed since the newest version, or when
 * it has none yet and is not empty (a new, empty file gets none).
 */
export function shouldCheckpointOnOpen(doc: LoroDoc): boolean {
  const latest = getVersions(doc)[0]
  if (latest) return changedSinceVersion(doc, latest)
  return getChildIds(doc, null).some((page) => getChildIds(doc, page).length > 0)
}
