import type { EventChannels, InvokeChannels, SendChannels, SyncChannels } from './channels'

/** The typed slice of `ipcRenderer` the bridge needs (injectable for tests). */
export interface TypedIpc {
  invoke<K extends keyof InvokeChannels>(
    channel: K,
    ...args: InvokeChannels[K]['args']
  ): Promise<InvokeChannels[K]['result']>
  send<K extends keyof SendChannels>(channel: K, ...args: SendChannels[K]): void
  /** Blocking request (preload start-up only); the result is unvalidated main-process data. */
  sendSync<K extends keyof SyncChannels>(channel: K, ...args: SyncChannels[K]['args']): unknown
  /** Subscribe to a main → renderer event; returns the unsubscribe function. */
  on<K extends keyof EventChannels>(channel: K, cb: (...args: EventChannels[K]) => void): () => void
}

/** Minimal structural type of Electron's `ipcRenderer` (keeps this module testable in Node). */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  sendSync(channel: string, ...args: unknown[]): unknown
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

const REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

/**
 * `ipcMain.handle` errors reach the renderer as
 * "Error invoking remote method 'files:open': Error: File not found: x".
 * Strip the transport prefix so callers see the original message.
 */
export function cleanRemoteError(error: unknown): Error {
  if (error instanceof Error) {
    const message = error.message.replace(REMOTE_ERROR_PREFIX, '')
    if (message === error.message) return error
    return new Error(message)
  }
  return new Error(String(error))
}

export function createTypedIpc(ipc: IpcRendererLike): TypedIpc {
  return {
    invoke(channel, ...args) {
      return ipc.invoke(channel, ...args).then(
        (value) => value as never,
        (error: unknown) => {
          throw cleanRemoteError(error)
        },
      )
    },
    send(channel, ...args) {
      ipc.send(channel, ...args)
    },
    sendSync(channel, ...args) {
      return ipc.sendSync(channel, ...args)
    },
    on(channel, cb) {
      const listener = (_event: unknown, ...args: unknown[]): void => {
        cb(...(args as Parameters<typeof cb>))
      }
      ipc.on(channel, listener)
      return () => {
        ipc.removeListener(channel, listener)
      }
    },
  }
}
