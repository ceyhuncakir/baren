/**
 * The tiny WebSocket surface `connectFile` needs, so tests can inject a mock and so the
 * renderer, Electron and Node (≥ 22, global `WebSocket`) all work the same way.
 */

export interface SyncSocket {
  send(data: Uint8Array<ArrayBuffer> | string): void
  close(code?: number, reason?: string): void
}

export interface SyncSocketEvents {
  open(): void
  /** Binary frames arrive as `Uint8Array`, text frames as `string`. */
  message(data: Uint8Array | string): void
  close(code: number, reason: string): void
}

export type SocketFactory = (url: string, events: SyncSocketEvents) => SyncSocket

/** A {@link SocketFactory} backed by the standard `WebSocket` (global by default). */
export function webSocketFactory(Ctor?: typeof WebSocket): SocketFactory {
  return (url, events) => {
    const Impl = Ctor ?? globalThis.WebSocket
    if (!Impl) throw new Error('No WebSocket implementation available')
    const ws = new Impl(url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => events.open()
    ws.onmessage = (ev: MessageEvent<unknown>) => {
      const { data } = ev
      if (typeof data === 'string') events.message(data)
      else if (data instanceof ArrayBuffer) events.message(new Uint8Array(data))
    }
    // `error` is always followed by `close`, which carries the useful information.
    ws.onerror = () => {}
    ws.onclose = (ev: CloseEvent) => events.close(ev.code, ev.reason)
    return {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    }
  }
}

/** `http(s)://host[/prefix]` → `ws(s)://host[/prefix]/ws/files/<id>?token=…`. */
export function fileSocketUrl(baseUrl: string, fileId: string, token: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/ws/files/${encodeURIComponent(fileId)}`)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}
