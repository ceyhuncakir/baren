/**
 * Electron main process: windows, the `window.baren` IPC surface, the
 * baren:// deep-link handler, the core backend (Rust napi, or the JS
 * fallback in a worker), auth token storage, the app theme, auto-update, the
 * baren-asset:// scheme and startup instrumentation.
 *
 * Cold-start path: everything before the first `loadURL` is synchronous and
 * cheap; the backend, token store, macOS menu and electron-updater load lazily
 * afterwards.
 */
import { performance } from 'node:perf_hooks'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  app,
  clipboard,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
  type WebContents,
} from 'electron'
import iconPath from '../../resources/icon.png?asset'
import type { RendererMilestone } from '../preload/channels'
import type { AgentHostState, McpStatus } from '../renderer/types/bridge'
import type { TokenStore } from './auth/tokenStore'
import type { BackendSelection } from './core/selectBackend'
import type { McpController } from './mcp/controller'
import {
  DEEP_LINK_SCHEME,
  devMayClaimScheme,
  findDeepLinkInArgv,
  parseDeepLink,
} from './deeplink/deepLink'
import { DeepLinkRouter } from './deeplink/router'
import { createClipboardService } from './clipboard/clipboard'
import { registerIpcHandlers } from './ipc/handlers'
import { createLogger } from './log'
import { serveAssets } from './protocol/assetProtocol'
import { RENDERER_ENTRY_URL, RENDERER_ORIGIN, serveRenderer } from './protocol/rendererProtocol'
import { registerPrivilegedSchemes } from './protocol/schemes'
import { buildCsp } from './security/csp'
import { installPermissionHandlers } from './security/guards'
import { originOf } from './security/urls'
import { chromiumSwitches } from './startup/chromium'
import { parseRuntimeFlags } from './startup/flags'
import { createSmokeUserDataDir, removeStaleSmokeDirs } from './startup/smokeDirs'
import { SmokeSession } from './startup/smokeSession'
import { StartupTimeline } from './startup/timeline'
import { THEME_BACKGROUND, themeArgument } from './theme/theme'
import { ThemeController, loadThemePreference } from './theme/themeController'
import { updateAvailability, type Availability } from './updates/availability'
import { resolveFeedUrl } from './updates/feed'
import { UpdateController, type UpdaterLike } from './updates/updateController'
import {
  DEV_DESKTOP_ID,
  claimDevSchemeHandler,
  ensureDevDesktopEntry,
} from './windows/desktopEntry'
import type { AppShortcut } from './windows/shortcuts'
import { WindowManager } from './windows/windowManager'
import { WindowStateStore } from './windows/windowStateStore'

const timeline = new StartupTimeline(() => performance.now(), performance.timeOrigin)
timeline.mark('mainStart')

const log = createLogger('main')
const flags = parseRuntimeFlags(process.env)
const platform = process.platform

// ---------------------------------------------------------------------------
// Before app.ready
// ---------------------------------------------------------------------------

let smokeUserDataDir: string | null = null
if (flags.userDataDir) {
  app.setPath('userData', resolve(flags.userDataDir))
} else if (flags.smoke) {
  // Smoke runs never touch the real profile (files, window state, token).
  smokeUserDataDir = createSmokeUserDataDir()
  app.setPath('userData', smokeUserDataDir)
}

for (const s of chromiumSwitches(flags)) app.commandLine.appendSwitch(s.name, s.value)
if (flags.disableGpu) app.disableHardwareAcceleration()
// Menus are HTML on Linux/Windows; skipping the default menu also saves startup work.
if (platform !== 'darwin') Menu.setApplicationMenu(null)
if (platform === 'win32') app.setAppUserModelId('dev.baren.app')
if (platform === 'linux' && !app.isPackaged && !flags.smoke) {
  // Dock/taskbar icon of dev runs (packaged builds ship baren.desktop with the icon).
  app.setDesktopName(DEV_DESKTOP_ID)
  try {
    ensureDevDesktopEntry({ execPath: process.execPath, appPath: app.getAppPath(), iconPath })
  } catch (error) {
    log.warn('could not write the dev desktop entry', error)
  }
}
app.enableSandbox()
registerPrivilegedSchemes()

const devServerUrl = app.isPackaged ? null : (process.env['ELECTRON_RENDERER_URL'] ?? null)
const rendererUrl = devServerUrl ?? RENDERER_ENTRY_URL
const devOrigin = devServerUrl ? originOf(devServerUrl) : null
const appOrigins: readonly string[] = devOrigin ? [RENDERER_ORIGIN, devOrigin] : [RENDERER_ORIGIN]
const serverUrl = import.meta.env.VITE_SERVER_URL ?? 'http://127.0.0.1:8787'

const userDataDir = app.getPath('userData')
const stateStore = new WindowStateStore(
  join(userDataDir, 'window-state.json'),
  log.child('window-state'),
)
// Read alongside the window state, before `ready`: the first window needs the resolved theme.
const themeFile = join(userDataDir, 'theme.json')
const savedThemePreference = loadThemePreference(themeFile, log.child('theme'))

let windows: WindowManager | null = null
let updates: UpdateController | null = null
let quitting = false
let smoke: SmokeSession | null = null
let firstContents: WebContents | null = null

const deepLinks = new DeepLinkRouter({
  pickTarget: (subscribers) => {
    const current = windows?.current()
    return subscribers.find((s) => s.id === current?.webContents.id)
  },
  onDelivered: (target) => {
    const win = windows?.all.find((w) => w.webContents.id === target.id)
    if (win) windows?.focus(win)
  },
})

function acceptDeepLink(raw: string, source: string): void {
  const link = parseDeepLink(raw)
  if (!link) {
    log.warn('ignored invalid deep link', { source })
    return
  }
  log.info(`deep link (${source}): ${link.kind}`)
  // No window at all (macOS after closing the last one): open one; the link waits in the queue.
  if (deepLinks.push(link.url) === 'queued' && windows && windows.all.length === 0) windows.create()
}

// ---------------------------------------------------------------------------
// Core backend & token store (lazy)
// ---------------------------------------------------------------------------

let coreSelection: Promise<BackendSelection> | null = null
let coreDisposed = false

function core(): Promise<BackendSelection> {
  coreSelection ??= import('./core/startCore')
    .then(({ startCore }) =>
      startCore({
        mode: flags.coreMode,
        nativeModulePath: flags.nativeModulePath,
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        userDataDir,
        log: log.child('core'),
      }),
    )
    .then((selection) => {
      timeline.mark('coreReady')
      log.info(`core backend: ${selection.kind}`, selection.detail)
      return selection
    })
  return coreSelection
}

async function disposeCore(): Promise<void> {
  if (coreDisposed || coreSelection === null) return
  coreDisposed = true
  // A backend that never started has nothing to flush.
  const selection = await coreSelection.catch(() => null)
  if (selection === null) return
  try {
    await Promise.race([
      selection.backend.dispose(),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
    ])
  } catch (error) {
    log.warn('core dispose failed', String(error))
  }
}

let tokenStore: Promise<TokenStore> | null = null
function tokens(): Promise<TokenStore> {
  tokenStore ??= import('./auth/tokenStore').then(
    ({ TokenStore, safeStorageCipher }) =>
      new TokenStore(
        join(userDataDir, 'auth.json'),
        safeStorageCipher(safeStorage, platform),
        log.child('auth'),
      ),
  )
  return tokenStore
}

// ---------------------------------------------------------------------------
// MCP server (Phase 4, docs/phase4/contract.md §3.5): loaded after the first window is
// interactive (or 3 s), never on the cold path. Smoke runs keep it off unless BAREN_MCP=1.
// ---------------------------------------------------------------------------

const mcpAutoStart = flags.smoke ? flags.mcp === true : true
let mcpController: McpController | null = null
let mcpLoading: Promise<McpController> | null = null
let mcpScheduled = false
let mcpShutDown = false
/** `agent:host` states that arrived before the controller loaded (replayed on load). */
const earlyHostStates = new Map<
  number,
  { sender: WebContents; states: Map<string, AgentHostState> }
>()

function provisionalMcpStatus(): McpStatus {
  const off = !mcpAutoStart || flags.mcp === false
  return {
    state: off ? 'off' : 'starting',
    enabled: !off,
    url: null,
    port: null,
    portChanged: false,
    error: null,
    agents: [],
  }
}

function loadMcp(): Promise<McpController> {
  mcpLoading ??= import('./mcp/controller').then(async ({ McpController }) => {
    if (!windows) throw new Error('the MCP server needs the window manager')
    const controller = new McpController({
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform,
      userDataDir,
      downloadsDir: app.getPath('downloads'),
      windows,
      core: () => core().then((s) => s.backend),
      rendererUrl,
      preloadPath: join(__dirname, '../preload/index.js'),
      appOrigins,
      shimSource: join(__dirname, 'mcp-stdio.js'),
      flags: {
        mcp: flags.mcp,
        mcpPort: flags.mcpPort,
        mcpAllowedOrigins: flags.mcpAllowedOrigins,
        exportDir: flags.exportDir,
        mcpToolTimeoutMs: flags.mcpToolTimeoutMs,
      },
      openExternal: (url) => void shell.openExternal(url),
      onListening: () => timeline.mark('mcpListening'),
      log: log.child('mcp'),
    })
    mcpController = controller
    for (const { sender, states } of earlyHostStates.values()) {
      if (sender.isDestroyed()) continue
      for (const state of states.values()) controller.agentHost(sender, state)
    }
    earlyHostStates.clear()
    await controller.start()
    return controller
  })
  mcpLoading.catch((error: unknown) => log.error('MCP server failed to load', error))
  return mcpLoading
}

function scheduleMcp(): void {
  if (mcpScheduled || !mcpAutoStart) return
  mcpScheduled = true
  setImmediate(() => void loadMcp().catch(() => undefined))
}

const mcpIpc = {
  status: (): McpStatus => mcpController?.status() ?? provisionalMcpStatus(),
  setEnabled: async (enabled: boolean) => (await loadMcp()).setEnabled(enabled),
  setup: async () => (await loadMcp()).setup(),
  resetToken: async () => (await loadMcp()).resetToken(),
  agentResponse(sender: WebContents, response: Parameters<McpController['agentResponse']>[1]) {
    mcpController?.agentResponse(sender, response)
  },
  agentHost(sender: WebContents, state: AgentHostState) {
    if (mcpController) {
      mcpController.agentHost(sender, state)
      return
    }
    let entry = earlyHostStates.get(sender.id)
    if (!entry) {
      entry = { sender, states: new Map() }
      earlyHostStates.set(sender.id, entry)
      sender.once('destroyed', () => earlyHostStates.delete(sender.id))
    }
    if (state.state === 'opened') entry.states.set(state.fileId, state)
    else entry.states.delete(state.fileId)
  },
  beforeFileOpen: async (sender: WebContents, fileId: string) => {
    await mcpController?.beforeVisibleOpen(sender, fileId)
  },
}

/** BAREN_SMOKE + BAREN_MCP=1: the server listens and answers an authenticated initialize. */
async function probeMcp(): Promise<Record<string, unknown>> {
  try {
    const controller = await Promise.race([
      loadMcp(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP load timed out')), 5_000),
      ),
    ])
    const status = await controller.whenSettled(5_000)
    if (status.state !== 'running' || status.url === null) {
      return { ok: false, state: status.state, error: status.error }
    }
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${controller.token ?? ''}`,
    }
    const res = await fetch(status.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'baren-smoke', version: '1' },
        },
      }),
    })
    const sessionId = res.headers.get('mcp-session-id')
    await res.text().catch(() => '')
    if (sessionId) {
      await fetch(status.url, {
        method: 'DELETE',
        headers: { ...headers, 'mcp-session-id': sessionId },
      }).catch(() => undefined)
    }
    return {
      ok: res.status === 200 && sessionId !== null,
      initializeStatus: res.status,
      sessionId: sessionId !== null,
      url: status.url,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// Startup instrumentation
// ---------------------------------------------------------------------------

const MILESTONE_KEYS: Record<RendererMilestone, string> = {
  domContentLoaded: 'rendererDomContentLoaded',
  load: 'rendererLoad',
  firstContentfulPaint: 'rendererFirstContentfulPaint',
  appReady: 'rendererAppReady',
}

function onRendererMilestone(sender: WebContents, name: RendererMilestone, epochMs: number): void {
  if (sender !== firstContents) return
  const key = MILESTONE_KEYS[name]
  if (timeline.has(key)) return // a reload: only the cold start counts
  timeline.markEpoch(key, epochMs)
  if (name === 'appReady') scheduleMcp()
  smoke?.milestone(name)
  if (!flags.smoke && (name === 'firstContentfulPaint' || name === 'appReady')) {
    log.info(`startup (${name})`, timeline.toJSON())
  }
}

function instrumentFirstWindow(win: BrowserWindow): void {
  firstContents = win.webContents
  timeline.mark('windowCreated')
  win.webContents.once('did-start-loading', () => timeline.mark('rendererLoadStart'))
  win.webContents.once('dom-ready', () => timeline.mark('domReady'))
  win.webContents.once('did-finish-load', () => timeline.mark('didFinishLoad'))
  win.once('ready-to-show', () => {
    timeline.mark('readyToShow')
    smoke?.milestone('readyToShow')
  })
  win.once('show', () => timeline.mark('windowShown'))
  smoke?.watch(win)
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function registerProtocolClient(): void {
  if (flags.smoke) return
  if (platform === 'linux' && !app.isPackaged) {
    // Dev runs take baren:// links through baren-dev.desktop (written at startup).
    claimDevSchemeHandler(flags.registerProtocolInDev).then(
      (changed) => {
        if (changed) log.info('baren:// links now open this dev build')
      },
      (error: unknown) => log.warn('could not register baren:// for the dev build', String(error)),
    )
    return
  }
  // On Linux this shells out to xdg-settings synchronously; deb/rpm installs
  // register the handler through the .desktop MimeType, so only AppImage needs it.
  if (platform === 'linux' && !process.env['APPIMAGE']) return
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
    return
  }
  // Windows dev runs take baren:// links unless an installed build has them. macOS registers
  // whole app bundles (here Electron.app), so dev runs there only do with the flag.
  const claim =
    platform === 'win32'
      ? devMayClaimScheme(
          app.getApplicationNameForProtocol(`${DEEP_LINK_SCHEME}://`),
          flags.registerProtocolInDev,
        )
      : flags.registerProtocolInDev
  const args = [app.getAppPath()]
  if (!claim || app.isDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, args)) return
  if (app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, args))
    log.info('baren:// links now open this dev build')
}

async function installMacMenu(): Promise<void> {
  const { macMenuTemplate } = await import('./menu/appMenu')
  const focusedContents = (): WebContents | undefined => windows?.current()?.webContents
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      macMenuTemplate(app.name, {
        newWindow: () => windows?.create(),
        reload: () => focusedContents()?.reload(),
        forceReload: () => focusedContents()?.reloadIgnoringCache(),
        toggleDevTools: () => focusedContents()?.toggleDevTools(),
        toggleFullScreen: () => {
          const win = windows?.current()
          win?.setFullScreen(!win.isFullScreen())
        },
        // Let the renderer run the check (as Help → Check for Updates… does on Linux/Windows), so
        // it shows the checking / up to date / error card; without a window, check silently.
        checkForUpdates: () => {
          const contents = focusedContents()
          if (contents) contents.send('menu:command', 'app.checkForUpdates')
          else void checkForUpdates()
        },
        command: (id) => focusedContents()?.send('menu:command', id),
      }),
    ),
  )
}

function runShortcut(shortcut: AppShortcut, win: BrowserWindow): void {
  switch (shortcut) {
    case 'newWindow':
      windows?.create({ cascadeFrom: win })
      return
    case 'quit':
      app.quit()
      return
    case 'reload':
      win.webContents.reload()
      return
    case 'forceReload':
      win.webContents.reloadIgnoringCache()
      return
    case 'toggleDevTools':
      win.webContents.toggleDevTools()
      return
    case 'toggleFullScreen':
      win.setFullScreen(!win.isFullScreen())
      return
    case 'minimize':
      win.minimize()
      return
    case 'closeWindow':
      win.close()
      return
  }
}

async function checkForUpdates(): Promise<void> {
  await updates?.check()
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

/**
 * electron-updater's download cache (`~/.cache/<name>/pending`): the name electron-builder
 * derives from package.json `name` and writes into app-update.yml.
 */
const UPDATER_CACHE_DIR_NAME = '@barendesktop-updater'

function readPackageType(): string | null {
  if (platform !== 'linux' || !app.isPackaged || process.env['APPIMAGE']) return null
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8')
  } catch {
    return null
  }
}

/**
 * electron-updater reads its cache directory name from app-update.yml (written by
 * electron-builder's `publish` config). Dev builds (BAREN_FORCE_UPDATES) and packages built
 * without it get an equivalent file in userData; the feed itself is always `setFeedURL`.
 */
function configureUpdater(updater: UpdaterLike, feedUrl: string, availability: Availability): void {
  const packagedConfig = app.isPackaged ? join(process.resourcesPath, 'app-update.yml') : null
  if (availability.enabled && availability.kind === 'dev') updater.forceDevUpdateConfig = true
  if (packagedConfig !== null && existsSync(packagedConfig)) return
  const file = join(userDataDir, 'dev-app-update.yml')
  const yaml = `provider: generic\nurl: ${JSON.stringify(feedUrl)}\nupdaterCacheDirName: '${UPDATER_CACHE_DIR_NAME}'\n`
  try {
    writeFileSync(file, yaml)
    updater.updateConfigPath = file
  } catch (error) {
    log.warn('could not write the updater config', String(error))
  }
}

/**
 * electron-updater is a runtime dependency (package.json `dependencies`, packed into app.asar),
 * required on first use: loading it costs ~20 ms that the cold start never pays.
 */
async function loadUpdater(): Promise<UpdaterLike> {
  const mod = createRequire(__filename)('electron-updater') as { autoUpdater?: UpdaterLike }
  if (!mod.autoUpdater) throw new Error('electron-updater has no autoUpdater export')
  return mod.autoUpdater
}

/** Before a quit-and-install: the new version starts while this one exits. */
async function prepareUpdateInstall(): Promise<void> {
  stateStore.flushSync()
  await disposeCore()
  // The relaunched app must win the single-instance lock instead of handing off to us.
  if (!flags.smoke) app.releaseSingleInstanceLock()
}

/** The install did not happen: keep running with a fresh core and the profile lock. */
function recoverFromFailedInstall(): void {
  coreSelection = null
  coreDisposed = false
  if (!flags.smoke) app.requestSingleInstanceLock()
}

function createUpdateController(): UpdateController {
  const feedUrl = resolveFeedUrl({
    override: flags.updateUrl,
    updateUrl: import.meta.env.VITE_UPDATE_URL,
    serverUrl: import.meta.env.VITE_SERVER_URL,
  })
  const availability = updateAvailability({
    platform,
    isPackaged: app.isPackaged,
    forced: flags.forceUpdates,
    smoke: flags.smoke,
    feedUrl,
    appImagePath: process.env['APPIMAGE'] ?? null,
    packageType: readPackageType(),
  })
  return new UpdateController({
    disabledReason: availability.enabled ? null : availability.reason,
    feedUrl: feedUrl ?? '',
    installOnQuit: availability.enabled && availability.installOnQuit,
    loadUpdater,
    configure: (updater) => configureUpdater(updater, feedUrl ?? '', availability),
    onStatus: (status) => windows?.broadcast('updates:status', status),
    prepareInstall: prepareUpdateInstall,
    installFailed: recoverFromFailedInstall,
    isQuitting: () => quitting,
    log: log.child('updates'),
  })
}

async function exitSmoke(code: number): Promise<void> {
  if (flags.smokeInstall && code === 0 && updates?.status().state === 'ready') {
    // Test hook (BAREN_SMOKE_INSTALL): exercise quit-and-install for real.
    log.info('smoke: installing the downloaded update')
    setTimeout(() => app.exit(1), 30_000).unref()
    await updates.install()
    return
  }
  await disposeCore()
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  if (smokeUserDataDir) {
    try {
      rmSync(smokeUserDataDir, { recursive: true, force: true })
    } catch {
      // Chromium may still hold files open; the OS temp dir is cleaned eventually.
    }
  }
  app.exit(code)
}

async function bootstrap(
  savedState: Promise<Awaited<ReturnType<WindowStateStore['load']>>>,
): Promise<void> {
  timeline.mark('appReady')

  if (!devServerUrl) {
    // Dev uses the Vite server (HMR needs inline scripts), so the CSP is production-only.
    serveRenderer(session.defaultSession, join(__dirname, '../renderer'), buildCsp(serverUrl))
  }
  serveAssets(
    session.defaultSession,
    async (hash) => (await core()).backend.getAssetEntry(hash),
    log.child('assets'),
  )
  installPermissionHandlers(session.defaultSession, appOrigins)

  // Before the first window: it is created with the resolved theme's background.
  const themeController = new ThemeController(
    {
      file: themeFile,
      nativeTheme,
      log: log.child('theme'),
      onChange: (resolved) => {
        windows?.setBackgroundColor(THEME_BACKGROUND[resolved])
        windows?.broadcast('theme:changed', resolved)
      },
    },
    await savedThemePreference,
  )
  const updateController = createUpdateController()
  updates = updateController

  if (flags.smoke) {
    if (smokeUserDataDir) void removeStaleSmokeDirs(smokeUserDataDir)
    const expected = flags.smokeUpdates
    smoke = new SmokeSession({
      timeline,
      timeoutMs: flags.smokeTimeoutMs,
      readyGraceMs: flags.smokeReadyGraceMs,
      core,
      exit: exitSmoke,
      ...(flags.mcp === true ? { mcp: probeMcp } : {}),
      ...(expected
        ? {
            updates: {
              expected,
              run: async () => {
                await updateController.check()
                const final = await updateController.whenSettled(flags.smokeTimeoutMs)
                return { final, transitions: updateController.history() }
              },
            },
          }
        : {}),
    })
  }

  windows = new WindowManager({
    platform,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl,
    appOrigins,
    stateStore,
    savedState: await savedState,
    showWindows: !flags.smoke,
    icon: iconPath,
    appearance: () => ({
      backgroundColor: themeController.background,
      additionalArguments: [themeArgument(themeController.resolved)],
    }),
    log: log.child('windows'),
    openExternal: (url) => void shell.openExternal(url),
    onShortcut: runShortcut,
    // Hidden MCP host windows keep `window-all-closed` from firing.
    onLastWindowClosed: () => {
      if (platform !== 'darwin') app.quit()
    },
  })

  registerIpcHandlers(ipcMain, {
    windows,
    core: () => core().then((s) => s.backend),
    tokens,
    deepLinks,
    appOrigins,
    version: () => app.getVersion(),
    quit: () => app.quit(),
    checkForUpdates,
    theme: {
      preference: () => themeController.preference,
      setPreference: (preference) => themeController.setPreference(preference),
      resolved: () => themeController.resolved,
    },
    updates: {
      status: () => updateController.status(),
      check: () => updateController.check(),
      install: () => void updateController.install(),
    },
    openExternal: (url) => shell.openExternal(url),
    onRendererMilestone,
    clipboard: createClipboardService(clipboard, (record) => new ClipboardItem(record)),
    mcp: mcpIpc,
    log: log.child('ipc'),
  })

  instrumentFirstWindow(windows.create())

  const coldLink = findDeepLinkInArgv(process.argv)
  if (coldLink) acceptDeepLink(coldLink.url, 'argv')

  // Off the critical path: warm the backend while the renderer boots.
  setImmediate(() => {
    core().catch((error: unknown) => log.error('core backend failed to start', error))
    if (platform === 'darwin') void installMacMenu()
  })
  setTimeout(registerProtocolClient, 3000).unref()
  // The MCP server starts after the first screen is interactive, or 3 s from now.
  setTimeout(scheduleMcp, 3000).unref()
  // Smoke runs with BAREN_SMOKE_UPDATES check on their own schedule.
  if (!flags.smokeUpdates) updateController.start()
}

function start(): void {
  // macOS delivers launch URLs very early: listen before `ready`.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    acceptDeepLink(url, 'open-url')
  })

  app.on('second-instance', (_event, argv) => {
    // Before bootstrap there is no window yet: the link is queued for the first one.
    if (windows) windows.focus(windows.current() ?? windows.create())
    const link = findDeepLinkInArgv(argv)
    if (link) acceptDeepLink(link.url, 'second-instance')
  })

  app.on('activate', () => {
    if (windows && windows.all.length === 0) windows.create()
  })

  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    quitting = true
    updates?.stop()
    // MCP: refuse new requests, flush headless hosts (≤ 3 s), remove endpoint.json; then quit.
    if (mcpController && !mcpShutDown) {
      event.preventDefault()
      mcpShutDown = true
      void mcpController
        .shutdown()
        .catch((error: unknown) => log.warn('MCP shutdown failed', String(error)))
        .finally(() => app.quit())
    }
  })

  app.on('will-quit', (event) => {
    stateStore.flushSync()
    if (coreSelection !== null && !coreDisposed) {
      event.preventDefault()
      void disposeCore().finally(() => app.quit())
    }
  })

  const savedState = stateStore.load()
  app
    .whenReady()
    .then(() => bootstrap(savedState))
    .catch((error: unknown) => {
      log.error('startup failed', error)
      if (flags.smoke)
        process.stdout.write(
          `${JSON.stringify({ smoke: 'baren', ok: false, error: String(error) })}\n`,
        )
      app.exit(1)
    })
}

// Smoke runs are isolated (own userData), so they must not hand off to a running instance.
if (flags.smoke || app.requestSingleInstanceLock()) {
  start()
} else {
  // Another instance owns the profile; it receives our argv via `second-instance`.
  app.quit()
}
