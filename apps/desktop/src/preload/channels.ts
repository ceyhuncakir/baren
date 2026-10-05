/**
 * IPC contract between the preload (`window.baren`) and the main process.
 * Imported by both sides so channel names and payload types cannot drift.
 *
 * - `InvokeChannels`: request/response (`ipcRenderer.invoke` ↔ `ipcMain.handle`).
 * - `SendChannels`: fire-and-forget renderer → main (`ipcRenderer.send` ↔ `ipcMain.on`).
 * - `EventChannels`: main → renderer pushes (`webContents.send` ↔ `ipcRenderer.on`).
 *
 * Binary payloads are `Uint8Array` (structured clone; Buffers arrive as Uint8Array).
 */
import type {
  AgentHostState,
  AgentPresenceUpdate,
  AgentRequest,
  AgentResponse,
  AgentRun,
  AgentRunRequest,
  AgentRunnerStatus,
  ClipboardRead,
  ClipboardWrite,
  FileMeta,
  McpSetup,
  McpStatus,
  ResolvedTheme,
  ThemePreference,
  UpdateStatus,
} from '../renderer/types/bridge'
import type { FontFaceSpec } from '../renderer/lib/fontUrls'

export interface InvokeChannels {
  'window:is-maximized': { args: []; result: boolean }
  'files:list': { args: []; result: FileMeta[] }
  'files:create': { args: [name: string]; result: FileMeta }
  'files:rename': { args: [id: string, name: string]; result: void }
  'files:archive': { args: [id: string, archived: boolean]; result: void }
  'files:remove': { args: [id: string]; result: void }
  'files:open': { args: [id: string]; result: Uint8Array }
  'files:apply-update': { args: [id: string, update: Uint8Array]; result: void }
  'files:set-thumbnail': { args: [id: string, png: Uint8Array]; result: void }
  'files:get-thumbnail': { args: [id: string]; result: Uint8Array | null }
  'files:import': { args: [snapshot: Uint8Array, name: string | null]; result: FileMeta }
  'files:set-remote': {
    args: [id: string, teamId: string | null, remoteId: string | null]
    result: void
  }
  'assets:put': { args: [bytes: Uint8Array, mime: string]; result: string }
  'assets:get': { args: [hash: string]; result: Uint8Array | null }
  'export:html': { args: [fileId: string, nodeId: string]; result: string }
  'export:json': { args: [fileId: string]; result: string }
  'auth:get-token': { args: []; result: string | null }
  'auth:set-token': { args: [token: string | null]; result: void }
  'shell:open-external': { args: [url: string]; result: void }
  'app:check-for-updates': { args: []; result: void }
  'app:version': { args: []; result: string }
  'theme:get-preference': { args: []; result: ThemePreference }
  'theme:set-preference': { args: [preference: ThemePreference]; result: void }
  'updates:status': { args: []; result: UpdateStatus }
  'updates:check': { args: []; result: UpdateStatus }
  'clipboard:write': { args: [content: ClipboardWrite]; result: void }
  'clipboard:read': { args: []; result: ClipboardRead }
  /** MCP server status (Phase 4, contract §4.14). */
  'mcp:status': { args: []; result: McpStatus }
  'mcp:set-enabled': { args: [enabled: boolean]; result: McpStatus }
  /** URL, token and snippets; rejects with "The MCP server is off" when not running. */
  'mcp:setup': { args: []; result: McpSetup }
  'mcp:reset-token': { args: []; result: McpSetup }
  /** A Google Fonts family's faces (`baren-font://` sources), or null when it is not one. */
  'fonts:faces': { args: [family: string]; result: FontFaceSpec[] | null }
  /** Comment requests to Claude Code (`main/agentRuns`). */
  'agentRuns:status': { args: []; result: AgentRunnerStatus }
  'agentRuns:set-enabled': { args: [enabled: boolean]; result: AgentRunnerStatus }
  'agentRuns:start': { args: [request: AgentRunRequest]; result: AgentRun }
  'agentRuns:stop': { args: [runId: string]; result: void }
  'agentRuns:list': { args: []; result: AgentRun[] }
}

/**
 * Synchronous renderer → main requests (`ipcRenderer.sendSync` ↔ `event.returnValue`).
 * Only for values the preload needs before the page runs; main always answers.
 */
export interface SyncChannels {
  /** The resolved theme now (the preload uses it after a reload; `null` if refused). */
  'theme:get-resolved': { args: []; result: ResolvedTheme | null }
}

export interface SendChannels {
  'window:minimize': []
  'window:toggle-maximize': []
  'window:close': []
  'app:new-window': []
  'app:quit': []
  'app:reload': []
  'app:force-reload': []
  'app:toggle-dev-tools': []
  'app:toggle-full-screen': []
  /** The renderer has at least one `onDeepLink` listener: flush queued links to it. */
  'deeplink:subscribe': []
  'deeplink:unsubscribe': []
  /** Run a native editing command (text fields) for a menu command the page cannot handle itself. */
  'edit:native': [action: NativeEditAction]
  /** Startup milestone observed in the renderer; `epochMs` is `performance.timeOrigin + now()`. */
  'startup:milestone': [name: RendererMilestone, epochMs: number]
  /** Quit and install the downloaded update (ignored unless the state is `ready`). */
  'updates:install': []
  /** The answer to an `agent:request` (Phase 4 runtime → main). */
  'agent:response': [response: AgentResponse]
  /** A renderer opened or closed a file it can serve agent requests for. */
  'agent:host': [state: AgentHostState]
}

export interface EventChannels {
  'window:maximized-changed': [maximized: boolean]
  'deeplink:open': [url: string]
  /** A native (macOS) menu item was chosen; the payload is a renderer command id. */
  'menu:command': [id: string]
  /** The resolved app theme changed (sent to every window). */
  'theme:changed': [resolved: ResolvedTheme]
  /** The auto-update status changed (sent to every window). */
  'updates:status': [status: UpdateStatus]
  /** An MCP tool call routed to the renderer that hosts the file (or the render window). */
  'agent:request': [request: AgentRequest]
  /** Give up the request with this id (deadline passed or the client cancelled). */
  'agent:cancel': [id: string]
  /** The agents active in a file (sent to the file's host). */
  'agent:presence': [update: AgentPresenceUpdate]
  /** The MCP server status changed (sent to every app window). */
  'mcp:status': [status: McpStatus]
  /** A tool created or imported a file (sent to every app window). */
  'files:changed': []
  /** A comment request run changed state (sent to every app window). */
  'agentRuns:update': [run: AgentRun]
}

export type InvokeChannel = keyof InvokeChannels
export type SendChannel = keyof SendChannels
export type EventChannel = keyof EventChannels
export type SyncChannel = keyof SyncChannels

export const THEME_PREFERENCES = [
  'light',
  'dark',
  'system',
] as const satisfies readonly ThemePreference[]
export const RESOLVED_THEMES = ['light', 'dark'] as const satisfies readonly ResolvedTheme[]

/**
 * `webPreferences.additionalArguments` entry carrying the resolved theme at window creation,
 * so the preload knows it synchronously (`--baren-theme=dark`).
 */
export const THEME_ARGUMENT_PREFIX = '--baren-theme='

export const NATIVE_EDIT_ACTIONS = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'delete',
  'selectAll',
] as const
export type NativeEditAction = (typeof NATIVE_EDIT_ACTIONS)[number]

export const RENDERER_MILESTONES = [
  'domContentLoaded',
  'load',
  'firstContentfulPaint',
  'appReady',
] as const
export type RendererMilestone = (typeof RENDERER_MILESTONES)[number]

/**
 * DOM events on `window` that connect the preload to the renderer without
 * widening the `BarenBridge` contract:
 * - `baren:command` (CustomEvent<string>, dispatched by the preload): run this command id.
 * - `baren:ready` (Event, dispatched by the renderer): the first screen is interactive.
 */
export const COMMAND_EVENT = 'baren:command'
export const APP_READY_EVENT = 'baren:ready'
