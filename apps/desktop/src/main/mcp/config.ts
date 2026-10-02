/**
 * MCP settings and secrets on disk (contract §3.1–§3.3), in `<userData>/mcp/` (mode 0700):
 *
 * - `config.json` (0600): `{ version: 1, enabled, port, token }`; created on first start
 *   (enabled, port 29170, a new token); unknown or invalid content is recreated with a new token.
 * - `endpoint.json` (0600): the live URL and pid while the server listens; no token.
 *
 * The token is plain text in a 0600 file: the stdio shim reads it without Electron, so it cannot
 * use safeStorage.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '../log'
import { readJsonOrNull, writeFileAtomic } from '../util/fs'

export const DEFAULT_PORT = 29170
/** The app's own dev ports: never used for MCP (a configured one falls through). */
export const RESERVED_PORTS: ReadonlySet<number> = new Set([8787, 5173, 5199])
export const TOKEN_PREFIX = 'brn_'

export interface McpConfig {
  version: 1
  enabled: boolean
  port: number
  token: string
}

export interface EndpointInfo {
  version: 1
  url: string
  port: number
  pid: number
  appVersion: string
  startedAt: number
}

export interface McpPaths {
  dir: string
  config: string
  endpoint: string
  agents: string
  shim: string
}

export function mcpPaths(userDataDir: string): McpPaths {
  const dir = join(userDataDir, 'mcp')
  return {
    dir,
    config: join(dir, 'config.json'),
    endpoint: join(dir, 'endpoint.json'),
    agents: join(dir, 'agents.json'),
    shim: join(dir, 'baren-mcp-stdio.cjs'),
  }
}

/** `brn_` + 32 random bytes as base64url (43 characters). */
export function generateToken(random: (n: number) => Buffer = randomBytes): string {
  return TOKEN_PREFIX + random(32).toString('base64url')
}

const TOKEN_PATTERN = /^brn_[A-Za-z0-9_-]{43}$/

export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535
}

export function isValidConfig(value: unknown): value is McpConfig {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v['version'] === 1 &&
    typeof v['enabled'] === 'boolean' &&
    isValidPort(v['port']) &&
    typeof v['token'] === 'string' &&
    TOKEN_PATTERN.test(v['token'])
  )
}

export function defaultConfig(token: string = generateToken()): McpConfig {
  return { version: 1, enabled: true, port: DEFAULT_PORT, token }
}

/**
 * Ports to try, in order: the configured one (unless reserved), then +1 … +9, then an ephemeral
 * port (0). `override` (BAREN_MCP_PORT) replaces the list with that single port (0 =
 * ephemeral).
 */
export function portCandidates(configured: number, override: number | null = null): number[] {
  if (override !== null) return [override]
  const out: number[] = []
  for (let i = 0; i <= 9; i++) {
    const port = configured + i
    if (port > 65_535) break
    if (!RESERVED_PORTS.has(port)) out.push(port)
  }
  out.push(0)
  return out
}

export function endpointUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

/** Reads, repairs and writes `config.json` / `endpoint.json`. */
export class McpConfigStore {
  readonly paths: McpPaths
  private current: McpConfig | null = null

  constructor(
    userDataDir: string,
    private readonly log: Logger,
  ) {
    this.paths = mcpPaths(userDataDir)
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.paths.dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.paths.dir, 0o700).catch(() => undefined)
  }

  /** The config, created or repaired on first use. */
  async load(): Promise<McpConfig> {
    if (this.current) return this.current
    await this.ensureDir()
    let raw: unknown = null
    let problem: string | null = null
    try {
      raw = await readJsonOrNull(this.paths.config)
    } catch (error) {
      problem = `unreadable (${error instanceof Error ? error.message : String(error)})`
    }
    if (raw !== null && isValidConfig(raw)) {
      this.current = { version: 1, enabled: raw.enabled, port: raw.port, token: raw.token }
      return this.current
    }
    if (raw !== null || problem !== null) {
      this.log.warn(`mcp/config.json was ${problem ?? 'invalid'}; recreated with a new token`)
    }
    const fresh = defaultConfig()
    if (raw !== null && typeof raw === 'object') {
      // Keep the user's choices that are still valid; only the token is always new.
      const r = raw as Record<string, unknown>
      if (typeof r['enabled'] === 'boolean') fresh.enabled = r['enabled']
      if (isValidPort(r['port'])) fresh.port = r['port']
    }
    await this.save(fresh)
    return fresh
  }

  async save(config: McpConfig): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(this.paths.config, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    })
    this.current = { ...config }
  }

  async update(patch: Partial<Omit<McpConfig, 'version'>>): Promise<McpConfig> {
    const next = { ...(await this.load()), ...patch, version: 1 as const }
    await this.save(next)
    return next
  }

  async rotateToken(): Promise<McpConfig> {
    return this.update({ token: generateToken() })
  }

  async writeEndpoint(info: EndpointInfo): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(this.paths.endpoint, `${JSON.stringify(info, null, 2)}\n`, {
      mode: 0o600,
    })
  }

  async removeEndpoint(): Promise<void> {
    await rm(this.paths.endpoint, { force: true })
  }
}
