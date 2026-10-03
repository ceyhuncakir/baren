import { loadDoc, toSnapshot } from '@baren/schema'
import type { RemoteFile, Team } from '@baren/sync-client/api'
import { describe, expect, it } from 'vitest'
import { createMockBridge } from '../lib/mockBridge'
import type { FileMeta } from '../types/bridge'
import {
  autoShareTeam,
  filesToShare,
  shareLocalFiles,
  shareOnce,
  type ShareLocalDeps,
} from './autoShare'

function team(id: string, role: Team['role']): Team {
  return { id, name: id, role, fileAccess: 'members', memberCount: 2, createdAt: 1 }
}

function meta(id: string, name: string, extra: Partial<FileMeta> = {}): FileMeta {
  return { id, name, createdAt: 1, updatedAt: 1, archived: false, ...extra } as FileMeta
}

/** Files API that records uploads; names in `failing` are refused once. */
function fakeApi(failing: string[] = []): ShareLocalDeps['api'] & {
  created: { teamId: string; name: string; snapshot: Uint8Array | undefined }[]
} {
  const created: { teamId: string; name: string; snapshot: Uint8Array | undefined }[] = []
  const refuse = new Set(failing)
  const reject = () => Promise.reject(new Error('not used'))
  return {
    created,
    files: {
      create: async (teamId, req) => {
        if (refuse.delete(req.name)) throw new Error('server down')
        created.push({ teamId, name: req.name, snapshot: req.snapshot })
        const file: RemoteFile = {
          id: `r-${req.name}`,
          teamId,
          name: req.name,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
          createdBy: null,
        }
        return file
      },
      list: reject,
      snapshot: reject,
      update: reject,
      remove: reject,
    },
  }
}

describe('autoShareTeam', () => {
  it('is the current team, unless the user may only view it', () => {
    const teams = [team('a', 'admin'), team('b', 'editor'), team('c', 'viewer')]
    expect(autoShareTeam(teams, 'b')?.id).toBe('b')
    expect(autoShareTeam(teams, 'c')).toBeNull()
    expect(autoShareTeam(teams, 'gone')).toBeNull()
    expect(autoShareTeam(teams, null)).toBeNull()
  })
})

describe('filesToShare', () => {
  it('skips shared and archived files and the Scratchpad', () => {
    const files = [
      meta('f1', 'Landing page'),
      meta('f2', 'Shared', { teamId: 't', remoteId: 'r' }),
      meta('f3', 'Old', { archived: true }),
      meta('f4', 'Scratchpad'),
      meta('f5', 'Notes'),
    ]
    expect(filesToShare(files, null).map((f) => f.id)).toEqual(['f1', 'f5'])
    // The remembered Scratchpad wins over the name.
    expect(filesToShare(files, 'f5').map((f) => f.id)).toEqual(['f1', 'f4'])
  })
})

describe('shareLocalFiles', () => {
  it('uploads each local file once, with its snapshot and images', async () => {
    const bridge = createMockBridge()
    const landing = await bridge.files.create('Landing page')
    await bridge.files.create('Scratchpad')
    const old = await bridge.files.create('Old')
    await bridge.files.archive(old.id, true)
    const api = fakeApi(['Broken'])
    const broken = await bridge.files.create('Broken')
    const assets: string[] = []
    const deps: ShareLocalDeps = {
      api,
      files: bridge.files,
      uploadAssets: async (remoteId) => void assets.push(remoteId),
    }

    const first = await shareLocalFiles('t1', null, deps)
    expect(first).toEqual({ shared: 1, failed: 1 })
    expect(api.created.map((c) => [c.teamId, c.name])).toEqual([['t1', 'Landing page']])
    expect(toSnapshot(loadDoc(api.created[0]!.snapshot!)).name).toBe('Landing page')
    expect(assets).toEqual(['r-Landing page'])
    const local = await bridge.files.list()
    expect(local.find((f) => f.id === landing.id)).toMatchObject({
      teamId: 't1',
      remoteId: 'r-Landing page',
    })

    // The refused file is retried; nothing is uploaded twice.
    const second = await shareLocalFiles('t1', null, deps)
    expect(second).toEqual({ shared: 1, failed: 0 })
    expect(api.created.map((c) => c.name)).toEqual(['Landing page', 'Broken'])
    expect((await bridge.files.list()).find((f) => f.id === broken.id)?.remoteId).toBe('r-Broken')
    expect(await shareLocalFiles('t1', null, deps)).toEqual({ shared: 0, failed: 0 })
  })
})

describe('shareOnce', () => {
  it('runs one upload per file, even when asked twice at once', async () => {
    let uploads = 0
    const upload = async () => {
      uploads++
      await new Promise((r) => setTimeout(r, 5))
      return { teamId: 't1', remoteId: 'r-once' }
    }
    const [a, b] = await Promise.all([shareOnce('once', upload), shareOnce('once', upload)])
    expect(a).toEqual({ teamId: 't1', remoteId: 'r-once' })
    expect(b).toEqual(a)
    expect(await shareOnce('once', upload)).toEqual(a)
    expect(uploads).toBe(1)
  })
})
