export interface BackoffOptions {
  /** Delay before the first retry, in ms. */
  initialMs: number
  /** Upper bound for any delay, in ms. */
  maxMs: number
  /** Growth per attempt. */
  factor: number
  /** Fraction of the delay that is randomised away (0 = none, 1 = full jitter). */
  jitter: number
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 250,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.5,
}

/**
 * Exponential backoff with jitter: `min(max, initial * factor^attempt)`, reduced by up to
 * `jitter` of itself so reconnecting clients do not stampede the server together.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exp = options.initialMs * options.factor ** Math.max(0, attempt)
  const capped = Math.min(options.maxMs, exp)
  return Math.round(capped * (1 - options.jitter * random()))
}
