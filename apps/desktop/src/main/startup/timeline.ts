/**
 * Cold-start milestones in milliseconds since the main process started
 * (Node's `performance.timeOrigin`). Renderer milestones arrive as epoch
 * times and are converted onto the same axis.
 */
export class StartupTimeline {
  private readonly marks = new Map<string, number>()

  constructor(
    private readonly now: () => number,
    /** Epoch ms of `now() === 0` (Node's performance.timeOrigin). */
    private readonly timeOrigin: number,
  ) {}

  /** Record a milestone once; later marks with the same name are ignored. */
  mark(name: string, at: number = this.now()): void {
    if (this.marks.has(name)) return
    this.marks.set(name, Math.round(at * 10) / 10)
  }

  /** Record a milestone observed elsewhere at an absolute epoch time. */
  markEpoch(name: string, epochMs: number): void {
    if (!Number.isFinite(epochMs)) return
    this.mark(name, epochMs - this.timeOrigin)
  }

  get(name: string): number | undefined {
    return this.marks.get(name)
  }

  has(name: string): boolean {
    return this.marks.has(name)
  }

  /** Milestones sorted by time. */
  toJSON(): Record<string, number> {
    return Object.fromEntries([...this.marks].sort((a, b) => a[1] - b[1]))
  }
}
