/**
 * Members and pending invites per team (artboard 02). Loaded from the server when a team
 * screen mounts; mutations update the cache first and reload on failure.
 */
import type { CreateInviteResponse, Invite, Member, Role } from '@baren/sync-client/api'
import { create } from 'zustand'
import { api, errorMessage } from '../lib/api'

export interface TeamData {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  members: Member[]
  invites: Invite[]
}

export interface TeamState {
  byTeam: Record<string, TeamData>
  load(teamId: string): Promise<void>
  setRole(teamId: string, userId: string, role: Role): Promise<void>
  removeMember(teamId: string, userId: string): Promise<void>
  createInvite(teamId: string, req: { role: Role; email?: string }): Promise<CreateInviteResponse>
  revokeInvite(teamId: string, inviteId: string): Promise<void>
  /**
   * Email invites: the server mails the invite again with a rotated link (the old one stops
   * working). Link-only invites have nobody to mail: a fresh link replaces the old invite.
   */
  resendInvite(teamId: string, invite: Invite): Promise<CreateInviteResponse>
}

const EMPTY: TeamData = { status: 'loading', error: null, members: [], invites: [] }

export const useTeamData = create<TeamState>()((set, get) => {
  const update = (teamId: string, change: Partial<TeamData>) =>
    set({
      byTeam: { ...get().byTeam, [teamId]: { ...(get().byTeam[teamId] ?? EMPTY), ...change } },
    })

  const guarded = async <T>(teamId: string, op: () => Promise<T>): Promise<T> => {
    try {
      return await op()
    } catch (error) {
      void get().load(teamId)
      throw error
    }
  }

  return {
    byTeam: {},

    async load(teamId) {
      if (!get().byTeam[teamId]) update(teamId, EMPTY)
      try {
        const [members, invites] = await Promise.all([
          api.teams.members(teamId),
          api.invites.list(teamId).catch(() => [] as Invite[]),
        ])
        update(teamId, { status: 'ready', error: null, members, invites })
      } catch (error) {
        update(teamId, { status: 'error', error: errorMessage(error) })
      }
    },

    async setRole(teamId, userId, role) {
      const data = get().byTeam[teamId]
      if (data)
        update(teamId, {
          members: data.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
        })
      await guarded(teamId, () => api.teams.updateMember(teamId, userId, role))
    },

    async removeMember(teamId, userId) {
      const data = get().byTeam[teamId]
      if (data) update(teamId, { members: data.members.filter((m) => m.userId !== userId) })
      await guarded(teamId, () => api.teams.removeMember(teamId, userId))
    },

    async createInvite(teamId, req) {
      const created = await api.invites.create(teamId, req)
      void get().load(teamId)
      return created
    },

    async revokeInvite(teamId, inviteId) {
      const data = get().byTeam[teamId]
      if (data) update(teamId, { invites: data.invites.filter((i) => i.id !== inviteId) })
      await guarded(teamId, () => api.invites.revoke(inviteId))
    },

    async resendInvite(teamId, invite) {
      if (invite.email) {
        const created = await guarded(teamId, () => api.resendInvite(invite.id))
        void get().load(teamId)
        return created
      }
      const created = await api.invites.create(teamId, { role: invite.role })
      await api.invites.revoke(invite.id).catch(() => undefined)
      void get().load(teamId)
      return created
    },
  }
})

export function useTeam(teamId: string | null): TeamData | null {
  return useTeamData((s) => (teamId ? (s.byTeam[teamId] ?? null) : null))
}
