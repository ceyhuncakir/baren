import { expect, test, type Page } from '@playwright/test'
import { frames, isColor, overlayPixel, selection, setup } from './helpers.ts'

// Phase 3 fixture page (bench/e2e.ts `p3`), shown with `phase3(x, y)`: world (wx, wy) is at
// client (wx - x, wy - y) at zoom 1. Default phase3() = (-50, -50): client = world + 50.

type P3 = Window['__e2e']['p3']

async function p3(page: Page): Promise<P3> {
  return page.evaluate(() => window.__e2e.p3)
}

async function phase3(page: Page, x = -50, y = -50, zoom = 1): Promise<void> {
  await page.evaluate(([vx, vy, z]) => window.__e2e.phase3(vx, vy, z), [x, y, zoom] as const)
  await frames(page, 2)
}

/** Client centre of a (real or virtual) node's element. */
async function center(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nid) => {
    const el = window.__e2e.elementOf(nid)
    if (!el) throw new Error(`no element for ${nid}`)
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, id)
}

function styles(page: Page, id: string): Promise<Record<string, unknown> | undefined> {
  return page.evaluate((nid) => window.__e2e.node(nid)?.styles, id)
}

test.beforeEach(async ({ page }) => {
  await setup(page)
})

test.describe('phase 3 rendering', () => {
  test('instances render their main live; a main edit patches every instance in place', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    const before = await page.evaluate((ids) => {
      const e = window.__e2e
      const inst = e.elementOf(ids.inst1) as HTMLElement
      const virtual = [...inst.querySelectorAll('[data-nid]')].map((el) =>
        el.getAttribute('data-nid'),
      )
      const title = inst.querySelector<HTMLElement>('.ic-text')
      ;(title as HTMLElement & { __tag?: number }).__tag = 1
      return { virtual, text: title?.textContent, width: inst.getBoundingClientRect().width }
    }, n)
    expect(before.text).toBe('Card')
    expect(before.width).toBe(200)
    expect(before.virtual.every((v) => v?.startsWith(`${n.inst1}/`))).toBe(true)
    expect(before.virtual).toHaveLength(2)
    const after = await page.evaluate(async (ids) => {
      const e = window.__e2e
      e.setText(ids.cardTitle, 'Plan')
      e.setStyle(ids.cardBar, 'backgroundColor', '#FF0000')
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const out = []
      for (const id of [ids.inst1, ids.inst2]) {
        const inst = e.elementOf(id) as HTMLElement
        const title = inst.querySelector<HTMLElement & { __tag?: number }>('.ic-text')
        const bar = inst.querySelectorAll<HTMLElement>('[data-nid]')[1]
        out.push({
          text: title?.textContent,
          sameEl: title?.__tag === 1,
          bar: bar ? getComputedStyle(bar).backgroundColor : null,
        })
      }
      return out
    }, n)
    expect(after[0]).toEqual({ text: 'Plan', sameEl: true, bar: 'rgb(255, 0, 0)' })
    expect(after[1]).toMatchObject({ text: 'Plan', bar: 'rgb(255, 0, 0)' })
  })

  test('renders vectors as svg paths, groups as pass-through boxes and rotation in degrees', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page)
    const r = await page.evaluate((ids) => {
      const e = window.__e2e
      const v = e.elementOf(ids.path) as SVGSVGElement | null
      const g = e.elementOf(ids.group) as HTMLElement | null
      const s = e.elementOf(ids.spin) as HTMLElement | null
      return {
        tag: v?.tagName,
        d: v?.querySelector('path')?.getAttribute('d'),
        viewBox: v?.getAttribute('viewBox'),
        stroke: v ? getComputedStyle(v).stroke : null,
        groupClass: g?.className,
        groupPointer: g ? getComputedStyle(g).pointerEvents : null,
        rotate: s?.style.rotate,
      }
    }, n)
    expect(r.tag).toBe('svg')
    expect(r.d).toBe('M 0 100 L 100 0 L 200 100')
    expect(r.viewBox).toBe('0 0 200 100')
    expect(r.stroke).toBe('rgb(0, 0, 0)')
    expect(r.groupClass).toContain('ic-group')
    expect(r.groupPointer).toBe('none')
    expect(r.rotate).toBe('30deg')
  })

  test('getNodeFrame reports rotated frames; getNodeBounds the axis-aligned box', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page)
    const r = await page.evaluate((id) => {
      const c = window.__e2e.canvas()
      return { frame: c.getNodeFrame(id), bounds: c.getNodeBounds(id) }
    }, n.spin)
    expect(r.frame?.rotation).toBeCloseTo(30, 3)
    expect(r.frame?.width).toBeCloseTo(100, 1)
    expect(r.frame?.height).toBeCloseTo(50, 1)
    expect(r.frame?.x).toBeCloseTo(250, 0)
    expect(r.frame?.y).toBeCloseTo(150, 0)
    // AABB of a 100×50 box rotated 30°: 111.6 × 93.3.
    expect(r.bounds?.width).toBeCloseTo(111.6, 0)
    expect(r.bounds?.height).toBeCloseTo(93.3, 0)
  })
})

const BLUE: [number, number, number] = [0x2f, 0x80, 0xff]

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; before?: () => Promise<void>; modifier?: 'Control' | 'Shift' } = {},
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  if (opts.modifier) await page.keyboard.down(opts.modifier)
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 6 })
  await frames(page, 2)
  if (opts.before) await opts.before()
  await page.mouse.up()
  if (opts.modifier) await page.keyboard.up(opts.modifier)
  await frames(page, 3)
}

function parentOf(page: Page, id: string): Promise<string | null | undefined> {
  return page.evaluate((nid) => window.__e2e.node(nid)?.parentId, id)
}

test.describe('reparent by dragging', () => {
  test('drags a layer into another artboard (absolute, world position kept, one undo step)', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page)
    let during: { clones: number; srcHidden: boolean; cloneRight: number } | null = null
    await drag(
      page,
      { x: 100, y: 90 },
      { x: 650, y: 120 },
      {
        before: async () => {
          during = await page.evaluate((id) => {
            const layer = document.querySelector('.ic-drag')
            const clone = layer?.firstElementChild as HTMLElement | null
            const src = window.__e2e.elementOf(id) as HTMLElement
            return {
              clones: layer?.childElementCount ?? 0,
              srcHidden: getComputedStyle(src).visibility === 'hidden',
              cloneRight: clone?.getBoundingClientRect().right ?? 0,
            }
          }, n.mover)
          // The target artboard is outlined (2 px, selection colour) while dragging.
          expect(isColor(await overlayPixel(page, 549, 200), BLUE)).toBe(true)
        },
      },
    )
    // The dragged copy sits in a world-space layer above Board P (not clipped at x = 450).
    expect(during).toMatchObject({ clones: 1, srcHidden: true })
    expect(during!.cloneRight).toBeGreaterThan(600)
    expect(await parentOf(page, n.mover)).toBe(n.boardQ)
    expect(await styles(page, n.mover)).toMatchObject({
      position: 'absolute',
      left: 70,
      top: 50,
      width: 60,
      height: 40,
    })
    expect(await page.evaluate(() => document.querySelector('.ic-drag'))).toBeNull()
    expect(await selection(page)).toEqual([n.mover])
    await page.evaluate(() => window.__e2e.canvas().undo())
    await frames(page, 2)
    expect(await parentOf(page, n.mover)).toBe(n.boardP)
    expect(await styles(page, n.mover)).toMatchObject({ left: 20, top: 20 })
  })

  test('drops into a flex frame at the insertion line', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -50, -50, 0.5)
    // Mover centre world (50, 40) → client (50, 45); between F1 and F2: world (1150, 45).
    await drag(
      page,
      { x: 50, y: 45 },
      { x: 600, y: 47.5 },
      {
        before: async () => {
          // Insertion line in the gap (world y = 45 → client 47.5), across Board F.
          expect(isColor(await overlayPixel(page, 650, 47), BLUE, 60)).toBe(true)
        },
      },
    )
    expect(await page.evaluate((id) => window.__e2e.children(id), n.boardF)).toEqual([
      n.f1,
      n.mover,
      n.f2,
    ])
    const st = await styles(page, n.mover)
    expect(st?.['position']).toBeUndefined()
    expect(st?.['left']).toBeUndefined()
    expect(st).toMatchObject({ width: 60, height: 40 })
  })

  test('drags a layer out to the page and into a nested frame', async ({ page }) => {
    const n = await p3(page)
    await phase3(page)
    // To the gap between the artboards: world (450, 350).
    await drag(page, { x: 100, y: 90 }, { x: 500, y: 400 })
    expect(await parentOf(page, n.mover)).toBe(n.page)
    const st = await styles(page, n.mover)
    expect(st).toMatchObject({ left: 420, top: 330 })
    expect(st?.['position']).toBeUndefined()
    // Into Inner (world 700..850 × 150..250): Mover's top-left lands at world (730, 172).
    const c = await center(page, n.mover)
    await drag(page, c, { x: c.x + 310, y: c.y - 158 })
    expect(await parentOf(page, n.inner)).toBe(n.boardQ)
    expect(await parentOf(page, n.mover)).toBe(n.inner)
    expect(await styles(page, n.mover)).toMatchObject({ position: 'absolute', left: 30, top: 22 })
  })

  test('Ctrl keeps the parent while dragging', async ({ page }) => {
    const n = await p3(page)
    await phase3(page)
    await drag(page, { x: 100, y: 90 }, { x: 650, y: 120 }, { modifier: 'Control' })
    expect(await parentOf(page, n.mover)).toBe(n.boardP)
    expect(await styles(page, n.mover)).toMatchObject({ left: 570, top: 50 })
  })
})

/** World → client for the default phase3() viewport. */
const cw = (x: number, y: number): { x: number; y: number } => ({ x: x + 50, y: y + 50 })

/** A point rotated by `deg` about `c`. */
function rot(p: { x: number; y: number }, c: { x: number; y: number }, deg: number) {
  const a = (deg * Math.PI) / 180
  const dx = p.x - c.x
  const dy = p.y - c.y
  return {
    x: c.x + dx * Math.cos(a) - dy * Math.sin(a),
    y: c.y + dx * Math.sin(a) + dy * Math.cos(a),
  }
}

test.describe('rotation', () => {
  test('corner zones rotate; Shift snaps to 15°; the live label shows the angle', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.spin)
    await frames(page, 2)
    // Spin: world (250,150) 100×50 at 30° → centre world (300,175) = client (350,225).
    const c = cw(300, 175)
    const ne = rot(cw(350, 150), c, 30)
    const zone = rot({ x: cw(350, 150).x + 8, y: cw(350, 150).y - 8 }, c, 30)
    await page.mouse.move(zone.x, zone.y)
    await frames(page, 1)
    const cursor = await page.evaluate(
      () => document.querySelector<HTMLElement>('.ic-root')?.style.cursor ?? '',
    )
    expect(cursor).toContain('data:image/svg+xml')
    expect(ne.x).toBeGreaterThan(0)
    // Drag ~60° clockwise around the centre with Shift: 30° + 60° = 90°.
    const r = Math.hypot(zone.x - c.x, zone.y - c.y)
    const a0 = Math.atan2(zone.y - c.y, zone.x - c.x)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    for (let i = 1; i <= 6; i++) {
      const a = a0 + ((i * 10 + 2) * Math.PI) / 180
      await page.mouse.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a))
    }
    await frames(page, 2)
    // The live angle pill sits 12 px right/below the pointer (selection colour).
    const last = {
      x: c.x + r * Math.cos(a0 + (62 * Math.PI) / 180),
      y: c.y + r * Math.sin(a0 + (62 * Math.PI) / 180),
    }
    expect(
      isColor(await overlayPixel(page, Math.round(last.x + 15), Math.round(last.y + 15)), BLUE),
    ).toBe(true)
    const live = await page.evaluate((id) => {
      const el = window.__e2e.elementOf(id) as HTMLElement
      return { rotate: el.style.rotate, stored: window.__e2e.node(id)?.styles['rotate'] }
    }, n.spin)
    expect(live).toEqual({ rotate: '90deg', stored: '30deg' })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await frames(page, 3)
    const st = await styles(page, n.spin)
    expect(st?.['rotate']).toBe('90deg')
    // Rotation about the centre: the unrotated box stays where it was.
    expect(st).toMatchObject({ left: 250, top: 150, width: 100, height: 50 })
    await page.evaluate(() => window.__e2e.canvas().undo())
    await frames(page, 2)
    expect((await styles(page, n.spin))?.['rotate']).toBe('30deg')
  })

  test('multi-selection rotates around the common centre', async ({ page }) => {
    const n = await p3(page)
    await phase3(page)
    await page.evaluate((ids) => window.__e2e.canvas().select(ids), [n.mover, n.spin])
    await frames(page, 2)
    const box = await page.evaluate(() => window.__e2e.canvas().getSelectionBounds())
    if (!box) throw new Error('no selection box')
    const c = cw(box.x + box.width / 2, box.y + box.height / 2)
    const corner = cw(box.x + box.width + 8, box.y - 8)
    const r = Math.hypot(corner.x - c.x, corner.y - c.y)
    const a0 = Math.atan2(corner.y - c.y, corner.x - c.x)
    await page.mouse.move(corner.x, corner.y)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    for (let i = 1; i <= 9; i++) {
      const a = a0 + ((i * 10 + 1) * Math.PI) / 180
      await page.mouse.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a))
    }
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await frames(page, 3)
    const st = await styles(page, n.mover)
    expect(st?.['rotate']).toBe('90deg')
    expect((await styles(page, n.spin))?.['rotate']).toBe('120deg')
    // Mover's centre (world 50, 40) turned 90° about the box centre.
    const pivot = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const moved = rot({ x: 50, y: 40 }, pivot, 90)
    expect(Number(st?.['left']) + 30).toBeCloseTo(moved.x, 0)
    expect(Number(st?.['top']) + 20).toBeCloseTo(moved.y, 0)
  })

  test('rotated nodes are hit on their shape, not their bounding box', async ({ page }) => {
    const n = await p3(page)
    // Tilt: world (700,800) 100×100 at 45° → a diamond around (750, 850).
    await phase3(page, -50, 750)
    const client = (x: number, y: number) => ({ x: x + 50, y: y - 750 })
    const empty = client(690, 790)
    await page.mouse.click(empty.x, empty.y)
    expect(await selection(page)).toEqual([])
    const inside = client(750, 792)
    await page.mouse.click(inside.x, inside.y)
    expect(await selection(page)).toEqual([n.tilt])
  })

  test('a rotated node resizes in its own axes; the opposite corner stays put', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.spin)
    await frames(page, 2)
    const c = { x: 300, y: 175 }
    const se = cw(rot({ x: 350, y: 200 }, c, 30).x, rot({ x: 350, y: 200 }, c, 30).y)
    const nwBefore = rot({ x: 250, y: 150 }, c, 30)
    // Drag the se handle 40 px along the box's local x axis.
    const d = rot({ x: 40, y: 0 }, { x: 0, y: 0 }, 30)
    await drag(page, se, { x: se.x + d.x, y: se.y + d.y })
    const st = await styles(page, n.spin)
    expect(st?.['rotate']).toBe('30deg')
    expect(st?.['width']).toBeCloseTo(140, 0)
    expect(st?.['height']).toBeCloseTo(50, 0)
    const left = Number(st?.['left'])
    const top = Number(st?.['top'])
    const w = Number(st?.['width'])
    const h = Number(st?.['height'])
    const nwAfter = rot({ x: left, y: top }, { x: left + w / 2, y: top + h / 2 }, 30)
    expect(nwAfter.x).toBeCloseTo(nwBefore.x, 0)
    expect(nwAfter.y).toBeCloseTo(nwBefore.y, 0)
  })
})

test.describe('groups', () => {
  // Board G at world (0, 400); phase3(-50, 350): client = world + (50, -350).
  const cg = (x: number, y: number): { x: number; y: number } => ({ x: x + 50, y: y - 350 })

  test('click selects the outermost group, double-click enters it', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    const ga = cg(45, 445)
    await page.mouse.click(ga.x, ga.y)
    expect(await selection(page)).toEqual([n.group])
    await page.mouse.dblclick(ga.x, ga.y)
    expect(await selection(page)).toEqual([n.ga])
    // Inside the entered group, a click on the sibling selects the sibling.
    const gb = cg(145, 495)
    await page.mouse.click(gb.x, gb.y)
    expect(await selection(page)).toEqual([n.gb])
    // Empty space inside the group's box falls through to the artboard.
    const hole = cg(140, 440)
    await page.mouse.click(hole.x, hole.y)
    expect(await selection(page)).toEqual([n.boardG])
  })

  test('moving, resizing and rotating a group carries its children', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    const g0 = await styles(page, n.group)
    expect(g0).toMatchObject({ position: 'absolute', left: 20, top: 20, width: 150, height: 100 })
    const ga = cg(45, 445)
    await page.mouse.click(ga.x, ga.y)
    // (+38, +22) keeps clear of snapping lines.
    await drag(page, ga, { x: ga.x + 38, y: ga.y + 22 })
    expect(await parentOf(page, n.ga)).toBe(n.group)
    expect(await styles(page, n.group)).toMatchObject({ left: 58, top: 42 })
    expect(await styles(page, n.ga)).toMatchObject({ left: 0, top: 0 })
    // Resize from the se corner: +150 × +100 doubles the group and its content.
    const se = cg(58 + 150, 442 + 100)
    await drag(page, se, { x: se.x + 150, y: se.y + 100 })
    expect(await styles(page, n.group)).toMatchObject({ width: 300, height: 200 })
    expect(await styles(page, n.gb)).toMatchObject({ left: 200, top: 100, width: 100, height: 100 })
    // Rotating turns the group itself.
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.group)
    await frames(page, 2)
    const c = cg(58 + 150, 442 + 100)
    const zone = cg(58 + 300 + 8, 442 - 8)
    const r = Math.hypot(zone.x - c.x, zone.y - c.y)
    const a0 = Math.atan2(zone.y - c.y, zone.x - c.x)
    await page.mouse.move(zone.x, zone.y)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    for (let i = 1; i <= 4; i++) {
      const a = a0 + ((i * 10 + 2) * Math.PI) / 180
      await page.mouse.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a))
    }
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await frames(page, 3)
    expect((await styles(page, n.group))?.['rotate']).toBe('45deg')
    expect((await styles(page, n.ga))?.['rotate']).toBeUndefined()
  })

  test('dragging a child out of its group reparents it; the group refits', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    const gb = cg(145, 495)
    await page.mouse.click(gb.x, gb.y)
    await page.mouse.dblclick(gb.x, gb.y)
    expect(await selection(page)).toEqual([n.gb])
    // Still over the group's box: stays inside the group.
    await drag(page, gb, { x: gb.x - 10, y: gb.y - 5 })
    expect(await parentOf(page, n.gb)).toBe(n.group)
    // Far outside the group, inside Board G: moves to the artboard; the group shrinks to GA.
    const now = await center(page, n.gb)
    await drag(page, now, { x: now.x + 150, y: now.y + 100 })
    expect(await parentOf(page, n.gb)).toBe(n.boardG)
    expect(await styles(page, n.group)).toMatchObject({ left: 20, top: 20, width: 50, height: 50 })
  })
})

test.describe('pen tool', () => {
  function vectorOf(page: Page, id: string) {
    return page.evaluate((nid) => window.__e2e.node(nid)?.vector, id)
  }

  test('P, three clicks and Enter create a vector with three corners', async ({ page }) => {
    const n = await p3(page)
    await phase3(page)
    await page.keyboard.press('p')
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('pen')
    for (const [x, y] of [
      [520, 30],
      [600, 110],
      [680, 30],
    ] as const) {
      const c = cw(x, y)
      await page.mouse.click(c.x, c.y)
    }
    await page.keyboard.press('Enter')
    await frames(page, 2)
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('select')
    const sel = await selection(page)
    expect(sel).toHaveLength(1)
    const id = sel[0] as string
    expect(await parentOf(page, id)).toBe(n.boardQ)
    expect(await page.evaluate((nid) => window.__e2e.node(nid)?.type, id)).toBe('vector')
    expect(await styles(page, id)).toMatchObject({
      position: 'absolute',
      left: 20,
      top: 30,
      width: 160,
      height: 80,
      fill: 'none',
      stroke: '#000000',
      strokeWidth: 1,
    })
    const v = await vectorOf(page, id)
    expect(v?.subpaths).toHaveLength(1)
    expect(v?.subpaths[0]?.closed).toBe(false)
    expect(v?.subpaths[0]?.points).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 80 },
      { x: 160, y: 0 },
    ])
    const d = await page.evaluate(
      (nid) => window.__e2e.elementOf(nid)?.querySelector('path')?.getAttribute('d'),
      id,
    )
    expect(d).toBe('M 0 0 L 80 80 L 160 0')
  })

  test('click-drag makes a smooth point; clicking the first point closes the path', async ({
    page,
  }) => {
    await phase3(page)
    await page.keyboard.press('p')
    const a = cw(520, 30)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(a.x + 15, a.y, { steps: 2 })
    await page.mouse.move(a.x + 30, a.y, { steps: 2 })
    await page.mouse.up()
    for (const [x, y] of [
      [600, 110],
      [680, 30],
    ] as const) {
      const c = cw(x, y)
      await page.mouse.click(c.x, c.y)
    }
    await page.mouse.click(a.x, a.y)
    await frames(page, 2)
    const id = (await selection(page))[0] as string
    const v = await page.evaluate((nid) => window.__e2e.node(nid)?.vector, id)
    const sp = v?.subpaths[0]
    expect(sp?.closed).toBe(true)
    expect(sp?.points[0]).toMatchObject({ out: [30, 0], in: [-30, 0], mode: 'smooth' })
    expect(sp?.points).toHaveLength(3)
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('select')
  })

  test('a double-click finishes the path open there, without entering vector editing', async ({
    page,
  }) => {
    await phase3(page)
    await page.keyboard.press('p')
    for (const [x, y] of [
      [520, 30],
      [600, 110],
    ] as const) {
      const c = cw(x, y)
      await page.mouse.click(c.x, c.y)
    }
    const end = cw(680, 30)
    await page.mouse.dblclick(end.x, end.y)
    await frames(page, 2)
    const id = (await selection(page))[0] as string
    expect(await page.evaluate((nid) => window.__e2e.node(nid)?.type, id)).toBe('vector')
    const sp = (await page.evaluate((nid) => window.__e2e.node(nid)?.vector, id))?.subpaths[0]
    expect(sp?.closed).toBe(false)
    // Both presses of the double-click landed on (680, 30): one point, not two.
    expect(sp?.points).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 80 },
      { x: 160, y: 0 },
    ])
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('select')
    expect(await page.evaluate(() => window.__e2e.canvas().getEditingVector())).toBeNull()
  })

  test('the rubber band follows the pointer between clicks', async ({ page }) => {
    await phase3(page)
    await page.keyboard.press('p')
    const a = cw(520, 30)
    await page.mouse.click(a.x, a.y)
    await page.mouse.move(a.x + 100, a.y + 100)
    await page.mouse.move(a.x + 160, a.y, { steps: 4 })
    await frames(page, 2)
    // The band runs to where the pointer is now, not to where it first moved.
    expect(isColor(await overlayPixel(page, a.x + 120, a.y), BLUE)).toBe(true)
    expect(isColor(await overlayPixel(page, a.x + 50, a.y + 50), BLUE)).toBe(false)
    // Escape with one point drops the draft; the overlay clears.
    await page.keyboard.press('Escape')
    await frames(page, 2)
    expect(isColor(await overlayPixel(page, a.x + 120, a.y), BLUE)).toBe(false)
  })
})

test.describe('vector editing', () => {
  // Zigzag in Board V: points world (550,550) (650,450) (750,550), stroke 4.
  const cv = (x: number, y: number): { x: number; y: number } => ({ x: x + 50, y: y - 350 })

  test('vectors are hit on their stroke (with tolerance); empty box areas fall through', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    const hole = cv(650, 530)
    await page.mouse.click(hole.x, hole.y)
    expect(await selection(page)).toEqual([n.boardV])
    await page.mouse.click(950, 650)
    const near = cv(600 + 3.2, 500 + 3.2)
    await page.mouse.click(near.x, near.y)
    expect(await selection(page)).toEqual([n.path])
  })

  test('double-click edits points: drag an anchor, add, delete, toggle smooth', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    const on = cv(600, 500)
    await page.mouse.click(on.x, on.y)
    await page.mouse.dblclick(on.x, on.y)
    expect(await page.evaluate(() => window.__e2e.canvas().getEditingVector())).toBe(n.path)
    expect(await page.evaluate(() => window.__e2e.events.vectorEdit.at(-1))).toBe(n.path)
    // Drag the middle anchor up 20 px: the box grows upwards, the path stays in place.
    const mid = cv(650, 450)
    await drag(page, mid, { x: mid.x, y: mid.y - 20 })
    expect(await styles(page, n.path)).toMatchObject({ left: 50, top: 30, width: 200, height: 120 })
    let v = await page.evaluate((id) => window.__e2e.node(id)?.vector, n.path)
    expect(v?.subpaths[0]?.points).toEqual([
      { x: 0, y: 120 },
      { x: 100, y: 0 },
      { x: 200, y: 120 },
    ])
    // Click the first segment: a point is inserted (shape unchanged), then Delete removes it.
    const seg = cv(600, 490)
    await page.mouse.click(seg.x, seg.y)
    await frames(page, 2)
    v = await page.evaluate((id) => window.__e2e.node(id)?.vector, n.path)
    expect(v?.subpaths[0]?.points).toHaveLength(4)
    expect(v?.subpaths[0]?.points[1]).toMatchObject({ x: 50, y: 60 })
    await page.keyboard.press('Delete')
    await frames(page, 2)
    v = await page.evaluate((id) => window.__e2e.node(id)?.vector, n.path)
    expect(v?.subpaths[0]?.points).toHaveLength(3)
    // Double-click the top anchor: corner → smooth (handles created).
    const top = cv(650, 430)
    await page.mouse.dblclick(top.x, top.y)
    await frames(page, 2)
    v = await page.evaluate((id) => window.__e2e.node(id)?.vector, n.path)
    expect(v?.subpaths[0]?.points[1]?.mode).toBe('smooth')
    expect(v?.subpaths[0]?.points[1]?.in).toBeDefined()
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => window.__e2e.canvas().getEditingVector())).toBeNull()
    expect(await page.evaluate(() => window.__e2e.events.vectorEdit.at(-1))).toBeNull()
    expect(await selection(page)).toEqual([n.path])
  })
})

test.describe('instances', () => {
  // Board I at world (0, 800); phase3(-50, 750): client = world + (50, -750).
  const ci = (x: number, y: number): { x: number; y: number } => ({ x: x + 50, y: y - 750 })

  async function virtualIds(page: Page, inst: string): Promise<string[]> {
    return page.evaluate(
      (id) =>
        [...(window.__e2e.elementOf(id)?.querySelectorAll('[data-nid]') ?? [])].map(
          (el) => el.getAttribute('data-nid') as string,
        ),
      inst,
    )
  }

  test('click selects the instance, double-click its content; text edits become overrides', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    const [title] = await virtualIds(page, n.inst1)
    const t = await center(page, title as string)
    await page.mouse.click(t.x, t.y)
    expect(await selection(page)).toEqual([n.inst1])
    await page.mouse.dblclick(t.x, t.y)
    expect(await selection(page)).toEqual([title])
    await page.mouse.dblclick(t.x, t.y)
    await frames(page, 2)
    expect(await page.evaluate(() => window.__e2e.events.textEdit.at(-1))).toBe(title)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Hello')
    await page.keyboard.press('Escape')
    await frames(page, 3)
    const r = await page.evaluate(
      (ids) => ({
        override: window.__e2e.resolved(ids.title)?.text,
        main: window.__e2e.node(ids.cardTitle)?.text,
        other: window.__e2e.elementOf(ids.inst2)?.querySelector('.ic-text')?.textContent,
        shown: window.__e2e.elementOf(ids.title)?.textContent,
      }),
      { title: title as string, cardTitle: n.cardTitle, inst2: n.inst2 },
    )
    expect(r).toEqual({ override: 'Hello', main: 'Card', other: 'Card', shown: 'Hello' })
  })

  test('Delete on instance content hides it (override); the instance resizes as itself', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    const [, bar] = await virtualIds(page, n.inst1)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), bar as string)
    await page.keyboard.press('Delete')
    await frames(page, 3)
    const hidden = await page.evaluate(
      (id) => ({
        resolved: window.__e2e.resolved(id)?.hidden,
        display: getComputedStyle(window.__e2e.elementOf(id) as Element).display,
      }),
      bar as string,
    )
    expect(hidden).toEqual({ resolved: true, display: 'none' })
    // The main still shows its bar.
    expect(await page.evaluate((id) => window.__e2e.node(id)?.hidden, n.cardBar)).toBeUndefined()
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.inst1)
    await frames(page, 2)
    const se = ci(20 + 200, 820 + 120)
    await drag(page, se, { x: se.x + 40, y: se.y + 30 })
    expect(await styles(page, n.inst1)).toMatchObject({ width: 240, height: 150 })
    expect(await page.evaluate((id) => window.__e2e.node(id)?.styles['width'], n.card)).toBe(200)
  })

  test('a remote peer: B’s main edit re-renders A’s instances, B’s override shows on A', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    const [title2] = await virtualIds(page, n.inst2)
    const r = await page.evaluate(
      async (ids) => {
        const e = window.__e2e
        e.sync.toB()
        e.sync.bSetStyle(ids.cardBar, 'backgroundColor', '#00FF00')
        e.sync.bSetTextAt(ids.title2, 'From B')
        e.sync.fromB()
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
        const bar1 = e.elementOf(ids.inst1)?.querySelectorAll<HTMLElement>('[data-nid]')[1]
        return {
          bar: bar1 ? getComputedStyle(bar1).backgroundColor : null,
          title2: e.elementOf(ids.title2)?.textContent,
          title1: e.elementOf(ids.inst1)?.querySelector('.ic-text')?.textContent,
        }
      },
      { cardBar: n.cardBar, title2: title2 as string, inst1: n.inst1 },
    )
    expect(r).toEqual({ bar: 'rgb(0, 255, 0)', title2: 'From B', title1: 'Card' })
  })
})

test.describe('instance lifecycle', () => {
  test('detaching an instance re-renders it as a frame with real children', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    const r = await page.evaluate(async (ids) => {
      const e = window.__e2e
      e.detach(ids.inst1)
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      const el = e.elementOf(ids.inst1) as HTMLElement
      return {
        type: e.node(ids.inst1)?.type,
        children: [...el.querySelectorAll('[data-nid]')].map((c) => c.getAttribute('data-nid')),
        real: e.children(ids.inst1),
        text: el.querySelector('.ic-text')?.textContent,
        width: el.getBoundingClientRect().width,
      }
    }, n)
    expect(r.type).toBe('frame')
    expect(r.children).toEqual(r.real)
    expect(r.children.some((c) => c?.includes('/'))).toBe(false)
    expect(r.text).toBe('Card')
    expect(r.width).toBe(200)
    // The main no longer drives it; the other instance still follows the main.
    await page.evaluate((id) => window.__e2e.setText(id, 'Main only'), n.cardTitle)
    await frames(page, 2)
    const texts = await page.evaluate(
      (ids) =>
        [ids.inst1, ids.inst2].map(
          (id) => window.__e2e.elementOf(id)?.querySelector('.ic-text')?.textContent,
        ),
      n,
    )
    expect(texts).toEqual(['Card', 'Main only'])
  })

  test('deleting the main keeps instances rendering; undo brings it back', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    const r = await page.evaluate(async (ids) => {
      const e = window.__e2e
      e.deleteNode(ids.card)
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      return {
        main: e.node(ids.card),
        text: e.elementOf(ids.inst2)?.querySelector('.ic-text')?.textContent,
        deleted: e.resolved(ids.inst2)?.mainDeleted,
      }
    }, n)
    expect(r).toEqual({ main: undefined, text: 'Card', deleted: true })
    // Undo re-creates the main (a new TreeID, same key and node keys): instances follow it again.
    const after = await page.evaluate(async (ids) => {
      const e = window.__e2e
      e.canvas().undo()
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      const restored = e
        .children(e.p3.page)
        .map((id) => e.node(id))
        .find((x) => x?.name === 'Card')
      if (restored) e.setText(restored.children[0] as string, 'Back')
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      return {
        deleted: e.resolved(ids.inst2)?.mainDeleted ?? false,
        text: e.elementOf(ids.inst2)?.querySelector('.ic-text')?.textContent,
      }
    }, n)
    expect(after).toEqual({ deleted: false, text: 'Back' })
  })
})

test.describe('canvas API and details', () => {
  test('dropTargetAt(deep) finds nested frames; accept falls back to shallower ones', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page)
    const r = await page.evaluate((ids) => {
      const c = window.__e2e.canvas()
      const at = { clientX: 800, clientY: 250 } // world (750, 200): inside Inner
      const top = c.dropTargetAt(at)
      const deep = c.dropTargetAt(at, { deep: true })
      const refused = c.dropTargetAt(at, { deep: true, accept: (id) => id !== ids.inner })
      const place = deep?.place({ x: 740, y: 190, width: 20, height: 10 })
      c.dropTargetAt(null)
      return { top: top?.parentId, deep: deep?.parentId, refused: refused?.parentId, place }
    }, n)
    expect(r.top).toBe(n.boardQ)
    expect(r.deep).toBe(n.inner)
    expect(r.refused).toBe(n.boardQ)
    expect(r.place?.styles).toMatchObject({ position: 'absolute', left: 40, top: 40, width: 20 })
  })

  test('Enter edits a selected vector and selects an instance’s content', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.tri)
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => window.__e2e.canvas().getEditingVector())).toBe(n.tri)
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => window.__e2e.canvas().getEditingVector())).toBeNull()
    await phase3(page, -50, 750)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.inst1)
    await page.keyboard.press('Enter')
    const sel = await selection(page)
    expect(sel).toHaveLength(2)
    expect(sel.every((id) => id.startsWith(`${n.inst1}/`))).toBe(true)
    // Select all inside an instance: its direct content.
    await page.evaluate((id) => window.__e2e.canvas().select([id]), sel[0] as string)
    await page.evaluate(() => window.__e2e.canvas().selectAll())
    expect(await selection(page)).toEqual(sel)
  })

  test('a text edit inside a group refits the group after layout (not an undo step)', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    const { text } = await page.evaluate((board) => {
      const e = window.__e2e
      const text = e.createNode({
        type: 'text',
        parentId: board,
        name: 'Label',
        text: 'Hi',
        styles: {
          position: 'absolute',
          left: 220,
          top: 200,
          fontFamily: 'Inter',
          fontSize: '16px',
          lineHeight: '20px',
        },
      })
      return { text }
    }, n.boardG)
    await frames(page, 3)
    const g = await page.evaluate((id) => window.__e2e.group([id]), text)
    expect(g).not.toBeNull()
    await frames(page, 3)
    const w0 = Number((await styles(page, g as string))?.['width'])
    await page.evaluate((id) => window.__e2e.setText(id, 'Hello wide world'), text)
    await page.waitForFunction(
      ([id, w]) => Number(window.__e2e.node(id as string)?.styles['width']) > (w as number) + 20,
      [g, w0] as const,
    )
    // Undo reverts the text change; the derived fit is not an undo step of its own.
    await page.evaluate(() => window.__e2e.canvas().undo())
    await frames(page, 2)
    expect(await page.evaluate((id) => window.__e2e.node(id)?.text, text)).toBe('Hi')
  })

  test('rotated top-level nodes keep their rotation as LOD stand-ins', async ({ page }) => {
    const n = await p3(page)
    await phase3(page, -2000, -1000, 0.1)
    await page.waitForFunction(() => window.__e2e.canvas().getStats().lod)
    const rotate = await page.evaluate(
      (id) =>
        document.querySelector<HTMLElement>(`[data-top="${id}"] .ic-standin`)?.style.rotate ?? '',
      n.tilt,
    )
    expect(rotate).toBe('45deg')
  })

  test('main components get a component label; instances are selected in the component colour', async ({
    page,
  }) => {
    const n = await p3(page)
    // Card (main) at world (1000, 400): label above it.
    await phase3(page, 900, 300)
    const PURPLE: [number, number, number] = [0x7b, 0x4d, 0xff]
    const found = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
      const d = c?.getContext('2d')?.getImageData(100, 81, 120, 14).data
      if (!d) return false
      for (let i = 0; i < d.length; i += 4)
        if (
          (d[i] ?? 0) > 90 &&
          (d[i + 1] ?? 255) < 110 &&
          (d[i + 2] ?? 0) > 200 &&
          (d[i + 3] ?? 0) > 200
        )
          return true
      return false
    })
    expect(found).toBe(true)
    await phase3(page, -50, 750)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.inst1)
    await frames(page, 2)
    // inst1 at world (20, 820) → client (70, 70); outline just outside its left edge.
    expect(isColor(await overlayPixel(page, 69, 120), PURPLE, 50)).toBe(true)
    // With the main in view, it gets a 1 px outline 2 px outside its box (artboard 31).
    await phase3(page, -50, 300, 0.5)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.inst1)
    await frames(page, 2)
    // Card at world (1000, 400) → client (525, 50) at 50 %.
    expect(isColor(await overlayPixel(page, 522, 80), PURPLE, 50)).toBe(true)
    expect(isColor(await overlayPixel(page, 524, 80), PURPLE, 50)).toBe(false)
  })

  test('drawing never inserts into an instance; absolute instance content moves by override', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    // A main with an absolutely positioned child, and an instance of it in Board I.
    const ids = await page.evaluate((boardI) => {
      const e = window.__e2e
      const main = e.createNode({
        type: 'frame',
        parentId: boardI,
        name: 'Abs main',
        styles: {
          position: 'absolute',
          left: 300,
          top: 180,
          width: 120,
          height: 100,
          backgroundColor: '#EEEEEE',
        },
      })
      const dot = e.createNode({
        type: 'rect',
        parentId: main,
        name: 'Dot',
        styles: {
          position: 'absolute',
          left: 10,
          top: 10,
          width: 30,
          height: 30,
          backgroundColor: '#FF00FF',
        },
      })
      e.makeComponent([main])
      const key = e.node(main)?.componentKey as string
      const inst = e.makeInstance(key, boardI, { position: 'absolute', left: 450, top: 180 })
      return { main, dot, inst, dotKey: e.node(dot)?.nodeKey as string }
    }, n.boardI)
    await frames(page, 4)
    const vdot = `${ids.inst}/${ids.dotKey}`
    // Rectangle tool over the instance: the rect goes into Board I, not the instance.
    await page.keyboard.press('r')
    const at = { x: 450 + 50 + 80, y: 180 + 800 - 750 + 60 }
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 20, at.y + 15, { steps: 3 })
    await page.mouse.up()
    await frames(page, 2)
    const rect = (await selection(page))[0] as string
    expect(await parentOf(page, rect)).toBe(n.boardI)
    // Move the virtual dot: an override on the instance, the main is untouched.
    await page.evaluate((id) => window.__e2e.canvas().select([id]), vdot)
    await frames(page, 2)
    const c = await center(page, vdot)
    // (+27, +17) keeps clear of the snapping lines of the instance box.
    await drag(page, c, { x: c.x + 27, y: c.y + 17 })
    const r = await page.evaluate(
      (x) => ({
        resolved: window.__e2e.resolved(x.vdot)?.styles,
        main: window.__e2e.node(x.dot)?.styles,
      }),
      { vdot, dot: ids.dot },
    )
    expect(r.resolved).toMatchObject({ left: 37, top: 27 })
    expect(r.main).toMatchObject({ left: 10, top: 10 })
  })
})

export { center, styles, isColor, overlayPixel, selection }
