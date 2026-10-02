/**
 * Pure selection/ordering for the home file views (unit-tested):
 *  - Recents: recently *opened* first (the design's order is not by edit time), then the
 *    rest by edit time. The Scratchpad is pinned in front of everything.
 *  - Files: every non-archived file, most recently edited first.
 *  - Archive: archived files, most recently edited first.
 */
import type { FileMeta } from '../types/bridge'

export type FileView = 'recents' | 'files' | 'archive'

export const SCRATCHPAD_NAME = 'Scratchpad'

/** Most recently opened ids first; at most this many are remembered. */
export const MAX_RECENTS = 200

export function touchRecent(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)].slice(0, MAX_RECENTS)
}

/** The scratchpad: the remembered id if it still exists, else the oldest file named "Scratchpad". */
export function findScratchpad(
  files: readonly FileMeta[],
  rememberedId: string | null,
): FileMeta | null {
  if (rememberedId) {
    const hit = files.find((f) => f.id === rememberedId && !f.archived)
    if (hit) return hit
  }
  let best: FileMeta | null = null
  for (const f of files) {
    if (f.archived || f.name !== SCRATCHPAD_NAME) continue
    if (!best || f.createdAt < best.createdAt) best = f
  }
  return best
}

function byEditedDesc(a: FileMeta, b: FileMeta): number {
  return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)
}

export function orderByRecency(files: readonly FileMeta[], mru: readonly string[]): FileMeta[] {
  const rank = new Map<string, number>()
  mru.forEach((id, i) => rank.set(id, i))
  return [...files].sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return byEditedDesc(a, b)
  })
}

export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  return q === '' || name.toLocaleLowerCase().includes(q)
}

export interface ViewSelection {
  /**
   * Scratchpad card state: the file, `'missing'` (show a card that creates it on open), or
   * null (not shown in this view or filtered out).
   */
  scratchpad: FileMeta | 'missing' | null
  items: FileMeta[]
}

export function selectView(
  files: readonly FileMeta[],
  view: FileView,
  options: { mru: readonly string[]; scratchpadId: string | null; query: string },
): ViewSelection {
  const { mru, scratchpadId, query } = options
  if (view === 'archive') {
    return {
      scratchpad: null,
      items: files.filter((f) => f.archived && matchesQuery(f.name, query)).sort(byEditedDesc),
    }
  }
  const pad = findScratchpad(files, scratchpadId)
  const rest = files.filter((f) => !f.archived && f.id !== pad?.id && matchesQuery(f.name, query))
  const items = view === 'recents' ? orderByRecency(rest, mru) : rest.sort(byEditedDesc)
  const padVisible = matchesQuery(pad?.name ?? SCRATCHPAD_NAME, query)
  return { scratchpad: padVisible ? (pad ?? 'missing') : null, items }
}

/** Columns of the auto-fill grid (minmax(240px, 1fr), 20px gap) for a content width. */
export function gridColumns(width: number, minCard = 240, gap = 20): number {
  return Math.max(1, Math.floor((width + gap) / (minCard + gap)))
}
