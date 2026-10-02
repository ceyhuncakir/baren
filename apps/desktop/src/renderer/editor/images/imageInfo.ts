/**
 * Cheap image dimension reads from file headers (PNG, GIF, JPEG incl. EXIF orientation,
 * WebP, AVIF) so inserting an image never decodes it on the main thread. Anything the
 * parser does not understand falls back to an off-thread decode (`createImageBitmap`).
 */

export interface Size {
  width: number
  height: number
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
}
function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
}
function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)
}
function u32be(b: Uint8Array, i: number): number {
  return (
    (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0
  )
}
function ascii(b: Uint8Array, i: number, s: string): boolean {
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false
  return true
}

/** EXIF orientation (1–8) from a JPEG APP1 segment, or 1. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (!ascii(b, start, 'Exif\0\0')) return 1
  const tiff = start + 6
  const le = ascii(b, tiff, 'II')
  const u16 = (i: number) => (le ? u16le(b, i) : u16be(b, i))
  const u32 = (i: number) => (le ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i))
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12
    if (entry + 12 > end) break
    if (u16(entry) === 0x0112) {
      const v = u16(entry + 8)
      return v >= 1 && v <= 8 ? v : 1
    }
  }
  return 1
}

function jpegSize(b: Uint8Array): Size | null {
  let i = 2
  let orientation = 1
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1] ?? 0
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    const len = u16be(b, i + 2)
    if (len < 2) return null
    if (marker === 0xe1) orientation = exifOrientation(b, i + 4, Math.min(b.length, i + 2 + len))
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = u16be(b, i + 5)
      const width = u16be(b, i + 7)
      if (!width || !height) return null
      return orientation >= 5 ? { width: height, height: width } : { width, height }
    }
    i += 2 + len
  }
  return null
}

function webpSize(b: Uint8Array): Size | null {
  if (ascii(b, 12, 'VP8X')) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  if (ascii(b, 12, 'VP8L')) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(b, 12, 'VP8 ')) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  return null
}

/** First `ispe` (image spatial extents) box of an AVIF/HEIF file. */
function avifSize(b: Uint8Array): Size | null {
  const limit = Math.min(b.length - 16, 64 * 1024)
  for (let i = 4; i < limit; i++) {
    if (b[i] === 0x69 && ascii(b, i, 'ispe')) {
      const width = u32be(b, i + 8)
      const height = u32be(b, i + 12)
      return width && height ? { width, height } : null
    }
  }
  return null
}

/** Intrinsic size from the header bytes, or null when the format is not recognised. */
export function imageSizeFromBytes(b: Uint8Array): Size | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG') && ascii(b, 12, 'IHDR')) {
    const width = u32be(b, 16)
    const height = u32be(b, 20)
    return width && height ? { width, height } : null
  }
  if (b.length >= 10 && ascii(b, 0, 'GIF8')) {
    const width = u16le(b, 6)
    const height = u16le(b, 8)
    return width && height ? { width, height } : null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b)
  if (b.length >= 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return webpSize(b)
  if (b.length >= 16 && ascii(b, 4, 'ftyp')) return avifSize(b)
  return null
}

/** Intrinsic size without blocking the main thread: header parse, else an async decode. */
export async function readImageSize(bytes: Uint8Array, blob?: Blob): Promise<Size | null> {
  const parsed = imageSizeFromBytes(bytes)
  if (parsed) return parsed
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(blob ?? new Blob([new Uint8Array(bytes)]))
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size.width > 0 && size.height > 0 ? size : null
  } catch {
    return null
  }
}
