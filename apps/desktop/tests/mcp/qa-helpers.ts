/**
 * Helpers for the QA specs of the MCP server (qa-*.spec.ts): an offline app launch, raw HTTP
 * requests (for the security checks, with any Host/Origin), an id-free document state read through
 * MCP (for the one-undo-step-per-call checks) and latency statistics.
 */
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { _electron as electron, type Page } from '@playwright/test'
import {
  DESKTOP,
  OUT,
  call,
  connect,
  launchApp,
  readEndpoint,
  waitFor,
  type Endpoint,
  type LaunchedApp,
} from './harness'

export interface OfflineApp {
  launched: LaunchedApp
  first: Page
  endpoint: Endpoint
}

/**
 * Launch the built app hidden on an existing profile (app restarts). `close()` keeps the
 * profile; the caller removes it.
 */
export async function relaunch(
  userData: string,
  exportDir: string,
  extraEnv: Record<string, string> = {},
): Promise<LaunchedApp> {
  const require_ = createRequire(join(DESKTOP, 'package.json'))
  const app = await electron.launch({
    executablePath: require_('electron') as unknown as string,
    args: [
      process.env['BAREN_ELECTRON_OUT'] ? join(OUT, 'main/index.js') : DESKTOP,
      '--ozone-platform=headless',
      '--disable-gpu',
    ],
    env: {
      ...(process.env as Record<string, string>),
      BAREN_USER_DATA_DIR: userData,
      BAREN_MCP: '1',
      BAREN_MCP_PORT: '0',
      BAREN_EXPORT_DIR: exportDir,
      BAREN_DISABLE_GPU: '1',
      ELECTRON_ENABLE_LOGGING: '0',
      ...extraEnv,
    },
    timeout: 60_000,
  })
  return {
    app,
    userData,
    exportDir,
    async close() {
      await app.close().catch(() => undefined)
    },
  }
}

/** The first window of a (re)launched app, on Recents, offline. */
export async function goOffline(launched: LaunchedApp): Promise<Page> {
  const first = await launched.app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  await first.evaluate(() => {
    localStorage.setItem('baren.offline', '1')
    if (location.hash !== '#/recents') {
      location.hash = '#/recents'
      location.reload()
    }
  })
  await first.waitForLoadState('domcontentloaded')
  return first
}

/** Launch the built app (hidden, scratch profile) and continue offline on the first window. */
export async function launchOffline(extraEnv: Record<string, string> = {}): Promise<OfflineApp> {
  const launched = await launchApp(extraEnv)
  const first = await launched.app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  await first.evaluate(() => {
    localStorage.setItem('baren.offline', '1')
    location.hash = '#/recents'
    location.reload()
  })
  await first.waitForLoadState('domcontentloaded')
  const endpoint = await readEndpoint(launched.userData)
  return { launched, first, endpoint }
}

/** The app window that shows `fileId` (an editor route). */
export function editorWindow(launched: LaunchedApp, fileId: string): Promise<Page> {
  return waitFor(
    () =>
      launched.app
        .windows()
        .find((w) => decodeURIComponent(w.url()).includes(`#/file/${fileId}`)) ?? null,
    20_000,
    `a window on file ${fileId}`,
  )
}

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** One HTTP request to the MCP endpoint with exactly the given headers (Host included). */
export function raw(
  url: string,
  opts: {
    method?: string
    path?: string
    headers?: Record<string, string>
    body?: string | Buffer
    timeoutMs?: number
  } = {},
): Promise<RawResponse> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: Number(u.port),
        method: opts.method ?? 'POST',
        path: opts.path ?? u.pathname,
        headers: {
          Host: u.host,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...opts.headers,
        },
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

export const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'qa-raw', version: '1.0.0' },
  },
})

/** Tree summary lines with ids removed (ids do not survive undo of a create or delete). */
export function idFree(summary: string): string[] {
  return summary.split('\n').map((line) => line.replace(/ \([^()\s]+\) /, ' ').replace(/\s+$/, ''))
}

/** Node ids in a tree summary, in document order. */
export function summaryIds(summary: string): string[] {
  return [...summary.matchAll(/" \(([^()\s]+)\) /g)].map((m) => m[1]!)
}

/**
 * The page's content as seen through MCP, without ids: the tree (types, names, sizes, text) at
 * depth 10, every node's declared styles in document order, and the tokens.
 */
export async function docState(client: Client, fileId: string, pageId: string): Promise<string> {
  const tree = (
    (await call(client, 'get_tree_summary', { fileId, nodeId: pageId, depth: 10 })).body as {
      summary: string
    }
  ).summary
  const ids = summaryIds(tree)
  const styles: unknown[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const body = (await call(client, 'get_computed_styles', { fileId, nodeIds: batch })).body as {
      styles: Record<string, unknown>
    }
    for (const id of batch) styles.push(body.styles[id] ?? null)
  }
  const tokens = (await call(client, 'get_tokens', { fileId })).body
  return JSON.stringify({ tree: idFree(tree), styles, tokens }, null, 1)
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]!
}

/** p50/p95 (ms) of `runs` sequential calls. */
export async function latency(
  runs: number,
  fn: (i: number) => Promise<unknown>,
): Promise<{ p50: number; p95: number; max: number }> {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    await fn(i)
    times.push(performance.now() - t)
  }
  const round = (n: number): number => Math.round(n * 10) / 10
  return {
    p50: round(percentile(times, 50)),
    p95: round(percentile(times, 95)),
    max: round(Math.max(...times)),
  }
}

/** Decode an image (base64) in main: size and an RGB pixel reader. */
export async function decodeImage(
  launched: LaunchedApp,
  b64: string,
  points: [number, number][],
): Promise<{ size: { width: number; height: number }; pixels: number[][] }> {
  return launched.app.evaluate(
    ({ nativeImage }, { b64, points }) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
      const size = img.getSize()
      const bitmap = img.toBitmap() // BGRA
      const pixels = points.map(([x, y]) => {
        const i = (Math.round(y) * size.width + Math.round(x)) * 4
        return [bitmap[i + 2]!, bitmap[i + 1]!, bitmap[i]!, bitmap[i + 3]!]
      })
      return { size, pixels }
    },
    { b64, points },
  )
}

export function near(actual: number[], expected: [number, number, number], tolerance = 3): boolean {
  return expected.every((v, i) => Math.abs((actual[i] ?? -999) - v) <= tolerance)
}

/** A tool call that is expected to fail: its `Error [code]` line. */
export async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const content = result.content as { type: string; text?: string }[]
  const text = content.filter((c) => c.type === 'text').at(-1)?.text ?? ''
  return {
    code: /^Error \[([a-z_]+)\]/.exec(text)?.[1] ?? '',
    text,
    isError: result.isError === true,
  }
}

/** End a client's session the way a well-behaved client quits (DELETE), then close it. */
export async function disconnect(client: Client): Promise<void> {
  const transport = client.transport as { terminateSession?: () => Promise<void> } | undefined
  await transport?.terminateSession?.().catch(() => undefined)
  await client.close().catch(() => undefined)
}

export { call, connect }
