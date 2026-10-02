import { describe, expect, it } from 'vitest'
import {
  AuthRateLimiter,
  allowedHosts,
  checkRequest,
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackAddress,
  isValidBearer,
  jsonRpcErrorBody,
  type RequestFacts,
} from './security'

const TOKEN = `brn_${'a'.repeat(43)}`
const ctx = { port: 29170, token: TOKEN, extraOrigins: ['http://localhost:6274'] }
const good: RequestFacts = {
  remoteAddress: '127.0.0.1',
  host: '127.0.0.1:29170',
  origin: undefined,
  authorization: `Bearer ${TOKEN}`,
}

describe('mcp security checks (contract §4.1)', () => {
  it('accepts only loopback sockets', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(false)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(
      checkRequest({ ...good, remoteAddress: '10.0.0.2' }, ctx, new AuthRateLimiter(), false),
    ).toMatchObject({ ok: false, status: 403, code: 'forbidden' })
  })

  it('checks Host against loopback names of the bound port (DNS rebinding)', () => {
    expect(allowedHosts(29170)).toEqual(['127.0.0.1:29170', 'localhost:29170'])
    expect(isAllowedHost('localhost:29170', 29170)).toBe(true)
    expect(isAllowedHost('LOCALHOST:29170', 29170)).toBe(true)
    expect(isAllowedHost('attacker.example', 29170)).toBe(false)
    expect(isAllowedHost('attacker.example:29170', 29170)).toBe(false)
    expect(isAllowedHost('127.0.0.1:29171', 29170)).toBe(false)
    expect(isAllowedHost('127.0.0.1', 29170)).toBe(false)
    expect(isAllowedHost(undefined, 29170)).toBe(false)
    const res = checkRequest(
      { ...good, host: 'attacker.example:29170' },
      ctx,
      new AuthRateLimiter(),
      false,
    )
    expect(res).toMatchObject({ ok: false, status: 403, code: 'invalid_host' })
  })

  it('allows a missing Origin, loopback origins and configured extras only', () => {
    expect(isAllowedOrigin(undefined, 29170)).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:29170', 29170)).toBe(true)
    expect(isAllowedOrigin('http://localhost:29170', 29170)).toBe(true)
    expect(isAllowedOrigin('http://localhost:6274', 29170, ctx.extraOrigins)).toBe(true)
    expect(isAllowedOrigin('https://evil.example', 29170)).toBe(false)
    expect(isAllowedOrigin('null', 29170)).toBe(false)
    expect(isAllowedOrigin('http://localhost:29171', 29170)).toBe(false)
    const res = checkRequest(
      { ...good, origin: 'https://evil.example' },
      ctx,
      new AuthRateLimiter(),
      false,
    )
    expect(res).toMatchObject({ ok: false, status: 403, code: 'invalid_origin' })
  })

  it('requires the exact bearer token', () => {
    expect(isValidBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(isValidBearer(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(isValidBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(isValidBearer(`Bearer ${TOKEN.slice(0, -1)}b`, TOKEN)).toBe(false)
    expect(isValidBearer(TOKEN, TOKEN)).toBe(false)
    expect(isValidBearer(undefined, TOKEN)).toBe(false)
    expect(isValidBearer('Bearer ', '')).toBe(false)
    const res = checkRequest(
      { ...good, authorization: undefined },
      ctx,
      new AuthRateLimiter(),
      false,
    )
    expect(res).toMatchObject({
      ok: false,
      status: 401,
      code: 'unauthorized',
      headers: { 'WWW-Authenticate': 'Bearer realm="Baren"' },
    })
    expect(checkRequest(good, ctx, new AuthRateLimiter(), false)).toEqual({ ok: true })
  })

  it('rate-limits more than 30 failures in 60 s for 60 s, for every request', () => {
    let now = 0
    const limiter = new AuthRateLimiter({ now: () => now })
    const bad = { ...good, authorization: 'Bearer nope' }
    for (let i = 0; i < 30; i++) {
      expect(checkRequest(bad, ctx, limiter, false)).toMatchObject({ status: 401 })
      now += 100
    }
    expect(checkRequest(good, ctx, limiter, false)).toEqual({ ok: true })
    expect(checkRequest(bad, ctx, limiter, false)).toMatchObject({ status: 401 })
    // The 31st failure blocks everything, even the right token.
    expect(checkRequest(good, ctx, limiter, false)).toMatchObject({
      status: 429,
      code: 'rate_limited',
    })
    now += 59_000
    expect(checkRequest(good, ctx, limiter, false)).toMatchObject({ status: 429 })
    now += 2_000
    expect(checkRequest(good, ctx, limiter, false)).toEqual({ ok: true })
  })

  it('does not count requests without credentials (a web page cannot lock the agent out)', () => {
    const limiter = new AuthRateLimiter()
    const anonymous = { ...good, authorization: undefined }
    for (let i = 0; i < 100; i++) {
      expect(checkRequest(anonymous, ctx, limiter, false)).toMatchObject({ status: 401 })
    }
    expect(limiter.isBlocked()).toBe(false)
    expect(checkRequest(good, ctx, limiter, false)).toEqual({ ok: true })
  })

  it('forgets failures older than the window', () => {
    let now = 0
    const limiter = new AuthRateLimiter({ now: () => now })
    for (let i = 0; i < 30; i++) limiter.recordFailure()
    now = 61_000
    limiter.recordFailure()
    expect(limiter.isBlocked()).toBe(false)
  })

  it('refuses with 503 while shutting down, after authentication', () => {
    expect(checkRequest(good, ctx, new AuthRateLimiter(), true)).toMatchObject({
      ok: false,
      status: 503,
      code: 'shutting_down',
    })
    expect(
      checkRequest({ ...good, authorization: undefined }, ctx, new AuthRateLimiter(), true),
    ).toMatchObject({
      status: 401,
    })
  })

  it('formats JSON-RPC error bodies', () => {
    expect(JSON.parse(jsonRpcErrorBody('nope'))).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'nope' },
      id: null,
    })
  })
})
