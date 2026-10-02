/**
 * The system clipboard behind `bridge.clipboard` (docs/phase3/contract.md §7.5).
 *
 * `write` puts ONE clipboard item on the system clipboard with every representation the
 * renderer gave (plain text, HTML, the baren payload as the Chromium web custom format
 * `web application/x-baren-clipboard+json`, a PNG), committed atomically by Electron 44's
 * main-process `clipboard.write([new ClipboardItem(…)])`. `read` collects the representations
 * the editor's paste understands from every item on the clipboard.
 *
 * Electron is injected (`ClipboardLike`, `makeItem`) so the module is unit-tested in Node.
 */
import type { ClipboardRead, ClipboardWrite } from '../../renderer/types/bridge'

/** The custom format name, identical in the renderer (`CLIPBOARD_MIME` in @baren/schema). */
export const BAREN_CLIPBOARD_FORMAT = 'web application/x-baren-clipboard+json'

const MiB = 1024 * 1024

/** Upper bounds per representation (contract §7.5). */
export const CLIPBOARD_LIMITS = {
  text: 16 * MiB,
  html: 16 * MiB,
  baren: 48 * MiB,
  png: 64 * MiB,
} as const

/** Raster image types read from the clipboard (one image per item, first match wins). */
export const RASTER_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const

/** The slice of Electron's `ClipboardItem` this module uses. */
export interface ClipboardItemLike {
  readonly types: readonly string[]
  getType(type: string): Promise<unknown>
}

/** The slice of Electron's main-process `clipboard` this module uses. */
export interface ClipboardLike {
  write(items: ClipboardItemLike[]): Promise<void>
  read(): Promise<ClipboardItemLike[]>
}

export type ClipboardItemFactory = (record: Record<string, string | Blob>) => ClipboardItemLike

export interface ClipboardService {
  write(content: ClipboardWrite): Promise<void>
  read(): Promise<ClipboardRead>
}

/** Blob (or string) → text. Electron resolves most types to a Blob; tolerate strings. */
async function asText(value: unknown): Promise<string | null> {
  if (typeof value === 'string') return value
  if (value instanceof Blob) return value.text()
  return null
}

async function asBytes(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

/** The record of one clipboard item for `content` (absent fields are left out). */
export function clipboardRecord(content: ClipboardWrite): Record<string, string | Blob> {
  const record: Record<string, string | Blob> = {}
  if (content.text !== undefined) record['text/plain'] = content.text
  if (content.html !== undefined) record['text/html'] = content.html
  if (content.baren !== undefined) {
    // Typed with the format's own MIME type, as Chromium requires for web custom formats
    // (a renderer writing the same format would be refused with any other blob type).
    record[BAREN_CLIPBOARD_FORMAT] = new Blob([content.baren], {
      type: BAREN_CLIPBOARD_FORMAT.slice('web '.length),
    })
  }
  if (content.png !== undefined) {
    record['image/png'] = new Blob([new Uint8Array(content.png)], { type: 'image/png' })
  }
  return record
}

export function createClipboardService(
  clipboard: ClipboardLike,
  makeItem: ClipboardItemFactory,
): ClipboardService {
  return {
    async write(content) {
      const record = clipboardRecord(content)
      if (Object.keys(record).length === 0) throw new Error('Nothing to copy')
      await clipboard.write([makeItem(record)])
    },

    async read() {
      const out: ClipboardRead = { text: null, html: null, baren: null, svg: null, images: [] }
      const items = await clipboard.read()
      for (const item of items) {
        const types = item.types
        const get = async (type: string): Promise<unknown> => {
          try {
            return await item.getType(type)
          } catch {
            return null
          }
        }
        if (out.baren === null && types.includes(BAREN_CLIPBOARD_FORMAT)) {
          out.baren = await asText(await get(BAREN_CLIPBOARD_FORMAT))
        }
        if (out.text === null && types.includes('text/plain')) {
          out.text = await asText(await get('text/plain'))
        }
        if (out.html === null && types.includes('text/html')) {
          out.html = await asText(await get('text/html'))
        }
        if (out.svg === null && types.includes('image/svg+xml')) {
          out.svg = await asText(await get('image/svg+xml'))
        }
        const raster = RASTER_IMAGE_TYPES.find((t) => types.includes(t))
        if (raster) {
          const bytes = await asBytes(await get(raster))
          if (bytes && bytes.byteLength > 0) out.images.push({ mime: raster, bytes })
        }
      }
      return out
    },
  }
}
