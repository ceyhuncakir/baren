import type { Member } from '@baren/sync-client/api'
import { describe, expect, it } from 'vitest'
import { canChangeRoles, canInvite, roleOptionsFor, sortMembers } from './members'

const m = (name: string, email = `${name.toLowerCase()}@x.dev`): Member => ({
  userId: name,
  name,
  email,
  role: 'editor',
  joinedAt: 0,
  lastSeenAt: null,
  online: false,
})

describe('team members', () => {
  it('sorts by name either way and filters by name or email', () => {
    const list = [m('Defne'), m('ceyhun'), m('Mert')]
    expect(sortMembers(list, 'az').map((x) => x.name)).toEqual(['ceyhun', 'Defne', 'Mert'])
    expect(sortMembers(list, 'za').map((x) => x.name)).toEqual(['Mert', 'Defne', 'ceyhun'])
    expect(sortMembers(list, 'az', 'DEF').map((x) => x.name)).toEqual(['Defne'])
    expect(sortMembers([m('A', 'zed@x.dev')], 'az', 'zed')).toHaveLength(1)
  })

  it('caps the roles you can hand out at your own', () => {
    expect(roleOptionsFor('admin').map((o) => o.value)).toEqual(['admin', 'editor', 'viewer'])
    expect(roleOptionsFor('editor').map((o) => o.value)).toEqual(['editor', 'viewer'])
    expect(canInvite('viewer')).toBe(false)
    expect(canInvite('editor')).toBe(true)
    expect(canChangeRoles('editor')).toBe(false)
  })
})
