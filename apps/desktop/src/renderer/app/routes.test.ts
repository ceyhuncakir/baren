import { describe, expect, it } from 'vitest'
import { isRememberable, paths, requiresSession, resolveRoute, titleForRoute } from './routes'

describe('routes', () => {
  it('resolves every screen', () => {
    expect(resolveRoute('/')).toEqual({ kind: 'home', view: 'recents' })
    expect(resolveRoute('/recents')).toEqual({ kind: 'home', view: 'recents' })
    expect(resolveRoute('/files/')).toEqual({ kind: 'home', view: 'files' })
    expect(resolveRoute('/archive')).toEqual({ kind: 'home', view: 'archive' })
    expect(resolveRoute('/team/members')).toEqual({ kind: 'team', tab: 'members' })
    expect(resolveRoute('/team/settings')).toEqual({ kind: 'team', tab: 'settings' })
    expect(resolveRoute('/auth/sign-in')).toEqual({ kind: 'auth', step: 'sign-in' })
    expect(resolveRoute('/auth/register')).toEqual({ kind: 'auth', step: 'register' })
    expect(resolveRoute('/auth/verify')).toEqual({ kind: 'auth', step: 'verify' })
    expect(resolveRoute('/auth/forgot')).toEqual({ kind: 'auth', step: 'forgot' })
    expect(resolveRoute(paths.reset)).toEqual({ kind: 'auth', step: 'reset' })
    expect(resolveRoute(paths.file('a b'))).toEqual({ kind: 'file', fileId: 'a b' })
    expect(resolveRoute(paths.invite('tok'))).toEqual({ kind: 'invite', token: 'tok' })
    expect(resolveRoute('/nope')).toEqual({ kind: 'notFound' })
    expect(resolveRoute('/file/%E0%A4%A')).toEqual({ kind: 'notFound' })
  })

  it('titles the window as the artboards do', () => {
    expect(titleForRoute(resolveRoute('/recents'))).toBe('Recents')
    expect(titleForRoute(resolveRoute('/team/members'))).toBe('Team › Members')
    expect(titleForRoute(resolveRoute('/team/settings'))).toBe('Team › Settings')
    expect(titleForRoute(resolveRoute('/auth/sign-in'))).toBe('Sign in')
    expect(titleForRoute(resolveRoute('/auth/register'))).toBe('Create account')
    expect(titleForRoute(resolveRoute('/auth/verify'))).toBe('Verify email')
    expect(titleForRoute(resolveRoute('/auth/forgot'))).toBe('Forgot password')
    expect(titleForRoute(resolveRoute('/auth/reset'))).toBe('Reset password')
    expect(titleForRoute(resolveRoute('/file/x'), 'Baren')).toBe('Baren')
  })

  it('guards and remembers only app screens', () => {
    expect(requiresSession(resolveRoute('/files'))).toBe(true)
    expect(requiresSession(resolveRoute('/auth/sign-in'))).toBe(false)
    expect(requiresSession(resolveRoute('/invite/x'))).toBe(false)
    expect(isRememberable(resolveRoute('/file/x'))).toBe(true)
    expect(isRememberable(resolveRoute('/auth/verify'))).toBe(false)
    expect(isRememberable(resolveRoute('/auth/reset'))).toBe(false)
  })
})
