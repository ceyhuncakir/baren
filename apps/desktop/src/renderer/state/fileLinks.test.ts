import { createEmptyDoc, exportSnapshot } from '@baren/schema'
import type { RemoteFile } from '@baren/sync-client/api'
import { describe, expect, it, vi } from 'vitest'
import { createMockBridge } from '../lib/mockBridge'
import { linkedLocalFile, localFileFor, onReveal, requestReveal } from './fileLinks'
import type { TeamFilesDeps } from './teamFiles'

function remoteFile(id: string, teamId: string, name: string): RemoteFile {
  return { id, teamId, name, archived: false, createdAt: 1, updatedAt: 1, createdBy: null }
}

/** Team t1 has file r1 on the server. */
function fakeApi(): TeamFilesDeps['api'] {
  const reject = () => Promise.reject(new Error('not used'))
  return {
    files: {
      list: async (teamId) => (teamId === 't1' ? [remoteFile('r1', 't1', 'Landing page')] : []),
      snapshot: async () => exportSnapshot(createEmptyDoc('Landing page')),
      create: reject,
      update: reject,
      remove: reject,
    },
  }
}

describe('localFileFor', () => {
  it('pulls a team file this machine does not have, then finds the local copy', async () => {
    const bridge = createMockBridge()
    const deps = { api: fakeApi(), files: bridge.files }
    const id = await localFileFor('r1', [{ id: 't1' }], deps)
    expect(id).not.toBeNull()
    const local = (await bridge.files.list()).find((f) => f.id === id)
    expect(local).toMatchObject({ name: 'Landing page', remoteId: 'r1', teamId: 't1' })
    // Already here: the same copy, no second import.
    expect(await localFileFor('r1', [{ id: 't1' }], deps)).toBe(id)
    expect((await bridge.files.list()).filter((f) => f.remoteId === 'r1')).toHaveLength(1)
  })

  it('finds a local file by its own id (MCP links) before any team file id, signed out too', async () => {
    const bridge = createMockBridge()
    const local = await bridge.files.create('Sketches')
    const deps = { api: fakeApi(), files: bridge.files }
    expect(await linkedLocalFile(local.id, bridge.files)).toBe(local.id)
    // No teams (signed out): a local file still resolves, without pulling anything.
    expect(await localFileFor(local.id, [], deps)).toBe(local.id)
    // A team file's server id resolves to its local copy.
    const pulled = await localFileFor('r1', [{ id: 't1' }], deps)
    expect(await linkedLocalFile('r1', bridge.files)).toBe(pulled)
    expect(await linkedLocalFile('nowhere', bridge.files)).toBeNull()
  })

  it('is null for a file none of the teams has', async () => {
    const bridge = createMockBridge()
    const deps = { api: fakeApi(), files: bridge.files }
    expect(await localFileFor('elsewhere', [{ id: 't1' }], deps)).toBeNull()
    // Without teams there is nothing to pull from.
    const fresh = createMockBridge()
    expect(await localFileFor('r1', [], { api: fakeApi(), files: fresh.files })).toBeNull()
  })
})

describe('layer links', () => {
  it('waits for the file to open, or goes straight to an open one', () => {
    const early = vi.fn()
    requestReveal('f1', '47@1076')
    const off = onReveal('f1', early)
    expect(early).toHaveBeenCalledWith('47@1076')

    requestReveal('f1', '12@9')
    expect(early).toHaveBeenLastCalledWith('12@9')

    // Another file's link waits for that file; a closed editor gets nothing.
    off()
    requestReveal('f1', '3@3')
    expect(early).toHaveBeenCalledTimes(2)
    const later = vi.fn()
    onReveal('f2', later)
    expect(later).not.toHaveBeenCalled()
  })
})
