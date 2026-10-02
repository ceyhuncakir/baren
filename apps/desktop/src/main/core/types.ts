/**
 * The main process talks to the local backend (persistence, assets, export)
 * only through `CoreBackend`. Two implementations:
 *
 * - `NativeCoreBackend`: the Rust core (`crates/napi`, napi-rs), async on the
 *   libuv thread pool.
 * - The JS fallback (`js/jsCore.ts`), run in a worker thread, used
 *   automatically when the native module is missing so the app always runs.
 */
import type { FileMeta } from '../../renderer/types/bridge'

export type { FileMeta }

/** The operations both backends implement (napi method names). */
export interface CoreOperations {
  listFiles(): Promise<FileMeta[]>
  createFile(name: string): Promise<FileMeta>
  renameFile(id: string, name: string): Promise<void>
  archiveFile(id: string, archived: boolean): Promise<void>
  removeFile(id: string): Promise<void>
  /** Compacted Loro snapshot of the file. */
  openFile(id: string): Promise<Uint8Array>
  /** Persist a Loro update produced by the renderer. */
  applyUpdate(id: string, update: Uint8Array): Promise<void>
  setThumbnail(id: string, png: Uint8Array): Promise<void>
  getThumbnail(id: string): Promise<Uint8Array | null>
  /** Store bytes content-addressed; returns the blake3 hex hash. */
  putAsset(bytes: Uint8Array, mime: string): Promise<string>
  getAsset(hash: string): Promise<Uint8Array | null>
  exportHtml(fileId: string, nodeId: string): Promise<string>
  exportJson(fileId: string): Promise<string>
  /** New file from a Loro snapshot; `name` overrides the document's name (`null` keeps it). */
  importFile(snapshot: Uint8Array, name: string | null): Promise<FileMeta>
  /** Link a file to a server team file, or unlink it with `null`s. Does not bump `updatedAt`. */
  setFileRemote(id: string, teamId: string | null, remoteId: string | null): Promise<void>
}

export const CORE_METHODS = [
  'listFiles',
  'createFile',
  'renameFile',
  'archiveFile',
  'removeFile',
  'openFile',
  'applyUpdate',
  'setThumbnail',
  'getThumbnail',
  'putAsset',
  'getAsset',
  'exportHtml',
  'exportJson',
  'importFile',
  'setFileRemote',
] as const satisfies readonly (keyof CoreOperations)[]

export type CoreMethod = (typeof CORE_METHODS)[number]

/** Compile-time check that CORE_METHODS lists every operation. */
type AssertNever<T extends never> = T
export type AllCoreMethodsListed = AssertNever<Exclude<keyof CoreOperations, CoreMethod>>

export type CoreBackendKind = 'native' | 'js'

/** An asset's bytes with the mime type stored by `putAsset`. */
export interface AssetEntry {
  bytes: Uint8Array
  mime: string
}

export interface CoreBackend extends CoreOperations {
  readonly kind: CoreBackendKind
  /**
   * The asset with its stored mime type (the `baren-asset://` protocol), or null when no
   * asset has this hash. Not a napi requirement: when the addon has no mime accessor, the
   * native backend sniffs the type from the bytes.
   */
  getAssetEntry(hash: string): Promise<AssetEntry | null>
  /** Flush pending writes and release resources (called at quit). */
  dispose(): Promise<void>
}

export type CoreErrorCode = 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'CORRUPT' | 'UNAVAILABLE'

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CoreError'
  }
}
