/**
 * Object URLs for file thumbnails (bridge.files.getThumbnail → PNG bytes). Cards in the
 * virtualized grid mount and unmount while scrolling, so URLs are cached by file id and
 * version (updatedAt); concurrent requests share one bridge call. Least recently used
 * entries are revoked past the cap.
 *
 * A thumbnail is written after its file's last save (when edits settle, on close, or when a
 * team file is pulled), so the version alone would keep a stale "no thumbnail" cached: the
 * writer calls `thumbnailChanged`, and the cards showing that file reload it.
 */
import { bridge } from '../lib/bridge'

const CAP = 300

interface Entry {
  version: number
  url: string | null
}

const entries = new Map<string, Entry>()
const pending = new Map<string, Promise<string | null>>()
/** Bumped by `thumbnailChanged`: a load started before a rewrite is not cached. */
const generations = new Map<string, number>()
const listeners = new Set<(id: string) => void>()

/** `id`'s thumbnail was rewritten: forget the cached one; cards showing it reload. */
export function thumbnailChanged(id: string): void {
  generations.set(id, (generations.get(id) ?? 0) + 1)
  const entry = entries.get(id)
  // NaN never matches a version: the next load replaces (and revokes) the old URL.
  if (entry) entries.set(id, { version: Number.NaN, url: entry.url })
  for (const listener of [...listeners]) listener(id)
}

/** Called with a file id whenever its thumbnail is rewritten. */
export function onThumbnailChanged(listener: (id: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function touch(id: string, entry: Entry): void {
  entries.delete(id)
  entries.set(id, entry)
  while (entries.size > CAP) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    const evicted = entries.get(oldest)
    entries.delete(oldest)
    if (evicted?.url) URL.revokeObjectURL(evicted.url)
  }
}

/** Cached URL for this version, `null` for "no thumbnail", `undefined` when not loaded. */
export function peekThumbnail(id: string, version: number): string | null | undefined {
  const entry = entries.get(id)
  return entry && entry.version === version ? entry.url : undefined
}

export function loadThumbnail(id: string, version: number): Promise<string | null> {
  const cached = peekThumbnail(id, version)
  if (cached !== undefined) return Promise.resolve(cached)
  const generation = generations.get(id) ?? 0
  const key = `${id}@${version}#${generation}`
  let request = pending.get(key)
  if (!request) {
    request = bridge.files
      .getThumbnail(id)
      .then((bytes) =>
        bytes && bytes.byteLength > 0
          ? URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
          : null,
      )
      .catch(() => null)
      .then((url) => {
        if ((generations.get(id) ?? 0) !== generation) {
          // Rewritten while loading: this one may be stale, and a fresh load follows.
          if (url) URL.revokeObjectURL(url)
          return null
        }
        const previous = entries.get(id)
        if (previous?.url && previous.url !== url) URL.revokeObjectURL(previous.url)
        touch(id, { version, url })
        return url
      })
      .finally(() => pending.delete(key))
    pending.set(key, request)
  }
  return request
}
