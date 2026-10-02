import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectFile, type ConnectFileOptions, type SyncStatus } from '../src/connect.ts'
import { CloseCode, MsgType, encodeFrame, type PeerPresence } from '../src/protocol.ts'
import { FakeRoom, mockSockets } from './mockSocket.ts'

const BASE = 'http://127.0.0.1:8787'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Let pending microtasks (token resolution, Loro callbacks) and due timers run. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

function setup(overrides: Partial<ConnectFileOptions> = {}) {
  const mocks = mockSockets()
  const doc = new LoroDoc()
  const statuses: SyncStatus[] = []
  const presence: Array<readonly PeerPresence[]> = []
  const conn = connectFile({
    baseUrl: BASE,
    token: 'tok',
    fileId: 'file-1',
    doc,
    socketFactory: mocks.factory,
    random: () => 0, // no jitter: deterministic backoff
    onStatus: (s) => statuses.push(s),
    onPresence: (p) => presence.push(p),
    ...overrides,
  })
  return { ...mocks, doc, conn, statuses, presence }
}

describe('connectFile handshake', () => {
  it('connects to the file socket with the token', async () => {
    const { last } = setup({ baseUrl: 'https://sync.example.com/' })
    await settle()
    expect(last().url).toBe('wss://sync.example.com/ws/files/file-1?token=tok')
  })

  it('sends its version vector on open and becomes synced on the reply', async () => {
    const { last, doc, conn, statuses } = setup()
    await settle()
    const socket = last()
    socket.open()
    expect(conn.status).toBe('syncing')

    const [request] = socket.frames(MsgType.SyncRequest)
    expect(request).toBeDefined()
    expect(request!.payload).toEqual(doc.oplogVersion().encode())

    // The room already has content; the reply carries it.
    const room = new FakeRoom()
    room.doc.getMap('meta').set('name', 'From server')
    room.doc.commit()
    room.handle(socket)
    expect(conn.status).toBe('synced')
    expect(doc.getMap('meta').get('name')).toBe('From server')
    await expect(conn.whenSynced()).resolves.toBeUndefined()
    expect(statuses).toEqual(['connecting', 'syncing', 'synced'])
  })

  it('uploads what the server is missing when asked (offline edits)', async () => {
    const { last, doc } = setup()
    doc.getMap('meta').set('name', 'Edited offline')
    doc.getList('log').push('one')
    doc.commit()
    await settle()
    const socket = last()
    socket.open()
    const room = new FakeRoom()
    const seen = room.handle(socket)
    room.requestFrom(socket)
    room.handle(socket, seen)
    expect(room.doc.getMap('meta').get('name')).toBe('Edited offline')
    expect(room.doc.getList('log').toArray()).toEqual(['one'])
  })

  it('does not upload anything when the server is already up to date', async () => {
    const { last } = setup()
    await settle()
    const socket = last()
    socket.open()
    new FakeRoom().requestFrom(socket)
    expect(socket.frames(MsgType.Update)).toHaveLength(0)
  })
})

describe('connectFile streaming', () => {
  it('streams local commits and applies remote updates', async () => {
    const { last, doc } = setup()
    await settle()
    const socket = last()
    socket.open()
    const room = new FakeRoom()
    let seen = room.handle(socket)

    doc.getText('t').insert(0, 'hello')
    doc.commit()
    await settle()
    const updates = socket.frames(MsgType.Update)
    expect(updates).toHaveLength(1)
    seen = room.handle(socket, seen)
    expect(room.doc.getText('t').toString()).toBe('hello')

    // A remote peer edits: the server forwards its update.
    const remote = new LoroDoc()
    remote.import(room.doc.export({ mode: 'snapshot' }))
    remote.getText('t').insert(5, ' world')
    remote.commit()
    socket.receive(
      encodeFrame(MsgType.Update, remote.export({ mode: 'update', from: room.doc.oplogVersion() })),
    )
    expect(doc.getText('t').toString()).toBe('hello world')
    // Imports are not echoed back.
    await settle()
    expect(socket.frames(MsgType.Update)).toHaveLength(1)
  })

  it('does not send while offline and catches up after reconnecting', async () => {
    const { last, sockets, doc, statuses } = setup()
    await settle()
    const first = last()
    first.open()
    const room = new FakeRoom()
    room.handle(first)
    first.serverClose(1006)
    expect(statuses.at(-1)).toBe('offline')

    doc.getMap('m').set('k', 'offline edit')
    doc.commit()
    await settle()
    expect(first.frames(MsgType.Update)).toHaveLength(0)

    await settle(250) // first retry, no jitter
    expect(sockets).toHaveLength(2)
    const second = last()
    second.open()
    const seen = room.handle(second)
    room.requestFrom(second)
    room.handle(second, seen)
    expect(room.doc.getMap('m').get('k')).toBe('offline edit')
  })
})

describe('connectFile presence', () => {
  it('throttles outgoing presence to 30 Hz and keeps the latest value', async () => {
    const { last, conn } = setup()
    await settle()
    const socket = last()
    socket.open()
    for (let x = 0; x < 10; x++) conn.setPresence({ cursor: { x, y: 0 } })
    expect(socket.texts()).toHaveLength(1)
    await settle(34)
    const texts = socket.texts() as Array<{ cursor: { x: number } }>
    expect(texts).toHaveLength(2)
    expect(texts[1]!.cursor.x).toBe(9)
    // Partial updates merge with the previous presence.
    await settle(100)
    conn.setPresence({ selection: ['n1'] })
    const merged = socket.texts().at(-1) as { cursor: { x: number }; selection: string[] }
    expect(merged.cursor.x).toBe(9)
    expect(merged.selection).toEqual(['n1'])
  })

  it('re-sends presence after reconnecting', async () => {
    const { last, conn } = setup()
    conn.setPresence({ pageId: 'p1' }) // before the socket is even open
    await settle()
    last().open()
    expect(last().texts()).toEqual([{ pageId: 'p1', cursor: null, selection: [] }])
    last().serverClose(1006)
    await settle(250)
    last().open()
    expect(last().texts()).toEqual([{ pageId: 'p1', cursor: null, selection: [] }])
  })

  it('tracks peers from presence and leave messages, batched', async () => {
    const { last, presence, conn } = setup()
    await settle()
    const socket = last()
    socket.open()
    const peer = {
      clientId: 'c2',
      userId: 'u2',
      name: 'Defne Aydın',
      color: '#6D4AFF',
      pageId: 'p1',
      cursor: { x: 1, y: 2 },
      selection: [],
    }
    socket.receiveJson({ type: 'presence', ...peer })
    socket.receiveJson({ type: 'presence', ...peer, cursor: { x: 5, y: 5 } })
    socket.receiveJson({ type: 'bogus' })
    socket.receive('not json')
    await settle(16)
    expect(presence).toHaveLength(1) // two updates, one callback
    expect(presence[0]).toEqual([{ ...peer, cursor: { x: 5, y: 5 } }])
    expect(conn.peers()).toHaveLength(1)

    socket.receiveJson({ type: 'leave', clientId: 'c2', userId: 'u2' })
    await settle(16)
    expect(presence.at(-1)).toEqual([])
  })

  it('reports the welcome and server errors', async () => {
    const onWelcome = vi.fn()
    const onServerError = vi.fn()
    const { last, conn } = setup({ onWelcome, onServerError })
    await settle()
    const socket = last()
    socket.open()
    const welcome = {
      type: 'welcome',
      clientId: 'c1',
      userId: 'u1',
      name: 'ceyhun cakir',
      color: '#F04E1E',
      role: 'viewer',
    }
    socket.receiveJson(welcome)
    socket.receiveJson({ type: 'error', code: 'read_only', message: 'nope' })
    expect(onWelcome).toHaveBeenCalledWith(welcome)
    expect(conn.self).toEqual(welcome)
    expect(onServerError).toHaveBeenCalledWith({ code: 'read_only', message: 'nope' })
  })

  it('clears peers when the connection drops', async () => {
    const { last, presence } = setup()
    await settle()
    const socket = last()
    socket.open()
    socket.receiveJson({
      type: 'presence',
      clientId: 'c2',
      userId: 'u2',
      name: 'D',
      color: '#000',
      pageId: null,
      cursor: null,
      selection: [],
    })
    await settle(16)
    socket.serverClose(1006)
    await settle(16)
    expect(presence.at(-1)).toEqual([])
  })
})

describe('connectFile reconnects', () => {
  it('backs off exponentially and resets after a successful sync', async () => {
    const delays: Array<number | undefined> = []
    const { last, sockets } = setup({
      onStatus: (s, info) => {
        if (s === 'offline') delays.push(info.retryInMs)
      },
    })
    await settle()
    for (let i = 0; i < 4; i++) {
      last().serverClose(1006)
      await settle(delays.at(-1) ?? 0)
    }
    expect(delays).toEqual([250, 500, 1000, 2000])
    expect(sockets).toHaveLength(5)

    // A successful sync resets the attempt counter.
    const socket = last()
    socket.open()
    new FakeRoom().handle(socket)
    socket.serverClose(1006)
    expect(delays.at(-1)).toBe(250)
  })

  it('caps the delay', async () => {
    const delays: Array<number | undefined> = []
    const { last } = setup({
      backoff: { maxMs: 1000 },
      onStatus: (s, info) => {
        if (s === 'offline') delays.push(info.retryInMs)
      },
    })
    await settle()
    for (let i = 0; i < 6; i++) {
      last().serverClose(1006)
      await settle(delays.at(-1) ?? 0)
    }
    expect(Math.max(...delays.map((d) => d ?? 0))).toBe(1000)
  })

  it.each([
    [CloseCode.Unauthorized, 'unauthorized'],
    [CloseCode.Forbidden, 'forbidden'],
    [CloseCode.NotFound, 'not-found'],
  ] as const)('stops on terminal close code %i', async (code, status) => {
    const { last, sockets, conn } = setup()
    await settle()
    const synced = expect(conn.whenSynced()).rejects.toThrow('sync stopped')
    last().serverClose(code)
    await settle(60_000)
    expect(conn.status).toBe(status)
    expect(sockets).toHaveLength(1)
    await synced
  })

  it('treats a missing token as unauthorized', async () => {
    const { conn, sockets } = setup({ token: async () => null })
    await settle()
    expect(conn.status).toBe('unauthorized')
    expect(sockets).toHaveLength(0)
  })

  it('asks the token source again on every reconnect', async () => {
    let n = 0
    const { last } = setup({ token: () => `t${++n}` })
    await settle()
    expect(last().url).toContain('token=t1')
    last().serverClose(1006)
    await settle(250)
    expect(last().url).toContain('token=t2')
  })

  it('reconnectNow skips the wait', async () => {
    const { last, sockets, conn } = setup()
    await settle()
    last().serverClose(1006)
    last().serverClose(1006) // a second close event from the same socket is ignored
    expect(sockets).toHaveLength(1)
    conn.reconnectNow()
    await settle()
    expect(sockets).toHaveLength(2)
  })

  it('sends heartbeats and drops a silent connection', async () => {
    const { last, sockets, statuses } = setup({ heartbeatMs: 1000, heartbeatTimeoutMs: 500 })
    await settle()
    const socket = last()
    socket.open()
    new FakeRoom().handle(socket)
    const before = socket.frames(MsgType.SyncRequest).length
    await settle(1000)
    expect(socket.frames(MsgType.SyncRequest).length).toBe(before + 1)
    // No answer within the timeout: the client gives up on this socket.
    await settle(500)
    expect(socket.closedWith?.code).toBe(CloseCode.Timeout)
    expect(statuses.at(-1)).toBe('offline')
    await settle(250)
    expect(sockets).toHaveLength(2)
  })

  it('gives up on a socket that never opens', async () => {
    const { last, sockets, statuses } = setup({ connectTimeoutMs: 2000 })
    await settle()
    const hung = last()
    await settle(1999)
    expect(sockets).toHaveLength(1)
    await settle(1)
    expect(hung.closedWith?.code).toBe(CloseCode.Timeout)
    expect(statuses.at(-1)).toBe('offline')
    await settle(250)
    expect(sockets).toHaveLength(2)
    // Opening in time cancels the deadline.
    last().open()
    await settle(5000)
    expect(sockets).toHaveLength(2)
  })

  it('keeps a connection that answers heartbeats', async () => {
    const { last, sockets } = setup({ heartbeatMs: 1000, heartbeatTimeoutMs: 500 })
    await settle()
    const socket = last()
    socket.open()
    const room = new FakeRoom()
    let seen = room.handle(socket)
    for (let i = 0; i < 5; i++) {
      await settle(1000)
      seen = room.handle(socket, seen)
    }
    await settle(500)
    expect(sockets).toHaveLength(1)
    expect(socket.closedWith).toBeNull()
  })
})

describe('connectFile disconnect', () => {
  it('closes the socket, stops syncing and never reconnects', async () => {
    const { last, sockets, doc, conn, statuses } = setup()
    await settle()
    const socket = last()
    socket.open()
    conn.disconnect()
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'bye' })
    expect(conn.status).toBe('closed')
    expect(statuses.at(-1)).toBe('closed')

    doc.getMap('m').set('k', 1)
    doc.commit()
    socket.serverClose(1000)
    await settle(60_000)
    expect(socket.frames(MsgType.Update)).toHaveLength(0)
    expect(sockets).toHaveLength(1)
    await expect(conn.whenSynced()).rejects.toThrow()
  })
})
