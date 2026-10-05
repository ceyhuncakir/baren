/**
 * The MCP server without Electron (contract §3, §4): config and endpoint files, the HTTP
 * endpoint and sessions, the agent registry and presence, host routing, the render service, the
 * tool runtime, status and lifecycle. Everything that needs Electron (windows, OSR capture,
 * nativeImage, net) comes in through `McpPlatform` (controller.ts), so the whole service runs in
 * Node tests with fakes.
 */
import { randomBytes } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  AgentHostState,
  AgentPresenceUpdate,
  AgentResponse,
  McpSetup,
  McpState,
  McpStatus,
} from '../../renderer/types/bridge'
import type { Logger } from '../log'
import { KeyedMutex } from '../util/keyedMutex'
import { AgentRegistry, KeyedThrottle, RecentAgentsStore, type ClientInfo } from './agents'
import {
  collectCssUrlsFallback,
  collectImageSourcesFallback,
  resolveImageSources,
  type FetchLike,
} from './assets'
import { McpConfigStore, endpointUrl, portCandidates, type McpConfig } from './config'
import { Guide } from './guide'
import { HostRegistry, type HeadlessWindow, type VisibleWindowInfo } from './hosts'
import { McpHttpServer } from './httpServer'
import { AgentRpc, type RpcTarget } from './ipc'
import { RenderService, type RenderWindow } from './render'
import { allowedHosts, allowedOrigins, type RunScope } from './security'
import { SessionManager } from './sessions'
import { buildSetup } from './setup'
import {
  ToolRuntime,
  deadlines,
  type CoreLike,
  type ImageCodec,
  type ToolEnv,
} from './tools/context'
import { registerTools } from './tools/index'

/** What the service needs from Electron (or from a test). */
export interface McpPlatform {
  /** The app's visible windows with their last focus. */
  visibleWindows(): VisibleWindowInfo[]
  /** A hidden window loading `#/agent-host/<fileId>`. */
  createHeadless(fileId: string): HeadlessWindow
  /** The off-screen render window (`#/agent-render`). */
  createRenderWindow(): RenderWindow
  /** open_file: navigate a home window to the file, or open a new window. */
  showFile(fileId: string): void
  /** The window `showFile` last used shows the sign-in screen (optional; see AppEffects). */
  signInShown?(): boolean
  /** Focus a window only when the app is focused already. */
  focusIfAppFocused(webContentsId: number): void
  /** `mcp:status` / `files:changed` to every app window. */
  broadcastStatus(status: McpStatus): void
  broadcastFilesChanged(): void
  /** `agent:presence` to one renderer. */
  sendPresence(target: RpcTarget, update: AgentPresenceUpdate): void
  /** Network fetch for image sources (Electron net in the app). */
  fetch: FetchLike
  codec: ImageCodec
  /** The stdio launch command (`$APPIMAGE` or `process.execPath`). */
  stdioCommand(): string
}

export interface McpServiceFlags {
  mcp: boolean | null
  mcpPort: number | null
  mcpAllowedOrigins: readonly string[]
  exportDir: string | null
  mcpToolTimeoutMs: number | null
}

export interface McpServiceDeps {
  appVersion: string
  userDataDir: string
  downloadsDir: string
  core(): Promise<CoreLike & { putAsset(bytes: Uint8Array, mime: string): Promise<string> }>
  /** The bundled stdio shim (`out/main/mcp-stdio.js`); copied to `<userData>/mcp/`. */
  shimSource: string | null
  flags: McpServiceFlags
  platform: McpPlatform
  log: Logger
  /** The server is listening (startup timeline). */
  onListening?(url: string): void
  /** @baren/html's source collectors (loaded on first use; fallbacks otherwise). */
  html?: () => Promise<HtmlSources>
}

/** The subset of @baren/html main uses (§4.8). */
export interface HtmlSources {
  collectImageSources?(html: string): string[]
  collectCssUrls?(styles: Record<string, unknown>): string[]
}

export class McpService {
  protected readonly log: Logger
  readonly config: McpConfigStore
  readonly guide = new Guide()
  readonly rpc: AgentRpc
  readonly recent: RecentAgentsStore
  readonly agents: AgentRegistry
  readonly hosts: HostRegistry
  readonly render: RenderService
  readonly sessions: SessionManager
  readonly http: McpHttpServer
  readonly runtime: ToolRuntime
  private readonly presenceThrottle: KeyedThrottle
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private html: Promise<HtmlSources> | null = null

  private cfg: McpConfig | null = null
  private state: McpState = 'starting'
  private error: string | null = null
  private portChanged = false
  private enabledOverride: boolean | null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private lastStatusAt = 0
  private readonly listeners = new Set<() => void>()
  private stopped = false
  /** Comment requests' run tokens → their scope. Memory only: a token ends with its run. */
  private readonly runTokens = new Map<string, RunScope>()

  constructor(protected readonly deps: McpServiceDeps) {
    this.log = deps.log
    this.enabledOverride = deps.flags.mcp
    this.config = new McpConfigStore(deps.userDataDir, this.log)
    this.rpc = new AgentRpc({ log: this.log })
    this.recent = new RecentAgentsStore(this.config.paths.agents, { log: this.log })
    this.presenceThrottle = new KeyedThrottle(100, (fileId) => this.pushPresence(fileId))
    this.agents = new AgentRegistry({
      recent: this.recent,
      log: this.log,
      onFilePresence: (fileId) => this.presenceThrottle.push(fileId),
      onChange: () => this.scheduleStatus(),
    })
    const timeouts = deadlines(deps.flags.mcpToolTimeoutMs)
    const platform = deps.platform
    this.hosts = new HostRegistry({
      visibleWindows: () => platform.visibleWindows(),
      createHeadless: (fileId) => platform.createHeadless(fileId),
      release: (target, fileId, timeoutMs) =>
        this.rpc
          .request(target, { fileId, tool: 'release', args: {}, timeoutMs })
          .then(() => undefined),
      hasWorkingSet: (fileId) => this.agents.hasWorkingSet(fileId),
      inFlight: (id) => this.rpc.inFlightFor(id),
      onOpened: (fileId) => this.presenceThrottle.push(fileId),
      log: this.log,
      startTimeoutMs: timeouts.hostStart,
      releaseTimeoutMs: timeouts.release,
    })
    this.render = new RenderService({
      create: () => platform.createRenderWindow(),
      rpc: this.rpc,
      log: this.log,
      timeoutMs: timeouts.render,
    })
    const env: ToolEnv = {
      log: this.log,
      guide: this.guide,
      agents: this.agents,
      hosts: this.hosts,
      rpc: this.rpc,
      render: this.render,
      writes: new KeyedMutex(),
      deadlines: timeouts,
      core: () => deps.core(),
      app: {
        showFile: (fileId) => platform.showFile(fileId),
        ...(platform.signInShown ? { signInShown: () => platform.signInShown!() } : {}),
        focusIfAppFocused: (id) => platform.focusIfAppFocused(id),
        filesChanged: () => platform.broadcastFilesChanged(),
        exportDir: (fileName) =>
          join(deps.flags.exportDir ?? join(deps.downloadsDir, 'Baren'), fileName),
      },
      codec: platform.codec,
      collectHtmlSources: async (html) => {
        const m = await this.htmlApi()
        return typeof m.collectImageSources === 'function'
          ? m.collectImageSources(html)
          : collectImageSourcesFallback(html)
      },
      collectStyleSources: async (styles) => {
        const m = await this.htmlApi()
        return typeof m.collectCssUrls === 'function'
          ? m.collectCssUrls(styles)
          : collectCssUrlsFallback(styles)
      },
      resolveSources: (sources, signal, policy) =>
        resolveImageSources(
          sources,
          {
            putAsset: async (bytes, mime) => (await deps.core()).putAsset(bytes, mime),
            fetch: platform.fetch,
          },
          signal,
          policy,
        ),
      headers: new Map(),
    }
    this.runtime = new ToolRuntime(env)
    this.sessions = new SessionManager({
      createServer: (ref) => {
        const server = new McpServer(
          { name: 'baren', title: 'Baren', version: deps.appVersion },
          { instructions: this.guide.serverInstructions, capabilities: { tools: {} } },
        )
        registerTools(server, this.runtime, ref)
        return server
      },
      onOpened: (id) => {
        this.agents.open(id)
      },
      onIdentified: (id, client) => {
        const info: ClientInfo = {
          name: client?.name ?? 'unknown',
          version: client?.version,
          title: client?.title,
        }
        const agent = this.agents.identify(id, info)
        if (agent) {
          this.log.info('MCP session opened', {
            name: agent.name,
            client: agent.client,
            version: agent.version,
          })
        }
      },
      onClosed: (id) => {
        const agent = this.agents.get(id)
        this.agents.close(id)
        this.log.info('MCP session closed', agent ? { name: agent.name } : undefined)
      },
      allowedHosts: () => allowedHosts(this.http.port ?? 0),
      allowedOrigins: () => allowedOrigins(this.http.port ?? 0, deps.flags.mcpAllowedOrigins),
      log: this.log,
    })
    this.http = new McpHttpServer({
      security: () => ({
        token: this.cfg?.token ?? '',
        runTokens: this.runTokens,
        extraOrigins: deps.flags.mcpAllowedOrigins,
      }),
      handle: (req, res, scope) => this.sessions.handle(req, res, scope),
      log: this.log,
    })
    const sweep = setInterval(() => this.agents.sweep(), 1_000)
    const hostSweep = setInterval(() => void this.hosts.sweep(), 10_000)
    sweep.unref?.()
    hostSweep.unref?.()
    this.timers.push(sweep, hostSweep)
  }

  private htmlApi(): Promise<HtmlSources> {
    this.html ??= (this.deps.html?.() ?? Promise.resolve({})).catch(() => ({}))
    return this.html
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  get enabled(): boolean {
    return this.enabledOverride ?? this.cfg?.enabled ?? true
  }

  async start(): Promise<void> {
    try {
      this.cfg = await this.config.load()
      await this.recent.load()
      await this.copyShim()
      if (this.enabled) await this.listen()
      else this.setState('off')
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.setState('error')
      this.log.error('MCP server failed to start', error)
    }
  }

  private async listen(): Promise<void> {
    if (this.http.listening) return
    const cfg = this.cfg ?? (await this.config.load())
    this.setState('starting')
    this.error = null
    this.portChanged = false
    try {
      const override = this.deps.flags.mcpPort
      const port = await this.http.listen(portCandidates(cfg.port, override))
      if (override === null && port !== cfg.port) {
        this.portChanged = true
        this.cfg = await this.config.update({ port })
        this.log.info(`MCP port changed from ${cfg.port} to ${port}`)
      }
      await this.config.writeEndpoint({
        version: 1,
        url: endpointUrl(port),
        port,
        pid: process.pid,
        appVersion: this.deps.appVersion,
        startedAt: Date.now(),
      })
      this.http.setShuttingDown(false)
      this.setState('running')
      this.log.info(`MCP server listening on ${endpointUrl(port)}`)
      this.deps.onListening?.(endpointUrl(port))
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.setState('error')
      this.log.warn('MCP server could not listen', this.error)
    }
  }

  private async stopListening(): Promise<void> {
    await this.sessions.closeAll()
    this.agents.closeAll()
    await this.http.close()
    await this.config.removeEndpoint().catch(() => undefined)
    await this.hosts.releaseAll(3_000)
    this.render.close()
    this.log.info('MCP server stopped')
  }

  /** Copy the stdio shim next to the config when the bytes differ (§4.12). */
  private async copyShim(): Promise<void> {
    if (this.deps.shimSource === null) return
    try {
      const source = await readFile(this.deps.shimSource)
      const current = await readFile(this.config.paths.shim).catch(() => null)
      if (current && current.equals(source)) return
      await this.config.ensureDir()
      await writeFile(this.config.paths.shim, source, { mode: 0o700 })
      if (process.platform !== 'win32') await chmod(this.config.paths.shim, 0o700)
    } catch (error) {
      this.log.warn('could not install the MCP stdio shim', String(error))
    }
  }

  /** Quit: 503 for new requests, cancel in-flight ones, flush headless hosts, clean up. */
  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.http.setShuttingDown(true)
    this.rpc.cancelAll()
    await this.hosts.releaseAll(3_000).catch(() => undefined)
    this.render.dispose()
    await this.sessions.closeAll().catch(() => undefined)
    this.sessions.dispose()
    await this.http.close().catch(() => undefined)
    await this.config.removeEndpoint().catch(() => undefined)
    await this.recent.flush().catch(() => undefined)
    this.presenceThrottle.cancel()
    for (const t of this.timers) clearInterval(t)
    if (this.statusTimer) clearTimeout(this.statusTimer)
  }

  // ---- status -------------------------------------------------------------------------------

  private setState(state: McpState): void {
    this.state = state
    this.scheduleStatus(true)
    for (const cb of [...this.listeners]) cb()
  }

  status(): McpStatus {
    const port = this.http.port
    const running = this.state === 'running' && port !== null
    return {
      state: this.state,
      enabled: this.enabled,
      url: running ? endpointUrl(port) : null,
      port: running ? port : null,
      portChanged: running && this.portChanged,
      error: this.state === 'error' ? this.error : null,
      agents: this.agents.statusAgents(),
    }
  }

  /** Broadcasts are throttled to 2 per second (state changes go out at once). */
  private scheduleStatus(immediate = false): void {
    const now = Date.now()
    if (immediate || now - this.lastStatusAt >= 500) {
      if (this.statusTimer) {
        clearTimeout(this.statusTimer)
        this.statusTimer = null
      }
      this.lastStatusAt = now
      this.deps.platform.broadcastStatus(this.status())
      return
    }
    if (this.statusTimer) return
    this.statusTimer = setTimeout(
      () => {
        this.statusTimer = null
        this.lastStatusAt = Date.now()
        this.deps.platform.broadcastStatus(this.status())
      },
      500 - (now - this.lastStatusAt),
    )
    this.statusTimer.unref?.()
  }

  /** Resolves once the server listens (or failed / is off). */
  whenSettled(timeoutMs: number): Promise<McpStatus> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.listeners.delete(done)
        resolve(this.status())
      }, timeoutMs)
      const done = (): void => {
        if (this.state === 'starting') return
        clearTimeout(timer)
        this.listeners.delete(done)
        resolve(this.status())
      }
      this.listeners.add(done)
      done()
    })
  }

  /** The token, for local probes (smoke) and tests; never logged. */
  get token(): string | null {
    return this.cfg?.token ?? null
  }

  async setEnabled(enabled: boolean): Promise<McpStatus> {
    this.cfg = await this.config.update({ enabled })
    this.enabledOverride = null
    if (enabled) {
      this.stopped = false
      await this.listen()
    } else {
      await this.stopListening()
      this.setState('off')
    }
    return this.status()
  }

  async setup(): Promise<McpSetup> {
    const port = this.http.port
    if (this.state !== 'running' || port === null || !this.cfg) {
      throw new Error('The MCP server is off')
    }
    return buildSetup({
      url: endpointUrl(port),
      token: this.cfg.token,
      command: this.deps.platform.stdioCommand(),
      args: [this.config.paths.shim],
    })
  }

  /**
   * Access for one comment request run (`agentRuns/`): a fresh token whose sessions work on
   * `scope.fileId` only and resolve only public image sources (tools/runScope.ts). `revoke`
   * when the run ends: the token stops working and its sessions close.
   */
  runAccess(scope: RunScope): { url: string; token: string; revoke(): Promise<void> } {
    const port = this.http.port
    if (this.state !== 'running' || port === null) throw new Error('The MCP server is off')
    const token = `brr_${randomBytes(32).toString('base64url')}`
    this.runTokens.set(token, scope)
    return {
      url: endpointUrl(port),
      token,
      revoke: async () => {
        this.runTokens.delete(token)
        await this.sessions.closeRun(scope.runId)
      },
    }
  }

  async resetToken(): Promise<McpSetup> {
    this.cfg = await this.config.rotateToken()
    this.http.limiter.reset()
    await this.sessions.closeAll()
    this.agents.closeAll()
    this.log.info('MCP token reset')
    this.scheduleStatus(true)
    return this.setup()
  }

  // ---- messages from renderers --------------------------------------------------------------

  handleResponse(senderId: number, response: AgentResponse): void {
    this.rpc.handleResponse(senderId, response)
  }

  handleHostState(target: RpcTarget, state: AgentHostState): void {
    this.hosts.hostState(target, state)
  }

  /** A renderer went away (destroyed, crashed, navigated). */
  targetGone(webContentsId: number, reason: string): void {
    this.hosts.webContentsGone(webContentsId)
    this.rpc.targetGone(webContentsId, reason)
    this.render.windowGone(webContentsId)
  }

  /** `files:open` from a visible window: a headless host holding the file hands off (§4.5). */
  async beforeOpen(senderId: number, fileId: string): Promise<void> {
    if (this.hosts.isHeadless(senderId)) return
    await this.runtime.env.writes.run(fileId, () => this.hosts.beforeVisibleOpen(fileId, senderId))
  }

  private pushPresence(fileId: string): void {
    const update: AgentPresenceUpdate = { fileId, agents: this.agents.presenceFor(fileId) }
    for (const target of this.hosts.targetsFor(fileId)) {
      this.deps.platform.sendPresence(target, update)
    }
  }
}
