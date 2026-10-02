/**
 * End-to-end for the Phase 2 server additions: spawns the real `baren-server` binary with
 * `MAIL_TRANSPORT=file:<tmp>` and `UPDATES_DIR=<tmp>` and drives it with the REST client:
 * register → read the code from the mail file → verify → forgot → reset → login, password
 * change, email invites (+ resend), image assets and the update feed.
 *
 * Build the server first (or set BAREN_SERVER_BIN):
 *   CARGO_TARGET_DIR=$PWD/target/sync-server cargo build -p baren-server
 * Without a binary the suite is skipped.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createApiClient, type ApiClient } from '../src/api.ts'
import { ApiError } from '../src/errors.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const candidates = [
  process.env['BAREN_SERVER_BIN'],
  join(repoRoot, 'target/sync-server/debug/baren-server'),
  join(repoRoot, 'target/sync-server/release/baren-server'),
  join(repoRoot, 'target/p2-server/debug/baren-server'),
  join(repoRoot, 'target/debug/baren-server'),
  join(repoRoot, 'target/release/baren-server'),
].filter((p): p is string => typeof p === 'string' && p.length > 0)
// An explicit BAREN_SERVER_BIN wins; otherwise the most recently built binary.
const serverBin =
  process.env['BAREN_SERVER_BIN'] && existsSync(process.env['BAREN_SERVER_BIN'])
    ? process.env['BAREN_SERVER_BIN']
    : candidates
        .filter((p) => existsSync(p))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]

it.runIf(!serverBin)('phase 2 e2e skipped: baren-server binary not found', () => {
  console.warn(
    '[sync-client e2e-phase2] SKIPPED: build the server or set BAREN_SERVER_BIN. Looked in:\n  ' +
      candidates.join('\n  '),
  )
})

/** A tiny PNG and its blake3 (the server re-hashes uploads and rejects mismatches). */
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  13,
  0x49,
  0x48,
  0x44,
  0x52,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  1,
  8,
  6,
  0,
  0,
  0,
  0x1f,
  0x15,
  0xc4,
  0x89,
  ...new Array<number>(32).fill(42),
])
const PNG_HASH = '144507ee07297fcaaa3b4e944a7145b6737cfcb81b4d4ec05fa40ffcc8ccd4ab'

interface MailFile {
  kind: string
  to: string
  subject: string
  code: string | null
  url: string | null
  text: string
  html: string
}

class ServerProcess {
  baseUrl = ''
  readonly dir = mkdtempSync(join(tmpdir(), 'baren-e2e2-'))
  readonly mailDir = join(this.dir, 'mail')
  readonly updatesDir = join(this.dir, 'updates')
  private child: ChildProcessWithoutNullStreams | null = null
  readonly log: string[] = []

  async start(bin: string): Promise<void> {
    mkdirSync(this.updatesDir)
    writeFileSync(join(this.updatesDir, 'latest-linux.yml'), 'version: 0.2.0\n')
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        BIND: '127.0.0.1:0',
        DATABASE_URL: `sqlite://${join(this.dir, 'e2e.db')}`,
        MAIL_TRANSPORT: `file:${this.mailDir}`,
        SMTP_URL: '',
        UPDATES_DIR: this.updatesDir,
        RUST_LOG: 'info',
        NO_COLOR: '1',
      },
    })
    this.child = child
    this.baseUrl = await new Promise<string>((resolve, reject) => {
      const onLine = (line: string) => {
        this.log.push(line)
        const url = /listening on (http:\/\/\S+)/.exec(line)
        if (url) resolve(url[1]!)
      }
      createInterface({ input: child.stdout }).on('line', onLine)
      createInterface({ input: child.stderr }).on('line', onLine)
      child.once('exit', (code) =>
        reject(new Error(`server exited early (${code}):\n${this.log.join('\n')}`)),
      )
    })
  }

  /** All mails of `kind` to `to`, oldest first (reads the `.json` sidecars). */
  mails(kind: string, to: string): MailFile[] {
    if (!existsSync(this.mailDir)) return []
    return readdirSync(this.mailDir)
      .filter((f) => f.endsWith(`-${kind}.json`))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(this.mailDir, f), 'utf8')) as MailFile)
      .filter((m) => m.to === to)
  }

  /** Wait for the `n`-th mail of `kind` to `to`. */
  async mail(kind: string, to: string, n = 1): Promise<MailFile> {
    await vi.waitFor(() => expect(this.mails(kind, to).length).toBeGreaterThanOrEqual(n), {
      timeout: 5000,
    })
    return this.mails(kind, to)[n - 1]!
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await exited
    }
    rmSync(this.dir, { recursive: true, force: true })
  }
}

describe.skipIf(!serverBin)('phase 2 e2e against the baren-server binary', () => {
  const server = new ServerProcess()
  let anon: ApiClient
  const signedIn = (token: string) =>
    createApiClient({ baseUrl: server.baseUrl, getToken: () => token })

  /** The binary predates Phase 2 (e.g. an old `target/` build): skip instead of failing. */
  let stale = false

  beforeAll(async () => {
    await server.start(serverBin!)
    anon = createApiClient({ baseUrl: server.baseUrl })
    const probe = await fetch(`${server.baseUrl}/api/auth/providers`)
    if (probe.status === 404) {
      stale = true
      console.warn(
        `[sync-client e2e-phase2] SKIPPED: ${serverBin} has no Phase 2 endpoints; rebuild it ` +
          '(cargo build -p baren-server) or set BAREN_SERVER_BIN.',
      )
    }
  })

  afterAll(async () => {
    await server.stop()
  })

  it('register → verify → forgot → reset → login, all through mail files', async (ctx) => {
    if (stale) return ctx.skip()
    // File transport is not real delivery.
    await expect(anon.providers()).resolves.toEqual({ email: false })

    const email = 'ceyhun@example.com'
    await anon.auth.register({ name: 'ceyhun cakir', email, password: 'first password' })
    const verification = await server.mail('verification_code', email)
    expect(verification.subject).toBe(`${verification.code} is your Baren verification code`)
    expect(verification.html).toContain('Verify your email')
    const first = await anon.auth.verify(email, verification.code!)
    expect(first.user.email).toBe(email)

    // Unknown addresses resolve exactly like known ones, and get no mail.
    await expect(anon.forgotPassword('nobody@example.com')).resolves.toBeUndefined()
    await expect(anon.forgotPassword(email)).resolves.toBeUndefined()
    const reset = await server.mail('password_reset', email)
    expect(reset.text).toContain(reset.code!)
    expect(server.mails('password_reset', 'nobody@example.com')).toHaveLength(0)

    await expect(
      anon.resetPassword(email, '000000' === reset.code ? '111111' : '000000', 'second password'),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_code',
    })
    const shown = `${reset.code!.slice(0, 3)} ${reset.code!.slice(3)}`
    const second = await anon.resetPassword(email, shown, 'second password')
    expect(second.user.id).toBe(first.user.id)

    // The earlier session was revoked; the old password no longer works.
    await expect(signedIn(first.token).me()).rejects.toMatchObject({ status: 401 })
    await expect(anon.auth.login(email, 'first password')).rejects.toMatchObject({
      code: 'invalid_credentials',
    })
    const third = await anon.auth.login(email, 'second password')
    expect(third.user.id).toBe(first.user.id)

    // Change password: needs the current one, keeps this session, ends the others.
    const api = signedIn(third.token)
    await expect(api.changePassword({ newPassword: 'third password' })).rejects.toMatchObject({
      code: 'current_password_required',
    })
    const wrong = await api
      .changePassword({ currentPassword: 'nope nope', newPassword: 'third password' })
      .catch((e: unknown) => e)
    expect(wrong).toBeInstanceOf(ApiError)
    expect(wrong).toMatchObject({ status: 400, code: 'invalid_credentials' })
    await api.changePassword({ currentPassword: 'second password', newPassword: 'third password' })
    await expect(api.me()).resolves.toMatchObject({ user: { email } })
    await expect(signedIn(second.token).me()).rejects.toMatchObject({ status: 401 })
    await anon.auth.login(email, 'third password')
  })

  it('mails email invites and re-sends them with a fresh link', async (ctx) => {
    if (stale) return ctx.skip()
    const email = 'admin@example.com'
    await anon.auth.register({ name: 'Ada Admin', email, password: 'admin password' })
    const code = (await server.mail('verification_code', email)).code!
    const { token } = await anon.auth.verify(email, code)
    const api = signedIn(token)
    const team = (await api.me()).teams[0]!

    const invite = await api.invites.create(team.id, {
      role: 'editor',
      email: 'guest@example.com',
    })
    const mail = await server.mail('team_invite', 'guest@example.com')
    expect(mail.url).toBe(invite.url)
    expect(mail.subject).toBe(`Ada Admin invited you to ${team.name} on Baren`)
    expect(mail.html).toContain('Join Ada&#39;s Team')

    const resent = await api.resendInvite(invite.id)
    expect(resent.id).toBe(invite.id)
    expect(resent.url).not.toBe(invite.url)
    expect((await server.mail('team_invite', 'guest@example.com', 2)).url).toBe(resent.url)
    await expect(anon.invites.preview(invite.token)).rejects.toMatchObject({ status: 404 })
    await expect(anon.invites.preview(resent.token)).resolves.toMatchObject({ teamName: team.name })
    // One re-send a minute.
    await expect(api.resendInvite(invite.id)).rejects.toMatchObject({ code: 'rate_limited' })

    // A link-only invite has no address to send to.
    const linkOnly = await api.invites.create(team.id, { role: 'viewer' })
    await expect(api.resendInvite(linkOnly.id)).rejects.toMatchObject({
      code: 'invite_has_no_email',
    })
  })

  it('uploads, checks and downloads image assets', async (ctx) => {
    if (stale) return ctx.skip()
    const email = 'images@example.com'
    await anon.auth.register({ name: 'Ima Ges', email, password: 'images password' })
    const { token } = await anon.auth.verify(
      email,
      (await server.mail('verification_code', email)).code!,
    )
    const api = signedIn(token)
    const team = (await api.me()).teams[0]!
    const file = await api.files.create(team.id, { name: 'With image' })

    await expect(api.hasAsset(file.id, PNG_HASH)).resolves.toBe(false)
    await expect(api.downloadAsset(file.id, PNG_HASH)).resolves.toBeNull()
    await expect(api.uploadAsset(file.id, PNG_HASH, PNG, 'image/png')).resolves.toEqual({
      hash: PNG_HASH,
      mime: 'image/png',
      size: PNG.length,
    })
    // Again: a no-op.
    await api.uploadAsset(file.id, PNG_HASH, PNG, 'image/png')
    await expect(api.hasAsset(file.id, PNG_HASH)).resolves.toBe(true)
    const downloaded = await api.downloadAsset(file.id, PNG_HASH)
    expect(downloaded?.mime).toBe('image/png')
    expect([...downloaded!.bytes]).toEqual([...PNG])

    const tampered = PNG.slice()
    tampered[40] = 7
    await expect(api.uploadAsset(file.id, PNG_HASH, tampered, 'image/png')).rejects.toMatchObject({
      status: 400,
      code: 'hash_mismatch',
    })
  })

  it('serves the update feed', async (ctx) => {
    if (stale) return ctx.skip()
    const res = await fetch(`${server.baseUrl}/updates/latest-linux.yml?noCache=1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('version: 0.2.0\n')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const partial = await fetch(`${server.baseUrl}/updates/latest-linux.yml`, {
      headers: { range: 'bytes=0-6' },
    })
    expect(partial.status).toBe(206)
    expect(await partial.text()).toBe('version')
    expect((await fetch(`${server.baseUrl}/updates/missing.yml`)).status).toBe(404)
  })
})
