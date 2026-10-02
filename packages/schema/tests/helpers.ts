import type { LoroDoc } from 'loro-crdt'
import {
  createEmptyDoc,
  docGeometry,
  getChildIds,
  loadDoc,
  type GeometrySource,
  type NodeFrame,
} from '../src/index.ts'

/** A fresh doc with its single page id. */
export function docWithPage(name = 'Test', peerId?: number): { doc: LoroDoc; pageId: string } {
  const doc = peerId === undefined ? createEmptyDoc(name) : createEmptyDoc(name, { peerId })
  const pageId = getChildIds(doc, null)[0]
  if (!pageId) throw new Error('expected a page')
  return { doc, pageId }
}

/** Wait for Loro's post-commit microtask so subscribers have run. */
export const flushEvents = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Exchange updates both ways (as the sync server would) until both peers are equal. */
export function sync(a: LoroDoc, b: LoroDoc): void {
  const toB = a.export({ mode: 'update', from: b.oplogVersion() })
  const toA = b.export({ mode: 'update', from: a.oplogVersion() })
  b.import(toB)
  a.import(toA)
}

/** Peer 1 with a page, and peer 2 loaded from its snapshot. */
export function twoPeers(): { a: LoroDoc; b: LoroDoc; pageId: string } {
  const { doc: a, pageId } = docWithPage('Shared', 1)
  const b = loadDoc(a.export({ mode: 'snapshot' }))
  b.setPeerId(2)
  return { a, b, pageId }
}

/** Deterministic random source (mulberry32) for keys in tests. */
export function seeded(seed = 1): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Geometry with explicit frames for some ids, declared styles for the rest. */
export function framesGeometry(doc: LoroDoc, frames: Record<string, NodeFrame>): GeometrySource {
  const declared = docGeometry(doc)
  return { frameOf: (id) => frames[id] ?? declared.frameOf(id) }
}

export function frame(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0,
): NodeFrame {
  return { x, y, width, height, rotation }
}

/** Compare frames with a tolerance. */
export function expectFrameClose(actual: NodeFrame | null, expected: NodeFrame, digits = 1): void {
  if (!actual) throw new Error('expected a frame')
  const tol = 10 ** -digits
  for (const k of ['x', 'y', 'width', 'height', 'rotation'] as const) {
    if (Math.abs(actual[k] - expected[k]) > tol) {
      throw new Error(
        `frame.${k}: expected ${expected[k]}, got ${actual[k]} (${JSON.stringify(actual)})`,
      )
    }
  }
}
