import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunRequest } from '../../renderer/types/bridge'
import { AgentRunner } from './runner'

/** A stand-in for the `claude` process: the test writes its stdout and ends it. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed: NodeJS.Signals[] = []

  emitLine(event: unknown): void {
    this.stdout.write(`${JSON.stringify(event)}\n`)
  }

  exit(code: number): void {
    this.exitCode = code
    this.emit('close', code)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    this.signalCode = signal
    setTimeout(() => this.emit('close', null), 0)
    return true
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

const request = (threadId = 't1'): AgentRunRequest => ({
  fileId: 'f1',
  fileName: 'File',
  pageName: 'Page 1',
  threadId,
  messageId: 'm1',
  authorName: 'Ana',
  body: '@Claude Code tighten this',
  layer: null,
  artboard: null,
})

describe('AgentRunner', () => {
  let dir: string
  let children: FakeChild[]
  let spawned: { command: string; args: string[]; options: SpawnOptions }[]
  let updates: AgentRun[]
  let claude: string | null
  let mcpOn: boolean
  let scopes: { runId: string; fileId: string }[]
  let revoked: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baren-runs-'))
    children = []
    spawned = []
    updates = []
    claude = '/usr/local/bin/claude'
    mcpOn = true
    scopes = []
    revoked = []
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function runner(
    extra: { launch?: (claude: string) => Promise<{ command: string; args: string[] }> } = {},
  ) {
    return new AgentRunner({
      dir,
      spawn: (command, args, options) => {
        spawned.push({ command, args, options })
        const child = new FakeChild()
        children.push(child)
        return child as unknown as ChildProcess
      },
      findClaude: async () => claude,
      mcp: async (scope) => {
        if (!mcpOn) throw new Error('The MCP server is off')
        scopes.push(scope)
        return {
          url: 'http://127.0.0.1:29170/mcp',
          token: 'brr_secret',
          revoke: async () => void revoked.push(scope.runId),
        }
      },
      broadcast: (run) => updates.push(run),
      ...extra,
    })
  }

  it('runs claude, reports its activity and finishes when it succeeds', async () => {
    const r = runner()
    const run = await r.start(request())
    expect(run).toMatchObject({ state: 'starting', threadId: 't1', fileId: 'f1' })
    expect(spawned[0]?.command).toBe('/usr/local/bin/claude')
    expect(spawned[0]?.options.cwd).toBe(dir)
    const args = spawned[0]!.args
    const configPath = args[args.indexOf('--mcp-config') + 1]!
    expect(JSON.parse(await readFile(configPath, 'utf8')).mcpServers.baren.headers).toEqual({
      Authorization: 'Bearer brr_secret',
    })
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    // The token never goes on the command line.
    expect(args.join(' ')).not.toContain('brr_secret')

    const child = children[0]!
    child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    child.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__baren__get_screenshot' }] },
    })
    await tick()
    expect(updates.at(-1)).toMatchObject({ state: 'working', activity: 'Taking a screenshot' })
    child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'Done' })
    await tick()
    child.exit(0)
    await tick()
    expect(updates.at(-1)).toMatchObject({ state: 'done', activity: null, error: null })
    expect(r.list()[0]?.state).toBe('done')
    // The run's token works on its comment's file only, and is revoked when the run ends.
    expect(scopes).toEqual([{ runId: run.id, fileId: 'f1' }])
    expect(revoked).toEqual([run.id])
    // The config file with the token is gone once the run ended.
    expect((await readdir(dir)).filter((f) => f.endsWith('.mcp.json'))).toEqual([])

    // A follow-up in the same thread resumes the same Claude Code session.
    await r.start(request())
    expect(spawned[1]!.args.slice(-2)).toEqual(['--resume', 'sess-1'])
  })

  it('reports failures with the reason', async () => {
    const r = runner()
    await r.start(request())
    children[0]!.emitLine({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'The MCP server did not answer',
    })
    await tick()
    children[0]!.exit(1)
    await tick()
    expect(updates.at(-1)).toMatchObject({
      state: 'failed',
      error: 'The MCP server did not answer',
    })

    await r.start(request('t2'))
    children[1]!.stderr.write('Error: not logged in\n')
    await tick()
    children[1]!.exit(1)
    await tick()
    expect(updates.at(-1)).toMatchObject({ state: 'failed', error: 'Error: not logged in' })
  })

  it('stops a run on request', async () => {
    const r = runner()
    const run = await r.start(request())
    await r.stop(run.id)
    expect(children[0]!.killed).toEqual(['SIGTERM'])
    await tick()
    expect(updates.at(-1)).toMatchObject({ state: 'stopped' })
  })

  it('refuses when off, without claude, with the MCP server off or a busy thread', async () => {
    const r = runner()
    await r.start(request())
    await expect(r.start(request())).rejects.toThrow('already working on this thread')

    claude = null
    await expect(runner().start(request('t9'))).rejects.toThrow('not installed')

    claude = '/usr/local/bin/claude'
    mcpOn = false
    await expect(runner().start(request('t9'))).rejects.toThrow('MCP server')

    mcpOn = true
    const off = runner()
    expect(await off.setEnabled(false)).toEqual({ enabled: false, claudePath: claude })
    await expect(off.start(request('t9'))).rejects.toThrow('off in Preferences')
    // The setting is remembered.
    expect((await runner().status()).enabled).toBe(false)
  })

  it('on quit, waits for runs to stop and leaves no token behind', async () => {
    const r = runner()
    await r.start(request('a'))
    await r.start(request('b'))
    // b ignores SIGTERM (and SIGKILL, as far as the runner can tell).
    children[1]!.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      children[1]!.killed.push(signal)
      return true
    }
    await r.stopAll(50)
    expect(children[0]!.killed).toEqual(['SIGTERM'])
    expect(children[1]!.killed).toEqual(['SIGTERM', 'SIGKILL'])
    expect((await readdir(dir)).filter((f) => f.endsWith('.mcp.json'))).toEqual([])
    expect(revoked.sort()).toEqual(scopes.map((s) => s.runId).sort())
  })

  it('deletes config files a crash left behind before the next run', async () => {
    await writeFile(join(dir, 'run-0123456789abcdef.mcp.json'), '{"old":true}')
    await writeFile(join(dir, 'sessions.json'), '{}')
    const r = runner()
    await r.start(request())
    const files = await readdir(dir)
    expect(files).not.toContain('run-0123456789abcdef.mcp.json')
    expect(files).toContain('sessions.json')
    expect(files.filter((f) => f.endsWith('.mcp.json'))).toHaveLength(1)
  })

  it('starts claude the way `launch` says (Windows npm shims)', async () => {
    claude = 'C:\\Users\\ana\\AppData\\Roaming\\npm\\claude.cmd'
    const r = runner({
      launch: async () => ({ command: 'node', args: ['C:\\npm\\cli.js'] }),
    })
    await r.start(request())
    expect(spawned[0]!.command).toBe('node')
    expect(spawned[0]!.args.slice(0, 3)).toEqual(['C:\\npm\\cli.js', '-p', expect.any(String)])
    expect(spawned[0]!.options.shell).toBeUndefined()
  })

  it('runs at most three at once', async () => {
    const r = runner()
    await r.start(request('a'))
    await r.start(request('b'))
    await r.start(request('c'))
    await expect(r.start(request('d'))).rejects.toThrow('already working on 3 comments')
  })
})
