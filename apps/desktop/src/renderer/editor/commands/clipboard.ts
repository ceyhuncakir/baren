/**
 * Clipboard plumbing for the editor (contract §7).
 *
 * Copy writes ONE clipboard item through `bridge.clipboard` (Electron main process, or the
 * browser mock): the baren payload v2 as the web custom format, `text/html` from the
 * schema's HTML exporter (small images inlined as data URIs) and `text/plain`. Paste reads
 * the same bridge and picks, in order: the payload, a payload or legacy v1 JSON in plain
 * text, raster images, SVG markup, plain text.
 *
 * Plain strings (CSS, JSX, links) still go through `copyText`; downloads stay here too.
 */
import {
  attachAssetBytes,
  bytesToBase64,
  clipboardText,
  renderHtml,
  type ClipboardPayload,
  type Token,
} from '@baren/schema'
import { getAssetBytes, sniffImageMime } from '../../lib/assets'
import { bridge } from '../../lib/bridge'
import type { ClipboardRead } from '../../types/bridge'

/** Per-image and total budget for data URIs in the copied `text/html` (contract §7.1). */
export const HTML_IMAGE_MAX_BYTES = 2 * 1024 * 1024
export const HTML_IMAGES_TOTAL_BYTES = 8 * 1024 * 1024
/** The whole `text/html` representation is left out above this size. */
export const HTML_MAX_CHARS = 16 * 1024 * 1024

export async function copyText(text: string): Promise<boolean> {
  try {
    await bridge.clipboard.write({ text })
    return true
  } catch {
    // Fall back to the async API (and execCommand) for the browser mock without focus.
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

/** Write rich content: plain text plus optional HTML (pasting into other apps). */
export async function copyRich(text: string, html?: string): Promise<boolean> {
  if (!html) return copyText(text)
  try {
    await bridge.clipboard.write({ text, html })
    return true
  } catch {
    return copyText(text)
  }
}

export async function copyPng(png: Blob): Promise<boolean> {
  try {
    await bridge.clipboard.write({ png: new Uint8Array(await png.arrayBuffer()) })
    return true
  } catch {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      return true
    } catch {
      return false
    }
  }
}

const EMPTY_READ: ClipboardRead = { text: null, html: null, baren: null, svg: null, images: [] }

/** Everything the paste understands on the system clipboard (never throws). */
export async function readClipboard(): Promise<ClipboardRead> {
  try {
    return await bridge.clipboard.read()
  } catch {
    try {
      return { ...EMPTY_READ, text: await navigator.clipboard.readText() }
    } catch {
      return EMPTY_READ
    }
  }
}

/** Asset bytes and their sniffed type for `attachAssetBytes`. */
export async function readAsset(hash: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const bytes = await getAssetBytes(hash)
  if (!bytes) return null
  return { bytes, mime: sniffImageMime(bytes) ?? 'application/octet-stream' }
}

/** `assetUrl` for `renderHtml`: data URIs of embedded assets within the HTML budget. */
export function htmlAssetUrls(payload: ClipboardPayload): (hash: string) => string | null {
  const urls = new Map<string, string>()
  let total = 0
  const entries = Object.entries(payload.assets)
    .filter(([, a]) => a.data !== undefined)
    .sort((a, b) => (a[1].size ?? 0) - (b[1].size ?? 0))
  for (const [hash, asset] of entries) {
    const size = asset.size ?? Math.floor(((asset.data ?? '').length * 3) / 4)
    if (size > HTML_IMAGE_MAX_BYTES || total + size > HTML_IMAGES_TOTAL_BYTES) continue
    total += size
    urls.set(hash, `data:${asset.mime ?? 'application/octet-stream'};base64,${asset.data}`)
  }
  return (hash) => urls.get(hash) ?? null
}

/** The representations of one copy (payload with bytes, html, text). */
export interface CopyContent {
  payload: ClipboardPayload
  json: string
  html: string | undefined
  text: string
}

/**
 * Finish a serialised payload: embed asset bytes (≤ 24 MiB, smallest first), render the HTML
 * of `roots` with small images inlined, and the plain text.
 */
export async function buildCopyContent(
  payload: ClipboardPayload,
  html: (assetUrl: (hash: string) => string | null, tokens: Record<string, Token>) => string,
  /** Plain text when the payload has none (e.g. instances named after their main). */
  fallbackText = '',
): Promise<CopyContent> {
  const full = await attachAssetBytes(payload, readAsset)
  let markup: string | undefined
  try {
    markup = html(htmlAssetUrls(full), full.tokens)
    if (markup.length > HTML_MAX_CHARS) markup = undefined
  } catch {
    markup = undefined
  }
  const text = clipboardText(full)
  return {
    payload: full,
    json: JSON.stringify(full),
    html: markup,
    text: text.trim() === '' ? fallbackText : text,
  }
}

export { renderHtml, bytesToBase64 }

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type }))
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
