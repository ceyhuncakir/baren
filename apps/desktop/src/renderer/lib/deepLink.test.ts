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

  it('parses file links, with the layer when it is valid', () => {
    const id = '01a0fefe-0b75-71ce-b315-db36b3935047'
    const file = { kind: 'file', fileId: id, pageId: null }
    expect(parseDeepLink(`baren://file/${id}`)).toEqual({ ...file, node: null })
    expect(parseDeepLink(`baren://file/${id}?node=47%401076`)).toEqual({
      ...file,
      node: '47@1076',
    })
    expect(parseDeepLink(`baren://file/${id}?node=%3Cb%3E`)).toEqual({ ...file, node: null })
  })

  it('parses the page of MCP file links (local id, page id raw or encoded)', () => {
    expect(parseDeepLink('baren://file/f-acme/2@9651120170868898917')).toEqual({
      kind: 'file',
      fileId: 'f-acme',
      pageId: '2@9651120170868898917',
      node: null,
    })
    expect(parseDeepLink('baren://file/f-acme/1%402?node=5%402')).toEqual({
      kind: 'file',
      fileId: 'f-acme',
      pageId: '1@2',
      node: '5@2',
    })
  })

  it('rejects anything else', () => {
    expect(parseDeepLink('https://baren.dev/i/x')).toBeNull()
    expect(parseDeepLink('baren://invite/')).toBeNull()
    expect(parseDeepLink('baren://invite/a%2Fb')).toBeNull()
    expect(parseDeepLink('baren://invite/%E0%A4%A')).toBeNull()
    expect(parseDeepLink('baren://settings/x')).toBeNull()
    expect(parseDeepLink('baren://auth/kq7-4xm')).toBeNull()
    expect(parseDeepLink('baren://file/')).toBeNull()
    expect(parseDeepLink('baren://file/f-acme/1@2/x')).toBeNull()
    expect(parseDeepLink('baren://file/f-acme/%3Cb%3E')).toBeNull()
    expect(parseDeepLink('baren://invite/tok/1@2')).toBeNull()
  })
})
