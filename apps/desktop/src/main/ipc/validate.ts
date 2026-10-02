/**
 * Runtime validation of IPC arguments. The renderer is treated as untrusted
 * input: every invoke/send payload is checked before it reaches the backend.
 */
import type {
  AgentErrorCode,
  AgentHostState,
  AgentResponse,
  FileHeader,
} from '../../renderer/types/bridge'

export class IpcArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcArgumentError'
  }
}

export type Parser<T> = (value: unknown, index: number) => T

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function bad(index: number, expected: string): never {
  throw new IpcArgumentError(`argument ${index} must be ${expected}`)
}

export const MiB = 1024 * 1024

export const is = {
  string(maxLength: number): Parser<string> {
    return (value, i) =>
      typeof value === 'string' && value.length <= maxLength
        ? value
        : bad(i, `a string of at most ${maxLength} characters`)
  },
  /** Identifiers: non-empty, bounded, no control characters. */
  id(value: unknown, i: number): string {
    return typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      !CONTROL_CHARS.test(value)
      ? value
      : bad(i, 'an id')
  },
  nullableId(value: unknown, i: number): string | null {
    return value === null ? null : is.id(value, i)
  },
  boolean(value: unknown, i: number): boolean {
    return typeof value === 'boolean' ? value : bad(i, 'a boolean')
  },
  nullableString(maxLength: number): Parser<string | null> {
    const str = is.string(maxLength)
    return (value, i) => (value === null ? null : str(value, i))
  },
  bytes(maxBytes: number): Parser<Uint8Array> {
    return (value, i) => {
      const bytes =
        value instanceof Uint8Array
          ? value
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : null
      if (bytes === null) return bad(i, 'a Uint8Array')
      if (bytes.byteLength > maxBytes) return bad(i, `at most ${maxBytes} bytes`)
      return bytes
    }
  },
  oneOf<const T extends string>(values: readonly T[]): Parser<T> {
    return (value, i) =>
      typeof value === 'string' && (values as readonly string[]).includes(value)
        ? (value as T)
        : bad(i, `one of ${values.join(', ')}`)
  },
  finiteNumber(value: unknown, i: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : bad(i, 'a finite number')
  },
  /**
   * A clipboard write (`bridge.clipboard.write`): a plain object with at least one of the
   * known representations, each of the right type and size; unknown keys are refused.
   */
  clipboardWrite(limits: {
    text: number
    html: number
    baren: number
    png: number
  }): Parser<ClipboardWriteArg> {
    const text = is.string(limits.text)
    const html = is.string(limits.html)
    const baren = is.string(limits.baren)
    const png = is.bytes(limits.png)
    return (value, i) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return bad(i, 'a clipboard content object')
      }
      const raw = value as Record<string, unknown>
      const out: ClipboardWriteArg = {}
      for (const key of Object.keys(raw)) {
        const v = raw[key]
        if (v === undefined) continue
        switch (key) {
          case 'text':
            out.text = text(v, i)
            break
          case 'html':
            out.html = html(v, i)
            break
          case 'baren':
            out.baren = baren(v, i)
            break
          case 'png':
            out.png = png(v, i)
            break
          default:
            return bad(i, 'a clipboard content object (text, html, baren, png)')
        }
      }
      if (Object.keys(out).length === 0) return bad(i, 'a non-empty clipboard content object')
      return out
    }
  },
}

// ---------------------------------------------------------------------------
// Agent IPC (Phase 4, docs/phase4/contract.md §4.6, §4.14)
// ---------------------------------------------------------------------------

export const AGENT_ERROR_CODES: readonly AgentErrorCode[] = [
  'no_file_open',
  'file_not_found',
  'page_not_found',
  'node_not_found',
  'invalid_target',
  'instance_content',
  'cycle',
  'read_only',
  'token_exists',
  'token_not_found',
  'unsupported',
  'too_large',
  'host_unavailable',
  'timeout',
  'cancelled',
  'invalid_argument',
  'internal',
]

/**
 * Approximate size of a structured-clone payload in bytes, stopping as soon as it exceeds
 * `limit` (returns `Infinity` then). Strings count one byte per UTF-16 unit.
 */
export function approxSize(value: unknown, limit: number): number {
  let total = 0
  const stack: unknown[] = [value]
  let visited = 0
  while (stack.length > 0) {
    const v = stack.pop()
    if (++visited > 5_000_000) return Number.POSITIVE_INFINITY
    if (typeof v === 'string') total += v.length
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined)
      total += 8
    else if (v instanceof Uint8Array) total += v.byteLength
    else if (v instanceof ArrayBuffer) total += v.byteLength
    else if (Array.isArray(v)) {
      total += 8
      for (const item of v) stack.push(item)
    } else if (typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        total += k.length
        stack.push(item)
      }
    }
    if (total > limit) return Number.POSITIVE_INFINITY
  }
  return total
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null
  return value.every((v) => typeof v === 'string' && v.length <= maxLength)
    ? (value as string[])
    : null
}

function fileHeader(value: unknown): FileHeader | null | undefined {
  if (value === null) return null
  if (!isPlainRecord(value)) return undefined
  const file = value['file']
  const hash = value['contentHash']
  if (
    !isPlainRecord(file) ||
    typeof file['id'] !== 'string' ||
    typeof file['name'] !== 'string' ||
    !isPlainRecord(hash) ||
    typeof hash['tokens'] !== 'string'
  ) {
    return undefined
  }
  return {
    file: { id: file['id'].slice(0, 256), name: file['name'].slice(0, 1024) },
    contentHash: { tokens: hash['tokens'].slice(0, 64) },
  }
}

export const agentIs = {
  /** `agent:host` payloads: `{ fileId, state, headless }`, strings ≤ 256. */
  hostState(value: unknown, i: number): AgentHostState {
    if (!isPlainRecord(value)) return bad(i, 'an agent host state')
    const fileId = value['fileId']
    const state = value['state']
    const headless = value['headless']
    if (
      typeof fileId !== 'string' ||
      fileId.length === 0 ||
      fileId.length > 256 ||
      CONTROL_CHARS.test(fileId) ||
      (state !== 'opened' && state !== 'closed') ||
      typeof headless !== 'boolean'
    ) {
      return bad(i, 'an agent host state { fileId, state, headless }')
    }
    return { fileId, state, headless }
  },
  /** `agent:response` payloads, at most `maxBytes` (approximate structured-clone size). */
  response(maxBytes: number): Parser<AgentResponse> {
    return (value, i) => {
      if (!isPlainRecord(value)) return bad(i, 'an agent response')
      const id = value['id']
      if (typeof id !== 'string' || id.length === 0 || id.length > 64)
        return bad(i, 'an agent response id')
      if (approxSize(value, maxBytes) > maxBytes)
        return bad(i, `an agent response of at most ${maxBytes} bytes`)
      if (value['ok'] === true) {
        const header = fileHeader(value['header'] ?? null)
        if (header === undefined) return bad(i, 'an agent response header')
        const touched =
          value['touched'] === undefined ? [] : stringList(value['touched'], 10_000, 256)
        if (touched === null) return bad(i, 'agent response touched ids')
        return { id, ok: true, header, result: value['result'], touched }
      }
      if (value['ok'] === false) {
        const error = value['error']
        if (!isPlainRecord(error) || typeof error['message'] !== 'string') {
          return bad(i, 'an agent response error')
        }
        const code = (AGENT_ERROR_CODES as readonly unknown[]).includes(error['code'])
          ? (error['code'] as AgentErrorCode)
          : 'internal'
        const data = isPlainRecord(error['data']) ? error['data'] : undefined
        return {
          id,
          ok: false,
          error: { code, message: error['message'].slice(0, 4096), ...(data ? { data } : {}) },
        }
      }
      return bad(i, 'an agent response with ok: true | false')
    }
  },
}

/** Mirrors `ClipboardWrite` in renderer/types/bridge.d.ts (kept structural, no DOM types). */
export interface ClipboardWriteArg {
  text?: string
  html?: string
  baren?: string
  png?: Uint8Array
}

type Parsed<P extends readonly Parser<unknown>[]> = {
  -readonly [K in keyof P]: P[K] extends Parser<infer T> ? T : never
}

/** Build a parser for a whole argument list (exact arity). */
export function args<const P extends readonly Parser<unknown>[]>(
  ...parsers: P
): (raw: readonly unknown[]) => Parsed<P> {
  return (raw) => {
    if (raw.length !== parsers.length) {
      throw new IpcArgumentError(`expected ${parsers.length} argument(s), got ${raw.length}`)
    }
    return parsers.map((parse, i) => parse(raw[i], i)) as Parsed<P>
  }
}
