import type { Team } from '@baren/sync-client/api'
import { describe, expect, it } from 'vitest'
import { pickCurrentTeam, useSession } from './session'

const team = (id: string): Team => ({
  id,
  name: id,
  role: 'admin',
  fileAccess: 'members',
  memberCount: 1,
  createdAt: 0,
})

describe('session', () => {
  it('keeps the remembered team while it exists', () => {
    expect(pickCurrentTeam([team('a'), team('b')], 'b')).toBe('b')
    expect(pickCurrentTeam([team('a')], 'gone')).toBe('a')
    expect(pickCurrentTeam([], 'a')).toBeNull()
  })

  it('starts signed out without a token, and can go offline', async () => {
    await useSession.getState().bootstrap()
    expect(useSession.getState().status).toBe('signedOut')
    useSession.getState().continueOffline()
    expect(useSession.getState().status).toBe('offline')
    await useSession.getState().bootstrap()
    expect(useSession.getState().status).toBe('offline')
  })

  it('tracks teams locally', () => {
    const s = useSession.getState()
    s.upsertTeam(team('x'))
    s.upsertTeam(team('y'))
    s.setCurrentTeam('y')
    expect(useSession.getState().currentTeamId).toBe('y')
    s.removeTeam('y')
    expect(useSession.getState().currentTeamId).toBe('x')
  })
})
