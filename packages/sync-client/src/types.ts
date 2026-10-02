/**
 * REST DTOs. Mirror of `crates/proto/src/dto.rs` — keep both in sync.
 * JSON is camelCase, timestamps are Unix milliseconds, ids are opaque strings.
 */

export type Role = 'admin' | 'editor' | 'viewer'

/** Who may open a team's files: members only, or any signed-in user with the link (view). */
export type FileAccess = 'members' | 'link'

export interface User {
  id: string
  name: string
  email: string
  createdAt: number
}

export interface AuthResponse {
  token: string
  user: User
}

export interface RegisterRequest {
  name: string
  email: string
  password: string
}

export interface RegisterResponse {
  userId: string
  needsVerification: true
}

/**
 * `GET /api/auth/providers`. Accounts are email + password only (no OAuth); `email` is true
 * when the server really delivers email (SMTP), false when codes only go to its log — use it
 * for copy like "check your email" vs "ask the server admin for your code".
 */
export interface ProvidersResponse {
  email: boolean
}

/** `POST /api/auth/password/reset`. */
export interface ResetPasswordRequest {
  email: string
  /** The 6-digit code from the reset email (spaces and dashes are ignored). */
  code: string
  /** The new password (at least 8 characters). */
  password: string
}

/** `POST /api/auth/password/change` (signed in). */
export interface ChangePasswordRequest {
  /** Required while the account has a password (today: always). */
  currentPassword?: string
  newPassword: string
}

export interface Team {
  id: string
  name: string
  /** The caller's role in this team. */
  role: Role
  fileAccess: FileAccess
  memberCount: number
  createdAt: number
}

export interface MeResponse {
  user: User
  teams: Team[]
}

export interface UpdateTeamRequest {
  name?: string
  fileAccess?: FileAccess
}

export interface Member {
  userId: string
  name: string
  email: string
  role: Role
  joinedAt: number
  lastSeenAt: number | null
  /** Connected to a live room on the server right now. */
  online: boolean
}

export interface CreateInviteRequest {
  role: Role
  maxUses?: number
  /** Defaults to 14 days on the server; 1–365. */
  expiresInDays?: number
  /** Optional invitee email, shown as a pending row in Team → Members. */
  email?: string
}

export interface CreateInviteResponse {
  id: string
  /** Shown once; the server only stores its hash. */
  token: string
  /** `<server>/i/<token>` — share this link. */
  url: string
  role: Role
  maxUses: number | null
  expiresAt: number | null
  email: string | null
}

export interface Invite {
  id: string
  role: Role
  email: string | null
  maxUses: number | null
  uses: number
  expiresAt: number | null
  createdAt: number
  invitedBy: string | null
}

export interface InvitePreview {
  teamId: string
  teamName: string
  inviterName: string | null
  role: Role
  memberCount: number
  expiresAt: number | null
}

export interface AcceptInviteResponse {
  team: Team
  alreadyMember: boolean
}

export interface RemoteFile {
  id: string
  teamId: string
  name: string
  archived: boolean
  createdAt: number
  updatedAt: number
  createdBy: string | null
}

export interface CreateFileRequest {
  name: string
  /** Optional initial Loro snapshot (or update) — sent base64-encoded. */
  snapshot?: Uint8Array
}

export interface UpdateFileRequest {
  name?: string
  archived?: boolean
}

/** An image stored on the server for a team file (`PUT /api/files/:id/assets/:hash`). */
export interface AssetInfo {
  /** blake3 of the bytes, lowercase hex. */
  hash: string
  /** The image type the server detected from the bytes, e.g. `image/png`. */
  mime: string
  size: number
}

export interface DownloadedAsset {
  bytes: Uint8Array
  mime: string
}

export interface OkResponse {
  ok: boolean
}

export interface ErrorBody {
  error: { code: string; message: string }
}
