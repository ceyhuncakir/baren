/**
 * BAREN_SMOKE controller: decides when a hidden smoke run is finished.
 *
 * Done as soon as the renderer dispatches `baren:ready`. Renderers that do
 * not (yet) dispatch it are given `readyGraceMs` after their first paint, then
 * the run completes with reason `first-paint`. Hidden windows never present a
 * frame, so the renderer's first-contentful-paint entry may not arrive there;
 * main's `ready-to-show` (first frame rendered) and `load` count as well.
 * Failures and the overall timeout exit non-zero.
 */
const PAINT_MILESTONES: ReadonlySet<string> = new Set([
  'firstContentfulPaint',
  'readyToShow',
  'load',
])

export type SmokeFinishReason = 'app-ready' | 'first-paint' | 'timeout' | 'renderer-failed'

export interface SmokeOutcome {
  ok: boolean
  reason: SmokeFinishReason
  error?: string
  rendererErrors: string[]
}

export type TimerFn = (fn: () => void, ms: number) => () => void

export interface SmokeRunOptions {
  timeoutMs: number
  readyGraceMs: number
  setTimer: TimerFn
  onFinish: (outcome: SmokeOutcome) => void
}

const MAX_RENDERER_ERRORS = 20

export class SmokeRun {
  private finished = false
  private cancelTimeout: (() => void) | null = null
  private cancelGrace: (() => void) | null = null
  private readonly rendererErrors: string[] = []

  constructor(private readonly options: SmokeRunOptions) {}

  start(): void {
    this.cancelTimeout = this.options.setTimer(
      () => this.finish({ ok: false, reason: 'timeout', error: 'renderer never became ready' }),
      this.options.timeoutMs,
    )
  }

  /** A main- or renderer-side startup milestone was recorded. */
  milestone(name: string): void {
    if (this.finished) return
    if (name === 'appReady') {
      this.finish({ ok: true, reason: 'app-ready' })
      return
    }
    if (PAINT_MILESTONES.has(name) && this.cancelGrace === null) {
      this.cancelGrace = this.options.setTimer(
        () => this.finish({ ok: true, reason: 'first-paint' }),
        this.options.readyGraceMs,
      )
    }
  }

  /** Console error from the renderer: reported, but does not fail the run on its own. */
  rendererError(message: string): void {
    if (this.rendererErrors.length < MAX_RENDERER_ERRORS) this.rendererErrors.push(message)
  }

  /** The renderer could not load or crashed. */
  fail(error: string): void {
    this.finish({ ok: false, reason: 'renderer-failed', error })
  }

  get isFinished(): boolean {
    return this.finished
  }

  private finish(outcome: Omit<SmokeOutcome, 'rendererErrors'>): void {
    if (this.finished) return
    this.finished = true
    this.cancelTimeout?.()
    this.cancelGrace?.()
    this.options.onFinish({ ...outcome, rendererErrors: [...this.rendererErrors] })
  }
}

/** Time from process start to "usable": app-ready if signalled, else first paint, else load. */
export function coldStartMs(timings: Readonly<Record<string, number>>): number | null {
  return (
    timings['rendererAppReady'] ??
    timings['rendererFirstContentfulPaint'] ??
    timings['readyToShow'] ??
    timings['rendererLoad'] ??
    null
  )
}
