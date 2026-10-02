import { describe, expect, it } from 'vitest'
import {
  CONTAINER_NODE_TYPES,
  benchDocNodeCount,
  exportSnapshot,
  generateBenchDoc,
  toSnapshot,
} from '../src/index.ts'

describe('generateBenchDoc', () => {
  it.each([
    { artboards: 0, nodesPerArtboard: 0 },
    { artboards: 1, nodesPerArtboard: 0 },
    { artboards: 3, nodesPerArtboard: 1 },
    { artboards: 4, nodesPerArtboard: 25 },
    { artboards: 10, nodesPerArtboard: 200 },
  ])('produces exactly 1 + artboards × (1 + nodesPerArtboard) nodes for %o', (opts) => {
    const snap = toSnapshot(generateBenchDoc(opts))
    expect(Object.keys(snap.nodes)).toHaveLength(benchDocNodeCount(opts))
    expect(snap.pageIds).toHaveLength(1)
    expect(snap.nodes[snap.pageIds[0]!]!.children).toHaveLength(opts.artboards)
  })

  it('builds a valid tree with absolutely positioned artboards on a grid', () => {
    const snap = toSnapshot(generateBenchDoc({ artboards: 5, nodesPerArtboard: 30, columns: 2 }))
    const page = snap.nodes[snap.pageIds[0]!]!
    const boards = page.children.map((id) => snap.nodes[id]!)
    expect(boards.map((b) => [b.styles['left'], b.styles['top']])).toEqual([
      [0, 0],
      [1600, 0],
      [0, 1060],
      [1600, 1060],
      [0, 2120],
    ])
    for (const node of Object.values(snap.nodes)) {
      if (node.children.length > 0) expect(CONTAINER_NODE_TYPES.has(node.type)).toBe(true)
      if (node.type === 'text') expect(node.text).toMatch(/\w+ \d+/)
    }
  })

  it('is deterministic for a given seed and peer id', () => {
    const a = toSnapshot(
      generateBenchDoc({ artboards: 2, nodesPerArtboard: 40, seed: 7, peerId: 9 }),
    )
    const b = toSnapshot(
      generateBenchDoc({ artboards: 2, nodesPerArtboard: 40, seed: 7, peerId: 9 }),
    )
    const c = toSnapshot(
      generateBenchDoc({ artboards: 2, nodesPerArtboard: 40, seed: 8, peerId: 9 }),
    )
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('generates a 20k-node document in reasonable time', () => {
    const start = performance.now()
    const doc = generateBenchDoc({ artboards: 40, nodesPerArtboard: 500 })
    const built = performance.now()
    const snap = toSnapshot(doc)
    const snapped = performance.now()
    expect(Object.keys(snap.nodes)).toHaveLength(
      benchDocNodeCount({ artboards: 40, nodesPerArtboard: 500 }),
    )
    const bytes = exportSnapshot(doc).byteLength
    console.info(
      `bench doc: 20,041 nodes, build ${(built - start).toFixed(0)} ms, toSnapshot ${(snapped - built).toFixed(0)} ms, snapshot ${(bytes / 1024).toFixed(0)} KiB`,
    )
    expect(built - start).toBeLessThan(15_000)
  })
})
