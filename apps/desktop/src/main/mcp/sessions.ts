/**
 * Stateful Streamable HTTP sessions (contract §4.2): one SDK `StreamableHTTPServerTransport` and
 * one `McpServer` per client session.
 *
 * - A `POST` without `Mcp-Session-Id` must be an `initialize` (else 400); an unknown session id
 *   → 404 (the client re-initialises).
 * - At most 32 sessions (the 33rd `initialize` → 503 `too_many_sessions`); a session with no
 *   request for 30 min and no open `GET` stream is closed.
 * - Bodies are read here (≤ 4 MiB) and handed to the transport pre-parsed.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../log'
import { jsonRpcErrorBody } from './security'

export const MAX_SESSIONS = 32
export const SESSION_IDLE_MS = 30 * 60_000
/**
 * A client that held the GET stream and lost it without reconnecting or sending anything for this
 * long has gone away (its process quit without DELETE): its session ends, so its "working"
 * indicators and "Connected" state clear (contract §10.5, "client disconnect").
 */
export const STREAM_GONE_MS = 60_000
export const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface SessionHandle {
  sessionId: string
}

export interface SessionEntry {
  id: string | null
  transport: StreamableHTTPServerTransport
  server: McpServer
  ref: SessionHandle
  lastRequestAt: number
  openStreams: number
  /** The client opened a GET stream at least once; when the last one closed. */
  streamed: boolean
  streamClosedAt: number
  /** `onIdentified` ran (once per session). */
  identified: boolean
  closed: boolean
}

export interface SessionManagerOptions {
  /** A new McpServer with every tool registered for `ref` (its sessionId is set on initialize). */
  createServer(ref: SessionHandle): McpServer
  /** The session is initialized (its id is known); clientInfo arrives later (`onIdentified`). */
  onOpened?(sessionId: string): void
  /** `notifications/initialized` arrived: `clientInfo` is known. */
  onIdentified?(
    sessionId: string,
    client: { name: string; version?: string; title?: string } | undefined,
  ): void
  onClosed?(sessionId: string): void
  allowedHosts(): string[]
  allowedOrigins(): string[]
  log?: Logger
  now?: () => number
  maxSessions?: number
  idleMs?: number
  streamGoneMs?: number
}

export function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  code = -32001,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(jsonRpcErrorBody(message, code))
}

class BodyTooLarge extends Error {}

export function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > max) {
      reject(new BodyTooLarge())
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > max) {
        reject(new BodyTooLarge())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(private readonly options: SessionManagerOptions) {
    this.sweeper = setInterval(() => this.sweep(), 15_000)
    this.sweeper.unref?.()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  get size(): number {
    return this.sessions.size
  }

  ids(): string[] {
    return [...this.sessions.keys()]
  }

  /** Route one authenticated `/mcp` request (POST, GET or DELETE). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerValue(req, 'mcp-session-id')
    let body: unknown = undefined
    if (req.method === 'POST') {
      let raw: Buffer
      try {
        raw = await readBody(req)
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          sendJsonRpcError(res, 413, 'Request body too large (limit 4 MiB)', -32000)
        } else {
          sendJsonRpcError(res, 400, 'Could not read the request body', -32000)
        }
        return
      }
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        sendJsonRpcError(res, 400, 'Parse error: invalid JSON', -32700)
        return
      }
    }

    if (sessionId !== undefined) {
      const entry = this.sessions.get(sessionId)
      if (!entry || entry.closed) {
        sendJsonRpcError(res, 404, 'Session not found', -32001)
        return
      }
      entry.lastRequestAt = this.now()
      // Open responses (the GET stream, or a long tool call's SSE answer) keep a session alive.
      entry.openStreams++
      if (req.method === 'GET') entry.streamed = true
      res.once('close', () => {
        entry.openStreams = Math.max(0, entry.openStreams - 1)
        entry.lastRequestAt = Math.max(entry.lastRequestAt, req.method === 'GET' ? 0 : this.now())
        if (req.method === 'GET') entry.streamClosedAt = this.now()
      })
      await entry.transport.handleRequest(req, res, body)
      return
    }

    const messages = Array.isArray(body) ? body : [body]
    if (req.method !== 'POST' || !messages.some((m) => isInitializeRequest(m))) {
      sendJsonRpcError(res, 400, 'Bad Request: No valid session ID provided', -32000)
      return
    }
    if (this.sessions.size >= (this.options.maxSessions ?? MAX_SESSIONS)) {
      sendJsonRpcError(res, 503, 'too_many_sessions: close another MCP client and retry', -32001)
      return
    }
    await this.open(req, res, body)
  }

  private async open(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const ref: SessionHandle = { sessionId: '' }
    const server = this.options.createServer(ref)
    let entry!: SessionEntry
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false,
      enableDnsRebindingProtection: true,
      allowedHosts: this.options.allowedHosts(),
      allowedOrigins: this.options.allowedOrigins(),
      onsessioninitialized: (id) => {
        ref.sessionId = id
        entry.id = id
        this.sessions.set(id, entry)
        this.options.onOpened?.(id)
      },
    })
    entry = {
      id: null,
      transport,
      server,
      ref,
      lastRequestAt: this.now(),
      openStreams: 0,
      streamed: false,
      streamClosedAt: 0,
      identified: false,
      closed: false,
    }
    transport.onclose = () => this.closed(entry)
    const identify = (): void => {
      const client = server.server.getClientVersion()
      if (entry.id === null || entry.identified || !client) return
      entry.identified = true
      this.options.onIdentified?.(entry.id, client)
    }
    server.server.oninitialized = identify
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
    // An initialize that failed never got a session: drop the transport.
    if (entry.id === null) {
      void this.closeEntry(entry)
      return
    }
    // clientInfo is known once initialize was answered: name the agent right away rather than
    // at `notifications/initialized`.
    identify()
  }

  private closed(entry: SessionEntry): void {
    if (entry.closed) return
    entry.closed = true
    if (entry.id !== null) {
      this.sessions.delete(entry.id)
      this.options.onClosed?.(entry.id)
    }
    void entry.server.close().catch(() => undefined)
  }

  private async closeEntry(entry: SessionEntry): Promise<void> {
    try {
      await entry.transport.close()
    } catch (error) {
      this.options.log?.debug('closing an MCP transport failed', String(error))
    }
    this.closed(entry)
  }

  /** Close one session (its transport and server). */
  async close(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (entry) await this.closeEntry(entry)
  }

  /** Close every session (token reset, disable, quit). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((e) => this.closeEntry(e)))
  }

  /**
   * Close sessions idle for 30 min without an open GET stream, and sessions whose client dropped
   * its GET stream and has not come back for a minute.
   */
  sweep(): void {
    const idleMs = this.options.idleMs ?? SESSION_IDLE_MS
    const goneMs = this.options.streamGoneMs ?? STREAM_GONE_MS
    const now = this.now()
    for (const entry of [...this.sessions.values()]) {
      if (entry.openStreams > 0) continue
      const quiet = now - entry.lastRequestAt
      const gone = entry.streamed && now - entry.streamClosedAt >= goneMs && quiet >= goneMs
      if (quiet >= idleMs || gone) {
        this.options.log?.info(
          gone ? 'closing a disconnected MCP session' : 'closing an idle MCP session',
        )
        void this.closeEntry(entry)
      }
    }
  }

  dispose(): void {
    clearInterval(this.sweeper)
  }
}
