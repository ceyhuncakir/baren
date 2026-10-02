/**
 * Request/response over IPC with the renderers that do the document and pixel work
 * (contract §4.6): `agent:request` → `agent:response`, with ids, deadlines and cancellation.
 *
 * - Ids are `r<n>`, unique per main process.
 * - A response from another webContents than the one asked is ignored (logged).
 * - On the deadline main sends `agent:cancel` and fails the call with `timeout`; an aborted
 *   signal (the client cancelled, or the session closed) sends `agent:cancel` and fails with
 *   `cancelled`. A host that goes away fails its pending requests with `host_unavailable`.
 */
import type {
  AgentPresenceUpdate,
  AgentRequest,
  AgentResponse,
  AgentToolName,
  FileHeader,
  ResolvedSource,
} from '../../renderer/types/bridge'
import type { Logger } from '../log'
import { ToolError } from './format'

/** Where a request goes: a host window or the render window. */
export interface RpcTarget {
  readonly webContentsId: number
  isDestroyed(): boolean
  send(channel: 'agent:request', request: AgentRequest): void
  send(channel: 'agent:cancel', id: string): void
  send(channel: 'agent:presence', update: AgentPresenceUpdate): void
}

export interface RpcCall {
  fileId: string | null
  tool: AgentToolName
  args: unknown
  agent?: AgentRequest['agent']
  assets?: Record<string, ResolvedSource>
  timeoutMs: number
  signal?: AbortSignal
}

export interface RpcOk {
  header: FileHeader | null
  result: unknown
  touched: string[]
}

interface Pending {
  target: RpcTarget
  tool: AgentToolName
  resolve(value: RpcOk): void
  reject(error: ToolError): void
  timer: ReturnType<typeof setTimeout>
  cleanup(): void
}

export class AgentRpc {
  private seq = 0
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly options: { log?: Logger; now?: () => number } = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  get inFlight(): number {
    return this.pending.size
  }

  /** In-flight request count for one target. */
  inFlightFor(webContentsId: number): number {
    let n = 0
    for (const p of this.pending.values()) if (p.target.webContentsId === webContentsId) n++
    return n
  }

  request(target: RpcTarget, call: RpcCall): Promise<RpcOk> {
    if (call.signal?.aborted) {
      return Promise.reject(new ToolError('cancelled', 'The request was cancelled'))
    }
    if (target.isDestroyed()) {
      return Promise.reject(
        new ToolError('host_unavailable', 'The window that has this file open is gone; try again'),
      )
    }
    const id = `r${++this.seq}`
    const request: AgentRequest = {
      id,
      fileId: call.fileId,
      tool: call.tool,
      args: call.args,
      agent: call.agent ?? null,
      ...(call.assets && Object.keys(call.assets).length > 0 ? { assets: call.assets } : {}),
      deadline: this.now() + call.timeoutMs,
    }
    return new Promise<RpcOk>((resolve, reject) => {
      const onAbort = (): void => {
        this.fail(id, new ToolError('cancelled', 'The request was cancelled'), true)
      }
      const timer = setTimeout(() => {
        this.fail(
          id,
          new ToolError(
            'timeout',
            `${call.tool} did not finish within ${Math.round(call.timeoutMs / 1000)} s`,
          ),
          true,
        )
      }, call.timeoutMs)
      timer.unref?.()
      call.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        target,
        tool: call.tool,
        resolve,
        reject,
        timer,
        cleanup: () => call.signal?.removeEventListener('abort', onAbort),
      })
      try {
        target.send('agent:request', request)
      } catch (error) {
        this.fail(
          id,
          new ToolError('host_unavailable', `Could not reach the window: ${String(error)}`),
          false,
        )
      }
    })
  }

  private fail(id: string, error: ToolError, cancel: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.cleanup()
    if (cancel && !p.target.isDestroyed()) {
      try {
        p.target.send('agent:cancel', id)
      } catch {
        // The window is going away: nothing left to cancel.
      }
    }
    p.reject(error)
  }

  /** An `agent:response` arrived from `senderId`. */
  handleResponse(senderId: number, response: AgentResponse): void {
    const p = this.pending.get(response.id)
    if (!p) {
      this.options.log?.debug('late or unknown agent response', { id: response.id })
      return
    }
    if (p.target.webContentsId !== senderId) {
      this.options.log?.warn('ignored agent response from another window', { id: response.id })
      return
    }
    this.pending.delete(response.id)
    clearTimeout(p.timer)
    p.cleanup()
    if (response.ok) {
      p.resolve({
        header: response.header,
        result: response.result,
        touched: Array.isArray(response.touched) ? response.touched : [],
      })
    } else {
      p.reject(new ToolError(response.error.code, response.error.message, response.error.data))
    }
  }

  /** A host or the render window went away: its requests fail with `host_unavailable`. */
  targetGone(webContentsId: number, reason = 'The window that served this request closed'): void {
    for (const [id, p] of [...this.pending]) {
      if (p.target.webContentsId === webContentsId) {
        this.fail(id, new ToolError('host_unavailable', `${reason}; try again`), false)
      }
    }
  }

  /** Fail everything (quit). */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.fail(id, new ToolError('cancelled', 'Baren is quitting'), true)
    }
  }
}
