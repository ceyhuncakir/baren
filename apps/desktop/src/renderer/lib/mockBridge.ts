/**
 * In-memory implementation of the full `BarenBridge`, used when the
 * renderer runs outside Electron (Vite dev in a browser, Playwright visual
 * tests). Foundation provides a minimal version; the screens workstream
 * enriches it (fixtures, realistic files, thumbnails).
 *
 * Loro is loaded lazily (dynamic import) so screens that never open a file —
 * Recents, auth — don't pay for the WASM module at startup.
 */
import { buildSetup } from '../../main/mcp/setup'
import type {
  AgentHostState,
  AgentPresenceUpdate,
  AgentRequest,
  AgentResponse,
  AgentToolName,
  ClipboardRead,
  ClipboardWrite,
  FileMeta,
  BarenBridge,
  McpSetup,
  McpStatus,
  Platform,
  ResolvedSource,
  ResolvedTheme,
  ThemePreference,
  UpdateState,
  UpdateStatus,
} from '../types/bridge'

export interface MockFileSeed {
  name: string
  id?: string
  createdAt?: number
  updatedAt?: number
  archived?: boolean
  teamId?: string | null
  remoteId?: string | null
  /** PNG bytes, or a loader called on first getThumbnail (fixtures load lazily). */
  thumbnail?: Uint8Array | (() => Promise<Uint8Array | null>)
}

export interface MockBridgeOptions {
  platform?: Platform
  files?: MockFileSeed[]
  token?: string | null
  version?: string
  /** Clock for createdAt/updatedAt (inject a fixed clock for deterministic tests). */
  now?: () => number
  /**
   * What shell.openExternal does: 'open' a browser tab (dev), or only 'record' the URL
   * (fixture/visual-test mode, readable through `mock.openedUrls()`).
   */
  externalLinks?: 'open' | 'record'
  /**
   * Where the session token survives a page reload (browser dev). Default: memory only.
   * The real bridge keeps it in Electron safeStorage.
   */
  tokenStore?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Theme preference. Default: the page's `?theme=dark|light|system`, else 'system'. */
  theme?: ThemePreference
  /** OS dark mode for 'system'. Default: `prefers-color-scheme: dark` (followed live). */
  systemDark?: boolean
  /**
   * Simulated auto-update status (visual tests): a state name or a full status. Default: the
   * page's `?updates=ready|downloading|available|checking|none|error|disabled`, else 'idle'.
   */
  updates?: UpdateState | UpdateStatus
  /** How long a simulated `updates.check()` stays in `checking` (default 400 ms). */
  updateCheckMs?: number
  /**
   * Simulated MCP server (Phase 4): a state name or a full status. Default: the page's
   * `?mcp=off|not-connected|connected|error`, else 'not-connected'.
   */
  mcp?: MockMcpState | McpStatus
  /**
   * Install `window.__barenAgent` (the in-page agent request loop, contract §4.14). Default:
   * true when a `window` exists (browser mode).
   */
  exposeAgentLoop?: boolean
}

const TOKEN_KEY = 'baren.mock.token'

/** Test/dev hooks that the real bridge doesn't have. */
export interface MockControls {
  emitDeepLink(url: string): void
  setMaximized(value: boolean): void
  /** URLs passed to shell.openExternal, oldest first. */
  openedUrls(): readonly string[]
  /** Push an update status (as main would). */
  setUpdateStatus(status: UpdateState | UpdateStatus): void
  /** How many times `updates.install()` ran while an update was ready. */
  updateInstalls(): number
  /** Simulate the OS switching dark mode (affects the 'system' preference). */
  setSystemDark(dark: boolean): void
  /** Push an MCP status (as main would), by state name or in full. */
  setMcpStatus(status: MockMcpState | McpStatus): void
  /** The in-page agent loop (also `window.__barenAgent` in browser mode). */
  readonly agent: MockAgentLoop
}

// ---------------------------------------------------------------------------
// MCP (Phase 4, docs/phase4/contract.md §4.14)
// ---------------------------------------------------------------------------

/** The `?mcp=` states of the mock (artboards 34–36). */
export type MockMcpState = 'off' | 'not-connected' | 'connected' | 'error'
export const MOCK_MCP_STATES: readonly MockMcpState[] = [
  'off',
  'not-connected',
  'connected',
  'error',
]
export const MOCK_MCP_URL = 'http://127.0.0.1:29170/mcp'
/** Masked in the dialog as `••••••••7f3a` (artboard 34). */
export const MOCK_MCP_TOKEN = 'brn_mock_token_7f3a'
/** Claude Code's presence id in the `connected` state (join key with `EditorState.agents`). */
export const MOCK_AGENT_PRESENCE_ID = 'mockclaudecd'
/** Placeholder stdio launch paths shown by the mock's "Other" snippet. */
export const MOCK_STDIO_COMMAND = '/opt/baren.dev/baren'
export const MOCK_STDIO_SHIM = '/home/you/.config/baren.dev/mcp/baren-mcp-stdio.cjs'

/** A full status for a simulated state: the agents of artboards 35/36 when connected. */
export function mockMcpStatus(state: MockMcpState, now: number = Date.now()): McpStatus {
  const running = { state: 'running', enabled: true, url: MOCK_MCP_URL, port: 29170 } as const
  switch (state) {
    case 'off':
      return {
        state: 'off',
        enabled: false,
        url: null,
        port: null,
        portChanged: false,
        error: null,
        agents: [],
      }
    case 'error':
      return {
        state: 'error',
        enabled: true,
        url: null,
        port: null,
        portChanged: false,
        error: 'port 29170 is in use',
        agents: [],
      }
    case 'connected':
      return {
        ...running,
        portChanged: false,
        error: null,
        agents: [
          {
            name: 'Claude Code',
            client: 'claude-code',
            version: '2.1.0',
            connected: true,
            presenceId: MOCK_AGENT_PRESENCE_ID,
            connectedAt: now - 12 * 60_000,
            lastActivityAt: now,
            lastFileId: 'f-baren',
            lastFileName: 'Baren',
            files: [],
          },
          {
            name: 'Cursor',
            client: 'cursor-vscode',
            version: null,
            connected: false,
            presenceId: null,
            connectedAt: null,
            lastActivityAt: now - 2 * 60 * 60_000,
            lastFileId: 'f-landing-page',
            lastFileName: 'acme – landing page',
            files: [],
          },
        ],
      }
    default:
      return { ...running, portChanged: false, error: null, agents: [] }
  }
}

/** Options of one simulated agent request (`window.__barenAgent.dispatch`). */
export interface MockDispatchOptions {
  /** Default: the file of the renderer that announced itself last (`agent.host`). */
  fileId?: string | null
  /** Default: Claude Code with {@link MOCK_AGENT_PRESENCE_ID}. */
  agent?: AgentRequest['agent']
  assets?: Record<string, ResolvedSource>
  /** Default 30 000 ms; on expiry the loop sends `cancel` and resolves with `timeout`. */
  timeoutMs?: number
}

/**
 * The in-page agent loop: delivers requests to the registered `agent.onRequest` listeners and
 * resolves with what they `respond()`, so runtime executors run in Playwright without Electron.
 */
export interface MockAgentLoop {
  dispatch(tool: AgentToolName, args?: unknown, opts?: MockDispatchOptions): Promise<AgentResponse>
  /** Push an `agent:presence` update to the page. */
  presence(update: AgentPresenceUpdate): void
  /** Hosts announced with `agent.host` (most recent last). */
  hosts(): AgentHostState[]
}

declare global {
  interface Window {
    /** Browser mode only (mock bridge): the in-page agent loop. */
    __barenAgent?: MockAgentLoop
  }
}

function initialMcpStatus(option: MockMcpState | McpStatus | undefined, now: number): McpStatus {
  if (typeof option === 'object') return structuredClone(option)
  if (option) return mockMcpStatus(option, now)
  const param = queryParam('mcp')
  return param !== null && (MOCK_MCP_STATES as readonly string[]).includes(param)
    ? mockMcpStatus(param as MockMcpState, now)
    : mockMcpStatus('not-connected', now)
}

/** Version the mock "finds" when simulating an update. */
export const MOCK_UPDATE_VERSION = '0.2.0'

const UPDATE_STATES: readonly UpdateState[] = [
  'disabled',
  'idle',
  'checking',
  'available',
  'downloading',
  'ready',
  'none',
  'error',
]

/** A full status for a simulated state (`?updates=downloading` → 42%, …). */
export function mockUpdateStatus(state: UpdateState): UpdateStatus {
  switch (state) {
    case 'available':
    case 'ready':
      return { state, version: MOCK_UPDATE_VERSION }
    case 'downloading':
      return { state, version: MOCK_UPDATE_VERSION, progress: 42 }
    case 'error':
      return { state, error: 'Could not reach the update server' }
    default:
      return { state }
  }
}

function queryParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name)
  } catch {
    return null
  }
}

function initialThemePreference(option: ThemePreference | undefined): ThemePreference {
  if (option) return option
  const param = queryParam('theme')
  return param === 'dark' || param === 'light' || param === 'system' ? param : 'system'
}

function initialUpdateStatus(option: UpdateState | UpdateStatus | undefined): UpdateStatus {
  if (typeof option === 'object') return { ...option }
  if (option) return mockUpdateStatus(option)
  const param = queryParam('updates')
  return param !== null && (UPDATE_STATES as readonly string[]).includes(param)
    ? mockUpdateStatus(param as UpdateState)
    : { state: 'idle' }
}

/** `prefers-color-scheme: dark`, or null outside a browser. */
function darkSchemeQuery(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  } catch {
    return null
  }
}

export type MockBridge = BarenBridge & { readonly mock: MockControls }

interface MockFile {
  meta: FileMeta
  /** Compacted Loro snapshot; created lazily on first open. */
  snapshot: Uint8Array | null
  /** Updates applied since the last compaction. */
  updates: Uint8Array[]
  thumbnail: Uint8Array | null
  /** Pending lazy thumbnail (fixtures); replaced by the bytes once loaded. */
  loadThumbnail: (() => Promise<Uint8Array | null>) | null
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux'
  const ua = navigator.userAgent
  if (/Mac|iPhone|iPad/.test(ua)) return 'darwin'
  if (/Windows/.test(ua)) return 'win32'
  return 'linux'
}

function readStoredToken(store: MockBridgeOptions['tokenStore']): string | null {
  try {
    return store?.getItem(TOKEN_KEY) ?? null
  } catch {
    return null
  }
}

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

const notFound = (id: string): Error => new Error(`File not found: ${id}`)

export function createMockBridge(options: MockBridgeOptions = {}): MockBridge {
  const now = options.now ?? Date.now
  const files = new Map<string, MockFile>()
  const assets = new Map<string, { bytes: Uint8Array; mime: string }>()
  const deepLinkListeners = new Set<(url: string) => void>()
  const maximizedListeners = new Set<(v: boolean) => void>()
  let maximized = false
  const tokenStore = options.tokenStore
  let token: string | null = options.token ?? readStoredToken(tokenStore)
  const openedUrls: string[] = []
  const thumbnailLoads = new WeakMap<MockFile, Promise<void>>()

  // ---- theme: preference + OS dark mode → resolved, like the main process
  let themePreference = initialThemePreference(options.theme)
  const darkQuery = options.systemDark === undefined ? darkSchemeQuery() : null
  let systemDark = options.systemDark ?? darkQuery?.matches ?? false
  const resolveTheme = (): ResolvedTheme =>
    themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference
  let resolvedTheme = resolveTheme()
  const themeListeners = new Set<(resolved: ResolvedTheme) => void>()
  const refreshTheme = (): void => {
    const next = resolveTheme()
    if (next === resolvedTheme) return
    resolvedTheme = next
    for (const cb of [...themeListeners]) cb(next)
  }
  const setSystemDark = (dark: boolean): void => {
    systemDark = dark
    refreshTheme()
  }
  darkQuery?.addEventListener?.('change', (event) => setSystemDark(event.matches))

  // ---- auto-update: a static simulated status (visual tests) plus a fake check
  let updateStatus = initialUpdateStatus(options.updates)
  let updateInstalls = 0
  let pendingCheck: Promise<UpdateStatus> | null = null
  const updateListeners = new Set<(status: UpdateStatus) => void>()
  const setUpdateStatus = (status: UpdateStatus): void => {
    updateStatus = { ...status }
    for (const cb of [...updateListeners]) cb({ ...updateStatus })
  }

  // ---- MCP: a static simulated status (visual tests) plus snippets with a mock token
  let mcpStatus = initialMcpStatus(options.mcp, now())
  let mcpToken = MOCK_MCP_TOKEN
  let tokenResets = 0
  const mcpListeners = new Set<(status: McpStatus) => void>()
  const setMcpStatus = (status: McpStatus): McpStatus => {
    mcpStatus = structuredClone(status)
    for (const cb of [...mcpListeners]) cb(structuredClone(mcpStatus))
    return structuredClone(mcpStatus)
  }
  const disconnectAgents = (status: McpStatus): McpStatus['agents'] =>
    status.agents.map((a) => ({
      ...a,
      connected: false,
      presenceId: null,
      connectedAt: null,
      files: [],
    }))
  const mcpSetup = (): McpSetup => {
    if (mcpStatus.state !== 'running' || mcpStatus.url === null) {
      throw new Error('The MCP server is off')
    }
    return buildSetup({
      url: mcpStatus.url,
      token: mcpToken,
      command: MOCK_STDIO_COMMAND,
      args: [MOCK_STDIO_SHIM],
    })
  }

  // ---- agent loop: requests to the page's onRequest listeners, answers via respond()
  const requestListeners = new Set<(req: AgentRequest) => void>()
  const cancelListeners = new Set<(id: string) => void>()
  const presenceListeners = new Set<(update: AgentPresenceUpdate) => void>()
  const pendingRequests = new Map<string, (res: AgentResponse) => void>()
  let announcedHosts: AgentHostState[] = []
  let requestSeq = 0
  function emitAll<T>(listeners: Set<(v: T) => void>, value: T): void {
    for (const cb of [...listeners]) {
      try {
        cb(value)
      } catch (error) {
        console.error('[baren mock] listener failed', error)
      }
    }
  }
  const agentLoop: MockAgentLoop = {
    dispatch(tool, args = {}, opts = {}) {
      const id = `m${++requestSeq}`
      const fileId =
        opts.fileId !== undefined ? opts.fileId : (announcedHosts.at(-1)?.fileId ?? null)
      const timeoutMs = opts.timeoutMs ?? 30_000
      const request: AgentRequest = {
        id,
        fileId,
        tool,
        args: structuredClone(args),
        agent: opts.agent ?? {
          sessionId: 'mock-session',
          presenceId: MOCK_AGENT_PRESENCE_ID,
          name: 'Claude Code',
        },
        ...(opts.assets ? { assets: structuredClone(opts.assets) } : {}),
        deadline: Date.now() + timeoutMs,
      }
      if (requestListeners.size === 0) {
        return Promise.resolve({
          id,
          ok: false,
          error: { code: 'host_unavailable', message: 'No renderer handles agent requests' },
        })
      }
      return new Promise<AgentResponse>((resolve) => {
        const timer = setTimeout(() => {
          if (!pendingRequests.delete(id)) return
          emitAll(cancelListeners, id)
          resolve({ id, ok: false, error: { code: 'timeout', message: `${tool} timed out` } })
        }, timeoutMs)
        pendingRequests.set(id, (res) => {
          clearTimeout(timer)
          pendingRequests.delete(id)
          resolve(structuredClone(res))
        })
        emitAll(requestListeners, structuredClone(request))
      })
    },
    presence(update) {
      emitAll(presenceListeners, structuredClone(update))
    },
    hosts: () => announcedHosts.map((h) => ({ ...h })),
  }
  if (options.exposeAgentLoop ?? typeof window !== 'undefined') {
    try {
      window.__barenAgent = agentLoop
    } catch {
      // No window (Node tests): the loop stays reachable through `bridge.mock.agent`.
    }
  }

  for (const seed of options.files ?? []) {
    const t = now()
    const meta: FileMeta = {
      id: seed.id ?? randomId(),
      name: seed.name,
      createdAt: seed.createdAt ?? t,
      updatedAt: seed.updatedAt ?? seed.createdAt ?? t,
      archived: seed.archived ?? false,
      teamId: seed.teamId ?? null,
      remoteId: seed.remoteId ?? null,
    }
    const thumb = seed.thumbnail
    files.set(meta.id, {
      meta,
      snapshot: null,
      updates: [],
      thumbnail: thumb instanceof Uint8Array ? copy(thumb) : null,
      loadThumbnail: typeof thumb === 'function' ? thumb : null,
    })
  }

  const getFile = (id: string): MockFile => {
    const file = files.get(id)
    if (!file) throw notFound(id)
    return file
  }

  /** Materialise the file's current Loro doc, compacting pending updates into the snapshot. */
  const loadFileDoc = async (file: MockFile) => {
    const schema = await import('@baren/schema')
    if (file.snapshot === null) {
      file.snapshot = schema.exportSnapshot(schema.createEmptyDoc(file.meta.name))
    }
    const doc = schema.loadDoc([file.snapshot, ...file.updates])
    if (file.updates.length > 0) {
      file.snapshot = schema.exportSnapshot(doc)
      file.updates = []
    }
    return { doc, schema }
  }

  const setMaximized = (value: boolean): void => {
    if (maximized === value) return
    maximized = value
    for (const cb of maximizedListeners) cb(value)
  }

  const bridge: MockBridge = {
    window: {
      minimize() {},
      toggleMaximize() {
        setMaximized(!maximized)
      },
      close() {
        window.close()
      },
      isMaximized: async () => maximized,
      onMaximizedChange(cb) {
        maximizedListeners.add(cb)
        return () => maximizedListeners.delete(cb)
      },
    },

    files: {
      async list() {
        return [...files.values()]
          .map((f) => ({ ...f.meta }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
      },
      async create(name) {
        const t = now()
        const meta: FileMeta = {
          id: randomId(),
          name,
          createdAt: t,
          updatedAt: t,
          archived: false,
          teamId: null,
          remoteId: null,
        }
        files.set(meta.id, {
          meta,
          snapshot: null,
          updates: [],
          thumbnail: null,
          loadThumbnail: null,
        })
        return { ...meta }
      },
      async rename(id, name) {
        const file = getFile(id)
        file.meta.name = name
        file.meta.updatedAt = now()
      },
      async archive(id, archived) {
        const file = getFile(id)
        file.meta.archived = archived
        file.meta.updatedAt = now()
      },
      async remove(id) {
        if (!files.delete(id)) throw notFound(id)
      },
      async open(id) {
        const file = getFile(id)
        await loadFileDoc(file)
        return copy(file.snapshot ?? new Uint8Array())
      },
      async applyUpdate(id, update) {
        const file = getFile(id)
        file.updates.push(copy(update))
        file.meta.updatedAt = now()
      },
      async setThumbnail(id, png) {
        const file = getFile(id)
        file.thumbnail = copy(png)
        file.loadThumbnail = null
      },
      async getThumbnail(id) {
        const file = getFile(id)
        const load = file.loadThumbnail
        if (load) {
          // Concurrent callers share one load; a setThumbnail meanwhile wins.
          let pending = thumbnailLoads.get(file)
          if (!pending) {
            pending = load()
              .catch(() => null)
              .then((bytes) => {
                if (file.loadThumbnail === load) {
                  file.thumbnail = bytes
                  file.loadThumbnail = null
                }
              })
            thumbnailLoads.set(file, pending)
          }
          await pending
        }
        return file.thumbnail ? copy(file.thumbnail) : null
      },
      async import(snapshot, name) {
        const schema = await import('@baren/schema')
        let doc
        try {
          doc = schema.loadDoc(snapshot)
        } catch {
          throw new Error('Not a complete Loro snapshot')
        }
        const finalName = name ?? (schema.getDocName(doc) || 'Untitled')
        if (schema.getDocName(doc) !== finalName) schema.setDocName(doc, finalName)
        const t = now()
        const meta: FileMeta = {
          id: randomId(),
          name: finalName,
          createdAt: t,
          updatedAt: t,
          archived: false,
          teamId: null,
          remoteId: null,
        }
        files.set(meta.id, {
          meta,
          snapshot: schema.exportSnapshot(doc),
          updates: [],
          thumbnail: null,
          loadThumbnail: null,
        })
        return { ...meta }
      },
      async setRemote(id, teamId, remoteId) {
        const file = getFile(id)
        file.meta.teamId = teamId
        file.meta.remoteId = remoteId
      },
      // No MCP tool creates files in browser mode.
      onChanged: () => () => undefined,
    },

    assets: {
      async put(bytes, mime) {
        // blake3 hex like the native core, so browser mode can upload to a real server
        // (it re-hashes with blake3). Loaded on first use: most screens never store assets.
        const [{ blake3 }, { bytesToHex }] = await Promise.all([
          import('@noble/hashes/blake3.js'),
          import('@noble/hashes/utils.js'),
        ])
        const hash = bytesToHex(blake3(bytes))
        assets.set(hash, { bytes: copy(bytes), mime })
        return hash
      },
      async get(hash) {
        const asset = assets.get(hash)
        return asset ? copy(asset.bytes) : null
      },
    },

    export: {
      async html(fileId, nodeId) {
        const { doc, schema } = await loadFileDoc(getFile(fileId))
        const node = schema.getNode(doc, nodeId)
        if (!node) throw new Error(`Node not found: ${nodeId}`)
        return `<!-- mock export of ${node.type} "${node.name}" -->\n<div data-node-id="${node.id}"></div>\n`
      },
      async json(fileId) {
        const { doc, schema } = await loadFileDoc(getFile(fileId))
        return JSON.stringify(schema.toSnapshot(doc), null, 2)
      },
    },

    auth: {
      getToken: async () => token,
      async setToken(next) {
        token = next
        try {
          if (next === null) tokenStore?.removeItem(TOKEN_KEY)
          else tokenStore?.setItem(TOKEN_KEY, next)
        } catch {
          // Storage unavailable: the token stays in memory.
        }
      },
    },

    shell: {
      async openExternal(url) {
        openedUrls.push(url)
        if (options.externalLinks !== 'record') window.open(url, '_blank', 'noopener,noreferrer')
      },
    },

    onDeepLink(cb) {
      deepLinkListeners.add(cb)
      return () => deepLinkListeners.delete(cb)
    },

    app: {
      newWindow() {
        window.open(window.location.href, '_blank')
      },
      quit() {
        window.close()
      },
      reload() {
        window.location.reload()
      },
      forceReload() {
        window.location.reload()
      },
      toggleDevTools() {},
      toggleFullScreen() {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen()
      },
      async checkForUpdates() {
        await bridge.updates.check()
      },
      version: async () => options.version ?? '0.0.0-mock',
    },

    theme: {
      initial: resolvedTheme,
      preference: async () => themePreference,
      async setPreference(preference) {
        themePreference = preference
        refreshTheme()
      },
      onChange(cb) {
        themeListeners.add(cb)
        return () => themeListeners.delete(cb)
      },
    },

    updates: {
      status: async () => ({ ...updateStatus }),
      check() {
        if (pendingCheck) return pendingCheck
        const { state } = updateStatus
        if (state !== 'idle' && state !== 'none' && state !== 'error') {
          return Promise.resolve({ ...updateStatus })
        }
        setUpdateStatus({ state: 'checking' })
        pendingCheck = new Promise<UpdateStatus>((resolve) => {
          setTimeout(() => {
            pendingCheck = null
            setUpdateStatus({ state: 'none' })
            resolve({ ...updateStatus })
          }, options.updateCheckMs ?? 400)
        })
        return pendingCheck
      },
      install() {
        if (updateStatus.state === 'ready') updateInstalls++
      },
      onStatus(cb) {
        updateListeners.add(cb)
        return () => updateListeners.delete(cb)
      },
    },

    clipboard: createMockClipboard(),

    mcp: {
      status: async () => structuredClone(mcpStatus),
      onStatus(cb) {
        mcpListeners.add(cb)
        return () => mcpListeners.delete(cb)
      },
      async setEnabled(enabled) {
        if (enabled === mcpStatus.enabled && mcpStatus.state !== 'error') {
          return structuredClone(mcpStatus)
        }
        if (!enabled) {
          return setMcpStatus({
            state: 'off',
            enabled: false,
            url: null,
            port: null,
            portChanged: false,
            error: null,
            agents: disconnectAgents(mcpStatus),
          })
        }
        return setMcpStatus({
          state: 'running',
          enabled: true,
          url: MOCK_MCP_URL,
          port: 29170,
          portChanged: false,
          error: null,
          agents: mcpStatus.agents,
        })
      },
      setup: async () => mcpSetup(),
      async resetToken() {
        if (mcpStatus.state !== 'running') throw new Error('The MCP server is off')
        tokenResets++
        mcpToken = `brn_mock_token_${(0x7f3a + tokenResets * 0x1111).toString(16).slice(-4)}`
        setMcpStatus({ ...mcpStatus, agents: disconnectAgents(mcpStatus) })
        return mcpSetup()
      },
    },

    agent: {
      onRequest(cb) {
        requestListeners.add(cb)
        return () => requestListeners.delete(cb)
      },
      respond(res) {
        pendingRequests.get(res.id)?.(res)
      },
      onCancel(cb) {
        cancelListeners.add(cb)
        return () => cancelListeners.delete(cb)
      },
      onPresence(cb) {
        presenceListeners.add(cb)
        return () => presenceListeners.delete(cb)
      },
      host(state) {
        announcedHosts = announcedHosts.filter((h) => h.fileId !== state.fileId)
        if (state.state === 'opened') announcedHosts.push({ ...state })
      },
    },

    platform: options.platform ?? detectPlatform(),

    mock: {
      emitDeepLink(url) {
        for (const cb of deepLinkListeners) cb(url)
      },
      setMaximized,
      openedUrls: () => [...openedUrls],
      setUpdateStatus(status) {
        setUpdateStatus(typeof status === 'string' ? mockUpdateStatus(status) : status)
      },
      updateInstalls: () => updateInstalls,
      setSystemDark,
      setMcpStatus(status) {
        setMcpStatus(typeof status === 'string' ? mockMcpStatus(status, now()) : status)
      },
      agent: agentLoop,
    },
  }

  return bridge
}

// ---------------------------------------------------------------------------
// Clipboard (editor-owned member, docs/phase3/contract.md §7.5)
// ---------------------------------------------------------------------------

/** The baren payload's web custom format (same name as the Electron bridge writes). */
export const MOCK_CLIPBOARD_FORMAT = 'web application/x-baren-clipboard+json'
const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
const CHANNEL_NAME = 'baren-clipboard'

/** The parts of `navigator.clipboard` the mock uses. */
export interface ClipboardApiLike {
  write(items: ClipboardItem[]): Promise<void>
  read(): Promise<readonly ClipboardItemLike[]>
}
interface ClipboardItemLike {
  readonly types: readonly string[]
  getType(type: string): Promise<Blob>
}

/** The parts of `BroadcastChannel` the mock uses. */
export interface ChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

interface MemoryEntry {
  seq: number
  content: ClipboardWrite
  /** The write also reached the system clipboard (so reads prefer it). */
  system: boolean
}

export interface MockClipboardOptions {
  /** Default: `navigator.clipboard` (null: memory only). */
  api?: ClipboardApiLike | null
  /** Default: `new BroadcastChannel('baren-clipboard')` (null: this window only). */
  channel?: ChannelLike | null
  /** `ClipboardItem` constructor (default: the global one). */
  makeItem?: (record: Record<string, Blob>) => ClipboardItem
}

function defaultApi(): ClipboardApiLike | null {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return null
  return navigator.clipboard as unknown as ClipboardApiLike
}

function defaultChannel(): ChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(CHANNEL_NAME)
  } catch {
    return null
  }
}

function memoryRead(content: ClipboardWrite): ClipboardRead {
  return {
    text: content.text ?? null,
    html: content.html ?? null,
    baren: content.baren ?? null,
    svg: null,
    images: content.png ? [{ mime: 'image/png', bytes: copy(content.png) }] : [],
  }
}

function isMemoryEntry(v: unknown): v is MemoryEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Partial<MemoryEntry>
  return typeof e.seq === 'number' && typeof e.content === 'object' && e.content !== null
}

/**
 * `bridge.clipboard` for browser mode: the async Clipboard API with the same representations
 * as the Electron bridge (including the `web …` custom format). When the API refuses (no
 * permission, the page is not focused), an in-memory clipboard shared by same-origin windows
 * through `BroadcastChannel('baren-clipboard')` stands in, so copy in one tab and paste in
 * another still works.
 */
export function createMockClipboard(options: MockClipboardOptions = {}): BarenBridge['clipboard'] {
  const api = options.api === undefined ? defaultApi() : options.api
  const channel = options.channel === undefined ? defaultChannel() : options.channel
  const makeItem =
    options.makeItem ??
    ((record: Record<string, Blob>) => new ClipboardItem(record as Record<string, Blob>))
  let memory: MemoryEntry | null = null

  channel?.addEventListener('message', (event) => {
    const data = event.data
    // Ties (same instant in two windows) go to the message that arrived last.
    if (isMemoryEntry(data) && (memory === null || data.seq >= memory.seq)) memory = data
  })

  const remember = (content: ClipboardWrite, system: boolean): void => {
    // High-resolution wall clock so windows agree on "latest" without coordination.
    const now =
      typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now()
    const seq = Math.max(now, (memory?.seq ?? 0) + 0.001)
    memory = { seq, content, system }
    try {
      channel?.postMessage(memory)
    } catch {
      // A closed channel: this window still has the copy.
    }
  }

  return {
    async write(content) {
      const record: Record<string, Blob> = {}
      if (content.text !== undefined)
        record['text/plain'] = new Blob([content.text], { type: 'text/plain' })
      if (content.html !== undefined)
        record['text/html'] = new Blob([content.html], { type: 'text/html' })
      if (content.baren !== undefined) {
        // Chromium requires the blob type to equal the custom format's MIME type.
        record[MOCK_CLIPBOARD_FORMAT] = new Blob([content.baren], {
          type: MOCK_CLIPBOARD_FORMAT.slice('web '.length),
        })
      }
      if (content.png !== undefined) {
        record['image/png'] = new Blob([copy(content.png)], { type: 'image/png' })
      }
      if (Object.keys(record).length === 0) throw new Error('Nothing to copy')
      let system = false
      if (api) {
        try {
          await api.write([makeItem(record)])
          system = true
        } catch {
          // Custom formats, permissions or focus: keep only the in-memory copy.
          system = false
        }
      }
      remember({ ...content }, system)
    },

    async read() {
      // The latest write did not reach the system clipboard: it only exists in memory.
      if (memory && !memory.system) return memoryRead(memory.content)
      if (api) {
        try {
          const items = await api.read()
          const out: ClipboardRead = {
            text: null,
            html: null,
            baren: null,
            svg: null,
            images: [],
          }
          for (const item of items) {
            const text = async (type: string) => (await item.getType(type)).text()
            if (out.baren === null && item.types.includes(MOCK_CLIPBOARD_FORMAT))
              out.baren = await text(MOCK_CLIPBOARD_FORMAT)
            if (out.text === null && item.types.includes('text/plain'))
              out.text = await text('text/plain')
            if (out.html === null && item.types.includes('text/html'))
              out.html = await text('text/html')
            if (out.svg === null && item.types.includes('image/svg+xml'))
              out.svg = await text('image/svg+xml')
            const raster = RASTER_TYPES.find((t) => item.types.includes(t))
            if (raster) {
              const bytes = new Uint8Array(await (await item.getType(raster)).arrayBuffer())
              if (bytes.byteLength > 0) out.images.push({ mime: raster, bytes })
            }
          }
          return out
        } catch {
          // Fall through to the in-memory copy.
        }
      }
      return memory
        ? memoryRead(memory.content)
        : { text: null, html: null, baren: null, svg: null, images: [] }
    },
  }
}
