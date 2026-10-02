import { expect, test, type Page } from '@playwright/test'
import { frames, selection, setup } from './helpers.ts'

/**
 * QA (Phase 3): adversarial interaction edge cases on the canvas — reparent targets that must
 * be refused (instances, groups, locked frames, component cycles), rotated layers in flex
 * frames, rotation + resize + undo, pen paths with 1/2 points, vector edits on closed paths
 * and deleting every point.
 *
 * Fixture: bench/e2e.ts (`p3`). `phase3(x, y)` shows world (x, y) at client (0, 0), so with
 * the default (-50, -50) client = world + 50.
 */

type P3 = Window['__e2e']['p3']
type Pt = { x: number; y: number }

async function p3(page: Page): Promise<P3> {
  return page.evaluate(() => window.__e2e.p3)
}

async function phase3(page: Page, x = -50, y = -50, zoom = 1): Promise<void> {
  await page.evaluate(([vx, vy, z]) => window.__e2e.phase3(vx, vy, z), [x, y, zoom] as const)
  await frames(page, 2)
}

function styles(page: Page, id: string): Promise<Record<string, unknown> | undefined> {
  return page.evaluate((nid) => window.__e2e.node(nid)?.styles, id)
}

function parentOf(page: Page, id: string): Promise<string | null | undefined> {
  return page.evaluate((nid) => window.__e2e.node(nid)?.parentId, id)
}

async function center(page: Page, id: string): Promise<Pt> {
  return page.evaluate((nid) => {
    const el = window.__e2e.elementOf(nid)
    if (!el) throw new Error(`no element for ${nid}`)
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, id)
}

async function drag(
  page: Page,
  from: Pt,
  to: Pt,
  opts: { modifier?: 'Control' | 'Shift' } = {},
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  if (opts.modifier) await page.keyboard.down(opts.modifier)
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await frames(page, 2)
  await page.mouse.up()
  if (opts.modifier) await page.keyboard.up(opts.modifier)
  await frames(page, 3)
}

/** Drag from a rotation zone around `c` by `deg` degrees (clockwise), Shift held. */
async function rotateFrom(page: Page, c: Pt, zone: Pt, deg: number): Promise<void> {
  const r = Math.hypot(zone.x - c.x, zone.y - c.y)
  const a0 = Math.atan2(zone.y - c.y, zone.x - c.x)
  await page.mouse.move(zone.x, zone.y)
  await page.mouse.down()
  await page.keyboard.down('Shift')
  const steps = Math.max(3, Math.round(Math.abs(deg) / 10))
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (((deg * i) / steps + Math.sign(deg) * 2) * Math.PI) / 180
    await page.mouse.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a))
  }
  await frames(page, 2)
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await frames(page, 3)
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() => window.__e2e.canvas().undo())
}

test.beforeEach(async ({ page }) => {
  await setup(page)
})

test.describe('QA reparent targets', () => {
  test('dropping onto an instance lands in its parent frame, never inside the instance', async ({
    page,
  }) => {
    const n = await p3(page)
    // Board I at world (0, 800); client = world + (50, -750).
    await phase3(page, -50, 750)
    const loose = await page.evaluate(
      (pageId) =>
        window.__e2e.createNode({
          type: 'rect',
          parentId: pageId,
          name: 'Loose',
          styles: { left: 650, top: 900, width: 30, height: 30, backgroundColor: '#123456' },
        }),
      n.page,
    )
    await frames(page, 3)
    const from = await center(page, loose)
    const onInst2 = await center(page, n.inst2)
    await drag(page, from, { x: onInst2.x + 13, y: onInst2.y + 7 })
    expect(await parentOf(page, loose)).toBe(n.boardI)
    expect(await page.evaluate((id) => window.__e2e.children(id), n.inst2)).toEqual([])
    expect(await styles(page, loose)).toMatchObject({ position: 'absolute' })
    // The instance's rendered content is untouched (2 virtual children).
    const virtual = await page.evaluate(
      (id) => window.__e2e.elementOf(id)?.querySelectorAll('[data-nid]').length,
      n.inst2,
    )
    expect(virtual).toBe(2)
  })

  test('dropping onto a group (not entered) lands in the frame under it', async ({ page }) => {
    const n = await p3(page)
    // Board G at world (0, 400); client = world + (50, -350).
    await phase3(page, -50, 350)
    const loose = await page.evaluate(
      (pageId) =>
        window.__e2e.createNode({
          type: 'rect',
          parentId: pageId,
          name: 'Loose',
          styles: { left: 420, top: 420, width: 20, height: 20, backgroundColor: '#123456' },
        }),
      n.page,
    )
    await frames(page, 3)
    const from = await center(page, loose)
    // GA centre: world (45, 445).
    await drag(page, from, { x: 45 + 50 + 3, y: 445 - 350 + 2 })
    expect(await parentOf(page, loose)).toBe(n.boardG)
    expect(await page.evaluate((id) => window.__e2e.children(id), n.group)).toEqual([n.ga, n.gb])
  })

  test('an instance dragged over its own main is not put inside it (component cycle)', async ({
    page,
  }) => {
    const n = await p3(page)
    // Card main at world (1000, 400); inst1 at world (20, 820): view both at 50 %.
    await phase3(page, -50, 300, 0.5)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.inst1)
    await frames(page, 2)
    const from = await center(page, n.inst1)
    const card = await center(page, n.card)
    await drag(page, from, { x: card.x + 7, y: card.y + 5 })
    const parent = await parentOf(page, n.inst1)
    expect(parent).not.toBe(n.card)
    expect(await page.evaluate((id) => window.__e2e.children(id), n.card)).toEqual([
      n.cardTitle,
      n.cardBar,
    ])
    // The instance still resolves (no cycle placeholder).
    expect(await page.evaluate((id) => window.__e2e.resolved(id)?.status, n.inst1)).toBe('ok')
  })

  test('locked and hidden frames are not drop targets', async ({ page }) => {
    const n = await p3(page)
    await phase3(page)
    // Lock Board Q through the document (the fixture has no lock helper).
    await page.evaluate((id) => {
      const e = window.__e2e
      e.doc
        .getTree('nodes')
        .getNodeByID(id as `${number}@${number}`)
        ?.data.set('locked', true)
      e.doc.commit()
    }, n.boardQ)
    await frames(page, 3)
    await drag(page, { x: 100, y: 90 }, { x: 650, y: 120 })
    expect(await parentOf(page, n.mover)).toBe(n.page)
    // A hidden nested frame is not a target either: unlock Q, hide Inner, drop over it.
    await page.evaluate(
      ([q, inner]) => {
        const e = window.__e2e
        const tree = e.doc.getTree('nodes')
        tree.getNodeByID(q as `${number}@${number}`)?.data.set('locked', false)
        e.doc.commit()
        e.setHidden(inner as string, true)
      },
      [n.boardQ, n.inner] as const,
    )
    await frames(page, 3)
    const c = await center(page, n.mover)
    // Inner spans world 700..850 × 150..250.
    await drag(page, c, { x: 775 + 50, y: 200 + 50 })
    expect(await parentOf(page, n.mover)).toBe(n.boardQ)
  })

  test('a node in a rotated frame keeps its world frame when dragged into another frame', async ({
    page,
  }) => {
    const ids = await page.evaluate(() => {
      const e = window.__e2e
      const tilted = e.createNode({
        type: 'frame',
        parentId: e.p3.page,
        name: 'Tilted',
        styles: {
          left: 1400,
          top: 0,
          width: 200,
          height: 200,
          rotate: '30deg',
          backgroundColor: '#EEEEFF',
        },
      })
      const child = e.createNode({
        type: 'rect',
        parentId: tilted,
        name: 'Child',
        styles: {
          position: 'absolute',
          left: 80,
          top: 80,
          width: 40,
          height: 40,
          backgroundColor: '#AA0000',
        },
      })
      const target = e.createNode({
        type: 'frame',
        parentId: e.p3.page,
        name: 'Target',
        styles: { left: 1700, top: 0, width: 250, height: 250, backgroundColor: '#FFFFFF' },
      })
      return { tilted, child, target }
    })
    // client = (world.x - 1350, world.y + 50)
    await phase3(page, 1350, -50)
    const before = await page.evaluate((id) => window.__e2e.canvas().getNodeFrame(id), ids.child)
    expect(before?.rotation).toBeCloseTo(30, 3)
    const from = await center(page, ids.child)
    await page.keyboard.down('Control')
    await page.mouse.click(from.x, from.y)
    await page.keyboard.up('Control')
    expect(await selection(page)).toEqual([ids.child])
    // Clear of the target's centre/edge snapping lines.
    const dx = 260
    const dy = 40
    await drag(page, from, { x: from.x + dx, y: from.y + dy })
    expect(await parentOf(page, ids.child)).toBe(ids.target)
    const after = await page.evaluate((id) => window.__e2e.canvas().getNodeFrame(id), ids.child)
    expect(after?.rotation).toBeCloseTo(30, 1)
    expect(after?.width).toBeCloseTo(40, 0)
    expect(after?.x).toBeCloseTo((before?.x ?? 0) + dx, 0)
    expect(after?.y).toBeCloseTo((before?.y ?? 0) + dy, 0)
    expect((await styles(page, ids.child))?.['rotate']).toBe('30deg')
  })
})

test.describe('QA groups and components on the canvas', () => {
  test('nested groups: click selects the outermost, each double-click enters one level', async ({
    page,
  }) => {
    const n = await p3(page)
    // Board G at world (0, 400); client = world + (50, -350).
    await phase3(page, -50, 350)
    const outer = await page.evaluate(
      ([g, extra]) => {
        const e = window.__e2e
        const third = e.createNode({
          type: 'rect',
          parentId: extra as string,
          name: 'GC',
          styles: {
            position: 'absolute',
            left: 250,
            top: 200,
            width: 40,
            height: 40,
            backgroundColor: '#0000AA',
          },
        })
        return e.group([g as string, third])
      },
      [n.group, n.boardG] as const,
    )
    expect(outer).not.toBeNull()
    await frames(page, 3)
    const ga = { x: 45 + 50, y: 445 - 350 }
    await page.mouse.click(ga.x, ga.y)
    expect(await selection(page)).toEqual([outer])
    await page.mouse.dblclick(ga.x, ga.y)
    expect(await selection(page)).toEqual([n.group])
    await page.mouse.dblclick(ga.x, ga.y)
    expect(await selection(page)).toEqual([n.ga])
    // Escape walks back up one level at a time.
    await page.keyboard.press('Escape')
    expect(await selection(page)).toEqual([n.group])
    await page.keyboard.press('Escape')
    expect(await selection(page)).toEqual([outer])
  })

  test('dragging a layer into a main component adds it to every instance live', async ({
    page,
  }) => {
    const n = await p3(page)
    // Card main at world (1000, 400) and Board I at (0, 800), at 50 %.
    await phase3(page, -50, 300, 0.5)
    const loose = await page.evaluate(
      (pageId) =>
        window.__e2e.createNode({
          type: 'rect',
          parentId: pageId,
          name: 'Added',
          styles: { left: 1300, top: 450, width: 60, height: 12, backgroundColor: '#FF00AA' },
        }),
      n.page,
    )
    await frames(page, 3)
    const from = await center(page, loose)
    const card = await center(page, n.card)
    await drag(page, from, { x: card.x + 3, y: card.y + 22 })
    expect(await parentOf(page, loose)).toBe(n.card)
    const key = await page.evaluate((id) => window.__e2e.node(id)?.nodeKey, loose)
    expect(key).toMatch(/^[0-9a-z]{10}$/)
    await frames(page, 2)
    const counts = await page.evaluate(
      (ids) =>
        ids.map((id) => window.__e2e.elementOf(id)?.querySelectorAll('[data-nid]').length ?? -1),
      [n.inst1, n.inst2],
    )
    expect(counts).toEqual([3, 3])
    // One undo removes it from the main and from every instance.
    await undo(page)
    await frames(page, 3)
    expect(await parentOf(page, loose)).toBe(n.page)
    const after = await page.evaluate(
      (ids) =>
        ids.map((id) => window.__e2e.elementOf(id)?.querySelectorAll('[data-nid]').length ?? -1),
      [n.inst1, n.inst2],
    )
    expect(after).toEqual([2, 2])
  })

  test('structural main edits re-render every instance exactly like a fresh instance', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 750)
    /** The rendered DOM under an instance, ids relative to the instance. */
    const shapeOf = (id: string) =>
      page.evaluate((inst) => {
        const root = window.__e2e.elementOf(inst)
        if (!root) return null
        const walk = (el: Element): unknown => ({
          nid: (el.getAttribute('data-nid') ?? '').slice(inst.length),
          tag: el.tagName,
          style: (el.getAttribute('style') ?? '')
            .split(';')
            .map((x) => x.trim())
            .filter((x) => x !== '' && !/^(left|top|position)\s*:/.test(x))
            .sort()
            .join(';'),
          text: el.classList.contains('ic-text') ? el.textContent : null,
          children: [...el.children].filter((c) => c.hasAttribute('data-nid')).map(walk),
        })
        return walk(root)
      }, id)
    const expectAllEqual = async (label: string) => {
      await frames(page, 3)
      const fresh = await page.evaluate(
        ([key, board]) =>
          window.__e2e.makeInstance(key as string, board as string, {
            position: 'absolute',
            left: 20,
            top: 160,
          }),
        [n.componentKey, n.boardI] as const,
      )
      await frames(page, 4)
      const want = await shapeOf(fresh)
      expect(want, label).not.toBeNull()
      expect(await shapeOf(n.inst1), `${label}: inst1`).toEqual(want)
      expect(await shapeOf(n.inst2), `${label}: inst2`).toEqual(want)
      await page.evaluate((id) => window.__e2e.deleteNode(id), fresh)
      await frames(page, 2)
    }
    // 1. Add a frame with a child at the start of the main.
    const ids = await page.evaluate((card) => {
      const e = window.__e2e
      const box = e.createNode({
        type: 'frame',
        parentId: card,
        index: 0,
        name: 'Box',
        styles: { display: 'flex', gap: '4px', backgroundColor: '#EEEEEE' },
      })
      const dot = e.createNode({
        type: 'rect',
        parentId: box,
        name: 'Dot',
        styles: { width: 8, height: 8, backgroundColor: '#FF0000' },
      })
      return { box, dot }
    }, n.card)
    await expectAllEqual('add')
    // 2. Move the title into the new frame (a node moves to a new parent).
    await page.evaluate(
      ([title, box]) => window.__e2e.moveNode(title as string, box as string, 0),
      [n.cardTitle, ids.box] as const,
    )
    await expectAllEqual('move into a child frame')
    // 3. Reorder: the bar first.
    await page.evaluate((bar) => window.__e2e.moveNode(bar, window.__e2e.p3.card, 0), n.cardBar)
    await expectAllEqual('reorder')
    // 4. Move the title back to the main root, delete the dot, then the frame.
    await page.evaluate(
      ([title, card]) => window.__e2e.moveNode(title as string, card as string, 1),
      [n.cardTitle, n.card] as const,
    )
    await expectAllEqual('move back')
    await page.evaluate((dot) => window.__e2e.deleteNode(dot), ids.dot)
    await expectAllEqual('delete a nested node')
    await page.evaluate((box) => window.__e2e.deleteNode(box), ids.box)
    await expectAllEqual('delete a frame')
    // 5. Undo everything back to the start: still identical to a fresh instance.
    for (let i = 0; i < 6; i++) await undo(page)
    await expectAllEqual('after undo')
  })

  test('selecting two layers from different frames and dropping them into a flex frame keeps their order', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, -50, 0.5)
    // Mover (Board P) and Inner (Board Q) → into Board F between F1 and F2.
    await page.evaluate((ids) => window.__e2e.canvas().select(ids), [n.mover, n.inner])
    await frames(page, 2)
    const from = await center(page, n.mover)
    // Board F at world (1000, 0): the gap between F1 and F2 is world y 45 → client 47.5.
    await drag(page, from, { x: 600, y: 47.5 })
    expect(await page.evaluate((id) => window.__e2e.children(id), n.boardF)).toEqual([
      n.f1,
      n.mover,
      n.inner,
      n.f2,
    ])
    for (const id of [n.mover, n.inner]) {
      const st = await styles(page, id)
      expect(st?.['position']).toBeUndefined()
      expect(st?.['left']).toBeUndefined()
    }
    await undo(page)
    await frames(page, 2)
    expect(await parentOf(page, n.mover)).toBe(n.boardP)
    expect(await parentOf(page, n.inner)).toBe(n.boardQ)
  })
})

test.describe('QA rotation', () => {
  test('rotating an absolutely positioned child of a flex frame keeps its position', async ({
    page,
  }) => {
    // Page 1: Board A (flex, padding 20) with "Floating" absolute at (300, 200) 50×50.
    const id = await page.evaluate(() => window.__e2e.ids.floating)
    await page.evaluate((nid) => window.__e2e.canvas().select([nid]), id)
    await frames(page, 2)
    // Viewport (-50, -50): client = world + 50. Centre world (325, 225).
    const c = { x: 375, y: 275 }
    const zone = { x: 400 + 8, y: 250 - 8 }
    await rotateFrom(page, c, zone, 90)
    const st = await styles(page, id)
    expect(st).toMatchObject({ position: 'absolute', left: 300, top: 200, rotate: '90deg' })
    const frame = await page.evaluate((nid) => window.__e2e.canvas().getNodeFrame(nid), id)
    expect(frame?.x).toBeCloseTo(300, 0)
    expect(frame?.y).toBeCloseTo(200, 0)
  })

  test('a rotated flow item keeps its slot, reorders and undoes step by step', async ({ page }) => {
    const n = await p3(page)
    // The e2e stage is 1000 × 700: show Board F (world x 1000..1300) at client x 500..800.
    await phase3(page, 500, -50)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.f1)
    await frames(page, 2)
    // F1: world (1010, 10) 100×30 → centre client (560, 75); ne corner client (610, 60).
    await rotateFrom(page, { x: 560, y: 75 }, { x: 618, y: 52 }, 45)
    let st = await styles(page, n.f1)
    expect(st?.['rotate']).toBe('45deg')
    expect(st?.['position']).toBeUndefined()
    expect(st?.['left']).toBeUndefined()
    // Reorder below F2 (Ctrl keeps the parent): F2 centre world (1060, 65) → client (560, 115).
    const from = await center(page, n.f1)
    await drag(page, from, { x: 560, y: 135 }, { modifier: 'Control' })
    expect(await page.evaluate((id) => window.__e2e.children(id), n.boardF)).toEqual([n.f2, n.f1])
    st = await styles(page, n.f1)
    expect(st?.['rotate']).toBe('45deg')
    expect(st?.['position']).toBeUndefined()
    await undo(page)
    await frames(page, 2)
    expect(await page.evaluate((id) => window.__e2e.children(id), n.boardF)).toEqual([n.f1, n.f2])
    await undo(page)
    await frames(page, 2)
    expect((await styles(page, n.f1))?.['rotate']).toBeUndefined()
  })

  test('rotate, then resize, then undo twice restores the original box', async ({ page }) => {
    const n = await p3(page)
    await phase3(page)
    const original = await styles(page, n.spin)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.spin)
    await frames(page, 2)
    // Spin centre world (300, 175) → client (350, 225); ne corner at 30°.
    const rot = (p: Pt, c: Pt, deg: number): Pt => {
      const a = (deg * Math.PI) / 180
      return {
        x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a),
        y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a),
      }
    }
    const c = { x: 350, y: 225 }
    const zone = rot({ x: 400 + 8, y: 200 - 8 }, c, 30)
    await rotateFrom(page, c, zone, 60)
    expect((await styles(page, n.spin))?.['rotate']).toBe('90deg')
    // Resize: the se handle of the 90° box is at local (100, 50) → world corner rotated 90°.
    const se = rot({ x: 400, y: 250 }, c, 90)
    const d = rot({ x: 30, y: 0 }, { x: 0, y: 0 }, 90)
    await drag(page, se, { x: se.x + d.x, y: se.y + d.y })
    const resized = await styles(page, n.spin)
    expect(resized?.['rotate']).toBe('90deg')
    expect(Number(resized?.['width'])).toBeCloseTo(130, 0)
    await undo(page)
    await frames(page, 2)
    expect(await styles(page, n.spin)).toMatchObject({ rotate: '90deg', width: 100, height: 50 })
    await undo(page)
    await frames(page, 2)
    expect(await styles(page, n.spin)).toEqual(original)
  })

  test('a group of rotated layers keeps every world frame when moved', async ({ page }) => {
    const n = await p3(page)
    await phase3(page)
    const before = await page.evaluate(
      (ids) => ids.map((id) => window.__e2e.canvas().getNodeFrame(id)),
      [n.mover, n.spin],
    )
    const g = await page.evaluate((ids) => window.__e2e.group(ids), [n.mover, n.spin])
    expect(g).not.toBeNull()
    await frames(page, 3)
    await page.evaluate((id) => window.__e2e.canvas().select([id as string]), g)
    await frames(page, 2)
    const from = await center(page, n.mover)
    await drag(page, from, { x: from.x + 23, y: from.y + 17 }, { modifier: 'Control' })
    const after = await page.evaluate(
      (ids) => ids.map((id) => window.__e2e.canvas().getNodeFrame(id)),
      [n.mover, n.spin],
    )
    for (let i = 0; i < 2; i++) {
      expect(after[i]?.x).toBeCloseTo((before[i]?.x ?? 0) + 23, 0)
      expect(after[i]?.y).toBeCloseTo((before[i]?.y ?? 0) + 17, 0)
      expect(after[i]?.rotation).toBeCloseTo(before[i]?.rotation ?? 0, 1)
    }
    expect(await parentOf(page, n.spin)).toBe(g)
  })
})

test.describe('QA pen and vector edits', () => {
  test('one click + Enter creates nothing; two clicks + Escape create a 2-point line', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page)
    const count = () => page.evaluate((id) => window.__e2e.children(id).length, n.boardQ)
    const before = await count()
    await page.keyboard.press('p')
    await page.mouse.click(560, 80)
    await page.keyboard.press('Enter')
    await frames(page, 2)
    expect(await count()).toBe(before)
    await page.keyboard.press('p')
    await page.mouse.click(560, 80)
    await page.mouse.click(700, 80)
    await page.keyboard.press('Escape')
    await frames(page, 2)
    expect(await count()).toBe(before + 1)
    const id = (await selection(page))[0] as string
    const node = await page.evaluate((nid) => window.__e2e.node(nid), id)
    expect(node?.type).toBe('vector')
    expect(node?.vector?.subpaths[0]?.points).toEqual([
      { x: 0, y: 0 },
      { x: 140, y: 0 },
    ])
    expect(node?.styles).toMatchObject({ width: 140, height: 1 })
    // One undo removes the whole path.
    await undo(page)
    await frames(page, 2)
    expect(await count()).toBe(before)
  })

  test('a closed path stays closed while its anchors are edited', async ({ page }) => {
    const n = await p3(page)
    // Board V at world (500, 400); client = world + (50, -350).
    await phase3(page, -50, 350)
    // Triangle at world (760, 570) 100×100, points (50,0) (100,100) (0,100).
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.tri)
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => window.__e2e.canvas().getEditingVector())).toBe(n.tri)
    const apex = { x: 810 + 50, y: 570 - 350 }
    await drag(page, apex, { x: apex.x + 20, y: apex.y - 30 })
    const v = await page.evaluate((id) => window.__e2e.node(id)?.vector, n.tri)
    expect(v?.subpaths[0]?.closed).toBe(true)
    expect(v?.subpaths[0]?.points).toHaveLength(3)
    const d = await page.evaluate(
      (id) => window.__e2e.elementOf(id)?.querySelector('path')?.getAttribute('d'),
      n.tri,
    )
    expect(d).toMatch(/ Z$/)
    // The box grew upwards by 30: top moved, the base stayed in place.
    expect(await styles(page, n.tri)).toMatchObject({ top: 140, height: 130 })
    // The anchor drag is one undo step (points and box together).
    await undo(page)
    await frames(page, 2)
    expect(await styles(page, n.tri)).toMatchObject({ top: 170, height: 100 })
    expect(
      (await page.evaluate((id) => window.__e2e.node(id)?.vector, n.tri))?.subpaths[0]?.points,
    ).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ])
  })

  test('a many-point path mixing corners and curves, closed on its first point', async ({
    page,
  }) => {
    await phase3(page)
    await page.keyboard.press('p')
    // Eight points around world (700, 150) in Board Q; every other one dragged (smooth).
    const pts = Array.from({ length: 8 }, (_, i) => ({
      x: 700 + 50 + Math.round(90 * Math.cos((i / 8) * 2 * Math.PI)),
      y: 150 + 50 + Math.round(70 * Math.sin((i / 8) * 2 * Math.PI)),
    }))
    for (const [i, p] of pts.entries()) {
      if (i % 2 === 0) {
        await page.mouse.click(p.x, p.y)
        continue
      }
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.move(p.x + 10, p.y + 10, { steps: 3 })
      await page.mouse.up()
    }
    await page.mouse.click(pts[0]!.x, pts[0]!.y)
    await frames(page, 2)
    const id = (await selection(page))[0] as string
    const node = await page.evaluate((nid) => window.__e2e.node(nid), id)
    const sp = node?.vector?.subpaths[0]
    expect(sp?.closed).toBe(true)
    expect(sp?.points).toHaveLength(8)
    expect(sp?.points.filter((p) => p.mode === 'smooth')).toHaveLength(4)
    const d = await page.evaluate(
      (nid) => window.__e2e.elementOf(nid)?.querySelector('path')?.getAttribute('d'),
      id,
    )
    expect(d).toMatch(/^M /)
    expect(d).toMatch(/ C /)
    expect(d).toMatch(/ Z$/)
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('select')
  })

  test('deleting every point removes the vector (one undo step brings it back)', async ({
    page,
  }) => {
    const n = await p3(page)
    await phase3(page, -50, 350)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.tri)
    await page.keyboard.press('Enter')
    // Shift-click the three anchors: (810, 570), (860, 670), (760, 670) world.
    const anchors = [
      { x: 810 + 50, y: 570 - 350 },
      { x: 860 + 50, y: 670 - 350 },
      { x: 760 + 50, y: 670 - 350 },
    ]
    await page.mouse.click(anchors[0]!.x, anchors[0]!.y)
    for (const a of anchors.slice(1)) {
      await page.keyboard.down('Shift')
      await page.mouse.click(a.x, a.y)
      await page.keyboard.up('Shift')
    }
    await page.keyboard.press('Delete')
    await frames(page, 3)
    expect(await page.evaluate((id) => window.__e2e.node(id), n.tri)).toBeUndefined()
    expect(await page.evaluate(() => window.__e2e.canvas().getEditingVector())).toBeNull()
    await undo(page)
    await frames(page, 3)
    const restored = await page.evaluate(
      (id) =>
        window.__e2e
          .children(id)
          .map((c) => window.__e2e.node(c))
          .find((x) => x?.name === 'Triangle'),
      n.boardV,
    )
    expect(restored?.vector?.subpaths[0]?.points).toHaveLength(3)
  })
})
