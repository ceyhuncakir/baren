import type { Rect } from '../types.ts'

/**
 * Agent additions (Phase 4 contract §10.4): a top-level layer an agent adds stays hidden for a
 * moment while a placeholder in the agent colour marks where it lands, then fades in as the
 * placeholder fades out. The document is already updated; only the presentation is staged.
 */

/** Commit origin of agent tool calls: one commit per call, `agent:<tool>` (Phase 4 contract). */
export const AGENT_ORIGIN_PREFIX = 'agent:'
/** Placeholder alone (content hidden, shimmer crossing it once). */
export const INCOMING_HOLD_MS = 450
/** Placeholder fade-out while the content fades in. */
export const INCOMING_FADE_MS = 400
/** Placeholder fade-in at the start. */
export const INCOMING_APPEAR_MS = 120
/** Give up (show the content) when the layer is still unmeasured after this long. */
export const INCOMING_WAIT_MS = 1500
/** At most this many staged layers; older ones are revealed at once. */
export const INCOMING_MAX = 40

/** What the overlay draws for one staged layer. */
export interface IncomingOverlay {
  /** World bounds of the layer. */
  bounds: Rect
  /** Placeholder opacity, 0–1. */
  alpha: number
  /** Shimmer position across the placeholder, 0–1, or null for none. */
  shimmer: number | null
}

export interface IncomingPhase {
  alpha: number
  shimmer: number | null
  /** The content is still hidden. */
  hidden: boolean
  done: boolean
}

/** The placeholder and content state `t` ms after the layer was first measured. */
export function incomingPhase(t: number, reducedMotion: boolean): IncomingPhase {
  if (reducedMotion) {
    // No hold and no shimmer: the content shows at once, the placeholder only fades.
    if (t >= INCOMING_FADE_MS) return { alpha: 0, shimmer: null, hidden: false, done: true }
    return { alpha: 1 - t / INCOMING_FADE_MS, shimmer: null, hidden: false, done: false }
  }
  if (t < INCOMING_HOLD_MS) {
    return {
      alpha: Math.min(1, t / INCOMING_APPEAR_MS),
      shimmer: t / INCOMING_HOLD_MS,
      hidden: true,
      done: false,
    }
  }
  const f = (t - INCOMING_HOLD_MS) / INCOMING_FADE_MS
  if (f >= 1) return { alpha: 0, shimmer: null, hidden: false, done: true }
  return { alpha: 1 - f, shimmer: null, hidden: false, done: false }
}

let reducedQuery: MediaQueryList | null | undefined

/** Whether the user asked for reduced motion (read live). */
export function prefersReducedMotion(): boolean {
  if (reducedQuery === undefined) {
    reducedQuery =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  }
  return reducedQuery?.matches ?? false
}
