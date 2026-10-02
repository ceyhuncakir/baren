/**
 * Image fills and image layers ↔ inspector controls (artboard 24). Pure, unit-tested.
 *
 * Image fill on a frame/rect (ARCHITECTURE.md, "Images"):
 *   backgroundImage: url("baren-asset://<hash>")
 *   backgroundSize:  cover (Fill) | contain (Fit) | "<w>px <h>px" (Crop / Tile)
 *   backgroundRepeat: no-repeat, or repeat (Tile); backgroundPosition: center (or left top)
 *
 * Fill opacity below 100% wraps the URL in `-webkit-cross-fade(<image>, <transparent>, p)`:
 * plain CSS that Chromium (the canvas, Electron) and Safari render as the image at
 * opacity 1 − p, that keeps the `url(baren-asset://…)` token where asset sync and the
 * exporters find it, and needs no extra element or style key.
 */
import { assetCssUrl, assetRefsInValue, type StylePatch, type Styles } from '@baren/schema'
import { HIDDEN_PREFIX } from './effects'
import { toPx } from './styles'

export type ImageFillMode = 'fill' | 'fit' | 'crop' | 'tile'

export const IMAGE_FILL_MODES: readonly { value: ImageFillMode; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' },
  { value: 'crop', label: 'Crop' },
  { value: 'tile', label: 'Tile' },
]

/** A 1×1 transparent GIF: the "to" image of the opacity cross-fade. */
export const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

export interface Size {
  width: number
  height: number
}

export interface ImageFill {
  /** Asset hash, or null for a URL the app did not store (pasted CSS). */
  assetId: string | null
  mode: ImageFillMode
  /** 0–1. */
  opacity: number
  hidden: boolean
}

const CROSS_FADE_RE =
  /^-webkit-cross-fade\(\s*(url\((?:"[^"]*"|'[^']*'|[^)]*)\))\s*,\s*url\((?:"[^"]*"|'[^']*'|[^)]*)\)\s*,\s*(-?\d*\.?\d+)(%?)\s*\)$/i

/** Opacity (0–1) encoded in an image fill value: 1 unless it is our cross-fade. */
export function imageOpacityOf(value: string): number {
  const m = CROSS_FADE_RE.exec(value.trim())
  if (!m) return 1
  const n = Number(m[2])
  const p = m[3] === '%' ? n / 100 : n
  return Number.isFinite(p) ? Math.min(1, Math.max(0, 1 - p)) : 1
}

const round = (n: number, step: number) => Math.round(n / step) * step

/** The `backgroundImage` value for an asset at `opacity` (0–1). */
export function imageFillValue(assetId: string, opacity = 1): string {
  const url = assetCssUrl(assetId)
  if (opacity >= 1) return url
  const p = round((1 - Math.max(0, opacity)) * 100, 0.1)
  return `-webkit-cross-fade(${url}, url("${TRANSPARENT_PIXEL}"), ${Number(p.toFixed(1))}%)`
}

/** Fill / Fit / Crop / Tile from the background styles. */
export function imageModeOf(styles: Styles): ImageFillMode {
  const repeat = String(styles['backgroundRepeat'] ?? '').trim()
  if (repeat === 'repeat' || repeat === 'repeat-x' || repeat === 'repeat-y' || repeat === 'round')
    return 'tile'
  const size = String(styles['backgroundSize'] ?? '').trim()
  if (size === 'cover') return 'fill'
  if (size === 'contain') return 'fit'
  return 'crop'
}

/** The node's image fill (visible or hidden), or null when its fill is not an image. */
export function readImageFill(styles: Styles): ImageFill | null {
  for (const [key, hidden] of [
    ['backgroundImage', false],
    [`${HIDDEN_PREFIX}backgroundImage`, true],
  ] as const) {
    const v = styles[key]
    if (typeof v !== 'string' || !/url\(/i.test(v)) continue
    return {
      assetId: assetRefsInValue(v)[0] ?? null,
      mode: imageModeOf(styles),
      opacity: imageOpacityOf(v),
      hidden,
    }
  }
  return null
}

/** `size` scaled to cover `box` (CSS background-size: cover), in whole px. */
export function coverSize(size: Size, box: Size): Size {
  const s = Math.max(box.width / size.width, box.height / size.height)
  return { width: Math.round(size.width * s), height: Math.round(size.height * s) }
}

/** Background size/position/repeat for a mode (`natural`/`box` size Crop and Tile). */
export function imageModePatch(
  mode: ImageFillMode,
  natural: Size | null,
  box: Size | null,
): StylePatch {
  switch (mode) {
    case 'fill':
      return {
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }
    case 'fit':
      return {
        backgroundSize: 'contain',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }
    case 'crop': {
      const s = natural && box ? coverSize(natural, box) : null
      return {
        backgroundSize: s ? `${s.width}px ${s.height}px` : 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }
    }
    case 'tile':
      return {
        backgroundSize: natural ? `${natural.width}px ${natural.height}px` : 'auto',
        backgroundPosition: 'left top',
        backgroundRepeat: 'repeat',
      }
  }
}

/** Set (or replace) the image fill, keeping hidden state and opacity; default mode Fill. */
export function setImageFillPatch(
  styles: Styles,
  assetId: string,
  natural: Size | null = null,
  box: Size | null = null,
): StylePatch {
  const current = readImageFill(styles)
  const value = imageFillValue(assetId, current?.opacity ?? 1)
  const mode = current?.mode ?? 'fill'
  const patch: StylePatch = {
    backgroundColor: null,
    background: null,
    [`${HIDDEN_PREFIX}backgroundColor`]: null,
    ...imageModePatch(mode, natural, box),
  }
  if (current?.hidden) {
    patch['backgroundImage'] = null
    patch[`${HIDDEN_PREFIX}backgroundImage`] = value
  } else {
    patch['backgroundImage'] = value
    patch[`${HIDDEN_PREFIX}backgroundImage`] = null
  }
  return patch
}

/** Change the opacity (0–1) of the node's image fill. */
export function imageOpacityPatch(styles: Styles, opacity: number): StylePatch | null {
  const fill = readImageFill(styles)
  if (!fill?.assetId) return null
  const key = fill.hidden ? `${HIDDEN_PREFIX}backgroundImage` : 'backgroundImage'
  return { [key]: imageFillValue(fill.assetId, opacity) }
}

// ---------------------------------------------------------------------------
// Image layers
// ---------------------------------------------------------------------------

export type ObjectFitMode = 'cover' | 'contain' | 'fill' | 'none'

export const OBJECT_FIT_MODES: readonly { value: ObjectFitMode; label: string }[] = [
  { value: 'cover', label: 'Fill' },
  { value: 'contain', label: 'Fit' },
  { value: 'fill', label: 'Stretch' },
  { value: 'none', label: 'Original' },
]

/** object-fit of an image layer (CSS default: fill). */
export function objectFitOf(styles: Styles): ObjectFitMode {
  const v = styles['objectFit']
  return v === 'cover' || v === 'contain' || v === 'none' || v === 'fill' ? v : 'fill'
}

/** Width/height for "reset to natural size" (px, keeps other keys untouched). */
export function naturalSizePatch(natural: Size): StylePatch {
  return { width: Math.round(natural.width), height: Math.round(natural.height) }
}

/** The box size of a node from its styles when both are numeric px. */
export function styleBox(styles: Styles): Size | null {
  const w = toPx(styles['width'])
  const h = toPx(styles['height'])
  return w !== null && h !== null ? { width: w, height: h } : null
}
