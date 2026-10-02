/**
 * `CoreBackend` proxy that runs the JS core in a worker thread. The worker is
 * spawned on first use and respawned after a crash; calls in flight when it
 * dies are rejected instead of hanging.
 */
import type { Logger } from '../log'
import {
  toWorkerError,
  transferables,
  type WorkerMethod,
  type WorkerRequest,
  type WorkerResponse,
} from './js/protocol'
import { CoreError, type CoreBackend, type CoreOperations } from './types'

/** The subset of `worker_threads.Worker` used here (fake-able in tests). */
export interface WorkerLike {
  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void
  on(event: 'message', listener: (message: WorkerResponse) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

function remoteError(error: { message: string; code?: string }): Error {
  const err = new Error(error.message)
  if (error.code) Object.assign(err, { code: error.code })
  return err
}

export function createWorkerBackend(spawn: () => WorkerLike, log: Logger): CoreBackend {
  let worker: WorkerLike | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()

  const failAll = (reason: string): void => {
    const error = new CoreError('UNAVAILABLE', `JS core worker stopped: ${reason}`)
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker
    const w = spawn()
    w.on('message', (response: WorkerResponse) => {
      const p = pending.get(response.id)
      if (!p) return
      pending.delete(response.id)
      if (response.ok) p.resolve(response.value)
      else p.reject(remoteError(response.error))
    })
    w.on('error', (error: Error) => {
      log.error('JS core worker crashed', error)
      if (worker === w) worker = null
      failAll(error.message)
    })
    w.on('exit', (code: number) => {
      if (worker === w) worker = null
      if (pending.size > 0) failAll(`exit code ${code}`)
    })
    worker = w
    return w
  }

  const call = <T>(method: WorkerMethod, args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const request: WorkerRequest = { id, method, args }
      try {
        ensureWorker().postMessage(request, transferables(args))
      } catch (error) {
        pending.delete(id)
        reject(remoteError(toWorkerError(error)))
      }
    })

  const ops: CoreOperations = {
    listFiles: () => call('listFiles', []),
    createFile: (name) => call('createFile', [name]),
    renameFile: (id, name) => call('renameFile', [id, name]),
    archiveFile: (id, archived) => call('archiveFile', [id, archived]),
    removeFile: (id) => call('removeFile', [id]),
    openFile: (id) => call('openFile', [id]),
    applyUpdate: (id, update) => call('applyUpdate', [id, update]),
    setThumbnail: (id, png) => call('setThumbnail', [id, png]),
    getThumbnail: (id) => call('getThumbnail', [id]),
    putAsset: (bytes, mime) => call('putAsset', [bytes, mime]),
    getAsset: (hash) => call('getAsset', [hash]),
    exportHtml: (fileId, nodeId) => call('exportHtml', [fileId, nodeId]),
    exportJson: (fileId) => call('exportJson', [fileId]),
    importFile: (snapshot, name) => call('importFile', [snapshot, name]),
    setFileRemote: (id, teamId, remoteId) => call('setFileRemote', [id, teamId, remoteId]),
  }

  return {
    kind: 'js',
    ...ops,
    getAssetEntry: (hash) => call('getAssetEntry', [hash]),
    async dispose() {
      const w = worker
      if (!w) return
      try {
        await call('flush', [])
      } finally {
        worker = null
        await w.terminate()
      }
    },
  }
}
