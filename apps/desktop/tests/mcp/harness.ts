/**
 * Helpers for the MCP end-to-end specs: launching the built app hidden with a scratch profile,
 * reading its MCP endpoint, connecting SDK clients, and a tiny JSX → HTML converter for the
 * write → JSX → write round trip.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

export const DESKTOP = resolve(__dirname, '../..')
export const OUT = process.env['BAREN_ELECTRON_OUT'] ?? join(DESKTOP, 'out')

export interface LaunchedApp {
  app: ElectronApplication
  userData: string
  exportDir: string
  close(): Promise<void>
}

export async function launchApp(extraEnv: Record<string, string> = {}): Promise<LaunchedApp> {
  if (!existsSync(join(OUT, 'main/index.js'))) {
    throw new Error(`no build at ${OUT}: run pnpm --filter @baren/desktop build first`)
  }
  const root = join(tmpdir(), `baren-mcp-e2e-${process.pid}-${Date.now()}`)
  const userData = join(root, 'profile')
  const exportDir = join(root, 'exports')
  mkdirSync(userData, { recursive: true })
  mkdirSync(exportDir, { recursive: true })
  const require_ = createRequire(join(DESKTOP, 'package.json'))
  const executablePath = require_('electron') as unknown as string
  const app = await electron.launch({
    executablePath,
    // A build elsewhere (BAREN_ELECTRON_OUT, e.g. made for a scratch server) runs by its main
    // script; the default build runs as the app directory.
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
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs = 20_000,
  what = 'condition',
): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = fn()
      if (value !== null && value !== undefined) return value
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

export interface Endpoint {
  url: string
  token: string
}

/** `<userData>/mcp/endpoint.json` + `config.json`, once the server listens. */
export async function readEndpoint(userData: string): Promise<Endpoint> {
  return waitFor(
    () => {
      const endpoint = JSON.parse(readFileSync(join(userData, 'mcp/endpoint.json'), 'utf8')) as {
        url: string
      }
      const config = JSON.parse(readFileSync(join(userData, 'mcp/config.json'), 'utf8')) as {
        token: string
      }
      return { url: endpoint.url, token: config.token }
    },
    30_000,
    'the MCP endpoint',
  )
}

export async function connect(endpoint: Endpoint, name = 'baren-e2e'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
    }),
  )
  return client
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }[]

/** Call a tool; throws with the tool's error line when it failed. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{
  header: Record<string, unknown> | null
  body: unknown
  content: Content
}> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const content = result.content as Content
  const texts = content.filter((c) => c.type === 'text').map((c) => c.text ?? '')
  if (result.isError) throw new Error(`${name}: ${texts.at(-1)}`)
  const parse = (t: string): unknown => {
    try {
      return JSON.parse(t)
    } catch {
      return t
    }
  }
  const first = texts[0] !== undefined ? parse(texts[0]) : null
  const isHeader =
    typeof first === 'object' && first !== null && 'file' in first && 'contentHash' in first
  return {
    header: isHeader ? (first as Record<string, unknown>) : null,
    body: texts.length > (isHeader ? 1 : 0) ? parse(texts[isHeader ? 1 : 0]!) : null,
    content,
  }
}

const UNITLESS = new Set([
  'fontWeight',
  'opacity',
  'flexGrow',
  'flexShrink',
  'zIndex',
  'order',
  'lineHeight',
])

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** JSX whitespace rules for text between tags (Babel's cleanJSXElementLiteralChild). */
function jsxText(text: string): string {
  if (!/[\r\n]/.test(text)) return text
  const lines = text.split(/\r\n|\n|\r/)
  let lastNonEmpty = 0
  lines.forEach((line, i) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = i
  })
  let out = ''
  lines.forEach((line, i) => {
    let trimmed = line.replace(/\t/g, ' ')
    if (i !== 0) trimmed = trimmed.replace(/^[ ]+/, '')
    if (i !== lines.length - 1) trimmed = trimmed.replace(/[ ]+$/, '')
    if (trimmed) {
      if (i !== lastNonEmpty) trimmed += ' '
      out += trimmed
    }
  })
  return out
}

/**
 * The subset of get_jsx inline-styles output our round trip uses: `style={{ … }}` objects,
 * `{'…'}` text escapes, `<br />` and JSX whitespace rules.
 */
export function jsxToHtml(jsx: string): string {
  let html = jsx.trim()
  if (html.startsWith('(') && html.endsWith(')')) html = html.slice(1, -1)
  html = html.replace(/style=\{\{([\s\S]*?)\}\}/g, (_m, body: string) => {
    const decls: string[] = []
    for (const m of body.matchAll(/([A-Za-z]+):\s*('(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?)/g)) {
      const key = m[1]!
      const raw = m[2]!
      const value = raw.startsWith("'")
        ? raw.slice(1, -1).replace(/\\'/g, "'")
        : UNITLESS.has(key)
          ? raw
          : `${raw}px`
      decls.push(`${kebab(key)}: ${value}`)
    }
    return `style="${decls.join('; ').replace(/"/g, '&quot;')}"`
  })
  html = html.replace(/>([^<>]*)</g, (_m, text: string) => `>${jsxText(text)}<`)
  html = html.replace(/\{'((?:[^'\\]|\\.)*)'\}/g, (_m, text: string) =>
    escapeHtml(text.replace(/\\'/g, "'")),
  )
  html = html.replace(/<br\s*\/>/g, '<br>')
  html = html.replace(/\sclassName="[^"]*"/g, '')
  return html
}

/** Tree summary lines without ids and names (structure, sizes and text only). */
export function shape(summary: string): string[] {
  return summary
    .split('\n')
    .map((line) => line.replace(/"[^"]*" \([^)]*\) /, '').replace(/\s+$/, ''))
}
