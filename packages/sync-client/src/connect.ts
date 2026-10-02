import { VersionVector, type LoroDoc } from 'loro-crdt'

import type { TokenSource } from './api.ts'
import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff.ts'
import {
  CloseCode,
  MsgType,
  decodeFrame,
  encodeFrame,
  parseServerText,
  type ClientPresence,
  type PeerPresence,
  type WelcomeMessage,
} from './protocol.ts'
import { fileSocketUrl, webSocketFactory, type SocketFactory, type SyncSocket } from './socket.ts'
import { throttleLatest, type Throttled } from './throttle.ts'

/**
 * - `connecting`: opening the socket.
 * - `syncing`: open, waiting for the server's answer to our version vector.
 * - `synced`: caught up; local edits stream live.
 * - `offline`: disconnected, retrying with backoff (edits keep accumulating in the doc and
 *   are uploaded on reconnect).
 * - `closed`: `disconnect()` was called.
 * - `unauthorized` / `forbidden` / `not-found`: terminal, no more retries.
 */
export type SyncStatus =
  | 'connecting'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'closed'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'

export interface StatusInfo {
  /** WebSocket close code that caused this status, if any. */
  closeCode?: number
  reason?: string
  /** For `offline`: when the next attempt happens. */
  retryInMs?: number
  /** Consecutive failed attempts so far. */
  attempt?: number
}

export interface ServerErrorMessage {
  code: string
  message: string
}

export interface ConnectFileOptions {
  /** Server base URL, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string
  /** Session token, or a function returning the current one (called on every reconnect). */
  token: string | TokenSource
  /** Remote file id (`FileMeta.remoteId`). */
  fileId: string
  /** The document to keep in sync. Remote changes arrive as `import` events. */
  doc: LoroDoc
  onStatus?: (status: SyncStatus, info: StatusInfo) => void
  /** Everyone else in the room. Batched to at most one call per animation frame. */
  onPresence?: (peers: readonly PeerPresence[]) => void
  /** Our own identity in the room (colour, role); sent again when the role changes. */
  onWelcome?: (self: WelcomeMessage) => void
  /** Non-fatal server notices, e.g. `read_only` when a viewer edits. */
  onServerError?: (error: ServerErrorMessage) => void
  /** Injected for tests; defaults to the global `WebSocket`. */
  socketFactory?: SocketFactory
  /** Max presence frames per second (default 30). */
  presenceHz?: number
  /** Heartbeat / anti-entropy sync request interval while connected (default 25 s). */
  heartbeatMs?: number
  /** Drop the connection when a heartbeat gets no traffic back within this (default 10 s). */
  heartbeatTimeoutMs?: number
  /** Give up on a socket that has not opened within this (default 15 s) and retry. */
  connectTimeoutMs?: number
  backoff?: Partial<BackoffOptions>
  /** Injected for deterministic backoff jitter in tests. */
  random?: () => number
}

export interface FileConnection {
  /** Update our presence (merged with the previous value); throttled to `presenceHz`. */
  setPresence(presence: Partial<ClientPresence>): void
  /** Stop syncing for good. The doc keeps all edits. */
  disconnect(): void
  /** Skip the backoff wait (e.g. when the OS reports the network is back). */
  reconnectNow(): void
  readonly status: SyncStatus
  /** Our identity from the server's welcome, once connected. */
  readonly self: WelcomeMessage | null
  peers(): readonly PeerPresence[]
  /** Resolves when the doc is caught up with the server; rejects on a terminal status. */
  whenSynced(): Promise<void>
}

const TERMINAL_STATUS: Record<number, SyncStatus> = {
  [CloseCode.Unauthorized]: 'unauthorized',
  [CloseCode.Forbidden]: 'forbidden',
  [CloseCode.NotFound]: 'not-found',
}

/**
 * Keep `doc` in sync with the server's live room for `fileId`:
 * handshake (exchange version vectors, upload offline edits), stream local updates, apply
 * remote ones, relay presence, and reconnect with exponential backoff.
 */
export function connectFile(options: ConnectFileOptions): FileConnection {
  return new FileSync(options)
}

class FileSync implements FileConnection {
  private readonly factory: SocketFactory
  private readonly backoff: BackoffOptions
  private readonly heartbeatMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly presenceThrottle: Throttled<ClientPresence>
  private readonly unsubscribeLocal: () => void

  private socket: SyncSocket | null = null
  /** Bumped per connection attempt; events from older sockets are ignored. */
  private generation = 0
  private isOpen = false
  private stopped = false
  private attempt = 0
  /** `null` until the first status is reported, so `connecting` is emitted too. */
  private currentStatus: SyncStatus | null = null
  private welcome: WelcomeMessage | null = null
  private readonly peersById = new Map<string, PeerPresence>()
  private presence: ClientPresence = { pageId: null, cursor: null, selection: [] }
  private hasPresence = false
  private lastMessageAt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null
  private connectDeadline: ReturnType<typeof setTimeout> | null = null
  private presenceFlushScheduled = false
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

  constructor(private readonly opts: ConnectFileOptions) {
    this.factory = opts.socketFactory ?? webSocketFactory()
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff }
    this.heartbeatMs = opts.heartbeatMs ?? 25_000
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 10_000
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000
    const hz = Math.max(1, opts.presenceHz ?? 30)
    this.presenceThrottle = throttleLatest((p) => this.send(JSON.stringify(p)), 1000 / hz)
    this.unsubscribeLocal = opts.doc.subscribeLocalUpdates((update) => {
      // While offline, edits simply stay in the doc; the reconnect handshake uploads them.
      if (this.isOpen) this.send(encodeFrame(MsgType.Update, update))
    })
    void this.connect()
  }

  // ---------------------------------------------------------------------------------------
  // Public API

  get status(): SyncStatus {
    return this.currentStatus ?? 'connecting'
  }

  get self(): WelcomeMessage | null {
    return this.welcome
  }

  peers(): readonly PeerPresence[] {
    return [...this.peersById.values()]
  }

  setPresence(presence: Partial<ClientPresence>): void {
    this.presence = { ...this.presence, ...presence }
    this.hasPresence = true
    if (this.isOpen) this.presenceThrottle.push(this.presence)
  }

  disconnect(): void {
    if (this.stopped) return
    const hadPeers = this.peersById.size > 0
    this.teardown()
    this.socket?.close(1000, 'bye')
    this.socket = null
    this.setStatus('closed', {})
    if (hadPeers) this.opts.onPresence?.([])
  }

  reconnectNow(): void {
    if (this.stopped || this.isOpen || this.currentStatus !== 'offline') return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    void this.connect()
  }

  whenSynced(): Promise<void> {
    if (this.currentStatus === 'synced') return Promise.resolve()
    if (this.stopped) return Promise.reject(new Error(`sync stopped (${this.status})`))
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  // ---------------------------------------------------------------------------------------
  // Connection lifecycle

  private async connect(): Promise<void> {
    if (this.stopped) return
    const generation = ++this.generation
    this.setStatus('connecting', { attempt: this.attempt })
    let token: string | null | undefined
    try {
      token = typeof this.opts.token === 'function' ? await this.opts.token() : this.opts.token
    } catch {
      token = null
    }
    if (generation !== this.generation || this.stopped) return
    if (!token) {
      this.finish('unauthorized', { closeCode: CloseCode.Unauthorized, reason: 'no token' })
      return
    }
    const isCurrent = () => generation === this.generation && !this.stopped
    try {
      this.socket = this.factory(fileSocketUrl(this.opts.baseUrl, this.opts.fileId, token), {
        open: () => isCurrent() && this.onOpen(),
        message: (data) => isCurrent() && this.onMessage(data),
        close: (code, reason) => isCurrent() && this.onClose(code, reason),
      })
    } catch (err) {
      this.onClose(1006, err instanceof Error ? err.message : 'socket error')
      return
    }
    // A blackholed connect can hang without ever firing `close`.
    this.connectDeadline = setTimeout(() => {
      this.connectDeadline = null
      if (isCurrent() && !this.isOpen) this.dropConnection(CloseCode.Timeout, 'connect timeout')
    }, this.connectTimeoutMs)
  }

  private onOpen(): void {
    if (this.connectDeadline) clearTimeout(this.connectDeadline)
    this.connectDeadline = null
    this.isOpen = true
    this.lastMessageAt = Date.now()
    this.setStatus('syncing', {})
    this.sendSyncRequest()
    if (this.hasPresence) this.send(JSON.stringify(this.presence))
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs)
  }

  private onClose(code: number, reason: string): void {
    this.generation += 1 // a socket closes once; ignore anything it reports afterwards
    this.isOpen = false
    this.socket = null
    this.clearConnectionTimers()
    this.presenceThrottle.cancel()
    if (this.peersById.size > 0) {
      this.peersById.clear()
      this.schedulePresenceEmit()
    }
    if (this.stopped) return
    const terminal = TERMINAL_STATUS[code]
    if (terminal) {
      this.finish(terminal, { closeCode: code, reason })
      return
    }
    const retryInMs = backoffDelay(this.attempt, this.backoff, this.opts.random)
    this.attempt += 1
    this.setStatus('offline', { closeCode: code, reason, retryInMs, attempt: this.attempt })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, retryInMs)
  }

  /** Abandon a connection that went silent and reconnect. */
  private dropConnection(code: number, reason: string): void {
    const socket = this.socket
    this.generation += 1 // ignore anything the old socket still reports
    socket?.close(code, reason)
    this.onClose(code, reason)
  }

  /** Stop for good with a terminal status. */
  private finish(status: SyncStatus, info: StatusInfo): void {
    this.teardown()
    this.setStatus(status, info)
  }

  private teardown(): void {
    this.stopped = true
    this.generation += 1
    this.isOpen = false
    this.clearConnectionTimers()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.presenceThrottle.cancel()
    this.unsubscribeLocal()
    this.peersById.clear()
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w.reject(new Error('sync stopped'))
  }

  private clearConnectionTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline)
    if (this.connectDeadline) clearTimeout(this.connectDeadline)
    this.heartbeatTimer = null
    this.heartbeatDeadline = null
    this.connectDeadline = null
  }

  private heartbeat(): void {
    if (!this.isOpen) return
    const sentAt = Date.now()
    this.sendSyncRequest()
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline)
    this.heartbeatDeadline = setTimeout(() => {
      this.heartbeatDeadline = null
      if (this.isOpen && this.lastMessageAt < sentAt) {
        this.dropConnection(CloseCode.Timeout, 'heartbeat timeout')
      }
    }, this.heartbeatTimeoutMs)
  }

  private setStatus(status: SyncStatus, info: StatusInfo): void {
    const changed = status !== this.currentStatus
    this.currentStatus = status
    if (changed || status === 'offline') this.opts.onStatus?.(status, info)
    if (status === 'synced') {
      const waiters = this.waiters
      this.waiters = []
      for (const w of waiters) w.resolve()
    }
  }

  // ---------------------------------------------------------------------------------------
  // Frames

  private send(data: Uint8Array<ArrayBuffer> | string): void {
    if (!this.isOpen || !this.socket) return
    try {
      this.socket.send(data)
    } catch {
      this.dropConnection(1006, 'send failed')
    }
  }

  private sendSyncRequest(): void {
    const vv = this.opts.doc.oplogVersion()
    try {
      this.send(encodeFrame(MsgType.SyncRequest, vv.encode()))
    } finally {
      vv.free()
    }
  }

  private onMessage(data: Uint8Array | string): void {
    this.lastMessageAt = Date.now()
    if (typeof data === 'string') {
      this.onText(data)
      return
    }
    const frame = decodeFrame(data)
    if (!frame) return
    switch (frame.type) {
      case MsgType.Update:
        this.importRemote(frame.payload)
        break
      case MsgType.SyncResponse:
        if (frame.payload.length > 0) this.importRemote(frame.payload)
        if (this.currentStatus !== 'synced' && this.isOpen) {
          this.attempt = 0
          this.setStatus('synced', {})
        }
        break
      case MsgType.SyncRequest:
        this.answerSyncRequest(frame.payload)
        break
    }
  }

  private importRemote(bytes: Uint8Array): void {
    try {
      this.opts.doc.import(bytes)
    } catch {
      // Corrupt data from the server: start over with a fresh handshake.
      this.dropConnection(CloseCode.BadRequest, 'bad update from server')
    }
  }

  /** The server sent its version vector: upload everything it is missing. */
  private answerSyncRequest(payload: Uint8Array): void {
    let theirs: VersionVector
    try {
      theirs = VersionVector.decode(payload)
    } catch {
      return
    }
    const ours = this.opts.doc.oplogVersion()
    try {
      const cmp = ours.compare(theirs)
      if (cmp === undefined || cmp > 0) {
        const update = this.opts.doc.export({ mode: 'update', from: theirs })
        this.send(encodeFrame(MsgType.Update, update))
      }
    } finally {
      ours.free()
      theirs.free()
    }
  }

  private onText(text: string): void {
    const msg = parseServerText(text)
    if (!msg) return
    switch (msg.type) {
      case 'welcome':
        this.welcome = msg
        this.opts.onWelcome?.(msg)
        break
      case 'presence': {
        const { type: _type, ...peer } = msg
        this.peersById.set(peer.clientId, peer)
        this.schedulePresenceEmit()
        break
      }
      case 'leave':
        if (this.peersById.delete(msg.clientId)) this.schedulePresenceEmit()
        break
      case 'error':
        this.opts.onServerError?.({ code: msg.code, message: msg.message })
        break
    }
  }

  /** Coalesce presence bursts from many peers into one callback per frame. */
  private schedulePresenceEmit(): void {
    if (!this.opts.onPresence || this.presenceFlushScheduled) return
    this.presenceFlushScheduled = true
    const flush = () => {
      this.presenceFlushScheduled = false
      this.opts.onPresence?.(this.peers())
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
    else setTimeout(flush, 16)
  }
}
