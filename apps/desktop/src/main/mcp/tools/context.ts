/**
 * What every tool handler works with: file resolution (contract §4.5), host calls with write
 * serialisation (§4.6), deadlines, agent bookkeeping (§4.4) and the last header per file.
 */
import type {
  AgentToolName,
  FileHeader,
  FileMeta,
  ResolvedSource,
} from '../../../renderer/types/bridge'
import type { Logger } from '../../log'
import type { KeyedMutex } from '../../util/keyedMutex'
import type { AgentRegistry, AgentSession } from '../agents'
import { ToolError, isToolError } from '../format'
import type { Guide } from '../guide'
import type { HostRegistry } from '../hosts'
import type { AgentRpc, RpcOk, RpcTarget } from '../ipc'
import type { RenderService } from '../render'
import type { SourcePolicy } from '../assets'
import type { RunScope } from '../security'

/** Deadlines in ms (contract §4.6); BAREN_MCP_TOOL_TIMEOUT_MS replaces every one. */
export interface Deadlines {
  read: number
  writeHtml: number
  write: number
  render: number
  screenshot: number
  export: number
  hostStart: number
  release: number
}

export const DEFAULT_DEADLINES: Deadlines = {
  read: 30_000,
  writeHtml: 60_000,
  write: 30_000,
  render: 30_000,
  screenshot: 45_000,
  export: 120_000,
  hostStart: 20_000,
  release: 5_000,
}

export function deadlines(override: number | null): Deadlines {
  if (override === null) return DEFAULT_DEADLINES
  return {
    read: override,
    writeHtml: override,
    write: override,
    render: override,
    screenshot: override,
    export: override,
    hostStart: override,
    release: Math.min(override, DEFAULT_DEADLINES.release),
  }
}

/** The core operations tools use. */
export interface CoreLike {
  listFiles(): Promise<FileMeta[]>
  createFile(name: string): Promise<FileMeta>
  openFile(id: string): Promise<Uint8Array>
  importFile(snapshot: Uint8Array, name: string | null): Promise<FileMeta>
  getAsset(hash: string): Promise<Uint8Array | null>
}

/** Image encoding available in main (Electron nativeImage); null when it cannot decode. */
export interface ImageCodec {
  toJpeg(
    bytes: Uint8Array,
    maxSide: number,
    quality: number,
  ): { bytes: Uint8Array; width: number; height: number } | null
}

/** App-level effects of tools (windows, broadcasts, disk). */
export interface AppEffects {
  /** Show `fileId` in a visible window (navigate a home window or open a new one). */
  showFile(fileId: string): void
  /**
   * The window `showFile` last navigated or opened shows the sign-in screen (signed out and
   * "Continue offline" not chosen), so the file cannot open there until the user acts.
   */
  signInShown?(): boolean
  /** Focus a window, but only when the app is focused already (never steal focus). */
  focusIfAppFocused(webContentsId: number): void
  /** `files:changed` to every app window. */
  filesChanged(): void
  /** The export directory for a file (created by the caller). */
  exportDir(fileName: string): string
}

export interface ToolEnv {
  log: Logger
  guide: Guide
  agents: AgentRegistry
  hosts: HostRegistry
  rpc: AgentRpc
  render: RenderService
  writes: KeyedMutex
  deadlines: Deadlines
  core(): Promise<CoreLike>
  app: AppEffects
  codec: ImageCodec
  /** `collectImageSources` / `collectCssUrls` of @baren/html (or the fallbacks). */
  collectHtmlSources(html: string): Promise<string[]>
  collectStyleSources(styles: Record<string, unknown>): Promise<string[]>
  resolveSources(
    sources: string[],
    signal?: AbortSignal,
    policy?: SourcePolicy,
  ): Promise<Record<string, ResolvedSource>>
  /** The last header each file's host answered with (errors and presence-only tools reuse it). */
  headers: Map<string, FileHeader>
}

export interface SessionRef {
  sessionId: string
  /** A comment request's session: one file, public image sources (tools/index.ts). */
  scope?: RunScope | null
}

export interface ParsedFileRef {
  fileId: string
  pageId: string | null
}

/**
 * Accepts a bare id, `baren://file/<id>[/<pageId>]`, `#/file/<id>`, `/file/<id>` and
 * `https://baren.dev/file/<id>[/<pageId>]`.
 */
export function parseFileRef(raw: string): ParsedFileRef | null {
  const value = raw.trim()
  if (value === '') return null
  const decode = (s: string | undefined): string | null => {
    if (s === undefined || s === '') return null
    try {
      return decodeURIComponent(s)
    } catch {
      return null
    }
  }
  const patterns = [
    /^baren:\/\/file\/([^/?#]+)(?:\/([^/?#]+))?\/?$/i,
    /^https?:\/\/(?:www\.)?baren\.dev\/file\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#].*)?$/i,
    /^#?\/file\/([^/?#]+)(?:\/([^/?#]+))?\/?$/,
  ]
  for (const pattern of patterns) {
    const m = pattern.exec(value)
    if (m) {
      const fileId = decode(m[1])
      return fileId ? { fileId, pageId: decode(m[2]) } : null
    }
  }
  if (/[\s/#?]/.test(value) || value.length > 256) return null
  return { fileId: value, pageId: null }
}

export function fileUrl(fileId: string, pageId?: string | null): string {
  const base = `baren://file/${encodeURIComponent(fileId)}`
  return pageId ? `${base}/${encodeURIComponent(pageId)}` : base
}

/** Combine the client's signal with a deadline; `expired()` tells the two apart. */
export function withDeadline(
  signal: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; expired(): boolean; done(): void } {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, ms)
  timer.unref?.()
  const onAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    expired: () => expired,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** Run `fn` under a deadline; a deadline abort surfaces as `timeout`, not `cancelled`. */
export async function underDeadline<T>(
  signal: AbortSignal | undefined,
  ms: number,
  what: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const d = withDeadline(signal, ms)
  try {
    return await fn(d.signal)
  } catch (error) {
    if (d.expired()) {
      throw new ToolError('timeout', `${what} did not finish within ${Math.round(ms / 1000)} s`)
    }
    throw error
  } finally {
    d.done()
  }
}

export interface HostCallResult extends RpcOk {
  fileId: string
  target: RpcTarget
}

export class ToolRuntime {
  private filesCache: { at: number; files: FileMeta[] } | null = null

  constructor(readonly env: ToolEnv) {}

  agentOf(session: SessionRef): AgentSession {
    const agent = this.env.agents.get(session.sessionId)
    if (agent) return agent
    // A tool call before `notifications/initialized` (or after a restart of the registry).
    return this.env.agents.open(session.sessionId)
  }

  async listFiles(maxAgeMs = 1_000): Promise<FileMeta[]> {
    const now = Date.now()
    if (this.filesCache && now - this.filesCache.at <= maxAgeMs) return this.filesCache.files
    const files = await (await this.env.core()).listFiles()
    this.filesCache = { at: now, files }
    return files
  }

  invalidateFiles(): void {
    this.filesCache = null
  }

  async fileMeta(fileId: string): Promise<FileMeta | null> {
    let meta = (await this.listFiles()).find((f) => f.id === fileId) ?? null
    if (!meta) meta = (await this.listFiles(0)).find((f) => f.id === fileId) ?? null
    return meta
  }

  /**
   * The file a call works on: `fileId` (any accepted form, must exist) or the file in the window
   * the user last used.
   */
  async resolveFile(raw: string | undefined | null): Promise<ParsedFileRef> {
    if (raw === undefined || raw === null || raw.trim() === '') {
      const fileId = this.env.hosts.defaultFileId()
      if (fileId === null) {
        throw new ToolError(
          'no_file_open',
          'No file is open in Baren. Pass fileId (find one with list_files) or call open_file first.',
        )
      }
      return { fileId, pageId: null }
    }
    const ref = parseFileRef(raw)
    if (!ref)
      throw new ToolError(
        'file_not_found',
        `"${raw.slice(0, 80)}" is not a file ID or URL; call list_files`,
      )
    // Open in a window: it exists (and may not be in the list yet right after an import). A
    // hidden host does not prove it: the user may have deleted the file from Home meanwhile, and
    // writes into the host's copy would report success and go nowhere.
    if (this.env.hosts.visibleHost(ref.fileId)) return ref
    if (!(await this.fileMeta(ref.fileId))) {
      if (this.env.hosts.isHeadlessFile(ref.fileId)) void this.env.hosts.releaseHeadless(ref.fileId)
      throw new ToolError('file_not_found', `No file with ID ${ref.fileId}; call list_files`)
    }
    return ref
  }

  agentRef(session: SessionRef): { sessionId: string; presenceId: string; name: string } {
    const agent = this.agentOf(session)
    return { sessionId: agent.sessionId, presenceId: agent.presenceId, name: agent.name }
  }

  /**
   * Forward a tool (or an internal step) to the host of `fileId`. Writes run through the per-file
   * mutex, so writes to one file never interleave.
   */
  async callHost(
    session: SessionRef | null,
    fileId: string,
    tool: AgentToolName,
    args: unknown,
    opts: {
      write: boolean
      timeoutMs: number
      signal?: AbortSignal
      assets?: Record<string, ResolvedSource>
      /** Count this call as agent activity on the file (default true for sessions). */
      activity?: boolean
    },
  ): Promise<HostCallResult> {
    const run = async (): Promise<HostCallResult> => {
      // A lease keeps a headless host from being released while this request uses it.
      const { target, headless, done } = await this.env.hosts.lease(fileId, opts.signal)
      try {
        this.env.hosts.noteUse(fileId)
        const res = await this.env.rpc.request(target, {
          fileId,
          tool,
          args,
          agent: session ? this.agentRef(session) : null,
          timeoutMs: opts.timeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.assets ? { assets: opts.assets } : {}),
        })
        return { ...res, fileId, target }
      } catch (error) {
        // A hidden host that missed a deadline may be hung: if it does not answer a ping
        // either, it is discarded and the next request opens the file afresh (contract §13).
        if (headless && isToolError(error) && error.code === 'timeout') {
          void this.env.hosts.probe(target, () =>
            this.env.rpc.request(target, { fileId, tool: 'flush', args: {}, timeoutMs: 2_000 }),
          )
        }
        throw error
      } finally {
        done()
      }
    }
    const res = opts.write ? await this.env.writes.run(fileId, run) : await run()
    if (res.header) this.env.headers.set(fileId, res.header)
    if (session && opts.activity !== false) {
      this.env.agents.noteCall(session.sessionId, fileId, res.header?.file.name ?? null)
      this.env.agents.touch(session.sessionId, fileId, res.touched, opts.write)
    }
    return res
  }

  /** Header to show with an error for `fileId`, if one is known. */
  headerFor(fileId: string | null): FileHeader | null {
    return fileId === null ? null : (this.env.headers.get(fileId) ?? null)
  }
}
