import { describe, expect, it } from 'vitest'
import { findDeepLinkInArgv, parseDeepLink } from './deepLink'

describe('parseDeepLink', () => {
  it('accepts invite and auth links in canonical form', () => {
    expect(parseDeepLink('baren://invite/abc123')).toEqual({
      kind: 'invite',
      value: 'abc123',
      url: 'baren://invite/abc123',
    })
    expect(parseDeepLink('baren://auth/Zx-9_q.~')).toMatchObject({
      kind: 'auth',
      value: 'Zx-9_q.~',
    })
  })

  it('normalises case, trailing slashes and surrounding whitespace', () => {
    expect(parseDeepLink('  BAREN://Invite/tok/  ')?.url).toBe('baren://invite/tok')
  })

  it('accepts the authority-less form', () => {
    expect(parseDeepLink('baren:invite/tok')?.url).toBe('baren://invite/tok')
  })

  it('keeps simple query parameters, re-encoded', () => {
    expect(parseDeepLink('baren://auth/code1?state=a%20b')?.url).toBe(
      'baren://auth/code1?state=a+b',
    )
  })

  it.each([
    ['other scheme', 'https://baren.dev/invite/abc'],
    ['unknown kind', 'baren://admin/abc'],
    ['missing value', 'baren://invite/'],
    ['extra segments', 'baren://invite/abc/def'],
    ['traversal', 'baren://invite/..%2F..%2Fetc'],
    ['bad characters', 'baren://invite/<script>'],
    ['credentials', 'baren://user:pw@invite/abc'],
    ['port', 'baren://invite:8080/abc'],
    ['malformed escape', 'baren://invite/%E0%A4%A'],
    ['bad param name', 'baren://auth/abc?a%3Cb=1'],
    ['empty', ''],
    ['too long', `baren://invite/${'a'.repeat(5000)}`],
  ])('rejects %s', (_name, url) => {
    expect(parseDeepLink(url)).toBeNull()
  })

  it('rejects non-strings', () => {
    expect(parseDeepLink(42)).toBeNull()
    expect(parseDeepLink(null)).toBeNull()
  })
})

describe('findDeepLinkInArgv', () => {
  it('finds the link among Chromium switches (Windows/Linux second-instance argv)', () => {
    const argv = ['/opt/baren/baren', '--allow-file-access-from-files', 'baren://invite/tok']
    expect(findDeepLinkInArgv(argv)?.url).toBe('baren://invite/tok')
  })

  it('prefers the last valid link and skips invalid ones', () => {
    const argv = ['app', 'baren://invite/first', 'baren://bogus/x', 'baren://auth/second']
    expect(findDeepLinkInArgv(argv)?.url).toBe('baren://auth/second')
  })

  it('returns null without a link (dev argv)', () => {
    expect(findDeepLinkInArgv(['electron', '.', '--inspect'])).toBeNull()
  })
})
