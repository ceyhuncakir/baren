/** `files.onChanged` (an MCP agent created a file) reloads a loaded file list. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listeners: (() => void)[] = []
const list = vi.fn(async () => [] as unknown[])

vi.mock('../lib/bridge', () => ({
  isMockBridge: false,
  bridge: {
    files: {
      list,
      onChanged(cb: () => void) {
        listeners.push(cb)
        return () => undefined
      },
    },
  },
}))

describe('files store: files.onChanged', () => {
  beforeEach(() => {
    list.mockClear()
  })

  it('subscribes once and reloads only after the list was loaded', async () => {
    const { useFiles } = await import('./files')
    expect(listeners).toHaveLength(1)
    listeners[0]?.()
    expect(list).not.toHaveBeenCalled()
    await useFiles.getState().load()
    expect(list).toHaveBeenCalledTimes(1)
    listeners[0]?.()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })
})
