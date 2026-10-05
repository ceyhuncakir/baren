/**
 * Electron harness for the clipboard bridge (contract §10.3, "Electron: copy in window 1,
 * paste in window 2 through bridge.clipboard"). Runs the REAL preload (built by
 * electron-vite), the real IPC handlers with their validation and trusted-sender check, and
 * the real main-process clipboard service on Electron 44's `clipboard.write/read`.
 *
 * Two hidden, offscreen windows load an `app://renderer/` page (trusted origin): window 1
 * writes through `window.baren.clipboard.write`, window 2 reads through
 * `window.baren.clipboard.read`. The raw clipboard item must carry the Chromium web custom
 * format, which any Chromium renderer (the browser mock's `navigator.clipboard`) reads; offscreen
 * windows cannot take focus, so that renderer-side read is covered by the browser tests. Run
 * with `--ozone-platform=headless` (no window on screen, no OS clipboard).
 *
 * Prints `RESULT <json>` and exits.
 */
import { BrowserWindow, ClipboardItem, app, clipboard, ipcMain, protocol, session } from 'electron'
import { createClipboardService } from '../../../src/main/clipboard/clipboard'
import { registerIpcHandlers, type IpcContext } from '../../../src/main/ipc/handlers'

const preload = process.env['BAREN_HARNESS_PRELOAD'] ?? ''
/** A 1×1 PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const unused = (): never => {
  throw new Error('not available in the clipboard harness')
}

async function main(): Promise<void> {
  await app.whenReady()
  protocol.handle(
    'app',
    () =>
      new Response('<!doctype html><meta charset="utf-8"><title>harness</title><p>x</p>', {
        headers: { 'content-type': 'text/html' },
      }),
  )
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  }
  const ctx = {
    windows: { create: unused },
    core: unused,
    tokens: unused,
    deepLinks: { subscribe: () => undefined, unsubscribe: () => undefined },
    appOrigins: ['app://renderer'],
    // The harness's windows are app windows (ipc/senders.ts).
    senderKind: () => 'app',
    version: () => 'harness',
    quit: () => undefined,
    checkForUpdates: async () => undefined,
    theme: {
      preference: () => 'light',
      setPreference: async () => undefined,
      resolved: () => 'light',
    },
    updates: {
      status: () => ({ state: 'disabled' }),
      check: async () => ({ state: 'disabled' }),
      install: () => undefined,
    },
    openExternal: async () => undefined,
    onRendererMilestone: () => undefined,
    clipboard: createClipboardService(clipboard, (record) => new ClipboardItem(record)),
    log,
  } as unknown as IpcContext
  registerIpcHandlers(ipcMain, ctx)

  const open = async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, offscreen: true },
    })
    await win.loadURL('app://renderer/index.html')
    return win
  }
  const out: Record<string, unknown> = {}
  try {
    const one = await open()
    const two = await open()
    const payload = JSON.stringify({ kind: 'baren/clipboard', version: 2, nodes: [] })
    out['bridge'] = await one.webContents.executeJavaScript(
      `typeof window.baren?.clipboard?.write === 'function'`,
    )
    await one.webContents.executeJavaScript(
      `window.baren.clipboard.write(${JSON.stringify({
        text: 'Card',
        html: '<div>Card</div>',
        baren: payload,
      })})`,
    )
    out['read'] = await two.webContents.executeJavaScript(`window.baren.clipboard.read()`)
    // Validation: unknown representations are refused by main (plain Error in the page).
    out['invalid'] = await one.webContents.executeJavaScript(
      `window.baren.clipboard.write({ text: 'x', script: 'y' }).then(() => 'accepted', (e) => String(e.message))`,
    )
    // The raw item: ONE item carrying the web custom format next to text and HTML.
    await one.webContents.executeJavaScript(
      `window.baren.clipboard.write(${JSON.stringify({
        text: 'Card',
        html: '<div>Card</div>',
        baren: payload,
      })})`,
    )
    const items = await clipboard.read()
    out['items'] = items.length
    out['types'] = items[0]?.types ?? []
    // And a PNG written by Copy as PNG (a real 1×1 image: Chromium decodes it) reads back.
    await one.webContents.executeJavaScript(
      `window.baren.clipboard.write({ png: Uint8Array.from(atob(${JSON.stringify(PIXEL)}), (c) => c.charCodeAt(0)) })`,
    )
    const images = (await two.webContents.executeJavaScript(
      `window.baren.clipboard.read().then((r) => r.images.map((i) => [i.mime, i.bytes.length]))`,
    )) as unknown
    out['images'] = images
  } catch (error) {
    out['error'] = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`)
  app.exit(0)
}

void main()
