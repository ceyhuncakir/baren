import { beforeEach, describe, expect, it } from 'vitest'
import { bridge } from '../lib/bridge'
import { useFiles } from './files'

describe('files store (browser mock with the design files)', () => {
  beforeEach(async () => {
    await useFiles.getState().load()
  })

  it('loads the artboard-01 files and finds the scratchpad', () => {
    const s = useFiles.getState()
    expect(s.status).toBe('ready')
    expect(s.files.map((f) => f.name)).toContain('acme dashboard')
    expect(s.scratchpadId).toBe('f-scratchpad')
    expect(s.mru[0]).toBe('f-baren')
  })

  it('creates, renames, archives and removes optimistically', async () => {
    const store = useFiles.getState()
    const meta = await store.create('Draft')
    expect(useFiles.getState().byId(meta.id)?.name).toBe('Draft')
    await store.rename(meta.id, '  Final  ')
    expect(useFiles.getState().byId(meta.id)?.name).toBe('Final')
    await store.setArchived(meta.id, true)
    expect((await bridge.files.list()).find((f) => f.id === meta.id)?.archived).toBe(true)
    store.markOpened(meta.id)
    expect(useFiles.getState().mru[0]).toBe(meta.id)
    await store.remove(meta.id)
    expect(useFiles.getState().byId(meta.id)).toBeUndefined()
    expect(useFiles.getState().mru).not.toContain(meta.id)
  })

  it('a load asked for while one runs gets a list taken after the call', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const list = bridge.files.list
    // The running load lists the files, then takes a while to come back.
    bridge.files.list = async () => {
      const files = await list()
      await gate
      return files
    }
    try {
      const running = useFiles.getState().load()
      const meta = await bridge.files.create('Pulled')
      const mine = useFiles.getState().load()
      release()
      await mine
      expect(useFiles.getState().byId(meta.id)?.name).toBe('Pulled')
      await running
      await useFiles.getState().remove(meta.id)
    } finally {
      bridge.files.list = list
    }
  })

  it('resyncs and rethrows when the bridge rejects', async () => {
    await expect(useFiles.getState().rename('missing', 'x')).rejects.toThrow('File not found')
    expect(useFiles.getState().status).toBe('ready')
  })
})
