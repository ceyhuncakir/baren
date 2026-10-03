import { describe, expect, it } from 'vitest'
import { knownRole, rolePending, type RoleState } from './role'

const base: RoleState = {
  self: null,
  teams: [
    { id: 't-edit', role: 'editor' },
    { id: 't-view', role: 'viewer' },
  ],
  teamId: 't-edit',
  accountLoaded: true,
  syncStatus: 'local',
}

describe('the role agent writes see in a shared file', () => {
  it("knows the user's team role before the live room says anything", () => {
    expect(knownRole(base)).toBe('editor')
    expect(knownRole({ ...base, teamId: 't-view' })).toBe('viewer')
  })

  it("prefers the live room's role", () => {
    expect(knownRole({ ...base, self: { role: 'viewer' } })).toBe('viewer')
    expect(knownRole({ ...base, teamId: 't-view', self: { role: 'admin' } })).toBe('admin')
  })

  it('is unknown for a file outside the user’s teams until the room answers', () => {
    expect(knownRole({ ...base, teamId: 'elsewhere' })).toBeNull()
    expect(knownRole({ ...base, teamId: null, teams: [] })).toBeNull()
  })

  it('is pending only while the account loads or the room connects', () => {
    expect(rolePending({ ...base, accountLoaded: false })).toBe(true)
    expect(rolePending({ ...base, syncStatus: 'connecting' })).toBe(true)
    expect(rolePending({ ...base, syncStatus: 'syncing' })).toBe(true)
    // Offline, signed out, refused or synced: nothing more is coming, so writes do not wait.
    for (const syncStatus of ['local', 'offline', 'synced', 'unauthorized', 'closed'] as const)
      expect(rolePending({ ...base, syncStatus })).toBe(false)
  })
})
