/** Standard (padded) base64 of bytes. Works in browsers, Electron and Node ≥ 16. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000 // keep String.fromCharCode's argument list small
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
