/**
 * `CoreBackend` over the napi module from crates/napi.
 *
 * Expected module shape (see docs/requests/desktop-shell.md): a class
 * constructed with the data directory (an existing directory; the core picks
 * its database file name inside it) —
 *   `new Core(dataDir)` or `await Core.open(dataDir)`
 * — whose async methods are the `CORE_METHODS`. Free functions plus an
 * `init(dataDir)` are accepted as well, so main keeps working while the Rust
 * surface settles. Anything else is rejected and main falls back to the JS core.
 */
import {
  asBuffer,
  normalizeFileList,
  normalizeFileMeta,
  toBytes,
  toOptionalBytes,
  toResultString,
} from './normalize'
import { sniffMime } from '../protocol/assetRequest'
import {
  CORE_METHODS,
  CoreError,
  type AssetEntry,
  type CoreBackend,
  type CoreMethod,
  type FileMeta,
} from './types'

type NativeFn = (...args: unknown[]) => unknown
export type NativeHandle = Record<CoreMethod, NativeFn> & {
  dispose?: NativeFn
  /**
   * Optional `getAssetEntry(hash) → { bytes, mime } | null` (bytes and stored mime in one call).
   * The addon from crates/napi exports it as `getAssetFile`; either name is accepted.
   */
  getAssetEntry?: NativeFn
  /** Optional `getAssetMime(hash) → string | null`. */
  getAssetMime?: NativeFn
}

const CLASS_EXPORTS = ['Core', 'BarenCore', 'NativeCore', 'CoreHandle', 'Store'] as const
const INIT_EXPORTS = ['init', 'open', 'initCore'] as const
const DISPOSE_METHODS = ['close', 'dispose', 'flush'] as const
const OPTIONAL_ASSET_METHODS = ['getAssetEntry', 'getAssetMime'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
}

export function missingMethods(target: unknown): CoreMethod[] {
  if (!isRecord(target)) return [...CORE_METHODS]
  return CORE_METHODS.filter((m) => typeof target[m] !== 'function')
}

function bindHandle(target: Record<string, unknown>): NativeHandle {
  const handle = {} as NativeHandle
  for (const m of CORE_METHODS) handle[m] = (target[m] as NativeFn).bind(target)
  const dispose = DISPOSE_METHODS.find((m) => typeof target[m] === 'function')
  if (dispose) handle.dispose = (target[dispose] as NativeFn).bind(target)
  for (const m of OPTIONAL_ASSET_METHODS) {
    if (typeof target[m] === 'function') handle[m] = (target[m] as NativeFn).bind(target)
  }
  if (!handle.getAssetEntry && typeof target['getAssetFile'] === 'function') {
    handle.getAssetEntry = (target['getAssetFile'] as NativeFn).bind(target)
  }
  return handle
}

/** Find the core API in a loaded napi module and bind it to `dataDir`. */
export async function resolveNativeHandle(
  mod: unknown,
  dataDir: string,
): Promise<{ handle: NativeHandle; shape: string }> {
  if (!isRecord(mod)) throw new CoreError('UNAVAILABLE', 'native module has no exports')

  for (const name of CLASS_EXPORTS) {
    const ctor = mod[name]
    if (typeof ctor !== 'function') continue
    const factory = (ctor as unknown as Record<string, unknown>)['open']
    const instance: unknown =
      typeof factory === 'function'
        ? await (factory as NativeFn).call(ctor, dataDir)
        : new (ctor as new (dir: string) => unknown)(dataDir)
    const missing = missingMethods(instance)
    if (missing.length === 0 && isRecord(instance)) {
      return {
        handle: bindHandle(instance),
        shape: typeof factory === 'function' ? `${name}.open(dataDir)` : `new ${name}(dataDir)`,
      }
    }
    throw new CoreError('UNAVAILABLE', `native ${name} lacks: ${missing.join(', ')}`)
  }

  const missing = missingMethods(mod)
  if (missing.length > 0) {
    throw new CoreError('UNAVAILABLE', `native module lacks: ${missing.join(', ')}`)
  }
  const init = INIT_EXPORTS.find((name) => typeof mod[name] === 'function')
  if (init) await (mod[init] as NativeFn)(dataDir)
  return { handle: bindHandle(mod), shape: init ? `${init}(dataDir) + functions` : 'functions' }
}

export class NativeCoreBackend implements CoreBackend {
  readonly kind = 'native' as const

  constructor(private readonly native: NativeHandle) {}

  async listFiles(): Promise<FileMeta[]> {
    return normalizeFileList(await this.native.listFiles())
  }

  async createFile(name: string): Promise<FileMeta> {
    return normalizeFileMeta(await this.native.createFile(name))
  }

  async renameFile(id: string, name: string): Promise<void> {
    await this.native.renameFile(id, name)
  }

  async archiveFile(id: string, archived: boolean): Promise<void> {
    await this.native.archiveFile(id, archived)
  }

  async removeFile(id: string): Promise<void> {
    await this.native.removeFile(id)
  }

  async openFile(id: string): Promise<Uint8Array> {
    return toBytes(await this.native.openFile(id), 'snapshot')
  }

  async applyUpdate(id: string, update: Uint8Array): Promise<void> {
    await this.native.applyUpdate(id, asBuffer(update))
  }

  async setThumbnail(id: string, png: Uint8Array): Promise<void> {
    await this.native.setThumbnail(id, asBuffer(png))
  }

  async getThumbnail(id: string): Promise<Uint8Array | null> {
    return toOptionalBytes(await this.native.getThumbnail(id), 'thumbnail')
  }

  async putAsset(bytes: Uint8Array, mime: string): Promise<string> {
    return toResultString(await this.native.putAsset(asBuffer(bytes), mime), 'asset hash')
  }

  async getAsset(hash: string): Promise<Uint8Array | null> {
    return toOptionalBytes(await this.native.getAsset(hash), 'asset')
  }

  async getAssetEntry(hash: string): Promise<AssetEntry | null> {
    if (this.native.getAssetEntry) {
      const raw = (await this.native.getAssetEntry(hash)) as {
        bytes?: unknown
        mime?: unknown
      } | null
      if (raw === null || raw === undefined) return null
      const bytes = toBytes(raw.bytes, 'asset')
      return { bytes, mime: typeof raw.mime === 'string' ? raw.mime : sniffMime(bytes) }
    }
    const bytes = await this.getAsset(hash)
    if (bytes === null) return null
    const mime = this.native.getAssetMime ? await this.native.getAssetMime(hash) : null
    return { bytes, mime: typeof mime === 'string' ? mime : sniffMime(bytes) }
  }

  async exportHtml(fileId: string, nodeId: string): Promise<string> {
    return toResultString(await this.native.exportHtml(fileId, nodeId), 'HTML export')
  }

  async exportJson(fileId: string): Promise<string> {
    return toResultString(await this.native.exportJson(fileId), 'JSON export')
  }

  async importFile(snapshot: Uint8Array, name: string | null): Promise<FileMeta> {
    return normalizeFileMeta(await this.native.importFile(asBuffer(snapshot), name))
  }

  async setFileRemote(id: string, teamId: string | null, remoteId: string | null): Promise<void> {
    await this.native.setFileRemote(id, teamId, remoteId)
  }

  async dispose(): Promise<void> {
    await this.native.dispose?.()
  }
}
