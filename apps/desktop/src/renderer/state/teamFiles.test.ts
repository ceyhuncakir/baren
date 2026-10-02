import { createEmptyDoc, exportSnapshot, loadDoc, toSnapshot } from '@baren/schema'
import type { RemoteFile } from '@baren/sync-client/api'
import { describe, expect, it } from 'vitest'
import { createMockBridge } from '../lib/mockBridge'
import { pullTeamFiles, type TeamFilesDeps } from './teamFiles'

function remoteFile(id: string, teamId: string, name: string, archived = false): RemoteFile {
  return { id, teamId, name, archived, createdAt: 1, updatedAt: 1, createdBy: null }
}

function fakeApi(
  byTeam: Record<string, RemoteFile[]>,
  snapshots: Record<string, Uint8Array>,
): TeamFilesDeps['api'] & { downloads: string[] } {
  const downloads: string[] = []
  const reject = () => Promise.reject(new Error('not used'))
  return {
    downloads,
    files: {
      list: async (teamId) => {
        const files = byTeam[teamId]
        if (!files) throw new Error('forbidden')
        return files
      },
      snapshot: async (fileId) => {
        downloads.push(fileId)
        const bytes = snapshots[fileId]
        if (!bytes) throw new Error('gone')
        return bytes
      },
      create: reject,
      update: reject,
      remove: reject,
    },
  }
}

describe('pullTeamFiles', () => {
  it('imports missing team files once, linked to their server file', async () => {
    const bridge = createMockBridge()
    const api = fakeApi(
      {
        t1: [
          remoteFile('r1', 't1', 'Landing page'),
          remoteFile('r2', 't1', 'Old', true),
          remoteFile('r3', 't1', 'Broken'),
        ],
        t2: [remoteFile('r4', 't2', 'Icons')],
      },
      {
        r1: exportSnapshot(createEmptyDoc('Landing page')),
        r4: exportSnapshot(createEmptyDoc('Icons')),
      },
    )
    const deps = { api, files: bridge.files }

    const first = await pullTeamFiles([{ id: 't1' }, { id: 't2' }, { id: 'gone' }], deps)
    expect(first.added.map((f) => [f.name, f.teamId, f.remoteId])).toEqual([
      ['Landing page', 't1', 'r1'],
      ['Icons', 't2', 'r4'],
    ])
    // r3 has no snapshot and team "gone" cannot be listed: both retried next time.
    expect(first.failed).toBe(2)
    expect(api.downloads).not.toContain('r2')

    const local = await bridge.files.list()
    const landing = local.find((f) => f.remoteId === 'r1')
    expect(landing).toMatchObject({ teamId: 't1', name: 'Landing page' })
    expect(toSnapshot(loadDoc(await bridge.files.open(landing!.id))).name).toBe('Landing page')

    api.downloads.length = 0
    const second = await pullTeamFiles([{ id: 't1' }, { id: 't2' }], deps)
    expect(second.added).toEqual([])
    expect(api.downloads).toEqual(['r3'])
  })
})
