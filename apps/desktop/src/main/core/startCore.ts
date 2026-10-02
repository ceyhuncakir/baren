/**
 * Wires backend selection to Electron/Node: probes the napi module, else
 * spawns the JS core worker. Loaded lazily (dynamic import) after the first
 * window is created, so none of this is on the cold-start path.
 */
import { access, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Logger } from '../log'
import type { CoreMode } from '../startup/flags'
import jsCoreWorkerPath from './js/worker?modulePath'
import type { WorkerInit } from './js/protocol'
import { NativeCoreBackend, resolveNativeHandle } from './nativeBackend'
import { nativeModuleCandidates } from './nativeModule'
import { selectCoreBackend, type BackendSelection } from './selectBackend'
import { createWorkerBackend, type WorkerLike } from './workerBackend'

export interface StartCoreOptions {
  mode: CoreMode
  nativeModulePath: string | null
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  userDataDir: string
  log: Logger
}

export function startCore(options: StartCoreOptions): Promise<BackendSelection> {
  const { log } = options
  const nativeDataDir = join(options.userDataDir, 'core')
  const jsDataDir = join(options.userDataDir, 'core-js')
  const nodeRequire = createRequire(__filename)

  return selectCoreBackend({
    mode: options.mode,
    candidates: nativeModuleCandidates({
      platform: process.platform,
      arch: process.arch,
      isPackaged: options.isPackaged,
      appPath: options.appPath,
      resourcesPath: options.resourcesPath,
      override: options.nativeModulePath,
    }),
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    async loadNative(path) {
      const mod: unknown = nodeRequire(path)
      await mkdir(nativeDataDir, { recursive: true })
      const { handle, shape } = await resolveNativeHandle(mod, nativeDataDir)
      return { backend: new NativeCoreBackend(handle), shape }
    },
    createJs: () =>
      createWorkerBackend(() => {
        const workerData: WorkerInit = { dataDir: jsDataDir }
        return new Worker(jsCoreWorkerPath, { workerData, name: 'baren-js-core' }) as WorkerLike
      }, log.child('js-core')),
    log,
  })
}
