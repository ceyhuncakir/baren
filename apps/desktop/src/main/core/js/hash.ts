import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** Content hash for assets: blake3, lowercase hex (same as the Rust core). */
export function blake3Hex(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes))
}
