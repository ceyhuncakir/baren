import { describe, expect, it } from 'vitest'
import { IpcArgumentError, MiB, agentIs, approxSize, args } from './validate'

describe('agent IPC validation (contract §4.14)', () => {
  const response = args(agentIs.response(32 * MiB))
  const host = args(agentIs.hostState)

  it('accepts ok and error responses and normalises them', () => {
    expect(
      response([
        {
          id: 'r1',
          ok: true,
          header: { file: { id: 'f', name: 'F' }, contentHash: { tokens: '0011aabb' } },
          result: { a: [1, 2] },
          touched: ['1@2'],
        },
      ]),
    ).toEqual([
      {
        id: 'r1',
        ok: true,
        header: { file: { id: 'f', name: 'F' }, contentHash: { tokens: '0011aabb' } },
        result: { a: [1, 2] },
        touched: ['1@2'],
      },
    ])
    expect(response([{ id: 'r2', ok: true, header: null, result: 'jsx' }])[0]).toMatchObject({
      touched: [],
    })
    expect(
      response([
        { id: 'r3', ok: false, error: { code: 'weird', message: 'x', data: { a: 1 } } },
      ])[0],
    ).toEqual({ id: 'r3', ok: false, error: { code: 'internal', message: 'x', data: { a: 1 } } })
    expect(
      response([{ id: 'r4', ok: false, error: { code: 'timeout', message: 'slow' } }])[0],
    ).toEqual({
      id: 'r4',
      ok: false,
      error: { code: 'timeout', message: 'slow' },
    })
  })

  it('refuses malformed and oversized responses', () => {
    for (const bad of [
      null,
      { ok: true },
      { id: '', ok: true },
      { id: 'r', ok: 'yes' },
      { id: 'r', ok: true, header: { file: {} } },
      { id: 'r', ok: true, header: null, touched: [1] },
      { id: 'r', ok: false, error: { code: 'x' } },
    ]) {
      expect(() => response([bad])).toThrow(IpcArgumentError)
    }
    const small = args(agentIs.response(1024))
    expect(() => small([{ id: 'r', ok: true, header: null, result: 'x'.repeat(2048) }])).toThrow(
      /at most 1024 bytes/,
    )
    expect(() =>
      small([{ id: 'r', ok: true, header: null, result: new Uint8Array(2048) }]),
    ).toThrow()
  })

  it('validates host states', () => {
    expect(host([{ fileId: 'f1', state: 'opened', headless: false }])).toEqual([
      { fileId: 'f1', state: 'opened', headless: false },
    ])
    for (const bad of [
      { fileId: '', state: 'opened', headless: false },
      { fileId: 'x'.repeat(257), state: 'opened', headless: false },
      { fileId: 'f', state: 'open', headless: false },
      { fileId: 'f', state: 'closed' },
      { fileId: 'a\nb', state: 'closed', headless: true },
    ]) {
      expect(() => host([bad])).toThrow(IpcArgumentError)
    }
  })

  it('estimates structured-clone sizes and stops early', () => {
    expect(approxSize({ a: 'xyz', b: [1, 2], c: new Uint8Array(10) }, 1e6)).toBe(
      1 + 3 + 1 + 8 + 8 + 8 + 1 + 10,
    )
    expect(approxSize('x'.repeat(100), 50)).toBe(Number.POSITIVE_INFINITY)
  })
})
