import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from '../src/api.ts'
import { ApiError } from '../src/errors.ts'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  /** Binary request bodies, as sent. */
  raw?: Uint8Array
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      ...(init?.body instanceof Uint8Array ? { raw: init.body } : {}),
    }
    calls.push(call)
    return respond(call)
  })
  return { fetch: fetchImpl as unknown as typeof fetch, calls }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('createApiClient', () => {
  it('sends JSON without auth for sign-up endpoints', async () => {
    const { fetch, calls } = mockFetch(() => json({ userId: 'u1', needsVerification: true }))
    const api = createApiClient({ baseUrl: 'http://srv/', getToken: () => 'secret', fetch })
    const res = await api.auth.register({ name: 'ceyhun cakir', email: 'c@x.io', password: 'pw' })
    expect(res.userId).toBe('u1')
    expect(calls[0]).toMatchObject({
      url: 'http://srv/api/auth/register',
      method: 'POST',
      body: { name: 'ceyhun cakir', email: 'c@x.io', password: 'pw' },
    })
    expect(calls[0]!.headers['authorization']).toBeUndefined()
    expect(calls[0]!.headers['content-type']).toBe('application/json')
  })

  it('adds the bearer token and encodes path segments', async () => {
    const { fetch, calls } = mockFetch(() => json([]))
    const api = createApiClient({ baseUrl: 'http://srv', getToken: async () => 'tok', fetch })
    await api.teams.members('team/1')
    await api.teams.updateMember('t', 'u', 'viewer')
    expect(calls[0]!.url).toBe('http://srv/api/teams/team%2F1/members')
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok')
    expect(calls[1]).toMatchObject({
      url: 'http://srv/api/teams/t/members/u',
      method: 'PATCH',
      body: { role: 'viewer' },
    })
  })

  it('maps every endpoint to the documented route', async () => {
    const { fetch, calls } = mockFetch(() => json({}))
    const api = createApiClient({ baseUrl: 'http://srv', getToken: () => 't', fetch })
    await api.auth.verify('e', '123456')
    await api.auth.resendCode('e')
    await api.auth.login('e', 'p')
    await api.auth.logout()
    await api.auth.deviceStart()
    await api.auth.devicePoll('dc')
    await api.me()
    await api.teams.list()
    await api.teams.create('T')
    await api.teams.update('t', { fileAccess: 'link' })
    await api.teams.remove('t')
    await api.teams.removeMember('t', 'u')
    await api.invites.create('t', { role: 'editor', maxUses: 2 })
    await api.invites.list('t')
    await api.invites.preview('tok')
    await api.invites.accept('tok')
    await api.invites.revoke('inv')
    await api.files.list('t')
    await api.files.update('f', { archived: true })
    await api.files.remove('f')
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://srv', '')}`)).toEqual([
      'POST /api/auth/verify',
      'POST /api/auth/resend',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/device/start',
      'POST /api/auth/device/poll',
      'GET /api/me',
      'GET /api/teams',
      'POST /api/teams',
      'PATCH /api/teams/t',
      'DELETE /api/teams/t',
      'DELETE /api/teams/t/members/u',
      'POST /api/teams/t/invites',
      'GET /api/teams/t/invites',
      'GET /api/invites/tok',
      'POST /api/invites/tok/accept',
      'DELETE /api/invites/inv',
      'GET /api/teams/t/files',
      'PATCH /api/files/f',
      'DELETE /api/files/f',
    ])
    // Invite previews work signed out.
    expect(calls[14]!.headers['authorization']).toBeUndefined()
    expect(calls[16]!.headers['authorization']).toBe('Bearer t')
  })

  it('base64-encodes an initial snapshot and returns snapshots as bytes', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const { fetch, calls } = mockFetch((call) =>
      call.url.endsWith('/snapshot') ? new Response(bytes) : json({ id: 'f1' }),
    )
    const api = createApiClient({ baseUrl: 'http://srv', getToken: () => 't', fetch })
    await api.files.create('team', { name: 'Doc', snapshot: bytes })
    expect(calls[0]!.body).toEqual({ name: 'Doc', snapshot: 'AAEC+v8=' })
    await api.files.create('team', { name: 'Empty' })
    expect(calls[1]!.body).toEqual({ name: 'Empty' })
    const snap = await api.files.snapshot('f1')
    expect(snap).toBeInstanceOf(Uint8Array)
    expect([...snap]).toEqual([...bytes])
  })

  it('turns error bodies into ApiError', async () => {
    const { fetch } = mockFetch(() =>
      json(
        { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } },
        401,
      ),
    )
    const api = createApiClient({ baseUrl: 'http://srv', fetch })
    const err = await api.auth.login('e', 'p').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      status: 401,
      code: 'invalid_credentials',
      message: 'Email or password is incorrect.',
      retryable: false,
    })
  })

  it('handles non-JSON errors and network failures', async () => {
    const api502 = createApiClient({
      baseUrl: 'http://srv',
      fetch: mockFetch(() => new Response('<html>bad gateway</html>', { status: 502 })).fetch,
    })
    await expect(api502.me()).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
      retryable: true,
    })

    const offline = createApiClient({
      baseUrl: 'http://srv',
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
    })
    await expect(offline.me()).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })

  it('waits for device approval', async () => {
    const replies = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'ok', token: 't', user: { id: 'u' } },
    ]
    const { fetch, calls } = mockFetch(() => json(replies.shift()))
    const api = createApiClient({ baseUrl: 'http://srv', fetch })
    const start = {
      deviceCode: 'dc',
      userCode: 'ABC-234',
      verifyUrl: 'x',
      expiresIn: 600,
      interval: 2,
    }
    const auth = await api.auth.waitForDevice(start, { intervalMs: 1 })
    expect(auth).toEqual({ token: 't', user: { id: 'u' } })
    expect(calls).toHaveLength(3)
    expect(calls[0]!.body).toEqual({ deviceCode: 'dc' })
  })

  it('rejects when the device request is denied, expires or is aborted', async () => {
    const start = {
      deviceCode: 'dc',
      userCode: 'ABC-234',
      verifyUrl: 'x',
      expiresIn: 600,
      interval: 2,
    }
    const denied = createApiClient({
      baseUrl: 'http://srv',
      fetch: mockFetch(() => json({ status: 'denied' })).fetch,
    })
    await expect(denied.auth.waitForDevice(start, { intervalMs: 1 })).rejects.toMatchObject({
      code: 'device_denied',
    })
    const expired = createApiClient({
      baseUrl: 'http://srv',
      fetch: mockFetch(() => json({ status: 'expired' })).fetch,
    })
    await expect(expired.auth.waitForDevice(start, { intervalMs: 1 })).rejects.toMatchObject({
      code: 'device_expired',
    })

    const pending = createApiClient({
      baseUrl: 'http://srv',
      fetch: mockFetch(() => json({ status: 'pending' })).fetch,
    })
    const controller = new AbortController()
    const waiting = pending.auth.waitForDevice(start, { intervalMs: 50, signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
  })

  describe('phase 2', () => {
    const empty = () => new Response(null, { status: 204 })

    it('maps the password, provider and invite endpoints', async () => {
      const { fetch, calls } = mockFetch((call) =>
        call.url.includes('/password/forgot') || call.url.includes('/password/change')
          ? empty()
          : json({ ok: true }),
      )
      const api = createApiClient({ baseUrl: 'http://srv', getToken: () => 't', fetch })
      await expect(api.providers()).resolves.toEqual({ ok: true })
      await expect(api.forgotPassword('c@x.io')).resolves.toBeUndefined()
      await api.resetPassword('c@x.io', '482 719', 'new password')
      await expect(
        api.changePassword({ currentPassword: 'old pw', newPassword: 'new password' }),
      ).resolves.toBeUndefined()
      await api.changePassword({ newPassword: 'new password' })
      await api.resendInvite('inv/1')
      expect(calls.map((c) => `${c.method} ${c.url.replace('http://srv', '')}`)).toEqual([
        'GET /api/auth/providers',
        'POST /api/auth/password/forgot',
        'POST /api/auth/password/reset',
        'POST /api/auth/password/change',
        'POST /api/auth/password/change',
        'POST /api/invites/inv%2F1/resend',
      ])
      expect(calls[1]!.body).toEqual({ email: 'c@x.io' })
      expect(calls[2]!.body).toEqual({ email: 'c@x.io', code: '482 719', password: 'new password' })
      expect(calls[3]!.body).toEqual({ currentPassword: 'old pw', newPassword: 'new password' })
      expect(calls[4]!.body).toEqual({ newPassword: 'new password' })
      // Anonymous: providers, forgot, reset. Signed in: change, resend.
      expect(calls.map((c) => c.headers['authorization'] ?? null)).toEqual([
        null,
        null,
        null,
        'Bearer t',
        'Bearer t',
        'Bearer t',
      ])
    })

    it('surfaces reset and change errors with their codes', async () => {
      const api = createApiClient({
        baseUrl: 'http://srv',
        fetch: mockFetch(() =>
          json({ error: { code: 'code_expired', message: 'That code has expired.' } }, 400),
        ).fetch,
      })
      await expect(api.resetPassword('e', '123456', 'pw pw pw pw')).rejects.toMatchObject({
        status: 400,
        code: 'code_expired',
        retryable: false,
      })
      const limited = createApiClient({
        baseUrl: 'http://srv',
        fetch: mockFetch(() => json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429))
          .fetch,
      })
      await expect(limited.forgotPassword('e@x.io')).rejects.toMatchObject({
        code: 'rate_limited',
        retryable: true,
      })
    })

    it('uploads asset bytes as the raw body', async () => {
      const info = { hash: 'ab'.repeat(32), mime: 'image/png', size: 3 }
      const { fetch, calls } = mockFetch(() => json(info, 201))
      const api = createApiClient({ baseUrl: 'http://srv', getToken: () => 't', fetch })
      const bytes = new Uint8Array([137, 80, 78])
      await expect(api.uploadAsset('f 1', 'AB'.repeat(32), bytes, 'image/png')).resolves.toEqual(
        info,
      )
      expect(calls[0]).toMatchObject({
        url: `http://srv/api/files/f%201/assets/${'ab'.repeat(32)}`,
        method: 'PUT',
      })
      expect(calls[0]!.headers['content-type']).toBe('image/png')
      expect(calls[0]!.headers['authorization']).toBe('Bearer t')
      expect([...calls[0]!.raw!]).toEqual([137, 80, 78])

      // A view into a larger buffer sends just its own bytes.
      const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
      await api.uploadAsset('f', 'h', backing.subarray(2, 5), '')
      expect([...calls[1]!.raw!]).toEqual([1, 2, 3])
      expect(calls[1]!.headers['content-type']).toBe('application/octet-stream')
    })

    it('downloads assets and answers null / false when they are missing', async () => {
      const png = new Uint8Array([137, 80, 78, 71])
      const { fetch, calls } = mockFetch((call) => {
        if (call.url.endsWith('/missing')) return json({ error: { code: 'asset_not_found' } }, 404)
        if (call.url.endsWith('/broken')) return json({ error: { code: 'internal' } }, 500)
        if (call.method === 'HEAD') return new Response(null, { status: 200 })
        return new Response(png, { headers: { 'content-type': 'image/png; charset=binary' } })
      })
      const api = createApiClient({ baseUrl: 'http://srv', getToken: () => 't', fetch })
      const asset = await api.downloadAsset('f', 'present')
      expect(asset?.mime).toBe('image/png')
      expect(asset?.bytes).toBeInstanceOf(Uint8Array)
      expect([...asset!.bytes]).toEqual([...png])
      await expect(api.downloadAsset('f', 'missing')).resolves.toBeNull()
      await expect(api.hasAsset('f', 'present')).resolves.toBe(true)
      await expect(api.hasAsset('f', 'missing')).resolves.toBe(false)
      await expect(api.downloadAsset('f', 'broken')).rejects.toMatchObject({
        status: 500,
        code: 'internal',
      })
      await expect(api.hasAsset('f', 'broken')).rejects.toMatchObject({ status: 500 })
      expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'HEAD', 'HEAD', 'GET', 'HEAD'])
      expect(calls[0]!.headers['authorization']).toBe('Bearer t')
    })
  })
})
