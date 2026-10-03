import { describe, expect, it } from 'vitest'
import { devMayClaimScheme, findDeepLinkInArgv, parseDeepLink } from './deepLink'

describe('parseDeepLink', () => {
  it('accepts invite links in canonical form', () => {
    expect(parseDeepLink('baren://invite/abc123')).toEqual({
      kind: 'invite',
      value: 'abc123',
      url: 'baren://invite/abc123',
    })
    expect(parseDeepLink('baren://invite/Zx-9_q.~')).toMatchObject({
      kind: 'invite',
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
    expect(parseDeepLink('baren://invite/code1?state=a%20b')?.url).toBe(
      'baren://invite/code1?state=a+b',
    )
  })

  it('accepts file links, keeping the layer', () => {
    const id = '01a0fefe-0b75-71ce-b315-db36b3935047'
    expect(parseDeepLink(`baren://file/${id}`)).toEqual({
      kind: 'file',
      value: id,
      url: `baren://file/${id}`,
    })
    expect(parseDeepLink(`baren://file/${id}?node=47%401076`)?.url).toBe(
      `baren://file/${id}?node=47%401076`,
    )
  })

  it('accepts the page of MCP file links (local ids), encoded or not', () => {
    const id = '0199a3f2-7c41-7e0a-9d11-5b2f3c4d5e6f'
    expect(parseDeepLink(`baren://file/${id}/2@9651120170868898917`)).toEqual({
      kind: 'file',
      value: id,
      page: '2@9651120170868898917',
      url: `baren://file/${id}/2%409651120170868898917`,
    })
    expect(parseDeepLink(`baren://file/${id}/1%402?node=5%402`)?.url).toBe(
      `baren://file/${id}/1%402?node=5%402`,
    )
  })

  it.each([
    ['other scheme', 'https://baren.dev/invite/abc'],
    ['unknown kind', 'baren://admin/abc'],
    ['auth kind (no longer used)', 'baren://auth/abc'],
    ['missing value', 'baren://invite/'],
    ['extra segments', 'baren://invite/abc/def'],
    ['a third file segment', 'baren://file/abc/1@2/x'],
    ['a bad page id', 'baren://file/abc/%3Cscript%3E'],
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
    const argv = ['app', 'baren://invite/first', 'baren://bogus/x', 'baren://invite/second']
    expect(findDeepLinkInArgv(argv)?.url).toBe('baren://invite/second')
  })

  it('returns null without a link (dev argv)', () => {
    expect(findDeepLinkInArgv(['electron', '.', '--inspect'])).toBeNull()
  })
})

describe('devMayClaimScheme', () => {
  it('claims links nobody handles, or another dev run handles', () => {
    expect(devMayClaimScheme('', false)).toBe(true)
    expect(devMayClaimScheme('Electron', false)).toBe(true)
  })

  it('leaves an installed build in charge unless forced', () => {
    expect(devMayClaimScheme('Baren', false)).toBe(false)
    expect(devMayClaimScheme('Baren', true)).toBe(true)
  })
})
