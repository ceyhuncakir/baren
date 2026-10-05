/**
 * Who is signed in, their teams and the current team. The token itself lives in the bridge
 * (Electron safeStorage); this store keeps a profile cache in localStorage so a returning
 * user sees Recents immediately while /api/me revalidates in the background.
 */
import type { AuthResponse, Team, User } from '@baren/sync-client/api'
import { create } from 'zustand'
import { api, isNetworkError, isUnauthorized } from '../lib/api'
import { bridge } from '../lib/bridge'
import { readJson, readString, writeJson, writeString } from '../lib/storage'

/**
 * unknown   — startup, token not read yet (nothing below the title bar renders)
 * signedOut — no token: auth screens only
 * signedIn  — token + profile (possibly cached while the server is unreachable)
 * offline   — local-only mode chosen with "Continue offline" (or token but no server/cache)
 */
export type SessionStatus = 'unknown' | 'signedOut' | 'signedIn' | 'offline'

export interface PendingVerification {
  email: string
  /** When the last code was sent (drives "Resend in 0:24"). */
  sentAt: number
  /**
   * The password just typed on Create account or Sign in, sent with the code so the account
   * keeps this user's password (`api.auth.verify`). Memory only: this store is never persisted.
   */
  password?: string
}

export interface SessionState {
  status: SessionStatus
  user: User | null
  teams: Team[]
  currentTeamId: string | null
  /** False while the server cannot be reached (cached profile shown). */
  serverReachable: boolean
  verification: PendingVerification | null
  /** Password reset in progress: where the code went and when (drives "Resend in 0:24"). */
  passwordReset: PendingVerification | null
  /** Email typed on the sign-in screen, carried to "Forgot password?". */
  emailHint: string
  /** Invite token waiting for the user to sign in. */
  pendingInvite: string | null

  bootstrap(): Promise<void>
  refresh(): Promise<void>
  completeSignIn(auth: AuthResponse): Promise<void>
  signOut(): Promise<void>
  continueOffline(): void
  setCurrentTeam(teamId: string): void
  upsertTeam(team: Team): void
  removeTeam(teamId: string): void
  setVerification(verification: PendingVerification | null): void
  setPasswordReset(reset: PendingVerification | null): void
  setEmailHint(email: string): void
  setPendingInvite(token: string | null): void
}

interface SessionCache {
  user: User
  teams: Team[]
}

const CACHE_KEY = 'session'
const OFFLINE_KEY = 'offline'
const TEAM_KEY = 'currentTeam'

function isSessionCache(value: unknown): value is SessionCache {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<SessionCache>
  return (
    typeof v.user === 'object' &&
    v.user !== null &&
    typeof v.user.id === 'string' &&
    typeof v.user.name === 'string' &&
    Array.isArray(v.teams)
  )
}

/** Picks the remembered team if it still exists, else the first one. */
export function pickCurrentTeam(teams: readonly Team[], preferred: string | null): string | null {
  if (preferred && teams.some((t) => t.id === preferred)) return preferred
  return teams[0]?.id ?? null
}

const cached = readJson(CACHE_KEY, isSessionCache)

export const useSession = create<SessionState>()((set, get) => {
  const applyProfile = (user: User, teams: Team[]) => {
    const currentTeamId = pickCurrentTeam(teams, get().currentTeamId ?? readString(TEAM_KEY))
    writeJson(CACHE_KEY, { user, teams } satisfies SessionCache)
    set({ status: 'signedIn', user, teams, currentTeamId, serverReachable: true })
  }

  const clearProfile = () => {
    writeJson(CACHE_KEY, null)
    set({ user: null, teams: [], currentTeamId: null })
  }

  return {
    // A cached profile renders the signed-in shell straight away (cold start < 1 s).
    status: cached ? 'signedIn' : 'unknown',
    user: cached?.user ?? null,
    teams: cached?.teams ?? [],
    currentTeamId: cached ? pickCurrentTeam(cached.teams, readString(TEAM_KEY)) : null,
    serverReachable: true,
    verification: null,
    passwordReset: null,
    emailHint: '',
    pendingInvite: null,

    async bootstrap() {
      const token = await bridge.auth.getToken().catch(() => null)
      if (!token) {
        clearProfile()
        set({ status: readString(OFFLINE_KEY) === '1' ? 'offline' : 'signedOut' })
        return
      }
      await get().refresh()
    },

    async refresh() {
      try {
        const me = await api.me()
        applyProfile(me.user, me.teams)
      } catch (error) {
        if (isUnauthorized(error)) {
          await bridge.auth.setToken(null).catch(() => undefined)
          clearProfile()
          set({ status: 'signedOut' })
        } else if (isNetworkError(error)) {
          // Keep the cached profile; without one, work locally until the server is back.
          set({ serverReachable: false, status: get().user ? 'signedIn' : 'offline' })
        } else {
          set({ serverReachable: true, status: get().user ? 'signedIn' : 'offline' })
        }
      }
    },

    async completeSignIn(auth) {
      await bridge.auth.setToken(auth.token)
      writeString(OFFLINE_KEY, null)
      set({ user: auth.user, verification: null, passwordReset: null })
      try {
        const me = await api.me()
        applyProfile(me.user, me.teams)
      } catch {
        applyProfile(auth.user, [])
      }
    },

    async signOut() {
      await api.auth.logout().catch(() => undefined)
      await bridge.auth.setToken(null).catch(() => undefined)
      writeString(OFFLINE_KEY, null)
      clearProfile()
      set({ status: 'signedOut', serverReachable: true })
    },

    continueOffline() {
      writeString(OFFLINE_KEY, '1')
      set({ status: 'offline' })
    },

    setCurrentTeam(teamId) {
      if (!get().teams.some((t) => t.id === teamId)) return
      writeString(TEAM_KEY, teamId)
      set({ currentTeamId: teamId })
    },

    upsertTeam(team) {
      const teams = get().teams
      const next = teams.some((t) => t.id === team.id)
        ? teams.map((t) => (t.id === team.id ? team : t))
        : [...teams, team]
      const user = get().user
      if (user) writeJson(CACHE_KEY, { user, teams: next } satisfies SessionCache)
      set({ teams: next })
    },

    removeTeam(teamId) {
      const teams = get().teams.filter((t) => t.id !== teamId)
      const user = get().user
      if (user) writeJson(CACHE_KEY, { user, teams } satisfies SessionCache)
      set({ teams, currentTeamId: pickCurrentTeam(teams, get().currentTeamId) })
    },

    setVerification(verification) {
      set({ verification })
    },

    setPasswordReset(passwordReset) {
      set({ passwordReset })
    },

    setEmailHint(emailHint) {
      set({ emailHint })
    },

    setPendingInvite(token) {
      set({ pendingInvite: token })
    },
  }
})

/** The current team object (stable reference while unchanged). */
export function useCurrentTeam(): Team | null {
  return useSession((s) => s.teams.find((t) => t.id === s.currentTeamId) ?? null)
}
