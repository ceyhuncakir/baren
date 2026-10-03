import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../log'
import { NativeCoreBackend, missingMethods, resolveNativeHandle } from './nativeBackend'
import { napiPlatformSuffix, nativeModuleCandidates } from './nativeModule'
import { asBuffer, normalizeFileMeta } from './normalize'
import { selectCoreBackend } from './selectBackend'
import { CORE_METHODS, type CoreBackend } from './types'

const silent = createLogger('test', { sink: () => {} })

describe('nativeModuleCandidates', () => {
  it('maps platforms to napi-rs suffixes', () => {
    expect(napiPlatformSuffix('linux', 'x64')).toBe('linux-x64-gnu')
    expect(napiPlatformSuffix('darwin', 'arm64')).toBe('darwin-arm64')
    expect(napiPlatformSuffix('win32', 'x64')).toBe('win32-x64-msvc')
    expect(napiPlatformSuffix('freebsd', 'x64')).toBeNull()
  })

  it('looks in crates/napi during development', () => {
    const appPath = resolve('/repo/apps/desktop')
    expect(
      nativeModuleCandidates({
        platform: 'linux',
        arch: 'x64',
        isPackaged: false,
        appPath,
        resourcesPath: '/unused',
        override: null,
      }),
    ).toEqual([
      join(resolve('/repo/crates/napi'), 'baren-core.linux-x64-gnu.node'),
      join(resolve('/repo/crates/napi'), 'baren-core.node'),
    ])
  })

  it('falls back to the MinGW core on Windows', () => {
    const names = nativeModuleCandidates({
      platform: 'win32',
      arch: 'x64',
      isPackaged: true,
      appPath: 'C:/Baren/resources/app.asar',
      resourcesPath: 'C:/Baren/resources',
      override: null,
    })
      .filter((p) => p.includes('app.asar.unpacked'))
      .map((p) => p.split(/[\\/]/).pop())
    expect(names).toEqual([
      'baren-core.win32-x64-msvc.node',
      'baren-core.win32-x64-gnu.node',
      'baren-core.node',
    ])
  })

  it('looks in app.asar.unpacked/native when packaged', () => {
    const paths = nativeModuleCandidates({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      appPath: '/App.app/Contents/Resources/app.asar',
      resourcesPath: '/App.app/Contents/Resources',
      override: null,
    })
    expect(paths[0]).toBe(
      join(
        '/App.app/Contents/Resources',
        'app.asar.unpacked',
        'native',
        'baren-core.darwin-arm64.node',
      ),
    )
    expect(paths).toContain(
      join(
        '/App.app/Contents/Resources',
        'app.asar.unpacked',
        'native',
        'baren-core.darwin-universal.node',
      ),
    )
  })

  it('uses only the override when BAREN_NATIVE_PATH is set', () => {
    const paths = nativeModuleCandidates({
      platform: 'linux',
      arch: 'x64',
      isPackaged: true,
      appPath: '/a',
      resourcesPath: '/r',
      override: '/custom/core.node',
    })
    expect(paths).toEqual([resolve('/custom/core.node')])
  })
})

/** A fake napi module with every method; records calls. */
function fakeNativeApi() {
  const calls: [string, unknown[]][] = []
  const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const m of CORE_METHODS) {
    api[m] = async (...args: unknown[]) => {
      calls.push([m, args])
      switch (m) {
        case 'listFiles':
          return [{ id: 'f1', name: 'A', createdAt: 1n, updatedAt: 2, archived: false }]
        case 'createFile':
        case 'importFile':
          return {
            id: 'f2',
            name: typeof args[0] === 'string' ? args[0] : (args[1] ?? 'Imported'),
            createdAt: 3,
            updatedAt: 3,
            archived: false,
            teamId: null,
            remoteId: 'r',
          }
        case 'openFile':
          return Buffer.from([1, 2, 3])
        case 'getThumbnail':
        case 'getAsset':
          return undefined
        case 'putAsset':
          return 'a'.repeat(64)
        case 'exportHtml':
          return '<div></div>'
        case 'exportJson':
          return '{}'
        default:
          return undefined
      }
    }
  }
  return { api, calls }
}

describe('resolveNativeHandle', () => {
  it('constructs a Core class with the data directory', async () => {
    const { api } = fakeNativeApi()
    const seen: string[] = []
    class Core {
      constructor(dir: string) {
        seen.push(dir)
        Object.assign(this, api)
      }
    }
    const { shape, handle } = await resolveNativeHandle(
      { Core, coreVersion: () => '0.1.0' },
      '/data/core',
    )
    expect(shape).toBe('new Core(dataDir)')
    expect(seen).toEqual(['/data/core'])
    expect(missingMethods(handle)).toEqual([])
  })

  it('prefers a static async open() factory', async () => {
    const { api } = fakeNativeApi()
    const open = vi.fn(async () => ({ ...api, close: async () => {} }))
    const { shape, handle } = await resolveNativeHandle(
      { Core: Object.assign(class {}, { open }) },
      '/d',
    )
    expect(shape).toBe('Core.open(dataDir)')
    expect(open).toHaveBeenCalledWith('/d')
    expect(handle.dispose).toBeTypeOf('function')
  })

  it('accepts free functions with init(dataDir)', async () => {
    const { api } = fakeNativeApi()
    const init = vi.fn()
    const { shape } = await resolveNativeHandle({ ...api, init }, '/d')
    expect(shape).toBe('init(dataDir) + functions')
    expect(init).toHaveBeenCalledWith('/d')
  })

  it('rejects the foundation skeleton (coreVersion only) so main falls back to JS', async () => {
    await expect(resolveNativeHandle({ coreVersion: () => '0.1.0' }, '/d')).rejects.toThrow(
      /lacks: listFiles/,
    )
  })

  it('rejects a Core class missing methods', async () => {
    class Core {
      listFiles() {}
    }
    await expect(resolveNativeHandle({ Core }, '/d')).rejects.toThrow(/Core lacks: createFile/)
  })
})

describe('NativeCoreBackend', () => {
  it('normalises napi values to the bridge contract', async () => {
    const { api, calls } = fakeNativeApi()
    const { handle } = await resolveNativeHandle(api, '/d')
    const core = new NativeCoreBackend(handle)
    expect(await core.listFiles()).toEqual([
      {
        id: 'f1',
        name: 'A',
        createdAt: 1,
        updatedAt: 2,
        archived: false,
        teamId: null,
        remoteId: null,
      },
    ])
    expect((await core.createFile('B')).remoteId).toBe('r')
    expect([...(await core.openFile('f1'))]).toEqual([1, 2, 3])
    expect(await core.getThumbnail('f1')).toBeNull()
    expect(await core.getAsset('x')).toBeNull()
    await core.applyUpdate('f1', new Uint8Array([9, 9]))
    const passed = calls.find(([m]) => m === 'applyUpdate')?.[1][1]
    expect(Buffer.isBuffer(passed)).toBe(true)
    const imported = await core.importFile(new Uint8Array([7]), null)
    expect(imported.name).toBe('Imported')
    expect(Buffer.isBuffer(calls.find(([m]) => m === 'importFile')?.[1][0])).toBe(true)
    await core.setFileRemote('f1', 't1', null)
    expect(calls.find(([m]) => m === 'setFileRemote')?.[1]).toEqual(['f1', 't1', null])
  })

  it('serves assets with the stored mime when the addon has an accessor, else sniffs', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    const base = Object.fromEntries(CORE_METHODS.map((m) => [m, async () => undefined])) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    const bytesOnly = {
      ...base,
      getAsset: async (h: unknown) => (h === 'h' ? Buffer.from(png) : null),
    }
    const sniffing = new NativeCoreBackend((await resolveNativeHandle(bytesOnly, '/d')).handle)
    expect(await sniffing.getAssetEntry('h')).toEqual({
      bytes: Buffer.from(png),
      mime: 'image/png',
    })
    expect(await sniffing.getAssetEntry('missing')).toBeNull()

    const withMime = { ...bytesOnly, getAssetMime: async () => 'image/x-custom' }
    const mimeCore = new NativeCoreBackend((await resolveNativeHandle(withMime, '/d')).handle)
    expect((await mimeCore.getAssetEntry('h'))?.mime).toBe('image/x-custom')

    const withEntry = {
      ...base,
      getAssetEntry: async (h: unknown) =>
        h === 'h' ? { bytes: Buffer.from(png), mime: 'image/webp' } : null,
    }
    const entryCore = new NativeCoreBackend((await resolveNativeHandle(withEntry, '/d')).handle)
    expect(await entryCore.getAssetEntry('h')).toEqual({
      bytes: Buffer.from(png),
      mime: 'image/webp',
    })

    // crates/napi names the same accessor `getAssetFile`.
    const withFile = {
      ...bytesOnly,
      getAssetFile: async (h: unknown) =>
        h === 'h' ? { bytes: Buffer.from(png), mime: 'image/avif' } : null,
    }
    const fileCore = new NativeCoreBackend((await resolveNativeHandle(withFile, '/d')).handle)
    expect(await fileCore.getAssetEntry('h')).toEqual({
      bytes: Buffer.from(png),
      mime: 'image/avif',
    })
    expect(await fileCore.getAssetEntry('missing')).toBeNull()
    expect(await entryCore.getAssetEntry('x')).toBeNull()
  })

  it('rejects malformed native results instead of passing them on', () => {
    expect(() => normalizeFileMeta({ id: 1, name: 'x' })).toThrow(/invalid FileMeta/)
    expect(() =>
      normalizeFileMeta({ id: 'a', name: 'x', createdAt: 'yesterday', updatedAt: 1 }),
    ).toThrow()
  })

  it('wraps Uint8Arrays as Buffers without copying', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3)
    const buf = asBuffer(bytes)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.buffer).toBe(bytes.buffer)
    expect([...buf]).toEqual([2, 3])
  })
})

describe('selectCoreBackend', () => {
  const fakeBackend = (kind: 'native' | 'js'): CoreBackend => ({ kind }) as CoreBackend

  it('uses the first native module that exists and loads', async () => {
    const loadNative = vi.fn(async (path: string) => {
      if (path === '/a.node') throw new Error('wrong ABI')
      return { backend: fakeBackend('native'), shape: 'new Core(dataDir)' }
    })
    const selection = await selectCoreBackend({
      mode: 'auto',
      candidates: ['/missing.node', '/a.node', '/b.node'],
      exists: async (p) => p !== '/missing.node',
      loadNative,
      createJs: () => fakeBackend('js'),
      log: silent,
    })
    expect(selection.kind).toBe('native')
    expect(selection.detail).toBe('/b.node [new Core(dataDir)]')
    expect(loadNative).toHaveBeenCalledTimes(2)
  })

  it('falls back to the JS core when no native module is usable', async () => {
    const selection = await selectCoreBackend({
      mode: 'auto',
      candidates: ['/a.node'],
      exists: async () => true,
      loadNative: async () => {
        throw new Error('native module lacks: listFiles')
      },
      createJs: () => fakeBackend('js'),
      log: silent,
    })
    expect(selection).toMatchObject({
      kind: 'js',
      detail: '/a.node: native module lacks: listFiles',
    })
  })

  it('BAREN_CORE=js never probes native; BAREN_CORE=native fails loudly', async () => {
    const exists = vi.fn(async () => false)
    const deps = {
      candidates: ['/a.node'],
      exists,
      loadNative: async () => ({ backend: fakeBackend('native'), shape: '' }),
      createJs: () => fakeBackend('js'),
      log: silent,
    }
    expect((await selectCoreBackend({ ...deps, mode: 'js' })).kind).toBe('js')
    expect(exists).not.toHaveBeenCalled()
    await expect(selectCoreBackend({ ...deps, mode: 'native' })).rejects.toThrow(
      /BAREN_CORE=native/,
    )
  })
})
