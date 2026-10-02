/**
 * Normalisation of values crossing the napi boundary. napi-rs maps Rust
 * `Option<T>` to `undefined` or `null`, `i64`/`u64` to number or BigInt, and
 * binary data to `Buffer`; the bridge contract wants `null`, numbers and
 * `Uint8Array`.
 */
import { CoreError, type FileMeta } from './types'

function fail(what: string, detail: string): never {
  throw new CoreError('CORRUPT', `native core returned an invalid ${what}: ${detail}`)
}

function toNumber(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return fail(what, `expected a number, got ${typeof value}`)
}

function toNullableString(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  return fail(what, `expected a string or null, got ${typeof value}`)
}

export function normalizeFileMeta(raw: unknown): FileMeta {
  if (typeof raw !== 'object' || raw === null) return fail('FileMeta', 'not an object')
  const r = raw as Record<string, unknown>
  if (typeof r['id'] !== 'string' || r['id'].length === 0) return fail('FileMeta', 'missing id')
  if (typeof r['name'] !== 'string') return fail('FileMeta', 'missing name')
  return {
    id: r['id'],
    name: r['name'],
    createdAt: toNumber(r['createdAt'], 'FileMeta.createdAt'),
    updatedAt: toNumber(r['updatedAt'], 'FileMeta.updatedAt'),
    archived: r['archived'] === true,
    teamId: toNullableString(r['teamId'], 'FileMeta.teamId'),
    remoteId: toNullableString(r['remoteId'], 'FileMeta.remoteId'),
  }
}

export function normalizeFileList(raw: unknown): FileMeta[] {
  if (!Array.isArray(raw)) return fail('file list', 'not an array')
  return raw.map(normalizeFileMeta)
}

export function toBytes(value: unknown, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return fail(what, `expected bytes, got ${typeof value}`)
}

export function toOptionalBytes(value: unknown, what: string): Uint8Array | null {
  return value === null || value === undefined ? null : toBytes(value, what)
}

export function toResultString(value: unknown, what: string): string {
  if (typeof value === 'string') return value
  return fail(what, `expected a string, got ${typeof value}`)
}

/** Zero-copy Buffer view (napi `Buffer` parameters require a real Buffer). */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
