/**
 * Baren MCP stdio shim (contract §4.12): for MCP clients that only speak stdio.
 *
 * Bundled into one self-contained CommonJS file (`out/main/mcp-stdio.js`, no `electron`
 * import), copied by the app to `<userData>/mcp/baren-mcp-stdio.cjs`, and run by the client as
 * `ELECTRON_RUN_AS_NODE=1 <app executable> <shim>` (or `node <shim>`). It pipes JSON-RPC between
 * stdin/stdout (SDK `StdioServerTransport`) and the app's Streamable HTTP endpoint (SDK
 * `StreamableHTTPClientTransport`), reading the URL from `endpoint.json` and the token from
 * `config.json` next to itself, so client configurations never hold a secret.
 *
 * - App not running (no endpoint, or its pid is gone): the first request gets JSON-RPC error
 *   -32002 and the shim exits 1.
 * - The app restarted (HTTP 404 for our session), the token was regenerated (401 and a new token
 *   in `config.json`) or the app came back on another port (a network error and a new URL in
 *   `endpoint.json`): re-read the endpoint, replay the client's `initialize` and
 *   `notifications/initialized` (swallowing that `initialize` response), resend the failed
 *   message. Anything else that fails exits 1.
 * - Logs go to stderr only.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

const NOT_RUNNING = 'Baren is not running (or its MCP server is off). Open the app, then reconnect.'

interface Endpoint {
  url: string
  token: string
}

function log(message: string): void {
  process.stderr.write(`[baren-mcp-stdio] ${message}\n`)
}

function shimDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname
  return dirname(fileURLToPath(import.meta.url))
}

function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The running app's endpoint and token, or null when the app (or its server) is not running. */
export function readEndpoint(dir: string = shimDir()): Endpoint | null {
  try {
    const endpoint = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as {
      url?: unknown
      pid?: unknown
    }
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      token?: unknown
    }
    if (typeof endpoint.url !== 'string' || typeof config.token !== 'string') return null
    if (!isAlive(endpoint.pid)) return null
    return { url: endpoint.url, token: config.token }
  } catch {
    return null
  }
}

function hasId(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
  return 'id' in message && message.id !== undefined && message.id !== null
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & {
  id: string | number
  method: string
} {
  return 'method' in message && hasId(message)
}

/**
 * Whether a failed HTTP send means "the app's endpoint changed under us", so the session should be
 * re-established with the client's original handshake:
 * - 404: the app restarted (our session id is unknown);
 * - 401 while `config.json` now holds another token: the user regenerated the token (stdio
 *   configurations hold no secret, so they keep working; contract §3.2);
 * - a network error while `endpoint.json` now names another URL: the app came back on another
 *   port.
 */
export function shouldReconnect(
  error: unknown,
  current: Endpoint | null,
  read: () => Endpoint | null = () => readEndpoint(),
): boolean {
  if (error instanceof StreamableHTTPError) {
    if (error.code === 404) return true
    if (error.code === 401) {
      const next = read()
      return next !== null && current !== null && next.token !== current.token
    }
    return false
  }
  const next = read()
  return next !== null && current !== null && next.url !== current.url
}

function errorResponse(id: string | number | null, message: string): JSONRPCMessage {
  return { jsonrpc: '2.0', id: id as string | number, error: { code: -32002, message } }
}

/** The bridge between one stdio client and the app. */
export async function runShim(): Promise<void> {
  const stdio = new StdioServerTransport()
  let endpoint = readEndpoint()
  let http: StreamableHTTPClientTransport | null = null
  let initialize: (JSONRPCMessage & { id: string | number; method: string }) | null = null
  let initializedSent = false
  let swallowId: string | null = null
  let replayWaiter: ((message: JSONRPCMessage) => void) | null = null
  let queue: Promise<void> = Promise.resolve()
  let exiting = false
  let replays = 0

  const exit = (code: number): void => {
    if (exiting) return
    exiting = true
    // Let stdout drain before leaving.
    setTimeout(() => process.exit(code), 50)
  }

  const connect = async (ep: Endpoint): Promise<StreamableHTTPClientTransport> => {
    const transport = new StreamableHTTPClientTransport(new URL(ep.url), {
      requestInit: { headers: { Authorization: `Bearer ${ep.token}` } },
    })
    transport.onmessage = (message) => {
      if (swallowId !== null && hasId(message) && message.id === swallowId) {
        replayWaiter?.(message)
        return
      }
      if (initialize && hasId(message) && message.id === initialize.id && 'result' in message) {
        const version = (message.result as { protocolVersion?: unknown }).protocolVersion
        if (typeof version === 'string') transport.setProtocolVersion(version)
      }
      void stdio.send(message).catch((error: unknown) => log(`stdout failed: ${String(error)}`))
    }
    transport.onerror = (error) => log(`http: ${error.message}`)
    await transport.start()
    return transport
  }

  /** The app restarted: new session with the client's original handshake. */
  const replay = async (): Promise<void> => {
    if (!initialize || replays++ > 5) throw new Error('cannot re-initialize')
    const next = readEndpoint()
    if (!next) throw new Error(NOT_RUNNING)
    endpoint = next
    await http?.close().catch(() => undefined)
    http = await connect(next)
    const id = `baren-shim-reinit-${replays}`
    swallowId = id
    const answered = new Promise<JSONRPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('re-initialize timed out')), 10_000)
      replayWaiter = (message) => {
        clearTimeout(timer)
        resolve(message)
      }
    })
    await http.send({ ...initialize, id })
    const answer = await answered
    swallowId = null
    replayWaiter = null
    if ('error' in answer) throw new Error('re-initialize was refused')
    const version = ((answer as { result?: { protocolVersion?: unknown } }).result ?? {})
      .protocolVersion
    if (typeof version === 'string') http.setProtocolVersion(version)
    if (initializedSent) {
      await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    }
    log('reconnected to Baren')
  }

  const forward = async (message: JSONRPCMessage): Promise<void> => {
    if (!endpoint) {
      if (isRequest(message)) await stdio.send(errorResponse(message.id, NOT_RUNNING))
      log(NOT_RUNNING)
      exit(1)
      return
    }
    if (isRequest(message) && message.method === 'initialize') initialize = message
    if ('method' in message && message.method === 'notifications/initialized')
      initializedSent = true
    http ??= await connect(endpoint)
    try {
      await http.send(message)
    } catch (error) {
      if (initialize && message !== initialize && shouldReconnect(error, endpoint)) {
        try {
          await replay()
          await http!.send(message)
          return
        } catch (replayError) {
          log(
            `could not reconnect: ${replayError instanceof Error ? replayError.message : String(replayError)}`,
          )
        }
      } else {
        log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (isRequest(message)) {
        await stdio.send(
          errorResponse(
            message.id,
            readEndpoint() ? 'Baren refused the request; reconnect the MCP server' : NOT_RUNNING,
          ),
        )
      }
      exit(1)
    }
  }

  stdio.onmessage = (message) => {
    // In order: the initialize response must set the session before the next message goes out.
    queue = queue
      .then(() => forward(message))
      .catch((error: unknown) => {
        log(`unexpected: ${String(error)}`)
        exit(1)
      })
  }
  stdio.onerror = (error) => log(`stdin: ${error.message}`)
  process.stdin.once('end', () => {
    void queue.then(async () => {
      await http?.terminateSession().catch(() => undefined)
      await http?.close().catch(() => undefined)
      exit(0)
    })
  })
  await stdio.start()
}

void runShim().catch((error: unknown) => {
  log(`failed to start: ${String(error)}`)
  process.exit(1)
})
