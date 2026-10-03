/**
 * Who is editing, and with whom the file is shared. Uses the REST client from
 * `@baren/sync-client/api` (no Loro) with the session token from the bridge. In the
 * browser design fixture the data of artboards 04/08 is returned instead (no server).
 */
import {
  createApiClient,
  isApiError,
  type ApiClient,
  type Member,
  type Role,
  type Team,
} from '@baren/sync-client/api'
import { docAssetRefs, exportSnapshot, getDocName } from '@baren/schema'
import { bridge } from '../../lib/bridge'
import { autoShareTeam, filesToShare, shareOnce } from '../../state/autoShare'
import { useFiles } from '../../state/files'
import { useSession } from '../../state/session'
import { SERVER_URL, SITE_URL, type FixtureMode } from '../lib/env'
import type { EditorSession, FileMeta } from '../session/context'
import type { Identity } from '../session/store'
import { assetApiOf } from './assetSync'

let client: ApiClient | null = null

export function api(): ApiClient {
  client ??= createApiClient({ baseUrl: SERVER_URL, getToken: () => bridge.auth.getToken() })
  return client
}

export const FIXTURE_IDENTITY: Identity = {
  userId: 'u-ceyhun',
  name: 'ceyhun cakir',
  email: 'ceyhun@example.com',
}

export async function loadIdentity(
  fixture: FixtureMode,
): Promise<{ identity: Identity; teams: Team[] } | null> {
  if (fixture.enabled) return { identity: FIXTURE_IDENTITY, teams: [FIXTURE_TEAM] }
  const token = await bridge.auth.getToken().catch(() => null)
  if (!token) return null
  try {
    const me = await api().me()
    return {
      identity: { userId: me.user.id, name: me.user.name, email: me.user.email },
      teams: me.teams,
    }
  } catch (error) {
    if (isApiError(error)) return null
    throw error
  }
}

// ---------------------------------------------------------------------------
// Share popover model (artboard 08)
// ---------------------------------------------------------------------------

export type ShareRole = 'owner' | 'edit' | 'view'

export interface SharePerson {
  id: string
  name: string
  email: string
  role: ShareRole
  isSelf: boolean
  color: string | undefined
}

export interface ShareModel {
  team: Pick<Team, 'id' | 'name' | 'memberCount' | 'fileAccess' | 'role'> | null
  people: SharePerson[]
  /** "Anyone with the link" access. */
  linkAccess: 'view' | 'edit' | 'none'
  /** Whether the current user may invite (editors and admins). */
  canInvite: boolean
  /** Remote file id when the file lives on the server. */
  remoteId: string | null
}

export const FIXTURE_TEAM: Team = {
  id: 't-ceyhun',
  name: "ceyhun's Team",
  role: 'admin',
  fileAccess: 'link',
  memberCount: 3,
  createdAt: 0,
}

const FIXTURE_SHARE: ShareModel = {
  team: FIXTURE_TEAM,
  people: [
    {
      id: 'u-ceyhun',
      name: 'ceyhun cakir',
      email: 'ceyhun@example.com',
      role: 'owner',
      isSelf: true,
      color: undefined,
    },
    {
      id: 'u-defne',
      name: 'Defne Aydın',
      email: 'defne@example.com',
      role: 'edit',
      isSelf: false,
      color: '#1A1A1A',
    },
  ],
  linkAccess: 'view',
  canInvite: true,
  remoteId: null,
}

function roleOf(role: Role, isSelf: boolean): ShareRole {
  if (role === 'admin' && isSelf) return 'owner'
  return role === 'viewer' ? 'view' : role === 'admin' ? 'owner' : 'edit'
}

export async function loadShareModel(
  fixture: FixtureMode,
  file: FileMeta | null,
  identity: Identity | null,
  teams: readonly Team[],
): Promise<ShareModel> {
  if (fixture.enabled) return structuredClone(FIXTURE_SHARE)
  const team = teams.find((t) => t.id === file?.teamId) ?? teams[0] ?? null
  const self: SharePerson | null = identity
    ? {
        id: identity.userId ?? 'me',
        name: identity.name,
        email: identity.email ?? '',
        role: 'owner',
        isSelf: true,
        color: undefined,
      }
    : null
  if (!team || !identity) {
    return {
      team: null,
      people: self ? [self] : [],
      linkAccess: 'none',
      canInvite: false,
      remoteId: file?.remoteId ?? null,
    }
  }
  let members: Member[] = []
  try {
    members = await api().teams.members(team.id)
  } catch {
    members = []
  }
  const people: SharePerson[] = []
  if (self) people.push({ ...self, role: roleOf(team.role, true) })
  for (const m of members) {
    if (m.userId === identity.userId) continue
    people.push({
      id: m.userId,
      name: m.name,
      email: m.email,
      role: roleOf(m.role, false),
      isSelf: false,
      color: undefined,
    })
  }
  return {
    team,
    people: people.slice(0, 2),
    linkAccess: team.fileAccess === 'link' ? 'view' : 'none',
    canInvite: team.role !== 'viewer',
    remoteId: file?.remoteId ?? null,
  }
}

const sharing = new WeakMap<EditorSession, Promise<string>>()

/**
 * Put a local file into a team so its members can open it and edit it live: upload the full
 * snapshot (same Loro history, so later sync only exchanges new ops), link the local file to
 * the new server file, and let `useCollaboration` connect (it follows `remoteId`).
 * Resolves to the server file id; a file that is already shared resolves immediately.
 */
export function shareToTeam(session: EditorSession, teamId: string): Promise<string> {
  const current = session.store.getState().remoteId
  if (current) return Promise.resolve(current)
  if (session.fixture.enabled) return Promise.resolve('fixture-remote')
  let pending = sharing.get(session)
  if (!pending) {
    pending = (async () => {
      // Home may be uploading the same file in the background (autoShare.ts): one upload.
      const shared = await shareOnce(session.fileId, async () => {
        const name = getDocName(session.doc) || session.file?.name || 'Untitled'
        const remote = await api().files.create(teamId, {
          name,
          snapshot: exportSnapshot(session.doc),
        })
        await bridge.files.setRemote(session.fileId, teamId, remote.id)
        return { teamId, remoteId: remote.id }
      })
      const { remoteId } = shared
      if (session.file) session.file = { ...session.file, teamId: shared.teamId, remoteId }
      // Upload the images the file already uses right away (members may open it next).
      const assetApi = assetApiOf(api())
      if (assetApi)
        void session.assets.attach({ fileId: remoteId, api: assetApi }, docAssetRefs(session.doc))
      session.store.setState({ remoteId })
      return remoteId
    })().finally(() => sharing.delete(session))
    sharing.set(session, pending)
  }
  return pending
}

/**
 * A file opened while signed in goes into the current team (autoShare.ts), unless it is the
 * Scratchpad or archived, or the user may only view that team. Sharing sets `remoteId`, so
 * `useCollaboration` connects right after.
 */
export async function autoShareOnOpen(
  session: EditorSession,
  teams: readonly Team[],
): Promise<void> {
  const team = autoShareTeam(teams, useSession.getState().currentTeamId)
  if (!team) return
  const files = await bridge.files.list()
  if (!filesToShare(files, useFiles.getState().scratchpadId).some((f) => f.id === session.fileId))
    return
  await shareToTeam(session, team.id)
}

/** Invite by email into the file's team; returns the shareable invite URL. */
export async function invite(
  fixture: FixtureMode,
  teamId: string,
  email: string,
  role: 'edit' | 'view',
): Promise<string> {
  if (fixture.enabled) return `${SERVER_URL}/i/fixture-invite`
  const res = await api().invites.create(teamId, {
    role: role === 'view' ? 'viewer' : 'editor',
    email,
  })
  return res.url
}

export async function setLinkAccess(fixture: FixtureMode, teamId: string, access: 'view' | 'none') {
  if (fixture.enabled) return
  await api().teams.update(teamId, { fileAccess: access === 'view' ? 'link' : 'members' })
}

/** Link to the file (or a node in it) for "Copy link" / "Link to selection". */
export function fileLink(fileId: string, remoteId: string | null, nodeId?: string): string {
  const base = `${SITE_URL}/file/${encodeURIComponent(remoteId ?? fileId)}`
  return nodeId ? `${base}?node=${encodeURIComponent(nodeId)}` : base
}
