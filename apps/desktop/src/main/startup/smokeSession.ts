/**
 * BAREN_SMOKE wiring: watches the (hidden) first window, then prints one
 * JSON line with startup timings to stdout and exits 0 (ready) or 1 (failed).
 */
import { performance } from 'node:perf_hooks'
import type { BrowserWindow, WebContents } from 'electron'
import { appInfo } from '../appInfo'
import type { UpdateState, UpdateStatus } from '../../renderer/types/bridge'
import type { BackendSelection } from '../core/selectBackend'
import { SmokeRun, coldStartMs, type SmokeOutcome } from './smoke'
import type { StartupTimeline } from './timeline'

export interface SmokeSessionOptions {
  timeline: StartupTimeline
  timeoutMs: number
  readyGraceMs: number
  /** Resolves the selected core backend (exercised once so the report proves it works). */
  core(): Promise<BackendSelection>
  /** Flush, tear down and exit the process with the given code. */
  exit(code: number): Promise<void>
  /**
   * BAREN_SMOKE + BAREN_MCP=1 (contract docs/phase4/contract.md §4.15): waits (≤ 5 s) for
   * the MCP server to listen and POSTs an authenticated `initialize`; `ok` must be true.
   */
  mcp?: () => Promise<Record<string, unknown>>
  /** BAREN_SMOKE_UPDATES: check for updates and wait for the result (never installs). */
  updates?: {
    expected: UpdateState
    run(): Promise<{ final: UpdateStatus; transitions: readonly unknown[] }>
  }
}

interface BackendReport {
  kind?: string
  detail?: string
  listFilesMs?: number
  error?: string
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function probeBackend(core: () => Promise<BackendSelection>): Promise<BackendReport> {
  try {
    const selection = await withTimeout(core(), 10_000, 'core backend start')
    const t0 = performance.now()
    await withTimeout(selection.backend.listFiles(), 10_000, 'listFiles')
    return {
      kind: selection.kind,
      detail: selection.detail,
      listFilesMs: Math.round((performance.now() - t0) * 10) / 10,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Runs in the page (main world) at the end of a smoke run: proves the preload
 * exposed the bridge and that IPC → main → core backend works end to end
 * (including Loro in the JS core: `files.open` builds a snapshot).
 */
const BRIDGE_PROBE = `(async () => {
  const b = window.baren
  if (!b) return { exposed: false }
  const t0 = performance.now()
  const version = await b.app.version()
  const before = (await b.files.list()).length
  const file = await b.files.create('smoke check')
  const snapshot = await b.files.open(file.id)
  await b.files.remove(file.id)
  // Links queued by main (e.g. a cold-start baren:// argv) flush to the first subscriber.
  const deepLinks = []
  const off = b.onDeepLink((url) => deepLinks.push(url))
  await new Promise((r) => setTimeout(r, 50))
  off()
  let evalBlocked = false
  try { (0, eval)('1') } catch { evalBlocked = true }
  // baren-asset:// end to end: core → protocol → CSP (fetch + <img>) with a 1×1 PNG.
  let asset
  try {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const hash = await b.assets.put(png, 'image/png')
    const url = 'baren-asset://' + hash
    const res = await fetch(url)
    const body = new Uint8Array(await res.arrayBuffer())
    const img = new Image()
    img.src = url
    await img.decode()
    const status = async (u) => { try { return (await fetch(u)).status } catch (e) { return String(e) } }
    asset = {
      status: res.status,
      type: res.headers.get('content-type'),
      cache: res.headers.get('cache-control'),
      bytesMatch: body.length === png.length && body.every((v, i) => v === png[i]),
      imageWidth: img.naturalWidth,
      missing: await status('baren-asset://' + '0'.repeat(64)),
      invalid: await status('baren-asset://not-a-hash'),
    }
  } catch (e) {
    asset = { error: String(e) }
  }
  return {
    exposed: true,
    evalBlocked,
    platform: b.platform,
    namespaces: Object.keys(b).sort(),
    version,
    filesBefore: before,
    snapshotBytes: snapshot.byteLength,
    deepLinks,
    roundTripMs: Math.round((performance.now() - t0) * 10) / 10,
    asset,
    theme: { initial: b.theme.initial, preference: await b.theme.preference(), dataTheme: document.documentElement.dataset.theme ?? null },
    updates: await b.updates.status(),
  }
})()`

function assetProbeOk(bridge: Record<string, unknown>): boolean {
  const asset = bridge['asset'] as Record<string, unknown> | undefined
  return (
    asset !== undefined &&
    asset['status'] === 200 &&
    asset['type'] === 'image/png' &&
    asset['bytesMatch'] === true &&
    asset['imageWidth'] === 1 &&
    asset['missing'] === 404 &&
    asset['invalid'] === 404
  )
}

async function probeBridge(contents: WebContents | null): Promise<Record<string, unknown>> {
  if (!contents || contents.isDestroyed()) return { error: 'no renderer' }
  try {
    const result: unknown = await withTimeout(
      contents.executeJavaScript(BRIDGE_PROBE, true),
      10_000,
      'bridge probe',
    )
    return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export class SmokeSession {
  private readonly run: SmokeRun
  private contents: WebContents | null = null

  constructor(private readonly options: SmokeSessionOptions) {
    this.run = new SmokeRun({
      timeoutMs: options.timeoutMs,
      readyGraceMs: options.readyGraceMs,
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      },
      onFinish: (outcome) => void this.report(outcome),
    })
  }

  watch(win: BrowserWindow): void {
    const contents = win.webContents
    this.contents = contents
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) this.run.fail(`did-fail-load ${code} ${description} (${url})`)
    })
    contents.on('render-process-gone', (_event, details) => {
      this.run.fail(`render process gone: ${details.reason}`)
    })
    contents.on('preload-error', (_event, path, error) => {
      this.run.fail(`preload error in ${path}: ${error.message}`)
    })
    contents.on('console-message', (event) => {
      if (event.level === 'error') this.run.rendererError(event.message)
    })
    this.run.start()
  }

  /** Renderer milestone names as sent by the preload (`appReady`, `firstContentfulPaint`, …). */
  milestone(name: string): void {
    this.run.milestone(name)
  }

  private async probeUpdates(): Promise<Record<string, unknown> & { ok: boolean }> {
    const updates = this.options.updates
    if (!updates) return { ok: true }
    try {
      const t0 = performance.now()
      const { final, transitions } = await updates.run()
      return {
        ok: final.state === updates.expected,
        expected: updates.expected,
        final,
        transitions,
        ms: Math.round(performance.now() - t0),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async report(outcome: SmokeOutcome): Promise<void> {
    const backend = await probeBackend(this.options.core)
    const bridge = outcome.ok ? await probeBridge(this.contents) : null
    const updates = outcome.ok && this.options.updates ? await this.probeUpdates() : undefined
    const mcp = outcome.ok && this.options.mcp ? await this.options.mcp() : undefined
    const ok =
      outcome.ok &&
      (mcp === undefined || mcp['ok'] === true) &&
      backend.error === undefined &&
      bridge !== null &&
      bridge['exposed'] === true &&
      !('error' in bridge) &&
      assetProbeOk(bridge) &&
      (updates === undefined || updates.ok)
    const timings = this.options.timeline.toJSON()
    const report = {
      smoke: 'baren',
      ok,
      reason: outcome.reason,
      ...(outcome.error ? { error: outcome.error } : {}),
      coldStartMs: coldStartMs(timings),
      timings,
      backend,
      bridge,
      ...(updates ? { updates } : {}),
      ...(mcp ? { mcp, mcpReadyMs: this.options.timeline.get('mcpListening') ?? null } : {}),
      rendererErrors: outcome.rendererErrors,
      app: appInfo(),
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
    await this.options.exit(ok ? 0 : 1)
  }
}
