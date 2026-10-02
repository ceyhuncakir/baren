/**
 * Hash routes (the app:// scheme has no SPA fallback, so the path lives after '#').
 * `resolveRoute` turns the location into a typed route; everything here is pure.
 */

export type HomeView = 'recents' | 'files' | 'archive'
export type TeamTab = 'members' | 'settings'
export type AuthStep = 'sign-in' | 'register' | 'verify' | 'browser' | 'forgot' | 'reset'

export type AppRoute =
  | { kind: 'home'; view: HomeView }
  | { kind: 'team'; tab: TeamTab }
  | { kind: 'auth'; step: AuthStep }
  | { kind: 'invite'; token: string }
  | { kind: 'file'; fileId: string }
  | { kind: 'notFound' }

export const paths = {
  recents: '/recents',
  files: '/files',
  archive: '/archive',
  teamMembers: '/team/members',
  teamSettings: '/team/settings',
  signIn: '/auth/sign-in',
  register: '/auth/register',
  verify: '/auth/verify',
  browser: '/auth/browser',
  forgot: '/auth/forgot',
  reset: '/auth/reset',
  invite: (token: string) => `/invite/${encodeURIComponent(token)}`,
  file: (fileId: string) => `/file/${encodeURIComponent(fileId)}`,
} as const

export const DEFAULT_PATH = paths.recents

function decodeSegment(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment)
    return value === '' ? null : value
  } catch {
    return null
  }
}

export function resolveRoute(location: string): AppRoute {
  const path = location.split(/[?#]/)[0]?.replace(/\/+$/, '') || '/'
  switch (path) {
    case '/':
    case '/recents':
      return { kind: 'home', view: 'recents' }
    case '/files':
      return { kind: 'home', view: 'files' }
    case '/archive':
      return { kind: 'home', view: 'archive' }
    case '/team':
    case '/team/members':
      return { kind: 'team', tab: 'members' }
    case '/team/settings':
      return { kind: 'team', tab: 'settings' }
    case '/auth':
    case '/auth/sign-in':
      return { kind: 'auth', step: 'sign-in' }
    case '/auth/register':
      return { kind: 'auth', step: 'register' }
    case '/auth/verify':
      return { kind: 'auth', step: 'verify' }
    case '/auth/browser':
      return { kind: 'auth', step: 'browser' }
    case '/auth/forgot':
      return { kind: 'auth', step: 'forgot' }
    case '/auth/reset':
      return { kind: 'auth', step: 'reset' }
  }
  const param = /^\/(invite|file)\/([^/]+)$/.exec(path)
  if (param) {
    const value = decodeSegment(param[2] ?? '')
    if (value !== null)
      return param[1] === 'invite'
        ? { kind: 'invite', token: value }
        : { kind: 'file', fileId: value }
  }
  return { kind: 'notFound' }
}

/** Screens that need a session or local mode (everything except auth and invite landing). */
export function requiresSession(route: AppRoute): boolean {
  return route.kind === 'home' || route.kind === 'team' || route.kind === 'file'
}

const AUTH_TITLES: Record<AuthStep, string> = {
  'sign-in': 'Sign in',
  register: 'Create account',
  verify: 'Verify email',
  browser: 'Sign in',
  forgot: 'Forgot password',
  reset: 'Reset password',
}

/** Window title per route, as written in the artboards' title bars. */
export function titleForRoute(route: AppRoute, fileName?: string | null): string {
  switch (route.kind) {
    case 'home':
      return route.view === 'recents' ? 'Recents' : route.view === 'files' ? 'Files' : 'Archive'
    case 'team':
      return route.tab === 'members' ? 'Team › Members' : 'Team › Settings'
    case 'auth':
      return AUTH_TITLES[route.step]
    case 'invite':
      return 'Join team'
    case 'file':
      return fileName ?? 'Baren'
    case 'notFound':
      return 'Baren'
  }
}

/** Routes worth restoring on the next launch (not auth steps or one-off invite links). */
export function isRememberable(route: AppRoute): boolean {
  return route.kind === 'home' || route.kind === 'team' || route.kind === 'file'
}

/** Where "back" from the editor goes: the last home/team screen. */
export function isHomeLike(route: AppRoute): boolean {
  return route.kind === 'home' || route.kind === 'team'
}
