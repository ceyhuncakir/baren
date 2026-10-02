/**
 * Object URLs for file thumbnails (bridge.files.getThumbnail → PNG bytes). Cards in the
 * virtualized grid mount and unmount while scrolling, so URLs are cached by file id and
 * version (updatedAt); concurrent requests share one bridge call. Least recently used
 * entries are revoked past the cap.
 */
import { bridge } from '../lib/bridge'

const CAP = 300

interface Entry {
  version: number
  url: string | null
}

const entries = new Map<string, Entry>()
const pending = new Map<string, Promise<string | null>>()

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
  const key = `${id}@${version}`
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
