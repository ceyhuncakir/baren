import { afterEach, describe, expect, it, vi } from 'vitest'

import { backoffDelay, DEFAULT_BACKOFF } from '../src/backoff.ts'
import { bytesToBase64 } from '../src/base64.ts'
import {
  CloseCode,
  MsgType,
  decodeFrame,
  encodeFrame,
  isTerminalClose,
  parseServerText,
} from '../src/protocol.ts'
import { fileSocketUrl } from '../src/socket.ts'
import { throttleLatest } from '../src/throttle.ts'

describe('frames', () => {
  it('round-trips type and payload', () => {
    const frame = encodeFrame(MsgType.SyncRequest, new Uint8Array([9, 8, 7]))
    expect([...frame]).toEqual([0x02, 9, 8, 7])
    const decoded = decodeFrame(frame)
    expect(decoded?.type).toBe(MsgType.SyncRequest)
    expect([...decoded!.payload]).toEqual([9, 8, 7])
    expect(decodeFrame(new Uint8Array([0x03]))?.payload.length).toBe(0)
  })

  it('rejects empty and unknown frames', () => {
    expect(decodeFrame(new Uint8Array())).toBeNull()
    expect(decodeFrame(new Uint8Array([0x7f, 1]))).toBeNull()
  })

  it('classifies close codes', () => {
    expect(isTerminalClose(CloseCode.Unauthorized)).toBe(true)
    expect(isTerminalClose(CloseCode.NotFound)).toBe(true)
    expect(isTerminalClose(CloseCode.TooSlow)).toBe(false)
    expect(isTerminalClose(1006)).toBe(false)
  })
})

describe('parseServerText', () => {
  it('accepts the documented messages', () => {
    expect(parseServerText('{"type":"leave","clientId":"c","userId":"u"}')).toEqual({
      type: 'leave',
      clientId: 'c',
      userId: 'u',
    })
    expect(
      parseServerText(
        '{"type":"presence","clientId":"c","userId":"u","name":"n","color":"#fff","pageId":null,"cursor":null,"selection":[]}',
      )?.type,
    ).toBe('presence')
    expect(parseServerText('{"type":"error","code":"read_only","message":"m"}')?.type).toBe('error')
  })

  it('keeps MCP agents on presence frames and drops malformed entries', () => {
    const base =
      '"type":"presence","clientId":"c","userId":"u","name":"n","color":"#fff","pageId":null,"cursor":null,"selection":[]'
    const frame = parseServerText(
      `{${base},"agents":[{"id":"k3v9q2m1x8z0","name":"Claude Code","working":["1@2"]},{"id":3},{"id":"x","name":"y","working":[1]}]}`,
    )
    expect(frame).toMatchObject({
      type: 'presence',
      agents: [{ id: 'k3v9q2m1x8z0', name: 'Claude Code', working: ['1@2'] }],
    })
    expect((frame as { agents: unknown[] }).agents).toHaveLength(1)
    expect(parseServerText(`{${base},"agents":"nope"}`)).toMatchObject({ agents: [] })
    // Old servers: no field at all.
    expect(parseServerText(`{${base}}`)).not.toHaveProperty('agents')
  })

  it('ignores junk', () => {
    for (const text of [
      '',
      'nope',
      '[]',
      '{"type":"other"}',
      '{"type":"presence","clientId":"c"}',
      'null',
    ]) {
      expect(parseServerText(text)).toBeNull()
    }
  })
})

describe('backoffDelay', () => {
  it('grows exponentially up to the cap', () => {
    const noJitter = () => 0
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, DEFAULT_BACKOFF, noJitter))).toEqual([
      250, 500, 1000, 2000,
    ])
    expect(backoffDelay(30, DEFAULT_BACKOFF, noJitter)).toBe(30_000)
  })

  it('applies jitter within bounds', () => {
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 1)).toBe(500)
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(3)
      expect(d).toBeGreaterThanOrEqual(1000)
      expect(d).toBeLessThanOrEqual(2000)
    }
  })
})

describe('throttleLatest', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends leading and trailing values only', () => {
    vi.useFakeTimers()
    const sent: number[] = []
    const t = throttleLatest((v: number) => sent.push(v), 100)
    t.push(1)
    t.push(2)
    t.push(3)
    expect(sent).toEqual([1])
    vi.advanceTimersByTime(100)
    expect(sent).toEqual([1, 3])
    vi.advanceTimersByTime(500)
    expect(sent).toEqual([1, 3])
    t.push(4)
    expect(sent).toEqual([1, 3, 4])
  })

  it('flushes and cancels', () => {
    vi.useFakeTimers()
    const sent: number[] = []
    const t = throttleLatest((v: number) => sent.push(v), 100)
    t.push(1)
    t.push(2)
    t.flush()
    expect(sent).toEqual([1, 2])
    t.push(3)
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual([1, 2])
  })
})

describe('helpers', () => {
  it('builds socket URLs', () => {
    expect(fileSocketUrl('http://127.0.0.1:8787', 'a b', 't+/=')).toBe(
      'ws://127.0.0.1:8787/ws/files/a%20b?token=t%2B%2F%3D',
    )
    expect(fileSocketUrl('https://example.com/sync/', 'f', 't')).toBe(
      'wss://example.com/sync/ws/files/f?token=t',
    )
  })

  it('encodes base64 in chunks', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('')
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=')
    const big = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'))
  })
})
