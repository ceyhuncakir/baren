/**
 * Append-only update log: a sequence of `u32 little-endian length` + payload
 * records. Appends are cheap (no Loro work per update); the log is folded
 * into the snapshot on open or when it grows large. A crash mid-append leaves
 * a truncated tail record, which decoding ignores.
 */
const HEADER_BYTES = 4
export const MAX_RECORD_BYTES = 0xffff_ffff

export function encodeRecord(payload: Uint8Array): Buffer {
  if (payload.byteLength > MAX_RECORD_BYTES) throw new RangeError('update too large')
  const record = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength)
  record.writeUInt32LE(payload.byteLength, 0)
  record.set(payload, HEADER_BYTES)
  return record
}

export interface DecodedLog {
  records: Uint8Array[]
  /** Bytes covered by complete records; anything after is a torn tail. */
  validBytes: number
}

export function decodeRecords(log: Uint8Array): DecodedLog {
  const view = new DataView(log.buffer, log.byteOffset, log.byteLength)
  const records: Uint8Array[] = []
  let offset = 0
  while (offset + HEADER_BYTES <= log.byteLength) {
    const length = view.getUint32(offset, true)
    const end = offset + HEADER_BYTES + length
    if (end > log.byteLength) break
    records.push(log.subarray(offset + HEADER_BYTES, end))
    offset = end
  }
  return { records, validBytes: offset }
}
