import { describe, expect, it, vi } from 'vitest'
import { createNode, getChildIds, loadDoc, toSnapshot } from '@baren/schema'
import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createMockBridge } from './mockBridge'

describe('mock bridge', () => {
  it('creates, lists, renames, archives and removes files', async () => {
    let t = 1000
    const bridge = createMockBridge({ now: () => t++, files: [{ name: 'Seed', id: 'seed' }] })
    const created = await bridge.files.create('Untitled')
    expect(created).toMatchObject({
      name: 'Untitled',
      archived: false,
      teamId: null,
      remoteId: null,
    })
    expect((await bridge.files.list()).map((f) => f.name)).toEqual(['Untitled', 'Seed'])
    await bridge.files.rename('seed', 'Renamed')
    await bridge.files.archive(created.id, true)
    // Most recently updated first: the archive happened after the rename.
    const list = await bridge.files.list()
    expect(list[0]).toMatchObject({ id: created.id, archived: true })
    expect(list[1]).toMatchObject({ id: 'seed', name: 'Renamed' })
    await bridge.files.remove('seed')
    await expect(bridge.files.remove('seed')).rejects.toThrow('File not found')
    await expect(bridge.files.open('missing')).rejects.toThrow('File not found')
  })

  it('opens a Loro snapshot and folds applied updates into it', async () => {
    const bridge = createMockBridge()
    const { id } = await bridge.files.create('Doc')
    const doc = loadDoc(await bridge.files.open(id))
    expect(toSnapshot(doc).name).toBe('Doc')
    const before = doc.oplogVersion()
    const pageId = getChildIds(doc, null)[0]!
    const frame = createNode(doc, { type: 'frame', parentId: pageId, name: 'Board' })
    await bridge.files.applyUpdate(id, doc.export({ mode: 'update', from: before }))
    const reopened = loadDoc(await bridge.files.open(id))
    expect(toSnapshot(reopened).nodes[frame]?.name).toBe('Board')
    const exported = JSON.parse(await bridge.export.json(id)) as ReturnType<typeof toSnapshot>
    expect(exported.nodes[frame]?.name).toBe('Board')
  })

  it('imports snapshots and links files to team files', async () => {
    const bridge = createMockBridge()
    const source = await bridge.files.create('Shared')
    const snapshot = await bridge.files.open(source.id)
    const copy = await bridge.files.import(snapshot, null)
    expect(copy).toMatchObject({ name: 'Shared', teamId: null, remoteId: null })
    expect(toSnapshot(loadDoc(await bridge.files.open(copy.id))).name).toBe('Shared')
    const renamed = await bridge.files.import(snapshot, 'Copy')
    expect(toSnapshot(loadDoc(await bridge.files.open(renamed.id))).name).toBe('Copy')
    await bridge.files.setRemote(copy.id, 't1', 'r1')
    expect((await bridge.files.list()).find((f) => f.id === copy.id)).toMatchObject({
      teamId: 't1',
      remoteId: 'r1',
    })
    await expect(bridge.files.import(Uint8Array.of(1, 2, 3), null)).rejects.toThrow(/snapshot/)
  })

  it('stores assets and thumbnails by copy', async () => {
    const bridge = createMockBridge()
    const bytes = new Uint8Array([1, 2, 3])
    const hash = await bridge.assets.put(bytes, 'image/png')
    // blake3, like the native core and the server's upload check.
    expect(hash).toBe(bytesToHex(blake3(new Uint8Array([1, 2, 3]))))
    bytes[0] = 9
    expect(await bridge.assets.get(hash)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await bridge.assets.get('nope')).toBeNull()
    const { id } = await bridge.files.create('T')
    expect(await bridge.files.getThumbnail(id)).toBeNull()
    await bridge.files.setThumbnail(id, new Uint8Array([7]))
    expect(await bridge.files.getThumbnail(id)).toEqual(new Uint8Array([7]))
  })

  it('emits deep links and maximize changes to subscribers', async () => {
    const bridge = createMockBridge({ platform: 'linux', token: 't0' })
    const onLink = vi.fn()
    const off = bridge.onDeepLink(onLink)
    bridge.mock.emitDeepLink('baren://invite/abc')
    off()
    bridge.mock.emitDeepLink('baren://invite/def')
    expect(onLink).toHaveBeenCalledExactlyOnceWith('baren://invite/abc')

    const onMax = vi.fn()
    bridge.window.onMaximizedChange(onMax)
    bridge.window.toggleMaximize()
    expect(await bridge.window.isMaximized()).toBe(true)
    expect(onMax).toHaveBeenCalledWith(true)

    expect(await bridge.auth.getToken()).toBe('t0')
    await bridge.auth.setToken(null)
    expect(await bridge.auth.getToken()).toBeNull()
    expect(bridge.platform).toBe('linux')
  })

  it('loads seeded thumbnails lazily, once, and records external links', async () => {
    let loads = 0
    const bridge = createMockBridge({
      externalLinks: 'record',
      files: [
        {
          id: 'f',
          name: 'F',
          thumbnail: async () => {
            loads++
            return new Uint8Array([1, 2])
          },
        },
      ],
    })
    const [a, b] = await Promise.all([
      bridge.files.getThumbnail('f'),
      bridge.files.getThumbnail('f'),
    ])
    expect(a).toEqual(new Uint8Array([1, 2]))
    expect(b).toEqual(new Uint8Array([1, 2]))
    expect(loads).toBe(1)
    await bridge.shell.openExternal('https://baren.dev/docs')
    expect(bridge.mock.openedUrls()).toEqual(['https://baren.dev/docs'])
  })
})
