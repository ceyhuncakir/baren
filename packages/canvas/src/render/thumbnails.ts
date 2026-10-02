import { drawThumbnail, type ThumbOp } from './measure.ts'
import type { TopRecord } from './topRecord.ts'

/** Max thumbnail edge in device px. */
const MAX_THUMB_PX = 512

/**
 * LOD thumbnails: measured draw ops are painted into an OffscreenCanvas,
 * encoded to PNG off the critical path and shown as a plain <img> in the
 * stand-in. (Visible <canvas> elements would each become a compositor layer
 * whose resource is re-produced every commit; 100 of them cost ~3.4 ms/frame.)
 */
export class Thumbnails {
  private ready: { rec: TopRecord; url: string }[] = []

  constructor(
    /** Whether `rec` is still the live record for its id (not removed or reloaded). */
    private readonly isCurrent: (rec: TopRecord) => boolean,
    private readonly requestFrame: () => void,
  ) {}

  get hasReady(): boolean {
    return this.ready.length > 0
  }

  /** Paint and start encoding; `scaleCap` is the largest useful canvas px per world px. */
  paint(rec: TopRecord, ops: readonly ThumbOp[], w: number, h: number, scaleCap: number): void {
    if (w <= 0 || h <= 0) return
    const scale = Math.min(scaleCap, MAX_THUMB_PX / Math.max(w, h))
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.ceil(w * scale)),
      Math.max(1, Math.ceil(h * scale)),
    )
    drawThumbnail(canvas, ops, scale)
    const version = rec.contentVersion
    rec.thumbVersion = version
    void canvas.convertToBlob({ type: 'image/png' }).then(
      (blob) => {
        if (!this.isCurrent(rec) || rec.thumbVersion !== version) return
        this.ready.push({ rec, url: URL.createObjectURL(blob) })
        this.requestFrame()
      },
      () => undefined,
    )
  }

  /** Swap in thumbnails whose PNGs finished encoding (write phase). */
  apply(): void {
    for (const { rec, url } of this.ready.splice(0)) {
      if (!this.isCurrent(rec)) {
        URL.revokeObjectURL(url)
        continue
      }
      let img = rec.thumb
      if (!img) {
        img = document.createElement('img')
        img.className = 'ic-thumb'
        img.alt = ''
        img.decoding = 'async'
        img.draggable = false
        rec.standin.appendChild(img)
        rec.thumb = img
      }
      const old = rec.thumbUrl
      rec.thumbUrl = url
      img.src = url
      if (old) URL.revokeObjectURL(old)
    }
  }

  release(rec: TopRecord): void {
    if (rec.thumbUrl) URL.revokeObjectURL(rec.thumbUrl)
    rec.thumbUrl = null
  }

  clear(): void {
    for (const { url } of this.ready.splice(0)) URL.revokeObjectURL(url)
  }
}
