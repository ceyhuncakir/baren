import { describe, expect, it } from 'vitest'
import {
  BAREN_CLIPBOARD_FORMAT,
  clipboardRecord,
  createClipboardService,
  type ClipboardItemLike,
  type ClipboardLike,
} from './clipboard'

/** In-memory stand-in for Electron's main-process clipboard (items keep their record). */
function fakeClipboard() {
  let items: ClipboardItemLike[] = []
  const writes: Record<string, string | Blob>[] = []
  const clipboard: ClipboardLike = {
    write: async (next) => {
      items = next
    },
    read: async () => items,
  }
  const makeItem = (record: Record<string, string | Blob>): ClipboardItemLike => {
    writes.push(record)
    return {
      types: Object.keys(record),
      getType: async (type) => {
        const v = record[type]
        if (v === undefined) throw new Error(`no ${type}`)
        return typeof v === 'string' ? new Blob([v], { type }) : v
      },
    }
  }
  return {
    clipboard,
    makeItem,
    writes,
    set(next: ClipboardItemLike[]) {
      items = next
    },
  }
}

describe('main-process clipboard', () => {
  it('writes ONE item with every given representation (custom format typed as itself)', async () => {
    const fake = fakeClipboard()
    const service = createClipboardService(fake.clipboard, fake.makeItem)
    await service.write({ text: 'Hello', html: '<p>Hello</p>', baren: '{"kind":1}' })
    expect(fake.writes).toHaveLength(1)
    const record = fake.writes[0] as Record<string, string | Blob>
    expect(Object.keys(record).sort()).toEqual(
      ['text/html', 'text/plain', BAREN_CLIPBOARD_FORMAT].sort(),
    )
    expect(record[BAREN_CLIPBOARD_FORMAT]).toBeInstanceOf(Blob)
    expect((record[BAREN_CLIPBOARD_FORMAT] as Blob).type).toBe('application/x-baren-clipboard+json')
    const read = await service.read()
    expect(read).toMatchObject({ text: 'Hello', html: '<p>Hello</p>', baren: '{"kind":1}' })
    expect(read.images).toEqual([])
  })

  it('round-trips a PNG and refuses an empty write', async () => {
    const fake = fakeClipboard()
    const service = createClipboardService(fake.clipboard, fake.makeItem)
    await service.write({ png: Uint8Array.of(137, 80, 78, 71) })
    const read = await service.read()
    expect(read.images).toHaveLength(1)
    expect(read.images[0]?.mime).toBe('image/png')
    expect([...(read.images[0]?.bytes ?? [])]).toEqual([137, 80, 78, 71])
    await expect(service.write({})).rejects.toThrow(/Nothing to copy/)
  })

  it('reads what other apps put there: svg, raster images, several items', async () => {
    const fake = fakeClipboard()
    const service = createClipboardService(fake.clipboard, fake.makeItem)
    fake.set([
      fake.makeItem({ 'text/plain': '<svg/>', 'image/svg+xml': new Blob(['<svg/>']) }),
      fake.makeItem({ 'image/jpeg': new Blob([Uint8Array.of(255, 216)]) }),
      fake.makeItem({ 'image/webp': new Blob([Uint8Array.of(1)]), 'text/html': '<b>x</b>' }),
    ])
    const read = await service.read()
    expect(read.svg).toBe('<svg/>')
    expect(read.text).toBe('<svg/>')
    expect(read.html).toBe('<b>x</b>')
    expect(read.baren).toBeNull()
    expect(read.images.map((i) => i.mime)).toEqual(['image/jpeg', 'image/webp'])
  })

  it('leaves absent fields out of the record', () => {
    expect(Object.keys(clipboardRecord({ text: '' }))).toEqual(['text/plain'])
    expect(Object.keys(clipboardRecord({}))).toEqual([])
  })
})
