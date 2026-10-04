import { describe, expect, it, vi } from 'vitest'
import { bridge } from '../lib/bridge'
import {
  loadThumbnail,
  onThumbnailChanged,
  peekThumbnail,
  thumbnailChanged,
} from './thumbnailCache'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('thumbnail cache', () => {
  it('reloads a thumbnail written after the card asked for it (same file version)', async () => {
    const file = await bridge.files.create('Preview')
    const version = file.updatedAt
    // The card asks before the editor has written the thumbnail: none, cached.
    expect(await loadThumbnail(file.id, version)).toBeNull()
    await bridge.files.setThumbnail(file.id, PNG)
    expect(await loadThumbnail(file.id, version)).toBeNull()

    // The writer says so: cards are told, and the next load fetches it.
    const told = vi.fn()
    const off = onThumbnailChanged(told)
    thumbnailChanged(file.id)
    off()
    expect(told).toHaveBeenCalledWith(file.id)
    expect(peekThumbnail(file.id, version)).toBeUndefined()
    const url = await loadThumbnail(file.id, version)
    expect(url).toMatch(/^blob:/)
    expect(peekThumbnail(file.id, version)).toBe(url)
  })

  it('does not cache a load that started before a rewrite', async () => {
    const file = await bridge.files.create('Race')
    const stale = loadThumbnail(file.id, file.updatedAt)
    await bridge.files.setThumbnail(file.id, PNG)
    thumbnailChanged(file.id)
    expect(await stale).toBeNull()
    expect(peekThumbnail(file.id, file.updatedAt)).toBeUndefined()
    expect(await loadThumbnail(file.id, file.updatedAt)).toMatch(/^blob:/)
  })
})
