import { describe, expect, it } from 'vitest'
import { DESIGN_TEAM_ID } from '../fixtures/design'
import { createMockApi } from './mockApi'

describe('fixture API', () => {
  it('serves the design data', async () => {
    const api = createMockApi({ now: () => 1_000_000 })
    const me = await api.me()
    expect(me.user.name).toBe('ceyhun cakir')
    expect(me.teams.map((t) => t.name)).toEqual(["ceyhun's Team", 'Acme Labs'])
    const members = await api.teams.members(DESIGN_TEAM_ID)
    expect(members.map((m) => m.name)).toEqual(['ceyhun cakir', 'Defne Aydın'])
    const invites = await api.invites.list(DESIGN_TEAM_ID)
    expect(invites).toHaveLength(1)
    expect(invites[0]).not.toHaveProperty('token')
  })

  it('creates, previews, accepts and revokes invites', async () => {
    const api = createMockApi({ serverUrl: 'http://srv/' })
    const created = await api.invites.create(DESIGN_TEAM_ID, { role: 'viewer', email: 'a@b.dev' })
    expect(created.url).toBe(`http://srv/i/${created.token}`)
    const preview = await api.invites.preview(created.token)
    expect(preview).toMatchObject({
      teamName: "ceyhun's Team",
      inviterName: 'ceyhun cakir',
      role: 'viewer',
    })
    await expect(api.invites.accept(created.token)).resolves.toMatchObject({ alreadyMember: true })
    await api.invites.revoke(created.id)
    await expect(api.invites.preview(created.token)).rejects.toMatchObject({
      code: 'invite_not_found',
    })
  })

  it('protects the last admin and requires a session', async () => {
    const api = createMockApi()
    await expect(
      api.teams.updateMember(DESIGN_TEAM_ID, 'u-ceyhun', 'editor'),
    ).rejects.toMatchObject({ code: 'last_admin' })
    await api.teams.updateMember(DESIGN_TEAM_ID, 'u-defne-4', 'admin')
    await api.teams.updateMember(DESIGN_TEAM_ID, 'u-ceyhun', 'editor')
    await api.auth.logout()
    await expect(api.me()).rejects.toMatchObject({ status: 401 })
    await api.auth.login('ceyhun@example.com', 'x')
    await expect(api.me()).resolves.toBeTruthy()
  })

  it('renames teams and rejects empty names', async () => {
    const api = createMockApi()
    await expect(api.teams.update(DESIGN_TEAM_ID, { name: '  ' })).rejects.toMatchObject({
      code: 'invalid_name',
    })
    await expect(
      api.teams.update(DESIGN_TEAM_ID, { name: 'Studio', fileAccess: 'members' }),
    ).resolves.toMatchObject({ name: 'Studio', fileAccess: 'members' })
  })

  it('reports email delivery and resets passwords with a 6-digit code', async () => {
    const api = createMockApi()
    await expect(api.providers()).resolves.toEqual({ email: true })
    await expect(createMockApi({ emailDelivery: false }).providers()).resolves.toEqual({
      email: false,
    })
    await expect(api.forgotPassword('nope')).rejects.toMatchObject({ code: 'invalid_email' })
    await api.forgotPassword('ceyhun@example.com')
    await expect(
      api.resetPassword('ceyhun@example.com', '12ab', 'n3w-passw0rd'),
    ).rejects.toMatchObject({ code: 'invalid_code' })
    await expect(api.resetPassword('ceyhun@example.com', '482719', 'short')).rejects.toMatchObject({
      code: 'weak_password',
    })
    // Spaces and dashes are ignored, as on the server.
    const auth = await api.resetPassword('ceyhun@example.com', '482 719', 'n3w-passw0rd')
    expect(auth.user.email).toBe('ceyhun@example.com')
    await expect(api.auth.login('ceyhun@example.com', 'old')).rejects.toMatchObject({
      code: 'invalid_credentials',
    })
    await expect(api.auth.login('ceyhun@example.com', 'n3w-passw0rd')).resolves.toMatchObject({
      user: { email: 'ceyhun@example.com' },
    })
  })

  it('changes the password only with the current one', async () => {
    const api = createMockApi()
    await expect(api.changePassword({ newPassword: 'n3w-passw0rd' })).rejects.toMatchObject({
      code: 'current_password_required',
      status: 400,
    })
    await api.changePassword({ currentPassword: 'anything', newPassword: 'n3w-passw0rd' })
    await expect(
      api.changePassword({ currentPassword: 'wrong', newPassword: 'an0ther-one' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials', status: 400 })
    await api.changePassword({ currentPassword: 'n3w-passw0rd', newPassword: 'an0ther-one' })
    await api.auth.logout()
    await expect(
      api.changePassword({ currentPassword: 'an0ther-one', newPassword: 'x' }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('resends email invites with a rotated link', async () => {
    const api = createMockApi({ serverUrl: 'http://srv' })
    const created = await api.invites.create(DESIGN_TEAM_ID, { role: 'editor', email: 'z@b.dev' })
    const resent = await api.resendInvite(created.id)
    expect(resent).toMatchObject({ id: created.id, email: 'z@b.dev', role: 'editor' })
    expect(resent.token).not.toBe(created.token)
    expect(resent.url).toBe(`http://srv/i/${resent.token}`)
    await expect(api.invites.preview(created.token)).rejects.toMatchObject({
      code: 'invite_not_found',
    })
    await expect(api.invites.preview(resent.token)).resolves.toMatchObject({ role: 'editor' })
    const link = await api.invites.create(DESIGN_TEAM_ID, { role: 'viewer' })
    await expect(api.resendInvite(link.id)).rejects.toMatchObject({ code: 'invite_has_no_email' })
    await expect(api.resendInvite('missing')).rejects.toMatchObject({ status: 404 })
  })

  it('stores team file assets per file', async () => {
    const api = createMockApi()
    const hash = 'a'.repeat(64)
    expect(await api.hasAsset('f1', hash)).toBe(false)
    expect(await api.downloadAsset('f1', hash)).toBeNull()
    await expect(
      api.uploadAsset('f1', 'nothex', Uint8Array.of(1), 'image/png'),
    ).rejects.toMatchObject({ code: 'invalid_hash' })
    await expect(api.uploadAsset('f1', hash, Uint8Array.of(1), 'text/html')).rejects.toMatchObject({
      code: 'unsupported_media_type',
    })
    await expect(api.uploadAsset('f1', hash, Uint8Array.of(1, 2), 'image/png')).resolves.toEqual({
      hash,
      mime: 'image/png',
      size: 2,
    })
    expect(await api.hasAsset('f1', hash.toUpperCase())).toBe(true)
    expect(await api.hasAsset('f2', hash)).toBe(false)
    expect(await api.downloadAsset('f1', hash)).toEqual({
      bytes: Uint8Array.of(1, 2),
      mime: 'image/png',
    })
  })
})
