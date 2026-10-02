import { describe, expect, it } from 'vitest'
import { IpcArgumentError, args, is } from './validate'

describe('IPC argument validation', () => {
  it('parses well-formed argument lists', () => {
    const parse = args(
      is.id,
      is.boolean,
      is.bytes(4),
      is.nullableString(5),
      is.oneOf(['a', 'b'] as const),
    )
    const bytes = Uint8Array.of(1, 2)
    expect(parse(['f1', true, bytes, null, 'b'])).toEqual(['f1', true, bytes, null, 'b'])
  })

  it('converts ArrayBuffers to Uint8Array', () => {
    const [bytes] = args(is.bytes(8))([new ArrayBuffer(3)])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBe(3)
  })

  it('accepts clipboard writes with known representations only', () => {
    const limits = { text: 4, html: 8, baren: 8, png: 2 }
    const parse = args(is.clipboardWrite(limits))
    const png = Uint8Array.of(1, 2)
    expect(parse([{ text: 'ab', html: '<p>', baren: '{}', png }])).toEqual([
      { text: 'ab', html: '<p>', baren: '{}', png },
    ])
    expect(parse([{ text: 'x', html: undefined }])).toEqual([{ text: 'x' }])
    for (const bad of [
      null,
      'text',
      [],
      {},
      { text: 1 },
      { text: 'abcde' },
      { png: Uint8Array.of(1, 2, 3) },
      { png: [1, 2] },
      { text: 'a', script: 'x' },
    ]) {
      expect(() => parse([bad]), JSON.stringify(bad)).toThrow(IpcArgumentError)
    }
  })

  it.each([
    ['wrong arity', args(is.id), []],
    ['extra argument', args(), ['x']],
    ['empty id', args(is.id), ['']],
    ['id with control chars', args(is.id), ['a\nb']],
    ['long id', args(is.id), ['x'.repeat(300)]],
    ['string too long', args(is.string(3)), ['abcd']],
    ['number for string', args(is.string(3)), [1]],
    ['bytes too large', args(is.bytes(2)), [Uint8Array.of(1, 2, 3)]],
    ['array for bytes', args(is.bytes(2)), [[1, 2]]],
    ['string for boolean', args(is.boolean), ['true']],
    ['unknown enum', args(is.oneOf(['undo'] as const)), ['rm -rf']],
    ['NaN', args(is.finiteNumber), [Number.NaN]],
  ])('rejects %s', (_name, parse, raw) => {
    expect(() => parse(raw)).toThrow(IpcArgumentError)
  })
})
