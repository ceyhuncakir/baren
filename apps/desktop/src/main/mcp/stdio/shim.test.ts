/**
 * The stdio shim (contract §4.12, §14.3): built with the same Vite config as the app, copied next
 * to a scratch config.json/endpoint.json, spawned with plain Node and driven by the SDK's stdio
 * client against an in-process server.
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger } from '../../log'
import { McpService } from '../service'
import { fakePlatform } from '../testing'
import { buildMcpShim } from './build'

const quiet = createLogger('test', { sink: () => undefined })
let buildDir: string
let userData: string
let shimPath: string
let svc: McpService

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'baren-shim-build-'))
  userData = await mkdtemp(join(tmpdir(), 'baren-shim-user-'))
  const built = await buildMcpShim({ root: resolve(__dirname, '../../../..'), outDir: buildDir })
  let platformRef: McpService | null = null
  const platform = fakePlatform(() => platformRef!.rpc)
  svc = new McpService({
    appVersion: '0.1.0-shim',
    userDataDir: userData,
    downloadsDir: userData,
    core: async () => ({
      listFiles: async () => [],
      createFile: async () => {
        throw new Error('unused')
      },
      openFile: async () => new Uint8Array(),
      importFile: async () => {
        throw new Error('unused')
      },
      getAsset: async () => null,
      putAsset: async () => 'x',
    }),
    shimSource: built,
    flags: {
      mcp: true,
      mcpPort: 0,
      mcpAllowedOrigins: [],
      exportDir: null,
      mcpToolTimeoutMs: 2_000,
    },
    platform,
    log: quiet,
  })
  platformRef = svc
  await svc.start()
  // The service installs the shim next to config.json and endpoint.json.
  shimPath = join(userData, 'mcp', 'baren-mcp-stdio.cjs')
}, 120_000)

afterAll(async () => {
  await svc.shutdown()
  await rm(buildDir, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
})

function stdioClient(path: string): {
  client: Client
  transport: StdioClientTransport
  stderr: string[]
} {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path],
    stderr: 'pipe',
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' },
  })
  const stderr: string[] = []
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
  return { client: new Client({ name: 'stdio-only-client', version: '1.0.0' }), transport, stderr }
}

describe('stdio shim', () => {
  it('is one self-contained CommonJS file without electron', async () => {
    const source = await readFile(shimPath, 'utf8')
    expect(source.startsWith('"use strict"')).toBe(true)
    expect(source).not.toMatch(/require\(["']electron["']\)/)
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]!)
    for (const r of requires) expect(r, r).toMatch(/^(node:)?[a-z_]+(\/[a-z_]+)?$/)
  })

  it('bridges initialize, tools/list and a tool call to the app', async () => {
    const { client, transport } = stdioClient(shimPath)
    await client.connect(transport)
    expect(client.getServerVersion()).toMatchObject({
      name: 'baren',
      version: '0.1.0-shim',
    })
    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(30)
    const guide = await client.callTool({ name: 'get_guide', arguments: { topic: 'images' } })
    expect((guide.content as { text: string }[])[0]!.text).toMatch(/^# Images/)
    expect(svc.agents.all().map((a) => a.name)).toContain('stdio-only-client')
    await client.close()
  }, 30_000)

  it('reconnects transparently after the app restarted its sessions (404)', async () => {
    const { client, transport } = stdioClient(shimPath)
    await client.connect(transport)
    await svc.sessions.closeAll()
    const again = await client.callTool({ name: 'get_guide', arguments: { topic: 'code-export' } })
    expect((again.content as { text: string }[])[0]!.text).toContain('code')
    expect(svc.sessions.size).toBe(1)
    await client.close()
  }, 30_000)

  it('keeps working after the token is regenerated (401 + a new token in config.json)', async () => {
    const { client, transport, stderr } = stdioClient(shimPath)
    await client.connect(transport)
    await svc.resetToken()
    const again = await client.callTool({ name: 'get_guide', arguments: { topic: 'images' } })
    expect(again.isError, stderr.join('')).not.toBe(true)
    expect((again.content as { text: string }[])[0]!.text).toMatch(/^# Images/)
    expect(stderr.join('')).toContain('reconnected')
    await client.close()
  }, 30_000)

  it('answers -32002 and exits when the app is not running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baren-shim-off-'))
    try {
      const path = join(dir, 'baren-mcp-stdio.cjs')
      await copyFile(shimPath, path)
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ version: 1, enabled: true, port: 1, token: 'brn_x' }),
      )
      // A pid that does not exist any more.
      const dead = spawn(process.execPath, ['-e', ''])
      await new Promise((r) => dead.on('exit', r))
      await writeFile(
        join(dir, 'endpoint.json'),
        JSON.stringify({ version: 1, url: 'http://127.0.0.1:1/mcp', port: 1, pid: dead.pid }),
      )
      const { client, transport } = stdioClient(path)
      await expect(client.connect(transport)).rejects.toThrow(/Baren is not running/)
      await client.close().catch(() => undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
