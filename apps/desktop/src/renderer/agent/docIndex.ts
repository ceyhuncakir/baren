/**
 * A plain-object mirror of the document for whole-file reads (get_basic_info's counts and font
 * families, find_nodes over every page), so they walk JS objects instead of crossing into Loro
 * per node (contract §11.7 budgets).
 *
 * Nothing runs before an agent's first request. `warm()` then loads the mirror one artboard
 * subtree at a time in idle time (no long main-thread task in a window the user works in);
 * afterwards it is kept current from the document's change batches (only the nodes a batch
 * names are re-read). A read that needs the mirror before it is complete finishes it on the
 * spot; a mirror that missed a change (its op count differs from the document's) is rebuilt.
 */
import {
  getChildIds,
  getNode,
  toSnapshot,
  toSubtreeSnapshot,
  type DesignNode,
  type NodeChangeBatch,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

export type BatchSubscribe = (listener: (batch: NodeChangeBatch) => void) => () => void

type Idle = (cb: (deadline: { timeRemaining(): number }) => void) => void

const idle: Idle =
  typeof requestIdleCallback === 'function'
    ? (cb) => void requestIdleCallback(cb, { timeout: 1_000 })
    : (cb) =>
        void setTimeout(() => {
          const end = performance.now() + 8
          cb({ timeRemaining: () => end - performance.now() })
        }, 0)

export class DocIndex {
  private nodes: Map<string, DesignNode> | null = null
  private pageIds: string[] = []
  /** Top-level subtrees still to load while warming (null: not warming). */
  private pending: string[] | null = null
  /** The document's op count when the mirror was last brought up to date. */
  private syncedOps = -1
  private off: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly doc: LoroDoc,
    private readonly subscribe: BatchSubscribe,
  ) {}

  /** True while `warm()` is still loading the mirror in idle time. */
  isWarming(): boolean {
    return this.pending !== null
  }

  /** True when reads are served from a complete, current mirror. */
  isReady(): boolean {
    return this.nodes !== null && this.pending === null && this.syncedOps === this.doc.opCount()
  }

  /** Every live node (pages included), current with the document. */
  map(): ReadonlyMap<string, DesignNode> {
    if (this.pending) this.finishWarm()
    if (this.nodes && this.syncedOps === this.doc.opCount()) return this.nodes
    this.build()
    return this.nodes as Map<string, DesignNode>
  }

  pages(): readonly string[] {
    this.map()
    return this.pageIds
  }

  get(id: string): DesignNode | undefined {
    return this.map().get(id)
  }

  /** Load the mirror in idle time, one artboard subtree per slice. */
  warm(): void {
    if (this.disposed || this.pending || this.isReady()) return
    const nodes = new Map<string, DesignNode>()
    const pending: string[] = []
    this.pageIds = getChildIds(this.doc, null)
    for (const page of this.pageIds) {
      const n = getNode(this.doc, page)
      if (n) nodes.set(page, n)
      pending.push(...getChildIds(this.doc, page))
    }
    this.nodes = nodes
    this.pending = pending.reverse()
    this.listen()
    const step = (deadline: { timeRemaining(): number }) => {
      if (this.disposed || this.pending !== pending) return
      while (pending.length > 0 && deadline.timeRemaining() > 2) this.loadSubtree(pending.pop())
      if (pending.length > 0) idle(step)
      else this.finishWarm()
    }
    idle(step)
  }

  dispose(): void {
    this.disposed = true
    this.off?.()
    this.off = null
    this.nodes = null
    this.pending = null
  }

  private listen(): void {
    this.off ??= this.subscribe((batch) => this.apply(batch))
  }

  private loadSubtree(id: string | undefined): void {
    if (id === undefined || !this.nodes) return
    const sub = toSubtreeSnapshot(this.doc, id)
    if (!sub) return
    for (const key in sub.nodes) this.nodes.set(key, sub.nodes[key] as DesignNode)
  }

  private finishWarm(): void {
    const pending = this.pending
    if (!pending) return
    while (pending.length > 0) this.loadSubtree(pending.pop())
    this.pending = null
    this.pageIds = getChildIds(this.doc, null)
    this.syncedOps = this.doc.opCount()
  }

  private build(): void {
    const snap = toSnapshot(this.doc)
    this.nodes = new Map(Object.entries(snap.nodes))
    this.pageIds = [...snap.pageIds]
    this.pending = null
    this.syncedOps = this.doc.opCount()
    this.listen()
  }

  private reread(id: string | null): void {
    if (id === null) return
    const nodes = this.nodes as Map<string, DesignNode>
    const n = getNode(this.doc, id)
    if (n) nodes.set(id, n)
    else nodes.delete(id)
  }

  private removeSubtree(id: string): void {
    const nodes = this.nodes as Map<string, DesignNode>
    const stack = [id]
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      const n = nodes.get(cur)
      nodes.delete(cur)
      if (n) for (const c of n.children) stack.push(c)
    }
  }

  private apply(batch: NodeChangeBatch): void {
    if (!this.nodes) return
    if (batch.by === 'checkout') {
      this.nodes = null
      this.pending = null
      return
    }
    let roots = false
    // Each node is re-read once per batch: re-reading a parent lists all its children, so doing
    // it per change made a write of N children into one frame O(N²).
    const reread = new Set<string>()
    const want = (id: string | null): void => {
      if (id !== null) reread.add(id)
    }
    for (const c of batch.changes) {
      switch (c.kind) {
        case 'created':
          want(c.id)
          want(c.parentId)
          if (c.parentId === null) roots = true
          break
        case 'moved':
          // While warming, the moved subtree may come from a part not loaded yet.
          if (this.pending) this.loadSubtree(c.id)
          else want(c.id)
          want(c.parentId)
          want(c.oldParentId)
          if (c.parentId === null || c.oldParentId === null) roots = true
          break
        case 'deleted':
          this.removeSubtree(c.id)
          want(c.oldParentId)
          if (c.oldParentId === null) roots = true
          break
        default:
          want(c.id)
      }
    }
    for (const id of reread) this.reread(id)
    if (roots) this.pageIds = getChildIds(this.doc, null)
    if (this.pending === null) this.syncedOps = this.doc.opCount()
  }
}
