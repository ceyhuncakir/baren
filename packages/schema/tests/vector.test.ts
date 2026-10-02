import { describe, expect, it } from 'vitest'
import type { LoroDoc } from 'loro-crdt'
import {
  createNode,
  editVector,
  getNode,
  nearestOnPath,
  normalizeVector,
  scaleVector,
  setPointMode,
  setVector,
  setVectorGeometry,
  splitSegment,
  subscribeNodes,
  vectorBounds,
  vectorToPathD,
  vectorToSvgMarkup,
  type NodeChangeBatch,
  type VectorData,
  type VectorSubpath,
} from '../src/index.ts'
import { docWithPage, expectFrameClose, flushEvents, frame } from './helpers.ts'

const square: VectorSubpath = {
  id: 'sq000001',
  closed: true,
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
}

const curve: VectorSubpath = {
  id: 'cv000001',
  closed: false,
  points: [
    { x: 0, y: 0, out: [10, -20] },
    { x: 30, y: 0, in: [-10, -20], mode: 'smooth' },
    { x: 60, y: 0.12345 },
  ],
}

function v(...subpaths: VectorSubpath[]): VectorData {
  return { fillRule: 'nonzero', subpaths }
}

/** Sample a subpath's segments (for shape comparisons). */
function sample(sp: VectorSubpath, steps = 8): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const pts = sp.points
  const n = pts.length
  const segs = sp.closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    const p1 = { x: a.x + (a.out?.[0] ?? 0), y: a.y + (a.out?.[1] ?? 0) }
    const p2 = { x: b.x + (b.in?.[0] ?? 0), y: b.y + (b.in?.[1] ?? 0) }
    for (let k = 0; k < steps; k++) {
      const t = k / steps
      const u = 1 - t
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y,
      })
    }
  }
  return out
}

function onShape(points: { x: number; y: number }[], sp: VectorSubpath): boolean {
  const dense = sample(sp, 400)
  return points.every((p) => dense.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.2))
}

describe('vectorToPathD (golden strings)', () => {
  it('prints lines, curves, closing segments and rounding exactly', () => {
    expect(vectorToPathD(v(square))).toBe('M 0 0 L 10 0 L 10 10 L 0 10 Z')
    expect(vectorToPathD(v(curve))).toBe('M 0 0 C 10 -20 20 -20 30 0 L 60 0.123')
    const closedCurve: VectorSubpath = {
      id: 'cc000001',
      closed: true,
      points: [
        { x: 0, y: 0, in: [0, 5] },
        { x: 10, y: 0 },
      ],
    }
    expect(vectorToPathD(v(closedCurve))).toBe('M 0 0 L 10 0 C 10 0 0 5 0 0 Z')
    expect(
      vectorToPathD(v({ id: 'x0000001', closed: true, points: [{ x: -0.0001, y: 1 / 3 }] })),
    ).toBe('M 0 0.333')
    expect(vectorToPathD(v(square, { id: 'empty001', closed: false, points: [] }, curve))).toBe(
      'M 0 0 L 10 0 L 10 10 L 0 10 Z M 0 0 C 10 -20 20 -20 30 0 L 60 0.123',
    )
    expect(vectorToPathD(v())).toBe('')
  })
})

describe('vector geometry', () => {
  it('bounds use curve extrema, not handle hulls', () => {
    const b = vectorBounds(v(curve))!
    expect(b.x).toBe(0)
    expect(b.y).toBeCloseTo(-15, 5) // the cubic's apex: 0.75 × -20
    expect(b.width).toBe(60)
    expect(b.height).toBeCloseTo(15.12345, 5)
    expect(vectorBounds(v())).toBeNull()
  })

  it('normalizes the box (rotation-aware) so the path stays put in world space', () => {
    const shifted = v({
      ...square,
      points: square.points.map((p) => ({ x: p.x + 5, y: p.y + 20 })),
    })
    const { vector, box } = normalizeVector(shifted, frame(100, 100, 50, 50, 90))
    expect(vector.subpaths[0]!.points[0]).toEqual({ x: 0, y: 0 })
    // Local bounds centre (10, 25) vs old centre (25, 25): Δ(-15, 0) rotated 90° = (0, -15).
    expectFrameClose(box, frame(120, 105, 10, 10, 90), 6)
    // Unrotated: a straight shift.
    expectFrameClose(normalizeVector(shifted, frame(0, 0, 50, 50)).box, frame(5, 20, 10, 10), 6)
    // Minimum 1 × 1.
    const line = v({
      id: 'ln000001',
      closed: false,
      points: [
        { x: 3, y: 0 },
        { x: 3, y: 8 },
      ],
    })
    expect(normalizeVector(line, frame(0, 0, 10, 10)).box.width).toBe(1)
  })

  it('scales points and handles', () => {
    expect(scaleVector(v(curve), 2, 0.5).subpaths[0]!.points[1]).toEqual({
      x: 60,
      y: 0,
      in: [-20, -10],
      mode: 'smooth',
    })
  })

  it('splits a segment without changing the shape', () => {
    const before = sample(curve)
    const split = splitSegment(curve, 0, 0.3)
    expect(split.points).toHaveLength(4)
    expect(split.points[1]!.mode).toBe('smooth')
    expect(onShape(before, split)).toBe(true)
    const line = splitSegment(square, 3, 0.5) // closing segment of a closed path
    expect(line.points[4]).toEqual({ x: 0, y: 5 })
    expect(onShape(sample(square), line)).toBe(true)
  })

  it('finds the nearest point on the path within a tolerance', () => {
    const hit = nearestOnPath(v(square), { x: 5, y: 1 }, 2)!
    expect(hit).toMatchObject({ subpathId: 'sq000001', segment: 0 })
    expect(hit.t).toBeCloseTo(0.5)
    expect(hit.distance).toBeCloseTo(1)
    expect(nearestOnPath(v(square), { x: 5, y: 5 }, 2)).toBeNull()
    const c = nearestOnPath(v(curve), { x: 15, y: -14 }, 3)!
    expect(c.segment).toBe(0)
  })

  it('toggles point modes', () => {
    const smooth = setPointMode(square, 1, 'smooth').points[1]!
    expect(smooth.mode).toBe('smooth')
    expect(smooth.in![0] * smooth.out![1] - smooth.in![1] * smooth.out![0]).toBeCloseTo(0) // collinear
    const corner = setPointMode(
      { ...square, points: [square.points[0]!, smooth, square.points[2]!] },
      1,
      'corner',
    ).points[1]!
    expect(corner).toEqual({ x: smooth.x, y: smooth.y })
    const mirrored = setPointMode(curve, 1, 'mirrored').points[1]!
    expect(Math.hypot(...mirrored.in!)).toBeCloseTo(Math.hypot(...mirrored.out!))
  })

  it('exports a standalone SVG with resolved paint', () => {
    const svg = vectorToSvgMarkup(
      {
        styles: {
          width: 10,
          height: 10,
          fill: 'var(--brand)',
          stroke: 'var(--missing, #000)',
          strokeWidth: 2,
          opacity: 0.5,
          strokeLinecap: 'var(--nope)',
        },
        vector: v(square),
      },
      { '--brand': { type: 'color', value: '#F04E1E' } },
    )
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M 0 0 L 10 0 L 10 10 L 0 10 Z" fill-rule="nonzero" fill="#F04E1E" stroke="#000" stroke-width="2"/></svg>',
    )
  })
})

describe('vector storage', () => {
  function vectorNode(doc: LoroDoc, pageId: string, data: VectorData): string {
    return createNode(doc, {
      type: 'vector',
      parentId: pageId,
      styles: {
        left: 0,
        top: 0,
        width: 60,
        height: 20,
        fill: 'none',
        stroke: '#000000',
        strokeWidth: 1,
      },
      vector: data,
    })
  }

  it('round-trips through the document (sorted subpaths, decoded points)', () => {
    const { doc, pageId } = docWithPage()
    const data: VectorData = { fillRule: 'evenodd', subpaths: [curve, square] }
    const id = vectorNode(doc, pageId, data)
    expect(getNode(doc, id)!.vector).toEqual(data)
    expect(() => createNode(doc, { type: 'rect', parentId: pageId, vector: data })).toThrow(
      /vector/,
    )
  })

  it('setVector writes a minimal diff; editVector applies point ops', async () => {
    const { doc, pageId } = docWithPage()
    const id = vectorNode(doc, pageId, v(square))
    await flushEvents()
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (b) => batches.push(b))
    const ops0 = doc.opCount()
    const moved = {
      ...square,
      points: square.points.map((p, i) => (i === 2 ? { x: 12, y: 12 } : p)),
    }
    setVector(doc, id, v(moved))
    expect(doc.opCount() - ops0).toBe(1) // one per-point set
    await flushEvents()
    expect(batches.at(-1)!.changes).toEqual([{ kind: 'vector', id }])
    setVector(doc, id, v(moved))
    expect(doc.opCount() - ops0).toBe(1) // unchanged → no op
    editVector(doc, id, [
      { kind: 'insert', subpathId: square.id, index: 1, point: { x: 5, y: -5 } },
      { kind: 'delete', subpathId: square.id, index: 4 },
      { kind: 'closed', subpathId: square.id, closed: false },
      { kind: 'insert', subpathId: 'new00001', index: 0, point: { x: 1, y: 1 } },
      { kind: 'fillRule', fillRule: 'evenodd' },
    ])
    expect(getNode(doc, id)!.vector).toEqual({
      fillRule: 'evenodd',
      subpaths: [
        {
          id: square.id,
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 5, y: -5 },
            { x: 10, y: 0 },
            { x: 12, y: 12 },
          ],
        },
        { id: 'new00001', closed: false, points: [{ x: 1, y: 1 }] },
      ],
    })
    // Removing a subpath clears it (entry kept, never deleted and re-ensured).
    setVector(doc, id, {
      fillRule: 'nonzero',
      subpaths: [
        {
          id: 'new00001',
          closed: true,
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
      ],
    })
    expect(getNode(doc, id)!.vector!.subpaths.map((s) => s.id)).toEqual(['new00001'])
    setVector(
      doc,
      id,
      v(
        { ...square, points: [{ x: 9, y: 9 }] },
        { id: 'new00001', closed: true, points: [{ x: 1, y: 1 }] },
      ),
    )
    expect(getNode(doc, id)!.vector!.subpaths).toEqual([
      { id: square.id, closed: true, points: [{ x: 9, y: 9 }] },
      { id: 'new00001', closed: true, points: [{ x: 1, y: 1 }] },
    ])
  })

  it('setVectorGeometry writes points and box in one commit', async () => {
    const { doc, pageId } = docWithPage()
    const id = vectorNode(doc, pageId, v(square))
    await flushEvents()
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (b) => batches.push(b))
    setVectorGeometry(doc, id, v(curve), { width: 60, height: 15.12, left: 3 })
    await flushEvents()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.origin).toBe('canvas:vector')
    expect(getNode(doc, id)!.styles).toMatchObject({ left: 3, width: 60, height: 15.12 })
  })
})
