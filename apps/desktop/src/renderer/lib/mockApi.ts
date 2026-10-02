/**
 * In-memory stand-in for the Baren server, seeded with the design fixture. Used in the
 * browser with `?fixture=design` so every screen renders without a server. Behaviour mirrors
 * the real endpoints closely enough for the UI flows (errors use the server's codes).
 */
import {
  ApiError,
  type ApiClient,
  type AssetInfo,
  type AuthResponse,
  type CreateInviteResponse,
  type Invite,
  type Member,
  type RemoteFile,
  type Role,
  type Team,
  type User,
} from '@baren/sync-client/api'
import {
  DESIGN_SIGNUP,
  DESIGN_TEAM_ID,
  DESIGN_USER,
  designInvites,
  designMembers,
  designTeams,
} from '../fixtures/design'
import { FIXTURE_TOKEN } from './fixture'

interface TeamRecord {
  team: Team
  members: Member[]
  invites: Array<Invite & { token: string }>
  files: RemoteFile[]
}

export interface MockApiOptions {
  now?: () => number
  /** Origin used for invite and device URLs. */
  serverUrl?: string
  /** What `providers()` reports (default: real email delivery, as designed). */
  emailDelivery?: boolean
}

/** Image types the server accepts for assets (it sniffs the bytes; the mock trusts `mime`). */
const ASSET_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
const MAX_ASSET_BYTES = 20 * 1024 * 1024

/** The server ignores spaces and dashes in codes ("482 719" as the emails show them). */
const normalizeCode = (code: string) => code.replace(/[\s-]/g, '')

const isEmail = (email: string) => /^\S+@\S+\.\S+$/.test(email)

let seq = 0
const nextId = (prefix: string) => `${prefix}-${(++seq).toString(36)}-${Date.now().toString(36)}`

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message)
}

export function createMockApi(options: MockApiOptions = {}): ApiClient {
  const now = options.now ?? Date.now
  const server = (options.serverUrl ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const t0 = now()
  let user: User = { ...DESIGN_USER, createdAt: t0 - 400 * 86_400_000 }
  let signedIn = true
  /** Unknown until the user sets one in this session (the fixture account accepts any). */
  let password: string | null = null
  const pendingSignups = new Map<string, { name: string; password: string }>()
  /** Addresses that asked for a reset code (any 6 digits are accepted, like `verify`). */
  const pendingResets = new Set<string>()
  const assets = new Map<string, { bytes: Uint8Array; mime: string }>()
  const assetKey = (fileId: string, hash: string) => `${fileId}/${hash.toLowerCase()}`

  const teams = new Map<string, TeamRecord>()
  for (const team of designTeams(t0)) {
    const isMain = team.id === DESIGN_TEAM_ID
    teams.set(team.id, {
      team,
      members: isMain
        ? designMembers(t0)
        : [
            {
              userId: user.id,
              name: user.name,
              email: user.email,
              role: team.role,
              joinedAt: team.createdAt,
              lastSeenAt: t0,
              online: true,
            },
          ],
      invites: isMain ? designInvites(t0).map((i) => ({ ...i, token: `tok-${i.id}` })) : [],
      files: [],
    })
  }

  const requireAuth = () => {
    if (!signedIn) fail(401, 'unauthorized', 'Sign in first.')
  }
  const getTeam = (teamId: string): TeamRecord => {
    requireAuth()
    const rec = teams.get(teamId)
    if (!rec) fail(404, 'team_not_found', 'Team not found.')
    return rec
  }
  const myRole = (rec: TeamRecord): Role =>
    rec.members.find((m) => m.userId === user.id)?.role ?? fail(403, 'forbidden', 'Not a member.')
  const requireAdmin = (rec: TeamRecord) => {
    if (myRole(rec) !== 'admin') fail(403, 'forbidden', 'Only admins can do that.')
  }
  const teamView = (rec: TeamRecord): Team => ({
    ...rec.team,
    role: myRole(rec),
    memberCount: rec.members.length,
  })
  const session = (): AuthResponse => {
    signedIn = true
    return { token: FIXTURE_TOKEN, user: { ...user } }
  }
  const findInvite = (token: string) => {
    for (const rec of teams.values()) {
      const invite = rec.invites.find((i) => i.token === token)
      if (invite) return { rec, invite }
    }
    return fail(404, 'invite_not_found', 'This invite link is not valid.')
  }

  const api: ApiClient = {
    auth: {
      async register(req) {
        if (!isEmail(req.email)) fail(400, 'invalid_email', 'Enter a valid email.')
        if (req.password.length < 8) fail(400, 'weak_password', 'Use at least 8 characters.')
        pendingSignups.set(req.email.toLowerCase(), { name: req.name, password: req.password })
        return { userId: nextId('u'), needsVerification: true }
      },
      async verify(email, code) {
        if (!/^\d{6}$/.test(code)) fail(400, 'invalid_code', 'That code is not right.')
        const signup = pendingSignups.get(email.toLowerCase())
        user = {
          id: nextId('u'),
          name: signup?.name ?? DESIGN_SIGNUP.name,
          email,
          createdAt: now(),
        }
        return session()
      },
      async resendCode() {
        return { ok: true }
      },
      async login(email, pass) {
        if (!email.includes('@')) fail(401, 'invalid_credentials', 'Wrong email or password.')
        if (password !== null && pass !== password)
          fail(401, 'invalid_credentials', 'Wrong email or password.')
        return session()
      },
      async logout() {
        signedIn = false
        return { ok: true }
      },
    },
    async me() {
      requireAuth()
      return { user: { ...user }, teams: [...teams.values()].map(teamView) }
    },
    teams: {
      async list() {
        requireAuth()
        return [...teams.values()].map(teamView)
      },
      async create(name) {
        requireAuth()
        const team: Team = {
          id: nextId('t'),
          name,
          role: 'admin',
          fileAccess: 'members',
          memberCount: 1,
          createdAt: now(),
        }
        const member: Member = {
          userId: user.id,
          name: user.name,
          email: user.email,
          role: 'admin',
          joinedAt: now(),
          lastSeenAt: now(),
          online: true,
        }
        teams.set(team.id, { team, members: [member], invites: [], files: [] })
        return team
      },
      async update(teamId, patch) {
        const rec = getTeam(teamId)
        requireAdmin(rec)
        if (patch.name !== undefined) {
          const name = patch.name.trim()
          if (!name) fail(400, 'invalid_name', 'Team name cannot be empty.')
          rec.team = { ...rec.team, name }
        }
        if (patch.fileAccess !== undefined) rec.team = { ...rec.team, fileAccess: patch.fileAccess }
        return teamView(rec)
      },
      async remove(teamId) {
        requireAdmin(getTeam(teamId))
        teams.delete(teamId)
        return { ok: true }
      },
      async members(teamId) {
        return getTeam(teamId).members.map((m) => ({ ...m }))
      },
      async updateMember(teamId, userId, role) {
        const rec = getTeam(teamId)
        requireAdmin(rec)
        const member = rec.members.find((m) => m.userId === userId)
        if (!member) fail(404, 'member_not_found', 'Member not found.')
        const admins = rec.members.filter((m) => m.role === 'admin')
        if (member.role === 'admin' && role !== 'admin' && admins.length === 1)
          fail(409, 'last_admin', 'A team needs at least one admin.')
        member.role = role
        return { ok: true }
      },
      async removeMember(teamId, userId) {
        const rec = getTeam(teamId)
        if (userId !== user.id) requireAdmin(rec)
        const member = rec.members.find((m) => m.userId === userId)
        if (!member) fail(404, 'member_not_found', 'Member not found.')
        if (member.role === 'admin' && rec.members.filter((m) => m.role === 'admin').length === 1)
          fail(409, 'last_admin', 'A team needs at least one admin.')
        rec.members = rec.members.filter((m) => m.userId !== userId)
        if (userId === user.id) teams.delete(teamId)
        return { ok: true }
      },
    },
    invites: {
      async create(teamId, req) {
        const rec = getTeam(teamId)
        if (myRole(rec) === 'viewer') fail(403, 'forbidden', 'Viewers cannot invite.')
        const token = nextId('tok').replace(/[^A-Za-z0-9_-]/g, '')
        const invite: Invite & { token: string } = {
          id: nextId('inv'),
          role: req.role,
          email: req.email ?? null,
          maxUses: req.maxUses ?? null,
          uses: 0,
          expiresAt: now() + (req.expiresInDays ?? 14) * 86_400_000,
          createdAt: now(),
          invitedBy: user.id,
          token,
        }
        rec.invites.push(invite)
        return {
          id: invite.id,
          token,
          url: `${server}/i/${token}`,
          role: invite.role,
          maxUses: invite.maxUses,
          expiresAt: invite.expiresAt,
          email: invite.email,
        }
      },
      async list(teamId) {
        return getTeam(teamId).invites.map(({ token: _token, ...invite }) => invite)
      },
      async preview(token) {
        const { rec, invite } = findInvite(token)
        const inviter = rec.members.find((m) => m.userId === invite.invitedBy)
        return {
          teamId: rec.team.id,
          teamName: rec.team.name,
          inviterName: inviter?.name ?? null,
          role: invite.role,
          memberCount: rec.members.length,
          expiresAt: invite.expiresAt,
        }
      },
      async accept(token) {
        requireAuth()
        const { rec, invite } = findInvite(token)
        const already = rec.members.some((m) => m.userId === user.id)
        if (!already) {
          rec.members.push({
            userId: user.id,
            name: user.name,
            email: user.email,
            role: invite.role,
            joinedAt: now(),
            lastSeenAt: now(),
            online: true,
          })
          invite.uses += 1
        }
        return { team: teamView(rec), alreadyMember: already }
      },
      async revoke(inviteId) {
        requireAuth()
        for (const rec of teams.values()) {
          const before = rec.invites.length
          rec.invites = rec.invites.filter((i) => i.id !== inviteId)
          if (rec.invites.length !== before) return { ok: true }
        }
        return fail(404, 'invite_not_found', 'Invite not found.')
      },
    },
    files: {
      async list(teamId) {
        return [...getTeam(teamId).files]
      },
      async create(teamId, req) {
        const rec = getTeam(teamId)
        const file: RemoteFile = {
          id: nextId('rf'),
          teamId,
          name: req.name,
          archived: false,
          createdAt: now(),
          updatedAt: now(),
          createdBy: user.id,
        }
        rec.files.push(file)
        return file
      },
      async update(fileId, patch) {
        for (const rec of teams.values()) {
          const file = rec.files.find((f) => f.id === fileId)
          if (file) {
            Object.assign(file, patch, { updatedAt: now() })
            return { ...file }
          }
        }
        return fail(404, 'file_not_found', 'File not found.')
      },
      async remove(fileId) {
        for (const rec of teams.values()) rec.files = rec.files.filter((f) => f.id !== fileId)
        return { ok: true }
      },
      async snapshot() {
        return fail(404, 'file_not_found', 'No snapshot in fixture mode.')
      },
    },

    async providers() {
      return { email: options.emailDelivery ?? true }
    },
    async forgotPassword(email) {
      if (!isEmail(email.trim())) fail(400, 'invalid_email', 'Enter a valid email address.')
      pendingResets.add(email.trim().toLowerCase())
    },
    async resetPassword(email, code, next) {
      const key = email.trim().toLowerCase()
      if (!pendingResets.has(key) && key !== user.email.toLowerCase())
        fail(400, 'invalid_code', 'That code is not right.')
      if (!/^\d{6}$/.test(normalizeCode(code))) fail(400, 'invalid_code', 'That code is not right.')
      if (next.length < 8) fail(400, 'weak_password', 'Use at least 8 characters.')
      pendingResets.delete(key)
      password = next
      if (key !== user.email.toLowerCase()) user = { ...user, email: email.trim() }
      return session()
    },
    async changePassword(req) {
      requireAuth()
      if (!req.currentPassword)
        fail(400, 'current_password_required', 'Enter your current password.')
      if (password !== null && req.currentPassword !== password)
        fail(400, 'invalid_credentials', 'Your current password is not right.')
      if (req.newPassword.length < 8) fail(400, 'weak_password', 'Use at least 8 characters.')
      password = req.newPassword
    },
    async resendInvite(inviteId): Promise<CreateInviteResponse> {
      requireAuth()
      for (const rec of teams.values()) {
        const invite = rec.invites.find((i) => i.id === inviteId)
        if (!invite) continue
        if (!invite.email) fail(400, 'invite_has_no_email', 'This invite has no email address.')
        // Like the server: only token hashes are stored, so a resend rotates the link.
        invite.token = nextId('tok').replace(/[^A-Za-z0-9_-]/g, '')
        return {
          id: invite.id,
          token: invite.token,
          url: `${server}/i/${invite.token}`,
          role: invite.role,
          maxUses: invite.maxUses,
          expiresAt: invite.expiresAt,
          email: invite.email,
        }
      }
      return fail(404, 'not_found', 'Invite not found.')
    },
    async uploadAsset(fileId, hash, bytes, mime): Promise<AssetInfo> {
      requireAuth()
      if (!/^[0-9a-f]{64}$/i.test(hash)) fail(400, 'invalid_hash', 'Not an asset hash.')
      if (bytes.byteLength > MAX_ASSET_BYTES) fail(413, 'asset_too_large', 'Images up to 20 MB.')
      if (!ASSET_MIMES.has(mime)) fail(415, 'unsupported_media_type', 'Unsupported image type.')
      assets.set(assetKey(fileId, hash), { bytes: new Uint8Array(bytes), mime })
      return { hash: hash.toLowerCase(), mime, size: bytes.byteLength }
    },
    async downloadAsset(fileId, hash) {
      requireAuth()
      const asset = assets.get(assetKey(fileId, hash))
      return asset ? { bytes: new Uint8Array(asset.bytes), mime: asset.mime } : null
    },
    async hasAsset(fileId, hash) {
      requireAuth()
      return assets.has(assetKey(fileId, hash))
    },
  }
  return api
}
