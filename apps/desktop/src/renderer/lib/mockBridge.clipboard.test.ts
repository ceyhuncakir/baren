/**
 * The browser mock's `bridge.clipboard` (contract §7.5): the async Clipboard API with the
 * custom format, and the BroadcastChannel stand-in shared by same-origin windows when the
 * API refuses (no permission or focus).
 */
import { describe, expect, it } from 'vitest'
import {
  MOCK_CLIPBOARD_FORMAT,
  createMockClipboard,
  type ChannelLike,
  type ClipboardApiLike,
} from './mockBridge'

/** Records passed to `ClipboardItem` (the test stand-in keeps them). */
type Record_ = Record<string, Blob>

function fakeApi(opts: { failWrite?: boolean; failRead?: boolean } = {}) {
  let items: Record_[] = []
  const api: ClipboardApiLike & { last(): Record_ | undefined } = {
    async write(next) {
      if (opts.failWrite) throw new DOMException('Document is not focused', 'NotAllowedError')
      items = next as unknown as Record_[]
    },
    async read() {
      if (opts.failRead) throw new DOMException('Read permission denied', 'NotAllowedError')
      return items.map((record) => ({
        types: Object.keys(record),
        getType: async (type: string) => record[type] as Blob,
      }))
    },
    last: () => items[0],
  }
  return api
}

const makeItem = (record: Record_) => record as unknown as ClipboardItem

/** BroadcastChannel stand-in: every channel of one hub sees the others' messages. */
function hub() {
  const channels: { listeners: ((e: { data: unknown }) => void)[] }[] = []
  return () => {
    const self = { listeners: [] as ((e: { data: unknown }) => void)[] }
    channels.push(self)
    const channel: ChannelLike = {
      postMessage(message) {
        for (const c of channels) {
          if (c === self) continue
          for (const l of c.listeners) l({ data: structuredClone(message) })
        }
      },
      addEventListener(_type, listener) {
        self.listeners.push(listener)
      },
    }
    return channel
  }
}

describe('mock bridge clipboard', () => {
  it('writes every representation through the Clipboard API, custom format included', async () => {
    const api = fakeApi()
    const clipboard = createMockClipboard({ api, channel: null, makeItem })
    await clipboard.write({ text: 'Hi', html: '<p>Hi</p>', baren: '{"a":1}' })
    expect(Object.keys(api.last() ?? {}).sort()).toEqual(
      ['text/html', 'text/plain', MOCK_CLIPBOARD_FORMAT].sort(),
    )
    expect(await clipboard.read()).toEqual({
      text: 'Hi',
      html: '<p>Hi</p>',
      baren: '{"a":1}',
      svg: null,
      images: [],
    })
  })

  it('falls back to a clipboard shared between windows when the API refuses', async () => {
    const channel = hub()
    const a = createMockClipboard({
      api: fakeApi({ failWrite: true }),
      channel: channel(),
      makeItem,
    })
    const b = createMockClipboard({
      api: fakeApi({ failRead: true }),
      channel: channel(),
      makeItem,
    })
    await a.write({ text: 'from A', baren: '{"kind":"x"}', png: Uint8Array.of(1, 2) })
    const read = await b.read()
    expect(read.text).toBe('from A')
    expect(read.baren).toBe('{"kind":"x"}')
    expect(read.images.map((i) => [i.mime, [...i.bytes]])).toEqual([['image/png', [1, 2]]])
  })

  it('prefers the newest in-memory copy over an older system clipboard', async () => {
    const api = fakeApi()
    const channel = hub()
    const writer = createMockClipboard({ api, channel: channel(), makeItem })
    await writer.write({ text: 'old' })
    const blocked = createMockClipboard({
      api: fakeApi({ failWrite: true }),
      channel: channel(),
      makeItem,
    })
    await blocked.write({ text: 'new' })
    // `writer` reads the system clipboard ("old") unless the latest write never reached it.
    expect((await writer.read()).text).toBe('new')
  })

  it('refuses an empty write and reads nothing from an empty clipboard', async () => {
    const clipboard = createMockClipboard({ api: null, channel: null, makeItem })
    await expect(clipboard.write({})).rejects.toThrow(/Nothing to copy/)
    expect(await clipboard.read()).toEqual({
      text: null,
      html: null,
      baren: null,
      svg: null,
      images: [],
    })
  })
})
