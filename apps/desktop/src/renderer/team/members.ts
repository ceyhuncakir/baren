/** Pure team-permission and ordering helpers (unit-tested). */
import type { Member, Role } from '@baren/sync-client/api'

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 }

/** Admins change roles and remove people. */
export function canChangeRoles(role: Role): boolean {
  return role === 'admin'
}

/** Editors and admins invite (the server caps the invite role at the inviter's role). */
export function canInvite(role: Role): boolean {
  return role !== 'viewer'
}

/** Roles someone with `role` may hand out, highest first. */
export function roleOptionsFor(role: Role): Array<{ value: Role; label: string }> {
  return (['admin', 'editor', 'viewer'] as const)
    .filter((r) => RANK[r] <= RANK[role])
    .map((r) => ({ value: r, label: ROLE_LABELS[r] }))
}

export function sortMembers(members: readonly Member[], order: 'az' | 'za', filter = ''): Member[] {
  const q = filter.trim().toLocaleLowerCase()
  const list = q
    ? members.filter(
        (m) => m.name.toLocaleLowerCase().includes(q) || m.email.toLocaleLowerCase().includes(q),
      )
    : [...members]
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return order === 'az' ? list : list.reverse()
}
