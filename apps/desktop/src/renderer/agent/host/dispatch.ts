/**
 * Request → executor (contract §4.6, §11.1): one `AbortController` per request id, the deadline
 * as a timer, the read-only check before writes, writes serialised (main serialises them per
 * file too; this keeps a test hook or a misbehaving caller from interleaving), error mapping,
 * the `{ file, contentHash }` header and `touched`. A transaction that has started always
 * completes: cancellation is only observed between async steps.
 */
import { getDocName, getTokens } from '@baren/schema'
import type { AgentRequest, AgentResponse, FileHeader } from '../../types/bridge'
import type { HostEnv, ToolCall, ToolSpec } from '../context'
import { AgentToolError, toAgentError } from '../errors'
import { html } from '../html'
import { HOST_TOOLS } from '../tools'

export interface DispatcherOptions {
  tools?: Readonly<Record<string, ToolSpec>>
  /** Awaited before every request (e.g. fonts ready, canvas mounted). */
  beforeRun?: () => Promise<void>
  now?: () => number
}

/** Why a request's signal aborted. */
type AbortWhy = 'timeout' | 'cancelled'

export class Dispatcher {
  private readonly pending = new Map<string, { ac: AbortController; why: AbortWhy | null }>()
  private writeQueue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(
    readonly env: HostEnv,
    private readonly opts: DispatcherOptions = {},
  ) {}

  header(): FileHeader {
    const { env } = this
    return {
      file: { id: env.fileId, name: env.fileName() || getDocName(env.doc) || 'Untitled' },
      contentHash: { tokens: html.tokensHash(getTokens(env.doc)) },
    }
  }

  /** Abort a pending request (main's `agent:cancel`). */
  cancel(id: string): void {
    const p = this.pending.get(id)
    if (!p || p.ac.signal.aborted) return
    p.why = 'cancelled'
    p.ac.abort()
  }

  dispose(): void {
    this.disposed = true
    for (const id of [...this.pending.keys()]) this.cancel(id)
  }

  async handle(req: AgentRequest): Promise<AgentResponse> {
    const spec = (this.opts.tools ?? HOST_TOOLS)[req.tool]
    if (!spec) {
      return {
        id: req.id,
        ok: false,
        error: { code: 'unsupported', message: `The host does not run ${req.tool}.` },
      }
    }
    if (this.disposed) {
      return {
        id: req.id,
        ok: false,
        error: { code: 'host_unavailable', message: 'The file was closed.' },
      }
    }
    const entry = { ac: new AbortController(), why: null as AbortWhy | null }
    this.pending.set(req.id, entry)
    const now = this.opts.now ?? Date.now
    const remaining = Math.max(0, req.deadline - now())
    const timer = setTimeout(() => {
      if (entry.ac.signal.aborted) return
      entry.why = 'timeout'
      entry.ac.abort()
    }, remaining)
    const call: ToolCall = {
      tool: req.tool,
      env: this.env,
      args:
        typeof req.args === 'object' && req.args !== null
          ? (req.args as Record<string, unknown>)
          : {},
      agent: req.agent,
      assets: req.assets ?? {},
      signal: entry.ac.signal,
    }
    const aborted = (): AgentToolError | null => {
      if (!entry.ac.signal.aborted) return null
      return entry.why === 'timeout'
        ? new AgentToolError('timeout', `${req.tool} did not finish before its deadline.`)
        : new AgentToolError('cancelled', 'The request was cancelled.')
    }
    const run = async (): Promise<AgentResponse> => {
      try {
        if (req.deadline <= now()) {
          entry.why = 'timeout'
          entry.ac.abort()
        }
        if (this.opts.beforeRun) await this.opts.beforeRun()
        const early = aborted()
        if (early) throw early
        if (spec.write && this.env.readOnly && (await this.env.readOnly())) {
          throw new AgentToolError(
            'read_only',
            'You can only view this shared file: the user is a viewer. Ask the file owner for edit access.',
          )
        }
        const before = aborted()
        if (before) throw before
        const out = await spec.run(call)
        const res: AgentResponse = {
          id: req.id,
          ok: true,
          header: spec.header === false ? null : this.header(),
          result: out.result,
        }
        if (out.touched && out.touched.length > 0) res.touched = [...new Set(out.touched)]
        return res
      } catch (error) {
        const late = error instanceof AgentToolError ? null : aborted()
        return { id: req.id, ok: false, error: toAgentError(late ?? error) }
      }
    }
    try {
      if (!spec.write) return await run()
      const result = this.writeQueue.then(run, run)
      this.writeQueue = result.catch(() => undefined)
      return await result
    } finally {
      clearTimeout(timer)
      this.pending.delete(req.id)
      // An agent is at work: get the whole-file mirror ready in idle time.
      if (!this.disposed) this.env.index.warm()
    }
  }
}
