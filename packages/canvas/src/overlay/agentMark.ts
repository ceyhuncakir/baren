import markUrl from './agentMark.png'

let image: HTMLImageElement | null = null
const waiting = new Set<() => void>()

/**
 * The Baren medallion drawn in agent islands, or null until it has decoded; `onLoad` runs once
 * it has, so the overlay can redraw. Null where there is no DOM `Image` (unit tests).
 */
export function agentMark(onLoad: () => void): HTMLImageElement | null {
  if (typeof Image !== 'function') return null
  if (!image) {
    image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      for (const cb of [...waiting]) cb()
      waiting.clear()
    }
    image.src = markUrl
  }
  if (image.complete && image.naturalWidth > 0) return image
  waiting.add(onLoad)
  return null
}
