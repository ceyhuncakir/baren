import { LoroDoc, VersionVector } from 'loro-crdt'

import { MsgType, decodeFrame, encodeFrame } from '../src/protocol.ts'
import type { SocketFactory, SyncSocket, SyncSocketEvents } from '../src/socket.ts'

/** A socket the test drives from the "server" side. */
export class MockSocket implements SyncSocket {
  readonly sent: Array<Uint8Array | string> = []
  closedWith: { code: number | undefined; reason: string | undefined } | null = null

  constructor(
    readonly url: string,
    private readonly events: SyncSocketEvents,
  ) {}

  send(data: Uint8Array | string): void {
    this.sent.push(typeof data === 'string' ? data : data.slice())
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
  }

  // Server side -------------------------------------------------------------------------

  open(): void {
    this.events.open()
  }

  receive(data: Uint8Array | string): void {
    this.events.message(data)
  }

  receiveJson(value: unknown): void {
    this.events.message(JSON.stringify(value))
  }

  serverClose(code: number, reason = ''): void {
    this.events.close(code, reason)
  }

  /** Binary frames the client sent, optionally of one type. */
  frames(type?: MsgType): Array<{ type: MsgType; payload: Uint8Array }> {
    return this.sent
      .filter((d): d is Uint8Array => typeof d !== 'string')
      .map((d) => decodeFrame(d))
      .filter((f) => f !== null)
      .filter((f) => type === undefined || f.type === type)
  }

  /** Text frames the client sent, parsed. */
  texts(): unknown[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((t) => JSON.parse(t))
  }
}

export function mockSockets() {
  const sockets: MockSocket[] = []
  const factory: SocketFactory = (url, events) => {
    const socket = new MockSocket(url, events)
    sockets.push(socket)
    return socket
  }
  const last = (): MockSocket => {
    const s = sockets.at(-1)
    if (!s) throw new Error('no socket created yet')
    return s
  }
  return { factory, sockets, last }
}

/**
 * Minimal stand-in for the server room: answers the client's `0x02` with `0x03`, imports
 * `0x01` frames, and can ask the client for missing updates (`0x02`).
 */
export class FakeRoom {
  readonly doc = new LoroDoc()

  /** Process everything the client sent on `socket` since the last call. */
  handle(socket: MockSocket, from = 0): number {
    const sent = socket.sent.slice(from)
    for (const data of sent) {
      if (typeof data === 'string') continue
      const frame = decodeFrame(data)
      if (!frame) continue
      if (frame.type === MsgType.Update) this.doc.import(frame.payload)
      if (frame.type === MsgType.SyncRequest) {
        const theirs = VersionVector.decode(frame.payload)
        const update = this.doc.export({ mode: 'update', from: theirs })
        socket.receive(encodeFrame(MsgType.SyncResponse, update))
      }
    }
    return socket.sent.length
  }

  /** Server → client sync request with the room's version vector. */
  requestFrom(socket: MockSocket): void {
    socket.receive(encodeFrame(MsgType.SyncRequest, this.doc.oplogVersion().encode()))
  }
}
