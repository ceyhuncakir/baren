/**
 * The MCP HTTP endpoint (contract §4.1): `http.createServer` on 127.0.0.1 only, `/mcp` for POST,
 * GET and DELETE, everything else 404, other methods 405, no CORS headers ever. Every request
 * passes the checks of security.ts before the SDK sees it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from '../log'
import { AuthRateLimiter, checkRequest, type RunScope, type SecurityContext } from './security'
import { sendJsonRpcError } from './sessions'

export const MCP_HOST = '127.0.0.1'
export const MCP_PATH = '/mcp'

export interface McpHttpServerOptions {
  /** The current token and extra origins (the port is filled in once bound). */
  security(): Omit<SecurityContext, 'port'>
  /** Authenticated `/mcp` requests; `scope` is set for a comment request's run token. */
  handle(req: IncomingMessage, res: ServerResponse, scope: RunScope | null): Promise<void>
  log?: Logger
  limiter?: AuthRateLimiter
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

export class McpHttpServer {
  private server: Server | null = null
  private boundPort: number | null = null
  private shuttingDown = false
  readonly limiter: AuthRateLimiter

  constructor(private readonly options: McpHttpServerOptions) {
    this.limiter = options.limiter ?? new AuthRateLimiter()
  }

  get port(): number | null {
    return this.boundPort
  }

  get listening(): boolean {
    return this.server?.listening === true
  }

  /** Requests from now on get 503 (quit). */
  setShuttingDown(value = true): void {
    this.shuttingDown = value
  }

  /** Bind the first free candidate (0 = ephemeral); throws when every one is taken. */
  async listen(candidates: readonly number[]): Promise<number> {
    const server = createServer((req, res) => void this.onRequest(req, res))
    // Long-lived SSE streams: no request/headers timeouts on a loopback server.
    server.requestTimeout = 0
    server.headersTimeout = 60_000
    server.keepAliveTimeout = 5_000
    const errors: string[] = []
    for (const port of candidates) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException): void => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen({ host: MCP_HOST, port, exclusive: true })
        })
        this.server = server
        this.boundPort = (server.address() as AddressInfo).port
        return this.boundPort
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? String(error)
        errors.push(`${port === 0 ? 'ephemeral' : port}: ${code}`)
      }
    }
    const first = candidates[0]
    throw new Error(
      first !== undefined && first !== 0
        ? `port ${first} is in use (${errors.join(', ')})`
        : `could not bind the MCP server (${errors.join(', ')})`,
    )
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? '/').split('?')[0]
      if (path !== MCP_PATH) {
        sendJsonRpcError(res, 404, 'Not found')
        return
      }
      if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
        sendJsonRpcError(res, 405, 'Method not allowed', -32001, { Allow: 'GET, POST, DELETE' })
        return
      }
      const port = this.boundPort ?? 0
      const check = checkRequest(
        {
          remoteAddress: req.socket.remoteAddress,
          host: header(req, 'host'),
          origin: header(req, 'origin'),
          authorization: header(req, 'authorization'),
        },
        { ...this.options.security(), port },
        this.limiter,
        this.shuttingDown,
      )
      if (!check.ok) {
        if (check.status === 401) this.options.log?.debug('MCP request without a valid token')
        sendJsonRpcError(
          res,
          check.status,
          `${check.code}: ${check.message}`,
          -32001,
          check.headers,
        )
        return
      }
      await this.options.handle(req, res, check.scope)
    } catch (error) {
      this.options.log?.error('MCP request failed', error)
      sendJsonRpcError(res, 500, 'Internal server error', -32603)
    }
  }

  /** Stop listening and drop open connections. */
  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.boundPort = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}
