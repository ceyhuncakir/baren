/**
 * SDK integration (contract §14.3): the real McpService (HTTP endpoint, sessions, tools, routing,
 * agents, render service) with fake renderers, driven by the MCP SDK's own Client over Streamable
 * HTTP. No Electron.
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentRequest, FileMeta, RenderJob } from '../../renderer/types/bridge'
import { createLogger } from '../log'
import { McpService } from './service'
import { FakeHeadless, FakeTarget, fakePlatform, type Executor, type FakePlatform } from './testing'
import { TOOL_NAMES } from './tools/schemas'

const quiet = createLogger('test', { sink: () => undefined })
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
)

let userData: string
let exportDir: string
let svc: McpService
let platform: FakePlatform
let url: string
const files: FileMeta[] = []
const putAssets: string[] = []
const clients: Client[] = []

function meta(id: string, name: string, extra: Partial<FileMeta> = {}): FileMeta {
  return {
    id,
    name,
    createdAt: 1_000,
    updatedAt: 2_000,
    archived: false,
    teamId: null,
    remoteId: null,
    ...extra,
  }
}

const header = (fileId: string) => ({
  file: { id: fileId, name: files.find((f) => f.id === fileId)?.name ?? fileId },
  contentHash: { tokens: 'c0ffee00' },
})

const renderJob = (nodeId: string): RenderJob => ({
  nodeId,
  stage: { html: '<div data-node-id="x"></div>', css: '', assetUrls: [] },
  width: 400,
  height: 200,
  background: '#ffffff',
  inherited: {},
  ids: [nodeId],
})

/** What the visible editor windows answer (a scripted runtime). */
const writesLog: { fileId: string; phase: 'start' | 'end'; at: number }[] = []
const hostExecutor: Executor = async (req: AgentRequest) => {
  const fileId = req.fileId!
  const args = req.args as Record<string, unknown>
  const ok = (result: unknown, touched: string[] = []) => ({
    ok: true as const,
    header: header(fileId),
    result,
    touched,
  })
  switch (req.tool) {
    case 'get_basic_info':
    case 'open_file':
      return ok({ fileName: header(fileId).file.name, pageId: 'p1', args })
    case 'write_html': {
      writesLog.push({ fileId, phase: 'start', at: Date.now() })
      await new Promise((r) => setTimeout(r, 40))
      writesLog.push({ fileId, phase: 'end', at: Date.now() })
      return ok(
        {
          createdNodes: [{ id: 'n9', name: 'Card' }],
          summary: '',
          warnings: [],
          assets: req.assets ?? null,
          agent: req.agent,
        },
        ['a1'],
      )
    }
    case 'update_styles':
      return ok({
        updated: [],
        errors: [{ index: 0, id: 'x', code: 'node_not_found', message: 'No node x' }],
        warnings: [],
      })
    case 'delete_nodes':
      return ok({ deleted: ['a1'], hidden: [] }, [])
    case 'get_jsx':
      return ok('(\n    <div />\n  )')
    case 'get_node_info':
      return ok(
        {
          id: args['nodeId'],
          name: args['nodeId'] === 'icon' ? 'Icon/Star' : 'Hero',
          width: 400,
          height: 200,
        },
        ['a1'],
      )
    case 'render_job':
      return ok(renderJob(String(args['nodeId'])), ['a1'])
    case 'artboards_of': {
      const ids = args['nodeIds'] as string[]
      return ok({
        artboards: Object.fromEntries(
          ids.filter((i) => i !== 'ghost').map((i) => [i, i === 'p1' ? null : 'a1']),
        ),
      })
    }
    case 'node_image':
      return args['nodeId'] === 'icon'
        ? ok({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
        : ok({ assetId: 'f'.repeat(64), mime: 'image/png', name: 'photo' })
    case 'flush':
      return ok({})
    default:
      return ok({ tool: req.tool, args })
  }
}

async function connect(name: string, token = svc.token!, version = '1.0.0'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name, version })
  await client.connect(transport)
  clients.push(client)
  return client
}

function text(result: unknown, index: number): string {
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content[index]?.text ?? ''
}

function last(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content[content.length - 1]?.text ?? ''
}

function body(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text?: string }[] }).content
  return JSON.parse(content[content.length - 1]!.text!) as Record<string, unknown>
}

function raw(opts: {
  method: string
  path?: string
  headers?: Record<string, string>
  body?: string
}): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(target.port),
        method: opts.method,
        path: opts.path ?? '/mcp',
        headers: {
          host: `127.0.0.1:${target.port}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...opts.headers,
        },
      },
      (res) => {
        let text = ''
        res.on('data', (c: Buffer) => (text += c.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
  },
})

let visibleA: FakeTarget
let visibleB: FakeTarget

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'baren-mcp-it-'))
  exportDir = await mkdtemp(join(tmpdir(), 'baren-mcp-export-'))
  files.push(
    meta('f1', 'Pricing'),
    meta('f2', 'Landing', { teamId: 't1', remoteId: 'r1' }),
    meta('f3', 'Background file'),
  )
  platform = fakePlatform(() => svc.rpc)
  platform.renderExecutor = (req) => {
    const args = req.args as Record<string, unknown>
    switch (req.tool) {
      case 'stage_prepare': {
        const scale = Math.min(Number(args['scale']), Number(args['maxSide']) / 400)
        return {
          ok: true,
          header: null,
          result: {
            width: 400,
            height: 200,
            scale,
            outWidth: Math.ceil(400 * scale),
            outHeight: Math.ceil(200 * scale),
          },
        }
      }
      case 'stage_styles':
        return {
          ok: true,
          header: null,
          result: {
            styles: Object.fromEntries(
              (args['nodeIds'] as string[]).map((id) => [id, { color: 'rgb(0, 0, 0)' }]),
            ),
          },
        }
      case 'fonts_probe':
        return {
          ok: true,
          header: null,
          result: { families: [{ familyName: 'Inter', available: true }] },
        }
      case 'image_transcode':
        return {
          ok: true,
          header: null,
          result: { bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1 },
        }
      default:
        return { ok: true, header: null, result: {} }
    }
  }
  platform.createHeadless = (fileId) => {
    const win = new FakeHeadless(() => svc.rpc, hostExecutor)
    platform.headless.push(win)
    setTimeout(() => svc.handleHostState(win, { fileId, state: 'opened', headless: true }), 5)
    return win
  }
  svc = new McpService({
    appVersion: '0.1.0-test',
    userDataDir: userData,
    downloadsDir: exportDir,
    core: async () => ({
      listFiles: async () => files.map((f) => ({ ...f })),
      createFile: async (name: string) => {
        const f = meta(`new-${files.length}`, name)
        files.push(f)
        return f
      },
      openFile: async () => Uint8Array.of(1, 2, 3),
      importFile: async (_s: Uint8Array, name: string | null) => {
        const f = meta(`imp-${files.length}`, name ?? 'x')
        files.push(f)
        return f
      },
      getAsset: async () => PNG,
      putAsset: async (_b: Uint8Array, mime: string) => {
        putAssets.push(mime)
        return 'e'.repeat(64)
      },
    }),
    shimSource: null,
    flags: { mcp: true, mcpPort: 0, mcpAllowedOrigins: [], exportDir, mcpToolTimeoutMs: 3_000 },
    platform,
    log: quiet,
  })
  await svc.start()
  const status = svc.status()
  expect(status.state).toBe('running')
  url = status.url!
  visibleA = new FakeTarget(() => svc.rpc, hostExecutor)
  visibleB = new FakeTarget(() => svc.rpc, hostExecutor)
  platform.visible.push({ target: visibleA, focusedAt: 2, focused: true })
  platform.visible.push({ target: visibleB, focusedAt: 1, focused: false })
  svc.handleHostState(visibleA, { fileId: 'f1', state: 'opened', headless: false })
  svc.handleHostState(visibleB, { fileId: 'f2', state: 'opened', headless: false })
})

afterEach(async () => {
  // Like a well-behaved client: end the session (DELETE), then close.
  await Promise.all(
    clients.splice(0).map(async (c) => {
      const transport = c.transport as StreamableHTTPClientTransport | undefined
      await transport?.terminateSession().catch(() => undefined)
      await c.close().catch(() => undefined)
    }),
  )
})

afterAll(async () => {
  await svc.shutdown()
  await rm(userData, { recursive: true, force: true })
  await rm(exportDir, { recursive: true, force: true })
})

describe('MCP server over Streamable HTTP (SDK client)', () => {
  it('writes endpoint.json with the live URL and no token', async () => {
    const endpoint = JSON.parse(await readFile(join(userData, 'mcp', 'endpoint.json'), 'utf8'))
    expect(endpoint).toMatchObject({ version: 1, url, pid: process.pid, appVersion: '0.1.0-test' })
    expect(JSON.stringify(endpoint)).not.toContain(svc.token!)
  })

  it('initializes with instructions and lists exactly the tools of §6', async () => {
    const client = await connect('claude-code', svc.token!, '2.1.0')
    expect(client.getServerVersion()).toMatchObject({
      name: 'baren',
      version: '0.1.0-test',
    })
    expect(client.getInstructions()).toContain('get_guide')
    const listed = (await client.listTools()).tools
    const tools = listed.map((t) => t.name).sort()
    expect(tools).toEqual([...TOOL_NAMES].sort())
    const annotations = (name: string) => listed.find((t) => t.name === name)?.annotations
    expect(annotations('get_comments')).toMatchObject({ readOnlyHint: true })
    expect(annotations('reply_to_comment')).toMatchObject({ readOnlyHint: false })
    expect(annotations('resolve_comment')).toMatchObject({ readOnlyHint: false })
    const agent = svc.status().agents.find((a) => a.connected)
    expect(agent).toMatchObject({ name: 'Claude Code', client: 'claude-code', version: '2.1.0' })
  })

  it('answers main tools: guide, list_files, create_file', async () => {
    const client = await connect('cursor')
    const guide = await client.callTool({
      name: 'get_guide',
      arguments: { topic: 'baren-mcp-instructions' },
    })
    expect(text(guide, 0)).toMatch(/^# Working in Baren/)
    const unknown = await client.callTool({ name: 'get_guide', arguments: { topic: 'nope' } })
    expect(unknown.isError).toBe(true)
    expect(text(unknown, 0)).toMatch(/^Error \[invalid_argument\]: Unknown topic "nope"/)

    const list = body(await client.callTool({ name: 'list_files', arguments: {} }))
    const listed = list['files'] as {
      id: string
      isOpen: boolean
      isShared: boolean
      url: string
      updatedAt: string
    }[]
    expect(listed.slice(0, 2).map((f) => [f.id, f.isOpen])).toEqual([
      ['f1', true],
      ['f2', true],
    ])
    expect(listed.find((f) => f.id === 'f2')!.isShared).toBe(true)
    expect(listed[0]!.url).toBe('baren://file/f1')
    expect(listed[0]!.updatedAt).toBe(new Date(2_000).toISOString())

    const before = platform.filesChanged
    const created = body(
      await client.callTool({ name: 'create_file', arguments: { name: 'From agent' } }),
    )
    expect(created).toMatchObject({ name: 'From agent' })
    expect(platform.filesChanged).toBe(before + 1)
    const cloned = body(
      await client.callTool({
        name: 'create_file',
        arguments: { cloneFileId: 'baren://file/f1' },
      }),
    )
    expect(cloned).toMatchObject({ name: 'Pricing copy' })
    expect(visibleA.requests.some((r) => r.tool === 'flush')).toBe(true)
  })

  it('forwards host tools with the header block, defaults and the agent, and marks working sets', async () => {
    const client = await connect('claude-code')
    const info = await client.callTool({ name: 'get_basic_info', arguments: {} })
    expect(JSON.parse(text(info, 0))).toEqual(header('f1'))
    expect(body(info)).toMatchObject({ fileName: 'Pricing' })

    const jsx = await client.callTool({
      name: 'get_jsx',
      arguments: { fileId: 'f1', nodeId: 'n1' },
    })
    expect(text(jsx, 1)).toBe('(\n    <div />\n  )')
    const jsxRequest = visibleA.requests.filter((r) => r.tool === 'get_jsx').at(-1)!
    expect(jsxRequest.args).toEqual({ nodeId: 'n1', format: 'tailwind', includeIds: false })

    await client.callTool({ name: 'get_tree_summary', arguments: { nodeId: 'n1', depth: 99 } })
    expect(visibleA.requests.filter((r) => r.tool === 'get_tree_summary').at(-1)!.args).toEqual({
      nodeId: 'n1',
      depth: 10,
    })

    const write = await client.callTool({
      name: 'write_html',
      arguments: {
        fileId: 'f1',
        html: '<div><img src="data:image/png;base64,AAAA"></div>',
        mode: 'insert-children',
        targetNodeId: 'p1',
      },
    })
    expect(write.isError).toBeFalsy()
    const written = body(write)
    expect(written['agent']).toMatchObject({ name: 'Claude Code' })
    // data: sources are left to the renderer.
    expect(written['assets']).toBeNull()
    const agent = svc.agents.all().find((a) => a.name === 'Claude Code')!
    expect(svc.agents.working(agent.sessionId).get('f1')).toEqual(['a1'])
    await new Promise((r) => setTimeout(r, 150))
    const presence = visibleA.presence.at(-1)!
    expect(presence.fileId).toBe('f1')
    expect(presence.agents.find((a) => a.name === 'Claude Code')).toMatchObject({ working: ['a1'] })

    const finished = body(
      await client.callTool({ name: 'finish_working_on_nodes', arguments: { nodeIds: ['n9'] } }),
    )
    expect(finished).toEqual({ released: ['a1'], remaining: [] })
  })

  it("keeps a comment request's token to its file, public images and no file navigation", async () => {
    const access = svc.runAccess({ runId: 'run1', fileId: 'f2' })
    const client = await connect('claude-code', access.token)

    // No fileId: the comment's file, not the one the user is looking at (f1, focused).
    const info = await client.callTool({ name: 'get_basic_info', arguments: {} })
    expect(JSON.parse(text(info, 0))).toEqual(header('f2'))
    expect(visibleB.requests.at(-1)).toMatchObject({ tool: 'get_basic_info', fileId: 'f2' })

    const other = await client.callTool({ name: 'get_basic_info', arguments: { fileId: 'f1' } })
    expect(other.isError).toBe(true)
    expect(last(other)).toContain('Error [invalid_argument]')
    for (const [name, args] of [
      ['list_files', {}],
      ['open_file', { fileId: 'f3' }],
      ['create_file', { name: 'Exfil' }],
      ['export', { fileId: 'f2', nodes: { a1: [{ format: 'png', scale: '1x' }] } }],
    ] as const) {
      const refused = await client.callTool({ name, arguments: args })
      expect([name, refused.isError, last(refused)]).toMatchObject([
        name,
        true,
        expect.stringContaining('Error [unsupported]'),
      ])
    }

    // Image sources: no files on this computer, no loopback or private network.
    const write = await client.callTool({
      name: 'write_html',
      arguments: {
        html: '<div><img src="/home/ana/private.png"><img src="http://127.0.0.1:8787/a.png"></div>',
        mode: 'insert-children',
        targetNodeId: 'p1',
      },
    })
    const assets = body(write)['assets'] as Record<string, { error?: string }>
    expect(assets['/home/ana/private.png']).toMatchObject({ error: 'unsupported_source' })
    expect(assets['http://127.0.0.1:8787/a.png']).toMatchObject({ error: 'unsupported_source' })

    // The run ended: its session closes and the token stops working.
    await access.revoke()
    await expect(client.callTool({ name: 'get_basic_info', arguments: {} })).rejects.toThrow()
    await expect(connect('claude-code', access.token)).rejects.toThrow()
  })

  it('reports batch failures and semantic validation as tool errors', async () => {
    const client = await connect('codex')
    const styles = await client.callTool({
      name: 'update_styles',
      arguments: { updates: [{ nodeIds: ['x'], styles: { color: 'red' } }] },
    })
    expect(styles.isError).toBe(true)
    const find = await client.callTool({ name: 'find_nodes', arguments: {} })
    expect(last(find)).toMatch(/^Error \[invalid_argument\]/)
    const artboard = await client.callTool({
      name: 'create_artboard',
      arguments: { name: 'A', styles: { width: '100%', height: '900px' } },
    })
    expect(last(artboard)).toMatch(/^Error \[invalid_argument\]: styles.width/)
    const missing = await client.callTool({
      name: 'get_node_info',
      arguments: { fileId: 'nope', nodeId: 'x' },
    })
    expect(text(missing, 0)).toMatch(/^Error \[file_not_found\]/)
    // Schema violations are refused by the SDK before the tool runs.
    const invalid = await client.callTool({
      name: 'get_children',
      arguments: { nodeId: 1 } as never,
    })
    expect(invalid.isError).toBe(true)
    expect(text(invalid, 0)).toMatch(/Invalid arguments|validation/i)
    const extra = await client.callTool({
      name: 'get_selection',
      arguments: { bogus: true } as never,
    })
    expect(extra.isError).toBe(true)
  })

  it('serialises writes per file and runs writes to different files in parallel', async () => {
    const client = await connect('claude-code')
    writesLog.length = 0
    const write = (fileId: string) =>
      client.callTool({
        name: 'write_html',
        arguments: { fileId, html: '<div>x</div>', mode: 'insert-children', targetNodeId: 'p1' },
      })
    await Promise.all([write('f1'), write('f1'), write('f2')])
    const f1 = writesLog.filter((w) => w.fileId === 'f1')
    expect(f1.map((w) => w.phase)).toEqual(['start', 'end', 'start', 'end'])
    const f2Start = writesLog.find((w) => w.fileId === 'f2' && w.phase === 'start')!
    const firstEnd = writesLog.find((w) => w.phase === 'end')!
    expect(f2Start.at).toBeLessThanOrEqual(firstEnd.at)
  })

  it('opens a headless host for a file no window has open', async () => {
    const client = await connect('claude-code')
    const info = await client.callTool({ name: 'get_basic_info', arguments: { fileId: 'f3' } })
    expect(body(info)).toMatchObject({ fileName: 'Background file' })
    expect(platform.headless).toHaveLength(1)
    await client.callTool({ name: 'get_children', arguments: { fileId: 'f3', nodeId: 'n' } })
    expect(platform.headless).toHaveLength(1)
    // A visible window opening f3 makes the headless host hand it off.
    const win = new FakeTarget(() => svc.rpc, hostExecutor)
    platform.visible.push({ target: win, focusedAt: 3, focused: false })
    await svc.beforeOpen(win.webContentsId, 'f3')
    expect(platform.headless[0]!.requests.some((r) => r.tool === 'release')).toBe(true)
    svc.handleHostState(win, { fileId: 'f3', state: 'opened', headless: false })
    await client.callTool({ name: 'get_children', arguments: { fileId: 'f3', nodeId: 'n' } })
    expect(win.requests.at(-1)!.tool).toBe('get_children')
  })

  it('captures screenshots through the render window', async () => {
    const client = await connect('claude-code')
    const shot = await client.callTool({
      name: 'get_screenshot',
      arguments: { nodeId: 'a1', scale: 2 },
    })
    const content = shot.content as { type: string; mimeType?: string; text?: string }[]
    expect(content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(content[1]!.mimeType).toBe('image/jpeg')
    const renderWin = platform.renderWindows.at(-1)!
    expect(renderWin.captures.at(-1)).toEqual({ width: 800, height: 400 })
    const prepare = renderWin.requests.filter((r) => r.tool === 'stage_prepare').at(-1)!
    expect(prepare.args).toMatchObject({
      scale: 2,
      maxSide: 1568,
      maxPixels: 1_150_000,
      transparent: false,
    })
    expect(renderWin.requests.at(-1)!.tool).toBe('stage_clear')

    const big = await client.callTool({
      name: 'get_screenshot',
      arguments: { nodeId: 'a1', scale: 4 },
    })
    const bigContent = big.content as { type: string; text?: string }[]
    expect(bigContent.at(-1)!.text).toBe('Downscaled to fit size limits (effective scale 3.92).')
  })

  it('serves fonts, fill images and resolved styles', async () => {
    const client = await connect('claude-code')
    const fonts = await client.callTool({
      name: 'get_font_family_info',
      arguments: { familyNames: ['Inter'] },
    })
    expect(body(fonts)).toEqual({ families: [{ familyName: 'Inter', available: true }] })
    const fill = await client.callTool({ name: 'get_fill_image', arguments: { nodeId: 'photo' } })
    const fillContent = fill.content as { type: string; mimeType?: string }[]
    expect(fillContent.map((c) => c.type)).toEqual(['text', 'text', 'image'])
    expect(JSON.parse(text(fill, 1))).toMatchObject({
      assetId: 'f'.repeat(64),
      mime: 'image/png',
      width: 1,
      height: 1,
    })
    const vector = await client.callTool({ name: 'get_fill_image', arguments: { nodeId: 'icon' } })
    expect(last(vector)).toBe('Error [invalid_target]: This is a vector layer; use get_jsx')
    const styles = body(
      await client.callTool({
        name: 'get_computed_styles',
        arguments: { nodeIds: ['n1', 'ghost', 'p1'], resolved: true },
      }),
    )
    expect(styles['styles']).toEqual({ n1: { color: 'rgb(0, 0, 0)' } })
    expect((styles['errors'] as { id: string; code: string }[]).map((e) => [e.id, e.code])).toEqual(
      [
        ['ghost', 'node_not_found'],
        ['p1', 'invalid_target'],
      ],
    )
  })

  it('exports png and svg files and reports unsupported formats per entry', async () => {
    const client = await connect('claude-code')
    const result = await client.callTool({
      name: 'export',
      arguments: {
        nodes: {
          a1: [
            { format: 'png', scale: '2x' },
            { format: 'png', scale: '2x' },
            { format: 'mp4', scale: '1x' },
            { format: 'png', scale: '100x' },
          ],
          icon: [{ format: 'svg', scale: '1x' }],
        },
      },
    })
    const out = body(result) as {
      files: { path: string; width: number; bytes: number }[]
      errors: { code: string }[]
    }
    expect(out.files.map((f) => f.path.split('/').slice(-2).join('/'))).toEqual([
      'Pricing/Hero@2x.png',
      'Pricing/Hero@2x (2).png',
      'Pricing/Icon-Star@1x.svg',
    ])
    expect(out.files[0]!.width).toBe(800)
    expect(out.errors.map((e) => e.code)).toEqual(['unsupported', 'too_large'])
    expect((await stat(out.files[0]!.path)).size).toBe(out.files[0]!.bytes)
    expect(await readdir(join(exportDir, 'Pricing'))).toHaveLength(3)
    const none = await client.callTool({
      name: 'export',
      arguments: { nodes: 'nodes-with-exports-only' },
    })
    expect(last(none)).toMatch(/^Error \[unsupported\]/)
  })

  it('opens files in the app (open_file)', async () => {
    const client = await connect('claude-code')
    const open = client.callTool({
      name: 'open_file',
      arguments: { fileId: 'baren://file/new-3/p7' },
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(platform.shown).toContain('new-3')
    const win = new FakeTarget(() => svc.rpc, hostExecutor)
    platform.visible.push({ target: win, focusedAt: 4, focused: false })
    svc.handleHostState(win, { fileId: 'new-3', state: 'opened', headless: false })
    const res = await open
    expect(body(res)).toMatchObject({ args: { pageId: 'p7', firstOpen: true } })
    // Already open: no new window.
    const again = await client.callTool({ name: 'open_file', arguments: { fileId: 'f1' } })
    expect(body(again)).toMatchObject({ args: { firstOpen: false } })
  })

  it('fails open_file at once when the window shows the sign-in screen', async () => {
    const client = await connect('claude-code')
    platform.signedOut = true
    try {
      const created = await client.callTool({ name: 'create_file', arguments: {} })
      const fileId = String(body(created)['fileId'])
      const started = Date.now()
      const res = await client.callTool({ name: 'open_file', arguments: { fileId } })
      expect(platform.shown).toContain(fileId)
      expect(last(res)).toMatch(/^Error \[host_unavailable\]: Baren is showing the sign-in screen/)
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      platform.signedOut = false
    }
  })

  it('refuses unauthenticated, rebinding and stale requests', async () => {
    const noToken = await raw({ method: 'POST', body: INITIALIZE })
    expect(noToken.status).toBe(401)
    expect(noToken.headers['www-authenticate']).toBe('Bearer realm="Baren"')
    expect(JSON.parse(noToken.text)).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001 },
      id: null,
    })
    const wrong = await raw({
      method: 'POST',
      body: INITIALIZE,
      headers: { authorization: 'Bearer brn_wrong' },
    })
    expect(wrong.status).toBe(401)
    const auth = { authorization: `Bearer ${svc.token}` }
    const rebinding = await raw({
      method: 'POST',
      body: INITIALIZE,
      headers: { ...auth, host: 'attacker.example' },
    })
    expect(rebinding.status).toBe(403)
    expect(rebinding.text).toContain('invalid_host')
    const origin = await raw({
      method: 'POST',
      body: INITIALIZE,
      headers: { ...auth, origin: 'https://evil.example' },
    })
    expect(origin.status).toBe(403)
    expect(origin.text).toContain('invalid_origin')
    const stale = await raw({
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      headers: { ...auth, 'mcp-session-id': '00000000-0000-0000-0000-000000000000' },
    })
    expect(stale.status).toBe(404)
    const noSession = await raw({
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      headers: auth,
    })
    expect(noSession.status).toBe(400)
    expect((await raw({ method: 'OPTIONS', headers: auth })).status).toBe(405)
    expect((await raw({ method: 'GET', path: '/other', headers: auth })).status).toBe(404)
    expect(noToken.headers['access-control-allow-origin']).toBeUndefined()
    const ok = await raw({ method: 'POST', body: INITIALIZE, headers: auth })
    expect(ok.status).toBe(200)
    expect(ok.headers['mcp-session-id']).toBeTruthy()
    svc.http.setShuttingDown(true)
    try {
      expect((await raw({ method: 'POST', body: INITIALIZE, headers: auth })).status).toBe(503)
    } finally {
      svc.http.setShuttingDown(false)
    }
  })

  it('keeps two sessions apart, shows them as one agent and ends one with DELETE', async () => {
    const a = await connect('claude-code')
    const b = await connect('claude-code')
    const claude = svc.agents.all().filter((s) => s.name === 'Claude Code')
    expect(claude.length).toBeGreaterThanOrEqual(2)
    expect(new Set(claude.map((s) => s.presenceId)).size).toBe(1)
    expect(svc.agents.statusAgents().filter((s) => s.name === 'Claude Code')).toHaveLength(1)
    const before = svc.sessions.size
    const transport = (b as unknown as { transport: StreamableHTTPClientTransport }).transport
    await transport.terminateSession()
    await new Promise((r) => setTimeout(r, 20))
    expect(svc.sessions.size).toBe(before - 1)
    expect(body(await a.callTool({ name: 'list_files', arguments: {} }))['count']).toBeGreaterThan(
      0,
    )
  })

  it('resets the token: old clients get 401, new ones connect; disabling removes the endpoint', async () => {
    const old = await connect('claude-code')
    const oldToken = svc.token!
    const setup = await svc.resetToken()
    expect(setup.token).not.toBe(oldToken)
    expect(setup.snippets.claudeCode).toContain(setup.token)
    expect(setup.stdio).toEqual({
      command: '/usr/bin/baren',
      args: [join(userData, 'mcp', 'baren-mcp-stdio.cjs')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    await expect(old.callTool({ name: 'list_files', arguments: {} })).rejects.toThrow()
    const fresh = await connect('claude-code', setup.token)
    expect((await fresh.listTools()).tools).toHaveLength(33)

    const off = await svc.setEnabled(false)
    expect(off).toMatchObject({ state: 'off', enabled: false, url: null })
    await expect(stat(join(userData, 'mcp', 'endpoint.json'))).rejects.toThrow()
    await expect(svc.setup()).rejects.toThrow('The MCP server is off')
    expect(platform.statuses.at(-1)!.state).toBe('off')
    const on = await svc.setEnabled(true)
    expect(on.state).toBe('running')
    url = on.url!
    const config = JSON.parse(await readFile(join(userData, 'mcp', 'config.json'), 'utf8'))
    expect(config).toMatchObject({ enabled: true, token: setup.token })
  })
})
