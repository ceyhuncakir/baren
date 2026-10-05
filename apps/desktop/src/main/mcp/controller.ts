/**
 * The built-in MCP server in the Electron main process (contract §3.5, §4): `McpService`
 * (service.ts) plus everything that needs Electron — app windows and their focus, hidden headless
 * host windows, the off-screen render window, `capturePage`/`printToPDF`, `nativeImage`, `net`
 * fetches in an isolated session, and IPC senders.
 *
 * Loaded lazily by `src/main/index.ts` after the first window is interactive (`baren:ready`,
 * or 3 s): this chunk is the only importer of the MCP SDK, zod and @baren/html/sources, so
 * none of them is on the cold-start path.
 */
import {
  BrowserWindow,
  nativeImage,
  net,
  screen,
  session as electronSession,
  type NativeImage,
  type WebContents,
} from 'electron'
import type { AgentHostState, AgentResponse } from '../../renderer/types/bridge'
import type { CoreBackend } from '../core/types'
import { markHiddenSender } from '../ipc/senders'
import type { Logger } from '../log'
import { guardWebContents } from '../security/guards'
import type { WindowManager } from '../windows/windowManager'
import { windowOptions } from '../windows/windowOptions'
import { pngHasAlpha, sniffImage, type FetchLike } from './assets'
import { isAuthUrl, isHomeUrl, type HeadlessWindow } from './hosts'
import type { RpcTarget } from './ipc'
import type { CapturedImage, RenderWindow } from './render'
import { McpService, type HtmlSources, type McpPlatform, type McpServiceFlags } from './service'
import type { ImageCodec } from './tools/context'

export interface McpControllerDeps {
  appVersion: string
  isPackaged: boolean
  platform: string
  userDataDir: string
  downloadsDir: string
  windows: WindowManager
  core(): Promise<CoreBackend>
  rendererUrl: string
  preloadPath: string
  appOrigins: readonly string[]
  /** The bundled stdio shim (`out/main/mcp-stdio.js`). */
  shimSource: string
  flags: McpServiceFlags
  openExternal(url: string): void
  /** The server is listening (startup timeline). */
  onListening?(url: string): void
  log: Logger
}

function targetOf(contents: WebContents): RpcTarget {
  return {
    webContentsId: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    send: (channel: string, payload: unknown) => {
      if (!contents.isDestroyed()) contents.send(channel, payload)
    },
  } as RpcTarget
}

function wrapImage(image: NativeImage): CapturedImage {
  return {
    isEmpty: () => image.isEmpty(),
    getSize: () => image.getSize(),
    resize: (size) => wrapImage(image.resize({ ...size, quality: 'best' })),
    toPNG: () => new Uint8Array(image.toPNG()),
    toJPEG: (quality) => new Uint8Array(image.toJPEG(quality)),
  }
}

/** JPEG re-encoding in main for opaque JPEG/PNG; everything else goes to the render page. */
const codec: ImageCodec = {
  toJpeg(bytes, maxSide, quality) {
    const sniffed = sniffImage(bytes)
    if (sniffed?.kind !== 'raster') return null
    if (sniffed.mime !== 'image/jpeg' && !(sniffed.mime === 'image/png' && !pngHasAlpha(bytes))) {
      return null
    }
    let image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (image.isEmpty()) return null
    const size = image.getSize()
    const scale = Math.min(1, maxSide / Math.max(size.width, size.height))
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best',
      })
    }
    const out = image.getSize()
    return { bytes: new Uint8Array(image.toJPEG(quality)), width: out.width, height: out.height }
  },
}

/**
 * One HTTP request without following redirects: a redirect answers as a bodiless 3xx `Response`
 * with its `location`; anything else streams its body (cancelling the stream aborts the request).
 */
function fetchManual(
  session: Electron.Session,
  url: string,
  init: Parameters<FetchLike>[1],
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (init.signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const request = net.request({
      url,
      session,
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      cache: 'no-store',
    })
    for (const [name, value] of Object.entries(init.headers)) request.setHeader(name, value)
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const onAbort = (): void => {
      request.abort()
      fail(new Error('aborted'))
    }
    init.signal.addEventListener('abort', onAbort, { once: true })
    request.on('redirect', (statusCode, _method, redirectUrl) => {
      settled = true
      init.signal.removeEventListener('abort', onAbort)
      request.abort()
      resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } }))
    })
    request.on('response', (response) => {
      settled = true
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          response.on('end', () => {
            init.signal.removeEventListener('abort', onAbort)
            controller.close()
          })
          response.on('error', (error: Error) => controller.error(error))
        },
        cancel() {
          request.abort()
        },
      })
      const status = response.statusCode
      resolve(
        new Response(status === 204 || status === 304 ? null : body, {
          status: status >= 200 && status <= 599 ? status : 502,
          headers,
        }),
      )
    })
    request.on('error', (error) => fail(error))
    request.on('abort', () => fail(new Error('aborted')))
    request.end()
  })
}

/** Pixels with a non-zero alpha (how completely a frame was painted). */
function paintedPixels(image: NativeImage): number {
  const bitmap = image.toBitmap()
  let n = 0
  for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] !== 0) n++
  return n
}

/** The device scale factor of the display a window is on (OSR frames are in device pixels). */
function displayScale(win: BrowserWindow): number {
  try {
    return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1
  } catch {
    return 1
  }
}

export class McpController extends McpService {
  private readonly watched = new WeakSet<WebContents>()
  /** The window open_file last navigated or opened (`signInShown`). */
  private lastShown: WebContents | null = null

  constructor(private readonly electronDeps: McpControllerDeps) {
    let assetSession: Electron.Session | null = null
    const fetch: FetchLike = (url, init) => {
      // An in-memory partition: no cookies, cache or credentials of the app's session.
      assetSession ??= electronSession.fromPartition('baren-mcp-assets', { cache: false })
      // `session.fetch` cannot hand back a redirect ("Redirect was cancelled"), so manual
      // redirects (assets.ts follows at most 3 itself) go through `net.request`.
      if (init.redirect === 'manual') return fetchManual(assetSession, url, init)
      return assetSession.fetch(url, init as RequestInit)
    }
    let self: McpController | null = null
    const platform: McpPlatform = {
      visibleWindows: () => self!.visibleWindows(),
      createHeadless: (fileId) => self!.createHeadless(fileId),
      createRenderWindow: () => self!.createRenderWindow(),
      showFile: (fileId) => self!.showFile(fileId),
      signInShown: () => self!.signInShown(),
      focusIfAppFocused: (id) => self!.focusIfAppFocused(id),
      broadcastStatus: (status) => electronDeps.windows.broadcast('mcp:status', status),
      broadcastFilesChanged: () => electronDeps.windows.broadcast('files:changed'),
      sendPresence: (target, update) => target.send('agent:presence', update),
      fetch,
      codec,
      stdioCommand: () => process.env['APPIMAGE'] ?? process.execPath,
    }
    super({
      appVersion: electronDeps.appVersion,
      userDataDir: electronDeps.userDataDir,
      downloadsDir: electronDeps.downloadsDir,
      core: () => electronDeps.core(),
      shimSource: electronDeps.shimSource,
      flags: electronDeps.flags,
      platform,
      log: electronDeps.log,
      ...(electronDeps.onListening ? { onListening: electronDeps.onListening } : {}),
      // The parse5-only subpath: the package index would pull @baren/schema (and Loro's
      // web glue) into this chunk for two pure string functions.
      html: () => import('@baren/html/sources').then((m) => m as HtmlSources),
    })
    self = this
  }

  // ---- IPC (index.ts → here) ----------------------------------------------------------------

  private watch(contents: WebContents): void {
    if (this.watched.has(contents)) return
    this.watched.add(contents)
    const id = contents.id
    contents.once('destroyed', () => this.targetGone(id, 'The window closed'))
    contents.on('render-process-gone', () => this.targetGone(id, 'The window crashed'))
    contents.on('did-start-navigation', (nav) => {
      if (nav.isMainFrame && !nav.isSameDocument) this.targetGone(id, 'The window reloaded')
    })
  }

  agentResponse(sender: WebContents, response: AgentResponse): void {
    this.handleResponse(sender.id, response)
  }

  agentHost(sender: WebContents, state: AgentHostState): void {
    this.watch(sender)
    this.handleHostState(targetOf(sender), state)
  }

  beforeVisibleOpen(sender: WebContents, fileId: string): Promise<void> {
    return this.beforeOpen(sender.id, fileId)
  }

  // ---- windows ------------------------------------------------------------------------------

  private visibleWindows(): { target: RpcTarget; focusedAt: number; focused: boolean }[] {
    const focused = BrowserWindow.getFocusedWindow()
    return this.electronDeps.windows
      .focusOrder()
      .filter(({ win }) => !win.isDestroyed() && !win.webContents.isDestroyed())
      .map(({ win, focusedAt }) => ({
        target: targetOf(win.webContents),
        focusedAt,
        focused: win === focused,
      }))
  }

  private webPreferences(): Electron.WebPreferences {
    return windowOptions({
      platform: this.electronDeps.platform,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      preloadPath: this.electronDeps.preloadPath,
    }).webPreferences!
  }

  private createHeadless(fileId: string): HeadlessWindow {
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      frame: false,
      width: 1440,
      height: 900,
      paintWhenInitiallyHidden: true,
      webPreferences: { ...this.webPreferences(), backgroundThrottling: false },
    })
    const contents = win.webContents
    // A file session, not a user's window: only the IPC channels it needs (ipc/senders.ts).
    markHiddenSender(contents, 'agent-host')
    guardWebContents(
      contents,
      this.electronDeps.appOrigins,
      this.electronDeps.openExternal,
      this.log,
    )
    this.watch(contents)
    win
      .loadURL(`${this.electronDeps.rendererUrl}#/agent-host/${encodeURIComponent(fileId)}`)
      .catch((error: unknown) => this.log.warn('headless host failed to load', String(error)))
    return {
      ...targetOf(contents),
      destroy: () => {
        if (!win.isDestroyed()) win.destroy()
      },
    }
  }

  private createRenderWindow(): RenderWindow {
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      frame: false,
      width: 64,
      height: 64,
      transparent: true,
      backgroundColor: '#00000000',
      paintWhenInitiallyHidden: true,
      enableLargerThanScreen: true,
      webPreferences: { ...this.webPreferences(), offscreen: true, backgroundThrottling: false },
    })
    const contents = win.webContents
    contents.setFrameRate(30)
    // Lays out design content for agents: assets, fonts and its answers only (ipc/senders.ts).
    markHiddenSender(contents, 'agent-render')
    guardWebContents(
      contents,
      this.electronDeps.appOrigins,
      this.electronDeps.openExternal,
      this.log,
    )
    this.watch(contents)
    const loaded = new Promise<void>((resolve, reject) => {
      contents.once('did-finish-load', () => resolve())
      contents.once('did-fail-load', (_e, code, description) =>
        reject(new Error(`render window failed to load (${code} ${description})`)),
      )
    })
    loaded.catch(() => undefined)
    // Off-screen frames. `capturePage` of an OSR window can fail (UnknownVizError with the
    // headless Ozone platform and no GPU), so captures come from the `paint` frames (which also
    // keep the alpha channel), with `capturePage` as the fallback. Only frames painted after the
    // last resize count (older ones show an older stage). `invalidate()` is called only when the
    // latest frame already has the right size: invalidating while a resize is pending keeps the
    // OSR view at its old size.
    let frame: { image: NativeImage; seq: number } | null = null
    let frameSeq = 0
    let resizedAtSeq = 0
    let resizePending = false
    let frameWaiters: (() => void)[] = []
    contents.on('paint', (_event, _dirty, image) => {
      frame = { image, seq: ++frameSeq }
      const waiters = frameWaiters
      frameWaiters = []
      for (const w of waiters) w()
    })
    const nextFrame = (timeoutMs: number, invalidate: boolean): Promise<void> =>
      new Promise<void>((resolve) => {
        if (win.isDestroyed()) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, timeoutMs)
        frameWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
        if (invalidate) contents.invalidate()
      })
    type Rect = { x: number; y: number; width: number; height: number }
    /** The size scale of `image` against `rect` (CSS or device pixels), or null when it differs. */
    const scaleOf = (image: NativeImage, rect: Rect): number | null => {
      const size = image.getSize()
      for (const k of [displayScale(win), 1]) {
        const w = Math.round(rect.width * k)
        const h = Math.round(rect.height * k)
        if (
          size.width >= w &&
          size.height >= h &&
          size.width <= w + Math.ceil(k) &&
          size.height <= h + Math.ceil(k)
        ) {
          return k
        }
      }
      return null
    }
    win.loadURL(`${this.electronDeps.rendererUrl}#/agent-render`).catch(() => undefined)
    return {
      ...targetOf(contents),
      loaded,
      setContentSize: (width, height) => {
        if (win.isDestroyed()) return
        resizedAtSeq = frameSeq
        const [cw, ch] = win.getContentSize()
        resizePending = cw !== width || ch !== height
        win.setContentSize(width, height)
      },
      // Without a resize nothing makes the view paint again (a screenshot of a node the size of
      // the previous one waited out the whole timeout): ask for a frame then. With a resize,
      // invalidating would keep the old size (see above), and the resize paints anyway.
      nextPaint: (timeoutMs) => nextFrame(timeoutMs, !resizePending),
      warmUp: async () => {
        // Repeat until capturePage works (a new OSR window's compositor needs a moment).
        const until = Date.now() + 4_000
        for (let i = 0; !win.isDestroyed() && Date.now() < until; i++) {
          resizedAtSeq = frameSeq
          win.setContentSize(16 + (i % 2), 16)
          await nextFrame(300, false)
          try {
            const image = await contents.capturePage(
              { x: 0, y: 0, width: 16, height: 16 },
              { stayHidden: true },
            )
            if (!image.isEmpty()) {
              this.log.debug('render window warmed up', { attempts: i + 1 })
              return
            }
          } catch {
            // Not ready yet.
          }
        }
        this.log.debug('render window: capturePage never worked during warm-up')
      },
      capture: async (rect) => {
        // 1. Wait until the OSR view has the stage size (a frame of that size painted after the
        //    resize), then repaint once at that size.
        const until = Date.now() + 3_000
        let invalidated = false
        let sized: { image: NativeImage; seq: number; k: number } | null = null
        while (!sized && Date.now() <= until && !win.isDestroyed()) {
          const current = frame as { image: NativeImage; seq: number } | null
          const k = current && !current.image.isEmpty() ? scaleOf(current.image, rect) : null
          if (current && k !== null && current.seq > resizedAtSeq) {
            sized = { ...current, k }
            break
          }
          const stale = current !== null && k !== null && !invalidated
          if (stale) invalidated = true
          await nextFrame(250, stale)
        }
        await nextFrame(500, true)
        // 2. capturePage: complete pixels, but right after a resize it can fail for a moment
        //    (UnknownVizError with the headless Ozone platform), so it is retried briefly.
        for (let attempt = 0; attempt < 6 && !win.isDestroyed(); attempt++) {
          try {
            const page = await contents.capturePage(rect, { stayHidden: true })
            if (!page.isEmpty()) return wrapImage(page)
          } catch (error) {
            if (attempt === 5) {
              this.log.debug('render window: capturePage failed; using paint frames', String(error))
            }
          }
          await nextFrame(200, true)
        }
        // 3. Paint frames: the first ones after a resize can be partly painted, so take the most
        //    complete of a few fresh frames.
        let best: { image: NativeImage; painted: number } | null = null
        for (let i = 0; i < 4 && !win.isDestroyed(); i++) {
          const current = frame as { image: NativeImage; seq: number } | null
          const k = current ? scaleOf(current.image, rect) : null
          if (current && k !== null && current.seq > resizedAtSeq) {
            const cropped = current.image.crop({
              x: Math.round(rect.x * k),
              y: Math.round(rect.y * k),
              width: Math.round(rect.width * k),
              height: Math.round(rect.height * k),
            })
            const painted = paintedPixels(cropped)
            if (!best || painted > best.painted) best = { image: cropped, painted }
            if (painted === cropped.getSize().width * cropped.getSize().height) break
          }
          await nextFrame(300, true)
        }
        if (best) return wrapImage(best.image)
        throw new Error(
          `the render window produced no frame of ${rect.width}×${rect.height}${sized ? '' : ' (the view was not resized)'}`,
        )
      },
      printToPdf: async ({ widthPx, heightPx }) =>
        new Uint8Array(
          await contents.printToPDF({
            printBackground: true,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            pageSize: { width: widthPx / 96, height: heightPx / 96 },
          }),
        ),
      destroy: () => {
        if (!win.isDestroyed()) win.destroy()
      },
    }
  }

  private showFile(fileId: string): void {
    const route = `/file/${encodeURIComponent(fileId)}`
    const windows = this.electronDeps.windows
    const appFocused = BrowserWindow.getFocusedWindow() !== null
    const recent = windows.focusOrder()[0]?.win
    if (
      recent &&
      !recent.isDestroyed() &&
      isHomeUrl(recent.webContents.getURL()) &&
      this.hosts.fileOf(recent.webContents.id) === null
    ) {
      recent.webContents
        .executeJavaScript(`location.hash = ${JSON.stringify(`#${route}`)}`)
        .catch((error: unknown) => this.log.warn('could not navigate to the file', String(error)))
      if (appFocused) windows.focus(recent)
      this.lastShown = recent.webContents
      return
    }
    this.lastShown = windows.create({ route, inactive: !appFocused }).webContents
  }

  /** open_file's window redirected to the sign-in screen (signed out, not offline). */
  private signInShown(): boolean {
    const contents = this.lastShown
    if (!contents || contents.isDestroyed()) return false
    return isAuthUrl(contents.getURL())
  }

  private focusIfAppFocused(webContentsId: number): void {
    if (BrowserWindow.getFocusedWindow() === null) return
    const win = this.electronDeps.windows.all.find((w) => w.webContents.id === webContentsId)
    if (win) this.electronDeps.windows.focus(win)
  }
}
