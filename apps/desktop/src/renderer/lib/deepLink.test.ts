import { describe, expect, it } from 'vitest'
import { parseDeepLink } from './deepLink'

describe('deep links', () => {
  it('parses invite links', () => {
    expect(parseDeepLink('baren://invite/Ab_c-123')).toEqual({
      kind: 'invite',
      token: 'Ab_c-123',
    })
    expect(parseDeepLink('baren://invite/tok/')).toEqual({ kind: 'invite', token: 'tok' })
    expect(parseDeepLink('  baren://INVITE/x?utm=1 ')).toEqual({ kind: 'invite', token: 'x' })
  })

  it('rejects anything else', () => {
    expect(parseDeepLink('https://baren.dev/i/x')).toBeNull()
    expect(parseDeepLink('baren://invite/')).toBeNull()
    expect(parseDeepLink('baren://invite/a%2Fb')).toBeNull()
    expect(parseDeepLink('baren://invite/%E0%A4%A')).toBeNull()
    expect(parseDeepLink('baren://settings/x')).toBeNull()
    expect(parseDeepLink('baren://auth/kq7-4xm')).toBeNull()
  })
})
