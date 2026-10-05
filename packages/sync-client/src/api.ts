import { bytesToBase64 } from './base64.ts'
import { ApiError } from './errors.ts'
import type {
  AcceptInviteResponse,
  AssetInfo,
  AuthResponse,
  ChangePasswordRequest,
  CreateFileRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  DownloadedAsset,
  Invite,
  InvitePreview,
  MeResponse,
  Member,
  OkResponse,
  ProvidersResponse,
  RegisterRequest,
  RegisterResponse,
  RemoteFile,
  Role,
  Team,
  UpdateFileRequest,
  UpdateTeamRequest,
} from './types.ts'

export type TokenSource = () => string | null | undefined | Promise<string | null | undefined>

export interface ApiClientOptions {
  /** Server base URL, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string
  /** Current session token (from `bridge.auth.getToken()`); omitted/null for anonymous calls. */
  getToken?: TokenSource
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** Typed methods for every REST endpoint in ARCHITECTURE.md "Server API" (+ Phase 2). */
export interface ApiClient {
  auth: {
    register(req: RegisterRequest): Promise<RegisterResponse>
    /**
     * Verify the email with its code. `password` is the one the user registered (or signed in)
     * with: the server sets it, so someone who registered the same address again before it was
     * verified cannot end up with the account.
     */
    verify(email: string, code: string, password?: string): Promise<AuthResponse>
    /** Send a fresh verification code (no-op within 30 s of the last one). */
    resendCode(email: string): Promise<OkResponse>
    login(email: string, password: string): Promise<AuthResponse>
    logout(): Promise<OkResponse>
  }
  me(): Promise<MeResponse>
  teams: {
    list(): Promise<Team[]>
    create(name: string): Promise<Team>
    update(teamId: string, patch: UpdateTeamRequest): Promise<Team>
    remove(teamId: string): Promise<OkResponse>
    members(teamId: string): Promise<Member[]>
    updateMember(teamId: string, userId: string, role: Role): Promise<OkResponse>
    /** Remove a member (admins), or leave the team (your own user id). */
    removeMember(teamId: string, userId: string): Promise<OkResponse>
  }
  invites: {
    create(teamId: string, req: CreateInviteRequest): Promise<CreateInviteResponse>
    list(teamId: string): Promise<Invite[]>
    /** Works signed out (for the invite landing flow). */
    preview(token: string): Promise<InvitePreview>
    accept(token: string): Promise<AcceptInviteResponse>
    revoke(inviteId: string): Promise<OkResponse>
  }
  files: {
    list(teamId: string): Promise<RemoteFile[]>
    create(teamId: string, req: CreateFileRequest): Promise<RemoteFile>
    update(fileId: string, patch: UpdateFileRequest): Promise<RemoteFile>
    remove(fileId: string): Promise<OkResponse>
    /** The current document as a binary Loro snapshot. */
    snapshot(fileId: string): Promise<Uint8Array>
  }

  // Phase 2 (ARCHITECTURE.md "Server additions"). Flat, as named in the contract.

  /** What sign-in help the server offers: `{ email }` = codes are really emailed (SMTP). */
  providers(): Promise<ProvidersResponse>
  /**
   * Ask for a 6-digit password-reset code. Resolves the same way whether or not the account
   * exists (the server answers 204 either way); rejects on an invalid address (400) or
   * rate limiting (429, `rate_limited`).
   */
  forgotPassword(email: string): Promise<void>
  /**
   * Set a new password with the emailed code and sign in. Signs out every other session.
   * Errors: `invalid_code`, `code_expired`, `too_many_attempts`, `weak_password`.
   */
  resetPassword(email: string, code: string, password: string): Promise<AuthResponse>
  /**
   * Change the signed-in user's password; other sessions are signed out, this one stays.
   * Errors: `current_password_required`, `invalid_credentials` (wrong current password,
   * status 400 — not 401), `weak_password`.
   */
  changePassword(req: ChangePasswordRequest): Promise<void>
  /**
   * Email an invite again (admins, or the editor who created it). The link is rotated: use
   * the returned `url`; the previous link stops working.
   */
  resendInvite(inviteId: string): Promise<CreateInviteResponse>
  /**
   * Upload an image for a team file (editors and admins, at most 20 MB). `hash` is the
   * blake3 hex of `bytes` (the core's asset id); the server re-hashes and rejects mismatches.
   * Uploading bytes the file already has is a cheap no-op on the server.
   */
  uploadAsset(fileId: string, hash: string, bytes: Uint8Array, mime: string): Promise<AssetInfo>
  /** Download a file's image; `null` when the file has no asset with that hash. */
  downloadAsset(fileId: string, hash: string): Promise<DownloadedAsset | null>
  /** Whether the server already has this image for the file (`HEAD`). */
  hasAsset(fileId: string, hash: string): Promise<boolean>
}

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface RequestOptions {
  body?: unknown
  /** A binary body sent as is with this content type (instead of JSON). */
  raw?: { bytes: Uint8Array; contentType: string }
  /** Send the session token (default true). */
  auth?: boolean
  binary?: boolean
  /** The response has no body (204). */
  empty?: boolean
}

const seg = encodeURIComponent

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))

  /** Perform a request; network failures become `ApiError(0, 'network_error')`. */
  async function send(method: Method, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (opts.auth !== false && options.getToken) {
      const token = await options.getToken()
      if (token) headers['authorization'] = `Bearer ${token}`
    }
    let body: string | Uint8Array<ArrayBuffer> | undefined
    if (opts.raw) {
      headers['content-type'] = opts.raw.contentType
      body = arrayBufferBacked(opts.raw.bytes)
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    try {
      return await doFetch(`${base}${path}`, { method, headers, body })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ApiError(0, 'network_error', `Could not reach the server: ${message}`)
    }
  }

  async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await send(method, path, opts)
    if (!res.ok) throw await toApiError(res)
    if (opts.empty || res.status === 204) return undefined as T
    if (opts.binary) return new Uint8Array(await res.arrayBuffer()) as T
    return (await res.json()) as T
  }

  const assetPath = (fileId: string, hash: string) =>
    `/api/files/${seg(fileId)}/assets/${seg(hash.toLowerCase())}`

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })

  const client: ApiClient = {
    auth: {
      register: (req) => request('POST', '/api/auth/register', { body: req, auth: false }),
      verify: (email, code, password) =>
        request('POST', '/api/auth/verify', {
          body: password === undefined ? { email, code } : { email, code, password },
          auth: false,
        }),
      resendCode: (email) => request('POST', '/api/auth/resend', { body: { email }, auth: false }),
      login: (email, password) =>
        request('POST', '/api/auth/login', { body: { email, password }, auth: false }),
      logout: () => request('POST', '/api/auth/logout'),
    },
    me: () => request('GET', '/api/me'),
    teams: {
      list: () => request('GET', '/api/teams'),
      create: (name) => request('POST', '/api/teams', { body: { name } }),
      update: (teamId, patch) => request('PATCH', `/api/teams/${seg(teamId)}`, { body: patch }),
      remove: (teamId) => request('DELETE', `/api/teams/${seg(teamId)}`),
      members: (teamId) => request('GET', `/api/teams/${seg(teamId)}/members`),
      updateMember: (teamId, userId, role) =>
        request('PATCH', `/api/teams/${seg(teamId)}/members/${seg(userId)}`, { body: { role } }),
      removeMember: (teamId, userId) =>
        request('DELETE', `/api/teams/${seg(teamId)}/members/${seg(userId)}`),
    },
    invites: {
      create: (teamId, req) => request('POST', `/api/teams/${seg(teamId)}/invites`, { body: req }),
      list: (teamId) => request('GET', `/api/teams/${seg(teamId)}/invites`),
      preview: (token) => request('GET', `/api/invites/${seg(token)}`, { auth: false }),
      accept: (token) => request('POST', `/api/invites/${seg(token)}/accept`),
      revoke: (inviteId) => request('DELETE', `/api/invites/${seg(inviteId)}`),
    },
    files: {
      list: (teamId) => request('GET', `/api/teams/${seg(teamId)}/files`),
      create: (teamId, req) =>
        request('POST', `/api/teams/${seg(teamId)}/files`, {
          body: {
            name: req.name,
            ...(req.snapshot ? { snapshot: bytesToBase64(req.snapshot) } : {}),
          },
        }),
      update: (fileId, patch) => request('PATCH', `/api/files/${seg(fileId)}`, { body: patch }),
      remove: (fileId) => request('DELETE', `/api/files/${seg(fileId)}`),
      snapshot: (fileId) =>
        request<Uint8Array>('GET', `/api/files/${seg(fileId)}/snapshot`, { binary: true }),
    },
    providers: () => request('GET', '/api/auth/providers', { auth: false }),
    forgotPassword: (email) =>
      request('POST', '/api/auth/password/forgot', { body: { email }, auth: false, empty: true }),
    resetPassword: (email, code, password) =>
      request('POST', '/api/auth/password/reset', {
        body: { email, code, password },
        auth: false,
      }),
    changePassword: (req) =>
      request('POST', '/api/auth/password/change', {
        body: {
          newPassword: req.newPassword,
          ...(req.currentPassword !== undefined ? { currentPassword: req.currentPassword } : {}),
        },
        empty: true,
      }),
    resendInvite: (inviteId) => request('POST', `/api/invites/${seg(inviteId)}/resend`),
    uploadAsset: (fileId, hash, bytes, mime) =>
      request('PUT', assetPath(fileId, hash), {
        raw: { bytes, contentType: mime || 'application/octet-stream' },
      }),
    async downloadAsset(fileId, hash) {
      const res = await send('GET', assetPath(fileId, hash))
      if (res.status === 404) return null
      if (!res.ok) throw await toApiError(res)
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        mime: mime || 'application/octet-stream',
      }
    },
    async hasAsset(fileId, hash) {
      const res = await send('HEAD', assetPath(fileId, hash))
      if (res.status === 404) return false
      if (!res.ok) throw await toApiError(res)
      return true
    },
  }
  return client
}

/** `fetch` bodies must be backed by a plain `ArrayBuffer` (not a `SharedArrayBuffer`). */
function arrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes)
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`
  let message = res.statusText || `Request failed with status ${res.status}`
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = (body as { error: unknown }).error
      if (typeof error === 'object' && error !== null) {
        const e = error as { code?: unknown; message?: unknown }
        if (typeof e.code === 'string') code = e.code
        if (typeof e.message === 'string') message = e.message
      }
    }
  } catch {
    // Not JSON (e.g. a proxy error page); keep the generic message.
  }
  return new ApiError(res.status, code, message)
}

function abortError(): ApiError {
  return new ApiError(0, 'aborted', 'The operation was aborted.')
}
