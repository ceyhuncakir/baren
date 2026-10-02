import { createEmptyDoc, createNode, getChildIds } from '@baren/schema'
import { describe, expect, it } from 'vitest'
import {
  AgentGeometry,
  placeArtboard,
  type ArtboardMeasure,
  type Measurer,
  type Rect,
} from './geometry'
import { createComponentResolver } from '@baren/schema'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

describe('placeArtboard (contract §6.21.1)', () => {
  it('puts the first artboard of an empty page at the origin', () => {
    expect(placeArtboard([], null, { width: 1440, height: 900 })).toEqual({ left: 0, top: 0 })
  })

  it('goes right of the anchor row, 80 px from the last artboard in it', () => {
    const existing = [r(0, 0, 1440, 900), r(1520, 0, 390, 844)]
    expect(placeArtboard(existing, existing[0] ?? null, { width: 390, height: 844 })).toEqual({
      left: 1990,
      top: 0,
    })
  })

  it('anchors on the top-most, then left-most artboard without a session anchor', () => {
    const existing = [r(500, 1200, 100, 100), r(0, 0, 400, 300), r(-800, 0, 400, 300)]
    // Top-most row is y = 0; left-most there is x = -800; its row reaches x = 400.
    expect(placeArtboard(existing, null, { width: 200, height: 200 })).toEqual({
      left: 480,
      top: 0,
    })
  })

  it('ignores artboards outside the row band but slides past anything it would touch', () => {
    const anchor = r(0, 0, 400, 300)
    // Below the band (does not count for the row's right edge) but in the way at y 0..380.
    const blocker = r(500, 350, 300, 300)
    const far = r(0, 5000, 3000, 100)
    const at = placeArtboard([anchor, blocker, far], anchor, { width: 200, height: 300 })
    // Candidate x 480 → inflated rect [400, 760] × [-80, 380] touches the blocker → x 880.
    expect(at).toEqual({ left: 880, top: 0 })
  })

  it('uses the taller of anchor and new artboard for the band', () => {
    const anchor = r(0, 0, 400, 100)
    const below = r(600, 150, 400, 100)
    // Band [0, 900] includes `below`, so the row's right edge is 1000.
    expect(placeArtboard([anchor, below], anchor, { width: 300, height: 900 })).toEqual({
      left: 1080,
      top: 0,
    })
  })

  it('is deterministic and rounds to integers', () => {
    const existing = [r(0.4, 10.6, 100.3, 50)]
    const a = placeArtboard(existing, existing[0] ?? null, { width: 10, height: 10 })
    const b = placeArtboard(existing, existing[0] ?? null, { width: 10, height: 10 })
    expect(a).toEqual(b)
    expect(Number.isInteger(a.left) && Number.isInteger(a.top)).toBe(true)
    expect(a).toEqual({ left: 181, top: 11 })
  })
})

function setup() {
  const doc = createEmptyDoc('t', { peerId: 1 })
  const page = getChildIds(doc, null)[0] as string
  const board = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Board',
    styles: {
      left: 100,
      top: 50,
      width: 400,
      height: 'fit-content',
      display: 'flex',
      padding: '20px',
    },
  })
  const flow = createNode(doc, {
    type: 'text',
    parentId: board,
    name: 'Title',
    text: 'Hello',
    styles: { fontSize: '16px' },
  })
  const abs = createNode(doc, {
    type: 'rect',
    parentId: board,
    name: 'Abs',
    styles: { position: 'absolute', left: 10, top: 20, width: 30, height: 40 },
  })
  return { doc, page, board, flow, abs }
}

describe('AgentGeometry (contract §5)', () => {
  it('reports exact declared values and null for layout-dependent ones without a measurer', () => {
    const { doc, board, flow, abs } = setup()
    const geo = new AgentGeometry({ doc, resolver: createComponentResolver(doc) }, null)
    expect(geo.fields(abs)).toEqual({
      worldX: 110,
      worldY: 70,
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    })
    // fit-content height: unknown without a measurement; the position does not depend on it.
    expect(geo.fields(board)).toEqual({
      worldX: 100,
      worldY: 50,
      x: 100,
      y: 50,
      width: 400,
      height: null,
    })
    expect(geo.fields(flow)).toEqual({
      worldX: null,
      worldY: null,
      x: null,
      y: null,
      width: null,
      height: null,
    })
  })

  it('uses the measurement for layout-dependent nodes (artboard-local → world)', () => {
    const { doc, board, flow, abs } = setup()
    let calls = 0
    const measurer: Measurer = {
      measure(id): ArtboardMeasure | null {
        calls++
        if (id !== board) return null
        return {
          width: 400,
          height: 120,
          nodes: new Map([
            [flow, { cx: 20 + 18, cy: 20 + 10, width: 36, height: 20, rotation: 0 }],
          ]),
        }
      },
    }
    const geo = new AgentGeometry({ doc, resolver: createComponentResolver(doc) }, measurer)
    expect(geo.fields(board)).toEqual({
      worldX: 100,
      worldY: 50,
      x: 100,
      y: 50,
      width: 400,
      height: 120,
    })
    expect(geo.fields(flow)).toEqual({
      worldX: 120,
      worldY: 70,
      x: 20,
      y: 20,
      width: 36,
      height: 20,
    })
    // Declared-exact nodes never lay out; the artboard is measured once per document version.
    expect(geo.fields(abs).worldX).toBe(110)
    expect(calls).toBe(1)
    geo.invalidate()
    geo.fields(flow)
    expect(calls).toBe(2)
  })

  it('lists top-level rects with unknown heights as 900 for placement', () => {
    const { doc, page } = setup()
    const geo = new AgentGeometry({ doc, resolver: createComponentResolver(doc) }, null)
    expect(geo.topLevelRects(page).map((t) => t.rect)).toEqual([r(100, 50, 400, 900)])
  })
})
