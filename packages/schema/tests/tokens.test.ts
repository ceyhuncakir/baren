import { describe, expect, it } from 'vitest'
import { SchemaError, getTokens, isTokenName, setTokens } from '../src/index.ts'
import { docWithPage } from './helpers.ts'

describe('tokens', () => {
  it('upserts, deletes and replaces', () => {
    const { doc } = docWithPage()
    setTokens(doc, {
      '--color-primary': { type: 'color', value: '#141414', description: 'Ink' },
      '--spacing-1': { type: 'spacing', value: '4px' },
    })
    expect(getTokens(doc)).toEqual({
      '--color-primary': { type: 'color', value: '#141414', description: 'Ink' },
      '--spacing-1': { type: 'spacing', value: '4px' },
    })
    setTokens(doc, { '--color-primary': { type: 'color', value: '#000' }, '--spacing-1': null })
    expect(getTokens(doc)).toEqual({ '--color-primary': { type: 'color', value: '#000' } })
    setTokens(doc, { '--radius-sm': { type: 'radius', value: 4 } }, { replace: true })
    expect(getTokens(doc)).toEqual({ '--radius-sm': { type: 'radius', value: 4 } })
  })

  it('validates names and values', () => {
    const { doc } = docWithPage()
    expect(isTokenName('--color-primary')).toBe(true)
    expect(isTokenName('color')).toBe(false)
    expect(() => setTokens(doc, { color: { type: 'color', value: '#000' } })).toThrow(SchemaError)
    expect(() =>
      setTokens(doc, { '--x': { type: 'color', value: {} as unknown as string } }),
    ).toThrow(SchemaError)
  })
})
