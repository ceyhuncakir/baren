import { describe, expect, it } from 'vitest'
import { placeAnchored, placeAtPoint, placeSubmenu } from './position'

const viewport = { width: 1440, height: 900 }

describe('placeAtPoint', () => {
  it('opens at the cursor when it fits', () => {
    expect(placeAtPoint({ x: 872, y: 300 }, { width: 244, height: 405 }, viewport)).toEqual({
      x: 872,
      y: 300,
    })
  })

  it('flips left of the cursor near the right edge', () => {
    const p = placeAtPoint({ x: 1400, y: 100 }, { width: 244, height: 200 }, viewport)
    expect(p).toEqual({ x: 1156, y: 100 })
  })

  it('flips above the cursor near the bottom edge', () => {
    const p = placeAtPoint({ x: 100, y: 850 }, { width: 200, height: 300 }, viewport)
    expect(p).toEqual({ x: 100, y: 550 })
  })

  it('clamps when neither side fits', () => {
    const p = placeAtPoint({ x: 100, y: 200 }, { width: 200, height: 880 }, viewport)
    expect(p.y).toBe(4)
  })
})

describe('placeSubmenu', () => {
  // Artboard 15: context menu at (872,300) 244 wide; "Copy as" is the 4th 30px item.
  const parent = { left: 872, top: 300, width: 244, height: 405 }
  const item = { left: 878, top: 396, width: 232, height: 30 }

  it('matches the reference layout (4px overlap, first item level with trigger)', () => {
    const p = placeSubmenu(item, parent, { width: 200, height: 233 }, viewport)
    expect(p).toEqual({ side: 'right', x: 1112, y: 390 })
  })

  it('flips to the left when the right side has no room', () => {
    const right = { left: 1200, top: 300, width: 232, height: 405 }
    const p = placeSubmenu({ ...item, left: 1206 }, right, { width: 200, height: 233 }, viewport)
    expect(p.side).toBe('left')
    expect(p.x).toBe(1200 + 4 - 200)
  })

  it('shifts up when it would overflow the bottom', () => {
    const low = { left: 878, top: 860, width: 232, height: 30 }
    const p = placeSubmenu(low, parent, { width: 200, height: 233 }, viewport)
    expect(p.y).toBe(860 + 30 + 6 - 233)
  })
})

describe('placeAnchored', () => {
  const anchor = { left: 1310, top: 45, width: 58, height: 26 }

  it('bottom-start aligns left edges under the anchor', () => {
    const p = placeAnchored(
      { left: 10, top: 48, width: 144, height: 34 },
      { width: 264, height: 328 },
      viewport,
      {
        offset: 2,
      },
    )
    expect(p).toEqual({ placement: 'bottom-start', x: 10, y: 84 })
  })

  it('bottom-end aligns right edges and clamps to the viewport', () => {
    const p = placeAnchored(anchor, { width: 248, height: 402 }, viewport, {
      placement: 'bottom-end',
      offset: 5,
    })
    expect(p.x).toBe(1310 + 58 - 248)
    expect(p.y).toBe(76)
  })

  it('flips to the top when there is no room below', () => {
    const low = { left: 100, top: 800, width: 100, height: 30 }
    const p = placeAnchored(low, { width: 200, height: 200 }, viewport, { offset: 4 })
    expect(p.placement).toBe('top-start')
    expect(p.y).toBe(800 - 4 - 200)
  })

  it('keeps the preferred side when neither side fits', () => {
    const mid = { left: 100, top: 400, width: 100, height: 30 }
    const p = placeAnchored(mid, { width: 200, height: 600 }, viewport)
    expect(p.placement).toBe('bottom-start')
  })

  it('supports side placements', () => {
    const p = placeAnchored(
      { left: 100, top: 100, width: 50, height: 20 },
      { width: 80, height: 40 },
      viewport,
      {
        placement: 'right-start',
        offset: 8,
      },
    )
    expect(p).toEqual({ placement: 'right-start', x: 158, y: 100 })
  })
})
