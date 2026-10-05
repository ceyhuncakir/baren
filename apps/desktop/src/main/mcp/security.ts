/**
 * Request checks for the MCP endpoint (contract §4.1), pure and unit-tested. They run in this
 * order before the SDK sees a request:
 *
 * 1. the socket is loopback (`127.0.0.1` / `::ffff:127.0.0.1`) → else 403;
 * 2. `Host` is `127.0.0.1:<port>` or `localhost:<port>` → else 403 `invalid_host` (DNS rebinding);
 * 3. `Origin` is absent or a loopback origin of this port (or an extra allowed origin) → else 403
 *    `invalid_origin`;
 * 4. `Authorization: Bearer <token>` matches (timing-safe) the app's token, or the token of a
 *    running comment request (a "run token", scoped to one file: `RunScope`) → else 401; more
 *    than 30 wrong tokens in 60 s → 429 for 60 s, for every request (requests without an
 *    Authorization header are refused but not counted);
 * 5. while shutting down → 503.
 */
import { timingSafeEqual } from 'node:crypto'

export interface CheckFailure {
  ok: false
  status: 401 | 403 | 429 | 503
  /** Short machine code, also the start of the JSON-RPC error message. */
  code:
    | 'forbidden'
    | 'invalid_host'
    | 'invalid_origin'
    | 'unauthorized'
    | 'rate_limited'
    | 'shutting_down'
  message: string
  headers?: Record<string, string>
}

/**
 * What a comment request's `claude -p` run may touch (`agentRuns/`): its own short-lived token
 * opens sessions that work on the comment's file only (tools/index.ts) and resolve no local
 * files or private-network URLs as image sources (assets.ts).
 */
export interface RunScope {
  runId: string
  /** The local file the comment is in. */
  fileId: string
}

/** `scope` is null for the app's own token (any agent the user connected). */
export type CheckResult = { ok: true; scope: RunScope | null } | CheckFailure

export interface RequestFacts {
  remoteAddress: string | undefined
  host: string | undefined
  origin: string | undefined
  authorization: string | undefined
}

export interface SecurityContext {
  /** The port the server is bound to. */
  port: number
  /** The current bearer token (it changes on rotation). */
  token: string
  /** Live run tokens → their scope (comment requests; none when absent). */
  runTokens?: ReadonlyMap<string, RunScope>
  /** BAREN_MCP_ALLOWED_ORIGINS. */
  extraOrigins: readonly string[]
}

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::ffff:127.0.0.1'])

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address)
}

/** The `Host` values a client of this port may send. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`]
}

/** The `Origin` values a browser page may send (absent is always fine). */
export function allowedOrigins(port: number, extra: readonly string[] = []): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra]
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const value = host.trim().toLowerCase()
  return allowedHosts(port).includes(value)
}

export function isAllowedOrigin(
  origin: string | undefined,
  port: number,
  extra: readonly string[] = [],
): boolean {
  if (origin === undefined || origin === '') return true
  const value = origin.trim().toLowerCase()
  return allowedOrigins(port, extra).some((o) => o.toLowerCase() === value)
}

/** `Authorization: Bearer <token>`, compared in constant time (after a length check). */
export function isValidBearer(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined || token.length === 0) return false
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization)
  if (!match) return false
  const given = Buffer.from(match[1] ?? '', 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

/** The scope of the run token in `authorization`, or null (every token compared in full). */
export function runScopeOf(
  authorization: string | undefined,
  runTokens: ReadonlyMap<string, RunScope> | undefined,
): RunScope | null {
  let found: RunScope | null = null
  for (const [token, scope] of runTokens ?? []) {
    if (isValidBearer(authorization, token)) found = scope
  }
  return found
}

/**
 * Failed-token counter: more than `limit` failures inside `windowMs` blocks every request for
 * `blockMs` (a local brute-force guard; the token has 256 bits).
 */
export class AuthRateLimiter {
  private failures: number[] = []
  private blockedUntil = 0

  constructor(
    private readonly options: {
      limit?: number
      windowMs?: number
      blockMs?: number
      now?: () => number
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  isBlocked(): boolean {
    return this.now() < this.blockedUntil
  }

  recordFailure(): void {
    const now = this.now()
    const windowMs = this.options.windowMs ?? 60_000
    this.failures = this.failures.filter((t) => now - t < windowMs)
    this.failures.push(now)
    if (this.failures.length > (this.options.limit ?? 30)) {
      this.blockedUntil = now + (this.options.blockMs ?? 60_000)
      this.failures = []
    }
  }

  reset(): void {
    this.failures = []
    this.blockedUntil = 0
  }
}

export const WWW_AUTHENTICATE = 'Bearer realm="Baren"'

/** Run every check of contract §4.1 in order; records token failures in `limiter`. */
export function checkRequest(
  facts: RequestFacts,
  ctx: SecurityContext,
  limiter: AuthRateLimiter,
  shuttingDown: boolean,
): CheckResult {
  if (!isLoopbackAddress(facts.remoteAddress)) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Only local connections' }
  }
  if (!isAllowedHost(facts.host, ctx.port)) {
    return {
      ok: false,
      status: 403,
      code: 'invalid_host',
      message: `Invalid Host header (use 127.0.0.1:${ctx.port} or localhost:${ctx.port})`,
    }
  }
  if (!isAllowedOrigin(facts.origin, ctx.port, ctx.extraOrigins)) {
    return { ok: false, status: 403, code: 'invalid_origin', message: 'Invalid Origin header' }
  }
  if (limiter.isBlocked()) {
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      message: 'Too many failed authentication attempts; try again in a minute',
      headers: { 'Retry-After': '60' },
    }
  }
  const appToken = isValidBearer(facts.authorization, ctx.token)
  const scope = appToken ? null : runScopeOf(facts.authorization, ctx.runTokens)
  if (!appToken && scope === null) {
    // Only a wrong token is a guess. Requests without credentials (a web page can make the
    // browser send those, e.g. an <img> pointing at the default port, and browsers cannot
    // attach an Authorization header cross-origin) must not lock out the real agent.
    if (facts.authorization !== undefined && facts.authorization.trim() !== '') {
      limiter.recordFailure()
    }
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message:
        'Missing or invalid access token. Copy the current snippet from Baren (MCP section → Connect your agent).',
      headers: { 'WWW-Authenticate': WWW_AUTHENTICATE },
    }
  }
  if (shuttingDown) {
    return { ok: false, status: 503, code: 'shutting_down', message: 'Baren is quitting' }
  }
  return { ok: true, scope }
}

/** The JSON-RPC error body every refusal carries (contract §4.1). */
export function jsonRpcErrorBody(message: string, code = -32001): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })
}
