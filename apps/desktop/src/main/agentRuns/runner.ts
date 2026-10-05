/**
 * Comment requests to Claude Code: when the user posts a comment that mentions Claude Code, the
 * renderer asks main (`agentRuns:start`) to run `claude -p` in the background. The run talks to
 * the built-in MCP server only, with a token of its own that works on the comment's file only
 * (`McpService.runAccess`; in a 0600 config file that lives as long as the run), may use only the
 * baren tools and never prompts; it answers in the comment thread with `reply_to_comment`. Only
 * the asker's own app starts runs, so a teammate's comment never spends this user's Claude plan.
 * The prompt quotes what collaborators wrote, so the run's token cannot open other files, read
 * this computer's files or reach the local network (mcp/tools/runScope.ts, mcp/assets.ts).
 *
 * - One run per thread at a time, at most `MAX_RUNNING` at once, each stopped after `RUN_TIMEOUT_MS`.
 * - A thread's Claude Code session id is remembered (`<userData>/agent-runs/sessions.json`), so a
 *   follow-up mention in the same thread continues the same conversation (`--resume`).
 * - Progress (`agentRuns:update`) comes from the stream-json events: starting, the current tool,
 *   done or failed.
 * - Runs start in `<userData>/agent-runs/` so no project's CLAUDE.md or settings apply.
 * - Quitting stops every run and waits for it (briefly); config files a crash left behind are
 *   deleted before the next run starts.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRun, AgentRunRequest, AgentRunnerStatus } from '../../renderer/types/bridge'
import type { Logger } from '../log'
import { readJsonOrNull, writeFileAtomic } from '../util/fs'
import { buildPrompt, mcpConfig, runArgs } from './prompt'
import { parseStreamLine } from './stream'

export const MAX_RUNNING = 3
export const RUN_TIMEOUT_MS = 20 * 60_000
const KILL_GRACE_MS = 3_000
const MAX_SESSIONS = 500
const MAX_RUNS_KEPT = 50
/** A run's MCP config file (it holds the run's token). */
const CONFIG_FILE = /^run-[0-9a-f]+\.mcp\.json$/

export class AgentRunError extends Error {}

/** SIGTERM, then SIGKILL if it is still running after a grace period. */
function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, KILL_GRACE_MS)
  force.unref?.()
}

export interface AgentRunnerDeps {
  /** `<userData>/agent-runs`. */
  dir: string
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess
  /** The `claude` executable, or null when it is not installed. */
  findClaude(): Promise<string | null>
  /** How to start `claude` (a Windows npm install is a `.cmd` shim: findClaude.ts). */
  launch?(claude: string): Promise<{ command: string; args: string[] }>
  /**
   * The built-in MCP server's URL and a token for this run only (it works on `fileId` only);
   * `revoke` ends it. Rejects when the server is off.
   */
  mcp(scope: { runId: string; fileId: string }): Promise<RunAccess>
  /** Push a run's new state to every window. */
  broadcast(run: AgentRun): void
  now?(): number
  log?: Logger
}

export interface RunAccess {
  url: string
  token: string
  revoke(): Promise<void>
}

interface Live {
  run: AgentRun
  child: ChildProcess
  timer: ReturnType<typeof setTimeout>
  configPath: string
  access: RunAccess
  /** Resolves once the process has exited. */
  closed: Promise<void>
  /** Stopped by the user (`stop`) or by the timeout. */
  ending: 'stopped' | 'timeout' | null
}

export class AgentRunner {
  private readonly runs: AgentRun[] = []
  private readonly live = new Map<string, Live>()
  private config: { enabled: boolean } | null = null
  private sessions: Record<string, string> | null = null
  private claude: Promise<string | null> | null = null
  private swept: Promise<void> | null = null

  constructor(private readonly deps: AgentRunnerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private claudePath(): Promise<string | null> {
    // Looked up again after a miss (the user may install it while the app runs).
    this.claude ??= this.deps.findClaude().then((path) => {
      if (path === null) this.claude = null
      return path
    })
    return this.claude
  }

  private async loadConfig(): Promise<{ enabled: boolean }> {
    if (this.config) return this.config
    const raw = (await readJsonOrNull(join(this.deps.dir, 'config.json')).catch(() => null)) as {
      enabled?: unknown
    } | null
    this.config = { enabled: raw?.enabled !== false }
    return this.config
  }

  async status(): Promise<AgentRunnerStatus> {
    const [config, claudePath] = await Promise.all([this.loadConfig(), this.claudePath()])
    return { enabled: config.enabled, claudePath }
  }

  async setEnabled(enabled: boolean): Promise<AgentRunnerStatus> {
    this.config = { enabled }
    await mkdir(this.deps.dir, { recursive: true })
    await writeFileAtomic(join(this.deps.dir, 'config.json'), `${JSON.stringify({ enabled })}\n`)
    return this.status()
  }

  list(): AgentRun[] {
    return [...this.runs].reverse().map((r) => ({ ...r }))
  }

  private async loadSessions(): Promise<Record<string, string>> {
    if (this.sessions) return this.sessions
    const raw = await readJsonOrNull(join(this.deps.dir, 'sessions.json')).catch(() => null)
    const out: Record<string, string> = {}
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
    }
    this.sessions = out
    return out
  }

  private async rememberSession(threadId: string, sessionId: string): Promise<void> {
    const sessions = await this.loadSessions()
    delete sessions[threadId]
    sessions[threadId] = sessionId
    const keys = Object.keys(sessions)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete sessions[k]
    await writeFileAtomic(join(this.deps.dir, 'sessions.json'), `${JSON.stringify(sessions)}\n`, {
      mode: 0o600,
    }).catch((error: unknown) =>
      this.deps.log?.warn('could not save agent run sessions', String(error)),
    )
  }

  async start(req: AgentRunRequest): Promise<AgentRun> {
    const config = await this.loadConfig()
    if (!config.enabled)
      throw new AgentRunError('Comment requests to Claude Code are off in Preferences.')
    const claude = await this.claudePath()
    if (claude === null) throw new AgentRunError('Claude Code is not installed on this computer.')
    for (const l of this.live.values()) {
      if (l.run.threadId === req.threadId && l.run.fileId === req.fileId) {
        throw new AgentRunError('Claude Code is already working on this thread.')
      }
    }
    if (this.live.size >= MAX_RUNNING) {
      throw new AgentRunError(
        `Claude Code is already working on ${MAX_RUNNING} comments. Try again when one is done.`,
      )
    }
    const id = randomBytes(8).toString('hex')
    let access: RunAccess
    try {
      access = await this.deps.mcp({ runId: id, fileId: req.fileId })
    } catch {
      throw new AgentRunError(
        'Turn on the MCP server in Preferences: Claude Code works through it.',
      )
    }

    const configPath = join(this.deps.dir, `run-${id}.mcp.json`)
    let launch: { command: string; args: string[] }
    try {
      await mkdir(this.deps.dir, { recursive: true })
      await (this.swept ??= this.sweepConfigs())
      launch = (await this.deps.launch?.(claude)) ?? { command: claude, args: [] }
      await writeFileAtomic(configPath, mcpConfig(access.url, access.token), { mode: 0o600 })
    } catch (error) {
      void access.revoke().catch(() => undefined)
      throw new AgentRunError(
        `Couldn't start Claude Code: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const resume = (await this.loadSessions())[req.threadId] ?? null

    const run: AgentRun = {
      id,
      fileId: req.fileId,
      threadId: req.threadId,
      messageId: req.messageId,
      state: 'starting',
      activity: 'Starting',
      error: null,
      startedAt: this.now(),
      endedAt: null,
    }
    let child: ChildProcess
    try {
      child = this.deps.spawn(
        launch.command,
        [
          ...launch.args,
          ...runArgs({
            prompt: buildPrompt(req),
            mcpConfigPath: configPath,
            resumeSessionId: resume,
          }),
        ],
        {
          cwd: this.deps.dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
          windowsHide: true,
        },
      )
    } catch (error) {
      await rm(configPath, { force: true })
      void access.revoke().catch(() => undefined)
      throw new AgentRunError(`Couldn't start Claude Code: ${String(error)}`)
    }
    this.runs.push(run)
    if (this.runs.length > MAX_RUNS_KEPT) this.runs.splice(0, this.runs.length - MAX_RUNS_KEPT)
    const timer = setTimeout(() => {
      entry.ending = 'timeout'
      kill(child)
    }, RUN_TIMEOUT_MS)
    timer.unref?.()
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })
    const entry: Live = { run, child, timer, configPath, access, closed, ending: null }
    this.live.set(id, entry)
    this.watch(entry, req.threadId)
    this.deps.broadcast({ ...run })
    this.deps.log?.info('agent run started', { id, resumed: resume !== null })
    return { ...run }
  }

  private watch(entry: Live, threadId: string): void {
    const { child, run } = entry
    let buffer = ''
    let stderr = ''
    let result: { ok: boolean; text: string } | null = null
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (line === '') continue
        const update = parseStreamLine(line)
        if (update.sessionId) void this.rememberSession(threadId, update.sessionId)
        if (update.result) result = update.result
        if (update.activity && run.state !== 'done' && run.state !== 'failed') {
          run.state = 'working'
          if (run.activity !== update.activity) {
            run.activity = update.activity
            this.deps.broadcast({ ...run })
          }
        }
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk
    })
    child.on('error', (error) =>
      this.finish(run.id, 'failed', `Couldn't run Claude Code: ${error.message}`),
    )
    child.on('close', (code) => {
      if (entry.ending === 'stopped') this.finish(run.id, 'stopped', null)
      else if (entry.ending === 'timeout')
        this.finish(run.id, 'failed', 'Claude Code took longer than 20 minutes and was stopped.')
      else if (result?.ok) this.finish(run.id, 'done', null)
      else {
        const why =
          (result && !result.ok && result.text) ||
          stderr.trim().split('\n').pop() ||
          `Claude Code exited with code ${code ?? 'unknown'}.`
        this.finish(run.id, 'failed', why.slice(0, 500))
      }
    })
  }

  private finish(id: string, state: 'done' | 'failed' | 'stopped', error: string | null): void {
    const entry = this.live.get(id)
    if (!entry) return
    this.live.delete(id)
    clearTimeout(entry.timer)
    void rm(entry.configPath, { force: true })
    void entry.access.revoke().catch(() => undefined)
    const run = entry.run
    run.state = state
    run.activity = null
    run.error = error
    run.endedAt = this.now()
    this.deps.broadcast({ ...run })
    this.deps.log?.info('agent run ended', { id, state })
  }

  async stop(runId: string): Promise<void> {
    const entry = this.live.get(runId)
    if (!entry) return
    entry.ending = 'stopped'
    kill(entry.child)
  }

  /**
   * On quit: stop every run and wait for the processes to exit (SIGKILL after the grace period).
   * A run still alive after `waitMs` is killed outright and its config file (with its token)
   * deleted right away: the app may exit before the process reports back.
   */
  async stopAll(waitMs = KILL_GRACE_MS + 1_000): Promise<void> {
    const entries = [...this.live.values()]
    if (entries.length === 0) return
    for (const entry of entries) {
      entry.ending = 'stopped'
      kill(entry.child)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(entries.map((e) => e.closed)),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs))),
    ])
    clearTimeout(timer)
    for (const entry of entries) {
      if (!this.live.has(entry.run.id)) continue
      entry.child.kill('SIGKILL')
      rmSync(entry.configPath, { force: true })
      void entry.access.revoke().catch(() => undefined)
    }
  }

  /** Delete the config files of runs that are not running (left by a crash or a forced quit). */
  private async sweepConfigs(): Promise<void> {
    const names = await readdir(this.deps.dir).catch(() => [] as string[])
    const live = new Set([...this.live.values()].map((l) => l.configPath))
    await Promise.all(
      names
        .filter((name) => CONFIG_FILE.test(name) && !live.has(join(this.deps.dir, name)))
        .map((name) => rm(join(this.deps.dir, name), { force: true }).catch(() => undefined)),
    )
  }
}
