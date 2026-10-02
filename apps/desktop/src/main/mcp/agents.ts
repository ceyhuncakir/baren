/**
 * Agent registry (contract §4.4): one entry per MCP session, with its display name, per-file
 * activity and working sets (the "<name> is working" indicators), plus the recently seen agents
 * of `<userData>/mcp/agents.json` for the home card.
 *
 * - Every successful write adds the response's `touched` artboards to the session's working set
 *   for that file (expiry now + 120 s); any later call touching an artboard renews it;
 *   `finish_working_on_nodes` releases; a sweep drops expired entries; closing a session drops
 *   everything.
 * - Presence pushes (`agent:presence`) go to the host of every affected file, throttled to 10 Hz
 *   per file, with the full list for that file: sessions active there in the last 10 min or with
 *   a working set there.
 */
import { randomBytes } from 'node:crypto'
import type { AgentPresence, McpAgentInfo } from '../../renderer/types/bridge'
import type { Logger } from '../log'
import { readJsonOrNull, writeFileAtomic } from '../util/fs'

export const WORKING_TTL_MS = 120_000
export const PRESENCE_ACTIVITY_MS = 10 * 60_000
const MAX_NAME = 32

/** Known client names (case-insensitive prefix match, first match wins). */
const KNOWN_CLIENTS: readonly (readonly [string, string])[] = [
  ['claude-code', 'Claude Code'],
  ['claude-ai', 'Claude'],
  ['claude', 'Claude'],
  ['cursor', 'Cursor'],
  ['codex', 'Codex'],
  ['visual studio code', 'VS Code'],
  ['vscode', 'VS Code'],
  ['windsurf', 'Windsurf'],
  ['zed', 'Zed'],
  ['gemini-cli', 'Gemini CLI'],
  ['mcp-inspector', 'MCP Inspector'],
  ['inspector-client', 'MCP Inspector'],
]

export interface ClientInfo {
  name: string
  version?: string | undefined
  title?: string | undefined
}

/** `clientInfo.title`, else a known-name map, else `clientInfo.name`; ≤ 32 chars; "Agent" if empty. */
export function baseDisplayName(info: ClientInfo | null | undefined): string {
  const title = info?.title?.trim()
  let name = title && title.length > 0 ? title : ''
  if (!name) {
    const raw = info?.name?.trim() ?? ''
    const lower = raw.toLowerCase()
    name = KNOWN_CLIENTS.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? raw
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trimEnd()
  return name || 'Agent'
}

/** `base`, or `base 2`, `base 3`… so live sessions never share a name. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/** 12 random base36 characters: the agent's id in presence data. */
export function newPresenceId(): string {
  const bytes = randomBytes(12)
  let out = ''
  for (const b of bytes) out += (b % 36).toString(36)
  return out
}

interface FileActivity {
  lastActivityAt: number
  /** artboard id → expires at */
  working: Map<string, number>
  /** Included in this file's presence list at the last sweep. */
  presented: boolean
}

export interface AgentSession {
  sessionId: string
  presenceId: string
  client: string
  version: string | null
  /** Base display name (without the " 2" suffix). */
  baseName: string
  name: string
  identified: boolean
  connectedAt: number
  lastActivityAt: number
  lastFileId: string | null
  lastFileName: string | null
  files: Map<string, FileActivity>
  /** Per page: the last artboard this session created or duplicated (placement anchor). */
  anchors: Map<string, string>
}

// ---------------------------------------------------------------------------
// agents.json (recently seen agents)
// ---------------------------------------------------------------------------

export interface RecentAgent {
  name: string
  client: string
  lastActivityAt: number
  lastFileId: string | null
  lastFileName: string | null
}

export const RECENT_MAX = 10
export const RECENT_MAX_AGE_MS = 30 * 24 * 60 * 60_000

function isRecentAgent(value: unknown): value is RecentAgent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['name'] === 'string' &&
    typeof v['client'] === 'string' &&
    typeof v['lastActivityAt'] === 'number' &&
    (v['lastFileId'] === null || typeof v['lastFileId'] === 'string') &&
    (v['lastFileName'] === null || typeof v['lastFileName'] === 'string')
  )
}

/** Recently seen agents, keyed by display name; ≤ 10, ≤ 30 days, written ≤ once a minute. */
export class RecentAgentsStore {
  private entries = new Map<string, RecentAgent>()
  private lastWrite = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly options: {
      now?: () => number
      log?: Logger
      writeIntervalMs?: number
      write?: (path: string, text: string) => Promise<void>
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  async load(): Promise<void> {
    try {
      const raw = (await readJsonOrNull(this.path)) as { agents?: unknown } | null
      const list = Array.isArray(raw?.agents) ? raw.agents.filter(isRecentAgent) : []
      for (const a of list) this.entries.set(a.name, { ...a })
      this.prune()
    } catch (error) {
      this.options.log?.warn('mcp/agents.json is unreadable; starting empty', String(error))
    }
  }

  private prune(): void {
    const now = this.now()
    const sorted = [...this.entries.values()]
      .filter((a) => now - a.lastActivityAt <= RECENT_MAX_AGE_MS)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, RECENT_MAX)
    this.entries = new Map(sorted.map((a) => [a.name, a]))
  }

  update(entry: RecentAgent): void {
    this.entries.set(entry.name, { ...entry })
    this.prune()
    this.dirty = true
    this.schedule()
  }

  list(): RecentAgent[] {
    this.prune()
    return [...this.entries.values()].map((a) => ({ ...a }))
  }

  private schedule(): void {
    if (this.timer !== null) return
    const interval = this.options.writeIntervalMs ?? 60_000
    const wait = Math.max(0, this.lastWrite + interval - this.now())
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, wait)
    this.timer.unref?.()
  }

  /** Write now if anything changed (also on quit). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return this.writing
    this.dirty = false
    this.lastWrite = this.now()
    const text = `${JSON.stringify({ version: 1, agents: this.list() }, null, 2)}\n`
    const write =
      this.options.write ?? ((p: string, t: string) => writeFileAtomic(p, t, { mode: 0o600 }))
    this.writing = this.writing
      .then(() => write(this.path, text))
      .catch((error: unknown) =>
        this.options.log?.warn('could not write mcp/agents.json', String(error)),
      )
    return this.writing
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface AgentRegistryOptions {
  now?: () => number
  log?: Logger
  recent?: RecentAgentsStore
  /** The agents of one file changed (throttling is the caller's job). */
  onFilePresence?(fileId: string): void
  /** Names, sessions or activity changed (status broadcast; throttled by the caller). */
  onChange?(): void
  workingTtlMs?: number
  activityWindowMs?: number
}

export class AgentRegistry {
  private readonly sessions = new Map<string, AgentSession>()

  constructor(private readonly options: AgentRegistryOptions = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  get size(): number {
    return this.sessions.size
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  all(): AgentSession[] {
    return [...this.sessions.values()]
  }

  /** A new MCP session (named once its `initialize` arrived). */
  open(sessionId: string, client: ClientInfo | null = null): AgentSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const now = this.now()
    const session: AgentSession = {
      sessionId,
      presenceId: newPresenceId(),
      client: 'unknown',
      version: null,
      baseName: 'Agent',
      name: 'Agent',
      identified: false,
      connectedAt: now,
      lastActivityAt: now,
      lastFileId: null,
      lastFileName: null,
      files: new Map(),
      anchors: new Map(),
    }
    this.sessions.set(sessionId, session)
    if (client) this.identify(sessionId, client)
    else session.name = this.uniqueFor(session, session.baseName)
    this.options.onChange?.()
    return session
  }

  private uniqueFor(session: AgentSession, base: string): string {
    const taken = new Set(
      [...this.sessions.values()].filter((s) => s !== session).map((s) => s.name),
    )
    return uniqueName(base, taken)
  }

  /** `clientInfo` from `initialize`: sets the display name. */
  identify(sessionId: string, client: ClientInfo): AgentSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    session.client = client.name || 'unknown'
    session.version = client.version ?? null
    session.baseName = baseDisplayName(client)
    session.name = this.uniqueFor(session, session.baseName)
    session.identified = true
    this.options.onChange?.()
    for (const fileId of session.files.keys()) this.options.onFilePresence?.(fileId)
    return session
  }

  /** The session ended: its indicators disappear from every file. */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    for (const fileId of session.files.keys()) this.options.onFilePresence?.(fileId)
    this.options.onChange?.()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /** A tool call ran (on a file, or none): activity for the status and agents.json. */
  noteCall(sessionId: string, fileId: string | null, fileName: string | null): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const now = this.now()
    session.lastActivityAt = now
    if (fileId !== null) {
      const wasActive = this.isActiveIn(session, fileId, now)
      session.lastFileId = fileId
      if (fileName !== null) session.lastFileName = fileName
      const activity = this.activity(session, fileId)
      activity.lastActivityAt = now
      if (!wasActive) this.options.onFilePresence?.(fileId)
    }
    this.options.recent?.update({
      name: session.baseName,
      client: session.client,
      lastActivityAt: now,
      lastFileId: session.lastFileId,
      lastFileName: session.lastFileName,
    })
    this.options.onChange?.()
  }

  private activity(session: AgentSession, fileId: string): FileActivity {
    let activity = session.files.get(fileId)
    if (!activity) {
      activity = { lastActivityAt: 0, working: new Map(), presented: true }
      session.files.set(fileId, activity)
    }
    return activity
  }

  private isActiveIn(session: AgentSession, fileId: string, now: number): boolean {
    const a = session.files.get(fileId)
    if (!a) return false
    return (
      a.working.size > 0 ||
      now - a.lastActivityAt <= (this.options.activityWindowMs ?? PRESENCE_ACTIVITY_MS)
    )
  }

  /**
   * Artboards a call touched: writes add them to the working set, reads only renew entries that
   * are already there.
   */
  touch(sessionId: string, fileId: string, artboardIds: readonly string[], write: boolean): void {
    const session = this.sessions.get(sessionId)
    if (!session || artboardIds.length === 0) return
    const activity = this.activity(session, fileId)
    const expires = this.now() + (this.options.workingTtlMs ?? WORKING_TTL_MS)
    let changed = false
    for (const id of artboardIds) {
      if (!write && !activity.working.has(id)) continue
      if (!activity.working.has(id)) changed = true
      activity.working.set(id, expires)
    }
    if (changed) {
      this.options.onFilePresence?.(fileId)
      this.options.onChange?.()
    }
  }

  /** Artboards in this session's working set for a file (or every file). */
  working(sessionId: string, fileId: string | null = null): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const session = this.sessions.get(sessionId)
    if (!session) return out
    for (const [id, a] of session.files) {
      if (fileId !== null && id !== fileId) continue
      if (a.working.size > 0) out.set(id, [...a.working.keys()])
    }
    return out
  }

  /**
   * Release working indicators: every one of the session in `fileId` (or in every file when
   * null), or only `artboardIds`. Never fails for ids that were not marked.
   */
  release(
    sessionId: string,
    fileId: string | null,
    artboardIds: readonly string[] | null,
  ): { released: string[]; remaining: string[] } {
    const session = this.sessions.get(sessionId)
    if (!session) return { released: [], remaining: [] }
    const released: string[] = []
    const remaining: string[] = []
    for (const [id, a] of session.files) {
      const inScope = fileId === null || id === fileId
      let changed = false
      for (const artboard of [...a.working.keys()]) {
        if (inScope && (artboardIds === null || artboardIds.includes(artboard))) {
          a.working.delete(artboard)
          released.push(artboard)
          changed = true
        } else if (inScope) {
          remaining.push(artboard)
        }
      }
      if (changed) this.options.onFilePresence?.(id)
    }
    if (released.length > 0) this.options.onChange?.()
    return { released, remaining }
  }

  /**
   * Drop expired working entries and push presence for files a session just went quiet in
   * (called every second).
   */
  sweep(): void {
    const now = this.now()
    let changed = false
    for (const session of this.sessions.values()) {
      for (const [fileId, a] of session.files) {
        let fileChanged = false
        for (const [artboard, expires] of a.working) {
          if (expires <= now) {
            a.working.delete(artboard)
            fileChanged = true
          }
        }
        const active = this.isActiveIn(session, fileId, now)
        if (a.presented && !active) fileChanged = true
        a.presented = active
        if (fileChanged) {
          changed = true
          this.options.onFilePresence?.(fileId)
        }
      }
    }
    if (changed) this.options.onChange?.()
  }

  /** Remove artboards that no longer exist (e.g. deleted by a write) from every working set. */
  forget(fileId: string, artboardIds: readonly string[]): void {
    if (artboardIds.length === 0) return
    let changed = false
    for (const session of this.sessions.values()) {
      const a = session.files.get(fileId)
      if (!a) continue
      for (const id of artboardIds) if (a.working.delete(id)) changed = true
    }
    if (changed) {
      this.options.onFilePresence?.(fileId)
      this.options.onChange?.()
    }
  }

  hasWorkingSet(fileId: string): boolean {
    for (const s of this.sessions.values()) {
      if ((s.files.get(fileId)?.working.size ?? 0) > 0) return true
    }
    return false
  }

  /** Files any session has activity or working sets in (for presence refreshes). */
  files(): string[] {
    const out = new Set<string>()
    for (const s of this.sessions.values()) for (const id of s.files.keys()) out.add(id)
    return [...out]
  }

  /** The `agent:presence` list for a file. */
  presenceFor(fileId: string): AgentPresence[] {
    const now = this.now()
    const out: AgentPresence[] = []
    for (const s of this.sessions.values()) {
      if (!this.isActiveIn(s, fileId, now)) continue
      const a = s.files.get(fileId)
      out.push({
        id: s.presenceId,
        name: s.name,
        working: a ? [...a.working.keys()] : [],
        activeAt: a?.lastActivityAt ?? s.lastActivityAt,
      })
    }
    return out.sort((x, y) => y.activeAt - x.activeAt)
  }

  /** `McpStatus.agents`: live sessions, then recently seen agents without one. */
  statusAgents(): McpAgentInfo[] {
    const live: McpAgentInfo[] = [...this.sessions.values()]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((s) => ({
        name: s.name,
        client: s.client,
        version: s.version,
        connected: true,
        presenceId: s.presenceId,
        connectedAt: s.connectedAt,
        lastActivityAt: s.lastActivityAt,
        lastFileId: s.lastFileId,
        lastFileName: s.lastFileName,
        files: [...s.files]
          .filter(([, a]) => a.working.size > 0)
          .map(([fileId, a]) => ({ fileId, working: [...a.working.keys()] })),
      }))
    const liveNames = new Set([...this.sessions.values()].map((s) => s.baseName))
    const recent: McpAgentInfo[] = (this.options.recent?.list() ?? [])
      .filter((r) => !liveNames.has(r.name))
      .map((r) => ({
        name: r.name,
        client: r.client,
        version: null,
        connected: false,
        presenceId: null,
        connectedAt: null,
        lastActivityAt: r.lastActivityAt,
        lastFileId: r.lastFileId,
        lastFileName: r.lastFileName,
        files: [],
      }))
    return [...live, ...recent]
  }
}

/**
 * Per-key trailing throttle: `push(key)` runs `fn(key)` at most once per `intervalMs` per key,
 * always delivering the latest state (the caller reads it when `fn` runs).
 */
export class KeyedThrottle {
  private readonly last = new Map<string, number>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly intervalMs: number,
    private readonly fn: (key: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(key: string): void {
    if (this.timers.has(key)) return
    const wait = Math.max(0, (this.last.get(key) ?? -Infinity) + this.intervalMs - this.now())
    if (wait === 0) {
      this.fire(key)
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(key)
      this.fire(key)
    }, wait)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  private fire(key: string): void {
    this.last.set(key, this.now())
    this.fn(key)
  }

  cancel(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
