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

  it('resyncs and rethrows when the bridge rejects', async () => {
    await expect(useFiles.getState().rename('missing', 'x')).rejects.toThrow('File not found')
    expect(useFiles.getState().status).toBe('ready')
  })
})
