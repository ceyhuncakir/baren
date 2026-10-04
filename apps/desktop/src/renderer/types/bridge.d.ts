/**
 * The desktop bridge exposed by the preload script as `window.baren`
 * (ARCHITECTURE.md, "Desktop bridge"). Implemented for real by desktop-shell
 * (src/preload) and in memory by lib/mockBridge.ts for browser/Playwright runs.
 */
import type { FontFaceSpec } from '../lib/fontUrls'

export type { FontFaceSpec }

export interface FileMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  archived: boolean
  teamId: string | null
  remoteId: string | null
}

export type Platform = 'linux' | 'darwin' | 'win32'

/** The Account menu's Light / Dark / System choice, persisted by the main process. */
export type ThemePreference = 'light' | 'dark' | 'system'
/** The theme actually applied (`<html data-theme>`): the preference with 'system' resolved. */
export type ResolvedTheme = 'light' | 'dark'

/**
 * Auto-update state (ARCHITECTURE.md, "Auto-update").
 *
 * - `disabled`: updates do not run here (dev build, browser, unsupported install, no feed).
 * - `idle`: enabled, nothing checked yet in this session.
 * - `checking` → `available` (a newer `version` exists; the download starts in the background)
 *   → `downloading` (`progress`) → `ready` (downloaded; `install()` restarts into it).
 * - `none`: the last check found no newer version. `error`: the last check, download or install
 *   failed (`error` holds the message; `version` is kept when it was known).
 */
export type UpdateState =
  'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** The new version (available, downloading, ready; kept on a download/install error). */
  version?: string
  /** Download progress in percent, an integer 0–100 (downloading only). */
  progress?: number
  /** Human-readable failure message (error only). */
  error?: string
}

/**
 * One clipboard write (contract docs/phase3/contract.md §7.5): every present field becomes one
 * representation of a single clipboard item, written atomically.
 */
export interface ClipboardWrite {
  /** `text/plain`, at most 16 MiB. */
  text?: string
  /** `text/html`, at most 16 MiB. */
  html?: string
  /** The baren payload JSON (`web application/x-baren-clipboard+json`), at most 48 MiB. */
  baren?: string
  /** `image/png` (Copy as PNG), at most 64 MiB. */
  png?: Uint8Array
}

/** What the system clipboard holds (absent representations are `null` / empty). */
export interface ClipboardRead {
  text: string | null
  html: string | null
  /** The baren payload JSON (custom web format). */
  baren: string | null
  /** `image/svg+xml` markup. */
  svg: string | null
  /** Raster images (`image/png|jpeg|webp|gif|avif`), one per clipboard item. */
  images: { mime: string; bytes: Uint8Array }[]
}

// ---------------------------------------------------------------------------
// MCP server and agents (Phase 4, docs/phase4/contract.md §4.6, §4.14). One definition shared by
// main, preload, the renderer runtime and the mock bridge. No DOM types (main includes this file).
// ---------------------------------------------------------------------------

/** State of the built-in MCP server. */
export type McpState = 'off' | 'starting' | 'running' | 'error'

export interface McpAgentInfo {
  /** Display name (contract §4.4), e.g. "Claude Code". */
  name: string
  /** `clientInfo.name` as sent by the client. */
  client: string
  version: string | null
  /** A live session (false: a recently seen agent from agents.json). */
  connected: boolean
  /** Live sessions only: the id used in presence data. */
  presenceId: string | null
  /** Live sessions only. */
  connectedAt: number | null
  /** Last tool call (epoch ms). */
  lastActivityAt: number
  lastFileId: string | null
  /** For "Active now · <file>". */
  lastFileName: string | null
  /** Live sessions: working artboard ids per file (names are resolved by the editor). */
  files: { fileId: string; working: string[] }[]
}

export interface McpStatus {
  state: McpState
  enabled: boolean
  /** 'http://127.0.0.1:29170/mcp' while running. */
  url: string | null
  port: number | null
  /** The server bound another port than the configured one (configured agents need the new snippet). */
  portChanged: boolean
  /** State 'error' only. */
  error: string | null
  /** Live sessions first, then recent ones; "Connected" = some agent is connected. */
  agents: McpAgentInfo[]
}

export interface McpSetup {
  url: string
  token: string
  snippets: { claudeCode: string; cursor: string; codex: string; json: string; stdioJson: string }
  stdio: { command: string; args: string[]; env: Record<string, string> }
}

/** The MCP tools (contract §6). */
export type McpToolName =
  | 'get_guide'
  | 'get_basic_info'
  | 'list_files'
  | 'open_file'
  | 'create_file'
  | 'create_page'
  | 'rename_pages'
  | 'get_selection'
  | 'get_tree_summary'
  | 'get_children'
  | 'get_node_info'
  | 'find_nodes'
  | 'get_jsx'
  | 'get_computed_styles'
  | 'get_screenshot'
  | 'get_fill_image'
  | 'get_font_family_info'
  | 'get_tokens'
  | 'create_tokens'
  | 'set_tokens'
  | 'create_artboard'
  | 'write_html'
  | 'update_styles'
  | 'set_text_content'
  | 'rename_nodes'
  | 'duplicate_nodes'
  | 'move_nodes'
  | 'delete_nodes'
  | 'finish_working_on_nodes'
  | 'export'
  | 'get_comments'
  | 'reply_to_comment'
  | 'resolve_comment'

/** Requests main sends to hosts and the render window that are not MCP tools (contract §4.6). */
export type InternalToolName =
  /** host: flush + close the session, then answer. */
  | 'release'
  /** host: persistence.flush(). */
  | 'flush'
  /** host: { nodeIds } → { artboards: Record<nodeId, artboardId | null> }. */
  | 'artboards_of'
  /** host: { nodeId, scale, purpose: 'screenshot'|'export'|'styles', nodeIds? } → RenderJob. */
  | 'render_job'
  /** host: { nodeId } → { assetId, mime?, name? } | { svg } (get_fill_image, svg export). */
  | 'node_image'
  /** render window: { job, scale, maxSide, maxPixels, transparent } → { width, height, scale, outWidth, outHeight }. */
  | 'stage_prepare'
  /** render window: { job, nodeIds } → { styles: Record<id, CSSProperties> }. */
  | 'stage_styles'
  /** render window. */
  | 'stage_clear'
  /** render window: { familyNames } → get_font_family_info body. */
  | 'fonts_probe'
  /** render window: { hash | png, to: 'jpeg'|'webp'|'png', maxSide?, quality? } → { bytes }. */
  | 'image_transcode'

export type AgentToolName = McpToolName | InternalToolName

/** An image source pre-resolved by main (contract §4.8), keyed by the exact source string. */
export type ResolvedSource =
  | { kind: 'raster'; hash: string; mime: string; name: string }
  | { kind: 'svg'; markup: string; name: string }
  | {
      error:
        | 'not_found'
        | 'too_large'
        | 'unsupported_type'
        | 'unsupported_source'
        | 'fetch_failed'
        | 'budget'
      message: string
    }

export interface AgentRequest {
  /** 'r' + increasing integer, unique per main process. */
  id: string
  /** null only for render-window tools. */
  fileId: string | null
  tool: AgentToolName
  /** Already validated by main (zod), plain JSON. */
  args: unknown
  agent: { sessionId: string; presenceId: string; name: string } | null
  /** Pre-resolved image sources (write tools only). */
  assets?: Record<string, ResolvedSource>
  /** Epoch ms; the renderer gives up (error 'timeout') after it. */
  deadline: number
}

export interface FileHeader {
  file: { id: string; name: string }
  contentHash: { tokens: string }
}

export type AgentErrorCode =
  /** no fileId and no window has a file open */
  | 'no_file_open'
  | 'file_not_found'
  | 'page_not_found'
  | 'node_not_found'
  /** e.g. children into a text/rect, replace a page, page target where not allowed */
  | 'invalid_target'
  /** structural edit inside an instance (virtual id) */
  | 'instance_content'
  /** would put a component inside itself */
  | 'cycle'
  /** the user is a viewer of this shared file */
  | 'read_only'
  | 'token_exists'
  | 'token_not_found'
  /** no comment thread with that id (deleted, or never existed) */
  | 'comment_not_found'
  /** format/feature not available (video export…) */
  | 'unsupported'
  /** output or input over a limit */
  | 'too_large'
  /** the host window did not answer / crashed / could not start */
  | 'host_unavailable'
  | 'timeout'
  | 'cancelled'
  /** semantic validation beyond the schema */
  | 'invalid_argument'
  /** unexpected exception (message = exception message, logged with stack) */
  | 'internal'

export interface AgentError {
  code: AgentErrorCode
  message: string
  data?: Record<string, unknown>
}

export type AgentResponse =
  | { id: string; ok: true; header: FileHeader | null; result: unknown; touched?: string[] }
  | { id: string; ok: false; error: AgentError }

export interface AgentHostState {
  fileId: string
  state: 'opened' | 'closed'
  headless: boolean
}

export interface AgentPresence {
  /** presenceId */
  id: string
  name: string
  /** Artboard ids with an active working indicator in this file. */
  working: string[]
  /** Last tool call on this file (epoch ms). */
  activeAt: number
}

export interface AgentPresenceUpdate {
  fileId: string
  agents: AgentPresence[]
}

/** What the host builds for screenshots, exports and resolved styles (contract §11.4). */
export interface RenderJob {
  nodeId: string
  /** `@baren/html` renderStage output. */
  stage: { html: string; css: string; assetUrls: string[] }
  /** Measured size of the node (null → layout in the stage). */
  width: number | null
  height: number | null
  /** Screenshot compositing colour (§9.1); null for export. */
  background: string | null
  /** INHERITED_TEXT_PROPERTIES from ancestors. */
  inherited: Record<string, string | number>
  /** Node ids present in the stage (data-node-id). */
  ids: string[]
}

export interface BarenBridge {
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizedChange(cb: (v: boolean) => void): () => void
  }
  files: {
    list(): Promise<FileMeta[]>
    create(name: string): Promise<FileMeta>
    rename(id: string, name: string): Promise<void>
    archive(id: string, archived: boolean): Promise<void>
    remove(id: string): Promise<void>
    /** Loro snapshot of the file. */
    open(id: string): Promise<Uint8Array>
    applyUpdate(id: string, update: Uint8Array): Promise<void>
    setThumbnail(id: string, png: Uint8Array): Promise<void>
    getThumbnail(id: string): Promise<Uint8Array | null>
    /**
     * Create a local file from a Loro snapshot (e.g. a team file downloaded from the server).
     * `name` overrides the document's own name; `null` keeps it.
     */
    import(snapshot: Uint8Array, name: string | null): Promise<FileMeta>
    /** Link a local file to a team file on the server (`null`s unlink). Not an edit: `updatedAt` is kept. */
    setRemote(id: string, teamId: string | null, remoteId: string | null): Promise<void>
    /** A tool (MCP agent) created or imported a file: reload the file list. Never fires in the mock. */
    onChanged(cb: () => void): () => void
  }
  assets: {
    /** Stores the bytes and returns their content hash (blake3 hex in the real bridge). */
    put(bytes: Uint8Array, mime: string): Promise<string>
    get(hash: string): Promise<Uint8Array | null>
  }
  /** Google Fonts for designs (main downloads and caches the files). */
  fonts: {
    /**
     * The faces of a Google Fonts family, sources on `baren-font://`; null when the family is not
     * in the catalog or cannot be fetched (offline before its first use).
     */
    faces(family: string): Promise<FontFaceSpec[] | null>
  }
  export: {
    html(fileId: string, nodeId: string): Promise<string>
    json(fileId: string): Promise<string>
  }
  /** Session token, persisted with Electron safeStorage. */
  auth: {
    getToken(): Promise<string | null>
    setToken(token: string | null): Promise<void>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  /** `baren://invite/<token>`, `baren://auth/<code>` */
  onDeepLink(cb: (url: string) => void): () => void
  app: {
    newWindow(): void
    quit(): void
    reload(): void
    forceReload(): void
    toggleDevTools(): void
    toggleFullScreen(): void
    /** Same as `updates.check()` (the Help menu's "Check for Updates…"). */
    checkForUpdates(): Promise<void>
    version(): Promise<string>
  }
  /**
   * App theme. `initial` is the resolved theme when the page started loading, available
   * synchronously so `<html data-theme>` can be set before the first paint.
   */
  theme: {
    readonly initial: ResolvedTheme
    preference(): Promise<ThemePreference>
    setPreference(p: ThemePreference): Promise<void>
    /** The resolved theme changed (preference change, or the OS theme while on 'system'). */
    onChange(cb: (resolved: ResolvedTheme) => void): () => void
  }
  /** Auto-update (electron-updater). Checks 10 s after start and every 4 h. */
  updates: {
    status(): Promise<UpdateStatus>
    /** Check now (no-op while checking/downloading/ready); resolves with the status after the check. */
    check(): Promise<UpdateStatus>
    /** Quit and install the downloaded update (state `ready` only), then relaunch. */
    install(): void
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }
  /**
   * The system clipboard with the app's own format (cross-file and cross-window copy/paste).
   * Errors are plain `Error`s with the main-process message.
   */
  clipboard: {
    /** Replace the system clipboard with ONE item carrying the given representations (atomic). */
    write(content: ClipboardWrite): Promise<void>
    read(): Promise<ClipboardRead>
  }
  /** The built-in MCP server (Phase 4). The token reaches the renderer only through `setup()`. */
  mcp: {
    status(): Promise<McpStatus>
    onStatus(cb: (s: McpStatus) => void): () => void
    setEnabled(enabled: boolean): Promise<McpStatus>
    /** Rejects with "The MCP server is off" when not running. */
    setup(): Promise<McpSetup>
    resetToken(): Promise<McpSetup>
  }
  /** Agent requests routed by main to the renderer that hosts a file (Phase 4 runtime). */
  agent: {
    onRequest(cb: (req: AgentRequest) => void): () => void
    respond(res: AgentResponse): void
    onCancel(cb: (id: string) => void): () => void
    onPresence(cb: (update: AgentPresenceUpdate) => void): () => void
    host(state: AgentHostState): void
  }
  platform: Platform
}

declare global {
  interface Window {
    /** Present inside Electron (preload); absent in a plain browser. */
    baren?: BarenBridge
  }
}
