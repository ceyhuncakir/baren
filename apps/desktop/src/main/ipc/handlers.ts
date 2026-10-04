/**
 * IPC handlers behind `window.baren`. Every message is checked for a
 * trusted sender (top-level app frame) and validated arguments before it
 * touches windows, the core backend or the token store.
 */
import {
  BrowserWindow,
  type IpcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import {
  NATIVE_EDIT_ACTIONS,
  RENDERER_MILESTONES,
  THEME_PREFERENCES,
  type InvokeChannels,
  type NativeEditAction,
  type RendererMilestone,
  type SendChannels,
  type SyncChannels,
} from '../../preload/channels'
import type {
  AgentHostState,
  AgentResponse,
  McpSetup,
  McpStatus,
  ResolvedTheme,
  ThemePreference,
  UpdateStatus,
} from '../../renderer/types/bridge'
import type { TokenStore } from '../auth/tokenStore'
import { CLIPBOARD_LIMITS, type ClipboardService } from '../clipboard/clipboard'
import type { CoreBackend } from '../core/types'
import type { DeepLinkRouter, DeepLinkTarget } from '../deeplink/router'
import type { Logger } from '../log'
import type { FontFaceSpec } from '../../renderer/lib/fontUrls'
import { isAppUrl, isSafeExternalUrl } from '../security/urls'
import type { WindowManager } from '../windows/windowManager'
import { IpcArgumentError, MiB, agentIs, args, is } from './validate'

export interface IpcContext {
  windows: WindowManager
  core(): Promise<CoreBackend>
  tokens(): Promise<TokenStore>
  deepLinks: DeepLinkRouter
  appOrigins: readonly string[]
  version(): string
  quit(): void
  checkForUpdates(): Promise<void>
  theme: {
    preference(): ThemePreference
    setPreference(preference: ThemePreference): Promise<void>
    resolved(): ResolvedTheme
  }
  updates: {
    status(): UpdateStatus
    check(): Promise<UpdateStatus>
    install(): void
  }
  openExternal(url: string): Promise<void>
  onRendererMilestone(sender: WebContents, name: RendererMilestone, epochMs: number): void
  /** The system clipboard (`bridge.clipboard`, Phase 3 copy/paste between files and windows). */
  clipboard: ClipboardService
  /**
   * The built-in MCP server (Phase 4, docs/phase4/contract.md §4.14). Implemented in index.ts on
   * top of the lazily loaded `mcp/controller`.
   */
  mcp: {
    status(): Promise<McpStatus> | McpStatus
    setEnabled(enabled: boolean): Promise<McpStatus>
    setup(): Promise<McpSetup>
    resetToken(): Promise<McpSetup>
    agentResponse(sender: WebContents, response: AgentResponse): void
    agentHost(sender: WebContents, state: AgentHostState): void
    /** Before a window opens a file: a headless host holding it flushes and closes (§4.5). */
    beforeFileOpen(sender: WebContents, fileId: string): Promise<void>
  }
  /** Google Fonts for designs (`fonts/googleFonts.ts`, loaded on first use). */
  fonts: {
    faces(family: string): Promise<FontFaceSpec[] | null>
  }
  log: Logger
}

/** Mirrors the Rust core's limits (crates/core/src/store: MAX_*_BYTES). */
const LIMITS = {
  name: 1024,
  token: 16 * 1024,
  url: 8 * 1024,
  mime: 255,
  update: 64 * MiB,
  agentResponse: 32 * MiB,
  thumbnail: 16 * MiB,
  asset: 256 * MiB,
  fontFamily: 256,
} as const

type SenderEvent = IpcMainEvent | IpcMainInvokeEvent

export function deepLinkTarget(contents: WebContents): DeepLinkTarget {
  return {
    id: contents.id,
    send: (url) => contents.send('deeplink:open', url),
    isDestroyed: () => contents.isDestroyed(),
  }
}

function runNativeEdit(contents: WebContents, action: NativeEditAction): void {
  switch (action) {
    case 'undo':
      return contents.undo()
    case 'redo':
      return contents.redo()
    case 'cut':
      return contents.cut()
    case 'copy':
      return contents.copy()
    case 'paste':
      return contents.paste()
    case 'delete':
      return contents.delete()
    case 'selectAll':
      return contents.selectAll()
  }
}

export function registerIpcHandlers(ipcMain: IpcMain, ctx: IpcContext): void {
  const { log } = ctx

  const isTrusted = (event: SenderEvent): boolean => {
    const frame = event.senderFrame
    return frame !== null && frame.parent === null && isAppUrl(frame.url, ctx.appOrigins)
  }

  const handle = <K extends keyof InvokeChannels>(
    channel: K,
    parse: (raw: readonly unknown[]) => InvokeChannels[K]['args'],
    fn: (
      event: IpcMainInvokeEvent,
      ...a: InvokeChannels[K]['args']
    ) => Promise<InvokeChannels[K]['result']> | InvokeChannels[K]['result'],
  ): void => {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      if (!isTrusted(event)) throw new Error(`untrusted sender for ${channel}`)
      return fn(event, ...parse(raw))
    })
  }

  const on = <K extends keyof SendChannels>(
    channel: K,
    parse: (raw: readonly unknown[]) => SendChannels[K],
    fn: (event: IpcMainEvent, ...a: SendChannels[K]) => void,
  ): void => {
    ipcMain.on(channel, (event, ...raw: unknown[]) => {
      if (!isTrusted(event)) {
        log.warn('ignored IPC from untrusted sender', { channel })
        return
      }
      try {
        fn(event, ...parse(raw))
      } catch (error) {
        log.warn(`IPC ${channel} failed`, error instanceof IpcArgumentError ? error.message : error)
      }
    })
  }

  /** Synchronous request: always answers (a missing `returnValue` would hang the renderer). */
  const handleSync = <K extends keyof SyncChannels>(
    channel: K,
    fn: (event: IpcMainEvent) => SyncChannels[K]['result'],
    refused: SyncChannels[K]['result'],
  ): void => {
    ipcMain.on(channel, (event) => {
      try {
        event.returnValue = isTrusted(event) ? fn(event) : refused
      } catch (error) {
        log.warn(`IPC ${channel} failed`, String(error))
        event.returnValue = refused
      }
    })
  }

  const windowOf = (event: SenderEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)
  const none = args()

  // ---- window
  on('window:minimize', none, (e) => windowOf(e)?.minimize())
  on('window:toggle-maximize', none, (e) => {
    const win = windowOf(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  on('window:close', none, (e) => windowOf(e)?.close())
  handle('window:is-maximized', none, (e) => windowOf(e)?.isMaximized() ?? false)

  // ---- files
  handle('files:list', none, async () => (await ctx.core()).listFiles())
  handle('files:create', args(is.string(LIMITS.name)), async (_e, name) =>
    (await ctx.core()).createFile(name),
  )
  handle('files:rename', args(is.id, is.string(LIMITS.name)), async (_e, id, name) =>
    (await ctx.core()).renameFile(id, name),
  )
  handle('files:archive', args(is.id, is.boolean), async (_e, id, archived) =>
    (await ctx.core()).archiveFile(id, archived),
  )
  handle('files:remove', args(is.id), async (_e, id) => (await ctx.core()).removeFile(id))
  handle('files:open', args(is.id), async (e, id) => {
    // A headless MCP host holding this file hands it off first (never two writers).
    await ctx.mcp.beforeFileOpen(e.sender, id)
    return (await ctx.core()).openFile(id)
  })
  handle('files:apply-update', args(is.id, is.bytes(LIMITS.update)), async (_e, id, update) =>
    (await ctx.core()).applyUpdate(id, update),
  )
  handle('files:set-thumbnail', args(is.id, is.bytes(LIMITS.thumbnail)), async (_e, id, png) =>
    (await ctx.core()).setThumbnail(id, png),
  )
  handle('files:get-thumbnail', args(is.id), async (_e, id) => (await ctx.core()).getThumbnail(id))
  handle(
    'files:import',
    args(is.bytes(LIMITS.update), is.nullableString(LIMITS.name)),
    async (_e, snapshot, name) => (await ctx.core()).importFile(snapshot, name),
  )
  handle(
    'files:set-remote',
    args(is.id, is.nullableId, is.nullableId),
    async (_e, id, teamId, remoteId) => (await ctx.core()).setFileRemote(id, teamId, remoteId),
  )

  // ---- assets & export
  handle(
    'assets:put',
    args(is.bytes(LIMITS.asset), is.string(LIMITS.mime)),
    async (_e, bytes, mime) => (await ctx.core()).putAsset(bytes, mime),
  )
  handle('assets:get', args(is.id), async (_e, hash) => (await ctx.core()).getAsset(hash))
  handle('fonts:faces', args(is.string(LIMITS.fontFamily)), (_e, family) => ctx.fonts.faces(family))
  handle('export:html', args(is.id, is.id), async (_e, fileId, nodeId) =>
    (await ctx.core()).exportHtml(fileId, nodeId),
  )
  handle('export:json', args(is.id), async (_e, fileId) => (await ctx.core()).exportJson(fileId))

  // ---- auth
  handle('auth:get-token', none, async () => (await ctx.tokens()).getToken())
  handle('auth:set-token', args(is.nullableString(LIMITS.token)), async (_e, token) =>
    (await ctx.tokens()).setToken(token),
  )

  // ---- shell
  handle('shell:open-external', args(is.string(LIMITS.url)), async (_e, url) => {
    if (!isSafeExternalUrl(url)) throw new Error('Only http(s) URLs can be opened externally')
    await ctx.openExternal(url)
  })

  // ---- deep links
  const tracked = new WeakSet<WebContents>()
  on('deeplink:subscribe', none, (e) => {
    const contents = e.sender
    if (!tracked.has(contents)) {
      tracked.add(contents)
      // A reload or navigation drops the page's listeners; it re-subscribes when ready.
      contents.on('did-start-navigation', (nav) => {
        if (nav.isMainFrame && !nav.isSameDocument) ctx.deepLinks.unsubscribe(contents.id)
      })
      contents.once('destroyed', () => ctx.deepLinks.unsubscribe(contents.id))
    }
    ctx.deepLinks.subscribe(deepLinkTarget(contents))
  })
  on('deeplink:unsubscribe', none, (e) => ctx.deepLinks.unsubscribe(e.sender.id))

  // ---- app commands
  on('app:new-window', none, (e) => {
    ctx.windows.create({ cascadeFrom: windowOf(e) })
  })
  on('app:quit', none, () => ctx.quit())
  on('app:reload', none, (e) => e.sender.reload())
  on('app:force-reload', none, (e) => e.sender.reloadIgnoringCache())
  on('app:toggle-dev-tools', none, (e) => e.sender.toggleDevTools())
  on('app:toggle-full-screen', none, (e) => {
    const win = windowOf(e)
    win?.setFullScreen(!win.isFullScreen())
  })
  handle('app:check-for-updates', none, () => ctx.checkForUpdates())
  handle('app:version', none, () => ctx.version())

  // ---- theme
  handle('theme:get-preference', none, () => ctx.theme.preference())
  handle('theme:set-preference', args(is.oneOf(THEME_PREFERENCES)), (_e, preference) =>
    ctx.theme.setPreference(preference),
  )
  handleSync('theme:get-resolved', () => ctx.theme.resolved(), null)

  // ---- auto-update
  handle('updates:status', none, () => ctx.updates.status())
  handle('updates:check', none, () => ctx.updates.check())
  on('updates:install', none, () => ctx.updates.install())

  // ---- clipboard (one atomic item: text, html, the baren payload, png)
  handle('clipboard:write', args(is.clipboardWrite(CLIPBOARD_LIMITS)), (_e, content) =>
    ctx.clipboard.write(content),
  )
  handle('clipboard:read', none, () => ctx.clipboard.read())

  // ---- MCP server + agent requests (Phase 4)
  handle('mcp:status', none, () => ctx.mcp.status())
  handle('mcp:set-enabled', args(is.boolean), (_e, enabled) => ctx.mcp.setEnabled(enabled))
  handle('mcp:setup', none, () => ctx.mcp.setup())
  handle('mcp:reset-token', none, () => ctx.mcp.resetToken())
  on('agent:response', args(agentIs.response(LIMITS.agentResponse)), (e, response) =>
    ctx.mcp.agentResponse(e.sender, response),
  )
  on('agent:host', args(agentIs.hostState), (e, state) => ctx.mcp.agentHost(e.sender, state))

  // ---- editing + startup instrumentation
  on('edit:native', args(is.oneOf(NATIVE_EDIT_ACTIONS)), (e, action) =>
    runNativeEdit(e.sender, action),
  )
  on(
    'startup:milestone',
    args(is.oneOf(RENDERER_MILESTONES), is.finiteNumber),
    (e, name, epochMs) => ctx.onRendererMilestone(e.sender, name, epochMs),
  )
}
