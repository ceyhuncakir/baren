/**
 * The user's role in a shared file, as agent writes see it (contract §11.2: a viewer's writes
 * are refused with `read_only`). The live room says it once connected; before that, the user's
 * role in the file's team says the same and is known as soon as the account has loaded, so a
 * write never has to wait for the room just to learn that the user may edit.
 */
import type { SyncStatus, WelcomeMessage } from '@baren/sync-client'
import type { Role, Team } from '@baren/sync-client/api'

export interface RoleState {
  /** The live room's welcome (null until connected). */
  self: Pick<WelcomeMessage, 'role'> | null
  /** The signed-in user's teams (empty until the account has loaded, or signed out). */
  teams: readonly Pick<Team, 'id' | 'role'>[]
  /** The team the file belongs to, when known. */
  teamId: string | null
  accountLoaded: boolean
  syncStatus: SyncStatus | 'local'
}

/** The room's role, else the user's role in the file's team; null when neither is known. */
export function knownRole(s: RoleState): Role | null {
  return s.self?.role ?? s.teams.find((t) => t.id === s.teamId)?.role ?? null
}

/** A role can still arrive: the account is loading or the room is connecting. */
export function rolePending(s: RoleState): boolean {
  return !s.accountLoaded || s.syncStatus === 'connecting' || s.syncStatus === 'syncing'
}
