import { expect, test } from '@playwright/test'
import { centerOf, frames, ids, isColor, overlayPixel, selection, setup } from './helpers.ts'

// Fixture (bench/e2e.ts): viewport x=-50, y=-50, zoom 1 → world (x, y) is at client (x + 50, y + 50).
// Board A: world (0,0) 400×300 → client (50,50)–(450,350); Board B: world (500,0) 300×300 → client (550,50)–(850,350).

const BLUE: [number, number, number] = [0x2f, 0x80, 0xff]

test.beforeEach(async ({ page }) => {
  await setup(page)
})

test.describe('rendering', () => {
  test('renders visible artboards as real DOM and virtualizes far ones', async ({ page }) => {
    const r = await page.evaluate(() => {
      const e = window.__e2e
      const section = e.elementOf(e.ids.section) as HTMLElement
      return {
        boardA: e.elementOf(e.ids.boardA) !== null,
        title: e.elementOf(e.ids.title)?.textContent,
        far: e.elementOf(e.ids.farAway) !== null,
        brand: getComputedStyle(section).backgroundColor,
        token: document
          .querySelector<HTMLElement>('.ic-root')
          ?.style.getPropertyValue('--color-brand'),
        floatingLeft: (e.elementOf(e.ids.floating) as HTMLElement).style.left,
        stats: e.canvas().getStats(),
      }
    })
    expect(r.boardA).toBe(true)
    expect(r.title).toBe('Hello')
    expect(r.far).toBe(false)
    expect(r.token).toBe('#FFE8E0')
    expect(r.brand).toBe('rgb(255, 232, 224)')
    expect(r.floatingLeft).toBe('300px')
    expect(r.stats.mountedArtboards).toBe(2)
  })

  test('sanitizes svg markup (no scripts, handlers, foreign content or external refs)', async ({
    page,
  }) => {
    const r = await page.evaluate(() => {
      const e = window.__e2e
      return { html: e.elementOf(e.ids.icon)?.outerHTML ?? '', pwned: window.__pwned ?? null }
    })
    expect(r.pwned).toBeNull()
    expect(r.html).toContain('<rect')
    for (const bad of [
      'script',
      'onload',
      'onclick',
      '<style',
      'foreignObject',
      'evil.example',
      'javascript:',
    ]) {
      expect(r.html).not.toContain(bad)
    }
  })

  test('draws svg markup written the way HTML inlines it (no xmlns, undeclared xlink)', async ({
    page,
  }) => {
    // write_html stores inline <svg> as written: without xmlns, which is not namespaced XML.
    const r = await page.evaluate(async () => {
      const e = window.__e2e
      const add = (svg: string, left: number) =>
        e.createNode({
          type: 'svg',
          parentId: e.ids.boardA,
          name: 'Icon',
          svg,
          styles: { position: 'absolute', left, top: 200, width: 24, height: 24 },
        })
      const inline = add(
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="#F04E1E"><path d="M2 2h20v20H2z"></path></svg>',
        10,
      )
      const xlink = add(
        '<svg viewBox="0 0 24 24"><defs><circle id="c" cx="12" cy="12" r="8"></circle></defs><use xlink:href="#c"></use></svg>',
        40,
      )
      const hostile = add(
        '<svg viewBox="0 0 24 24"><script>window.__pwned = 1</script><path d="M0 0h4v4z" onclick="window.__pwned = 2"></path><foreignObject><div>x</div></foreignObject><img src="x" onerror="window.__pwned = 3"></svg>',
        70,
      )
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      await new Promise((res) => setTimeout(res, 50))
      const el = (id: string) => e.elementOf(id)
      return {
        inline: el(inline)?.querySelectorAll('path').length,
        inlineNs: el(inline)?.querySelector('path')?.namespaceURI,
        inlineWidth: Math.round(el(inline)?.getBoundingClientRect().width ?? 0),
        xlink: el(xlink)?.querySelector('use')?.getAttribute('xlink:href'),
        hostile: el(hostile)?.outerHTML ?? '',
        pwned: window.__pwned ?? null,
      }
    })
    expect(r).toMatchObject({
      inline: 1,
      inlineNs: 'http://www.w3.org/2000/svg',
      inlineWidth: 24,
      xlink: '#c',
      pwned: null,
    })
    expect(r.hostile).toContain('<path')
    for (const bad of ['script', 'onclick', 'foreignObject', '<img', 'onerror'])
      expect(r.hostile).not.toContain(bad)
  })

  test('applies incremental updates to the changed elements only', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const e = window.__e2e
      const title = e.elementOf(e.ids.title) as HTMLElement & { __tag?: number }
      const box = e.elementOf(e.ids.box) as HTMLElement & { __tag?: number }
      title.__tag = 1
      box.__tag = 2
      e.setStyle(e.ids.box, 'width', 80)
      e.setText(e.ids.title, 'World')
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      const title2 = e.elementOf(e.ids.title) as HTMLElement & { __tag?: number }
      const box2 = e.elementOf(e.ids.box) as HTMLElement & { __tag?: number }
      return {
        sameTitle: title2.__tag === 1,
        sameBox: box2.__tag === 2,
        width: box2.style.width,
        text: title2.textContent,
      }
    })
    expect(r).toEqual({ sameTitle: true, sameBox: true, width: '80px', text: 'World' })
  })

  test('shows a remote edit within 100 ms', async ({ page }) => {
    const ms = await page.evaluate(async () => {
      const e = window.__e2e
      const t0 = performance.now()
      e.remoteSetText(e.ids.title, 'Remote!')
      return new Promise<number>((resolve) => {
        const check = (): void => {
          if (e.elementOf(e.ids.title)?.textContent === 'Remote!') resolve(performance.now() - t0)
          else requestAnimationFrame(check)
        }
        check()
      })
    })
    expect(ms).toBeLessThan(100)
  })

  test('hides nodes and removes deleted subtrees', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const e = window.__e2e
      e.setHidden(e.ids.second, true)
      e.deleteNode(e.ids.section)
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      return {
        hidden: getComputedStyle(e.elementOf(e.ids.second) as Element).display,
        section: e.elementOf(e.ids.section),
        title: e.elementOf(e.ids.title),
      }
    })
    expect(r).toEqual({ hidden: 'none', section: null, title: null })
  })

  test('mounts far artboards when scrolled into view and unmounts the rest', async ({ page }) => {
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: 19900, y: 19900, zoom: 1 }))
    await page.waitForFunction(() => window.__e2e.elementOf(window.__e2e.ids.farAway) !== null)
    await frames(page, 3)
    const r = await page.evaluate(() => ({
      a: window.__e2e.elementOf(window.__e2e.ids.boardA) !== null,
    }))
    expect(r.a).toBe(false)
  })

  test('renders bitmap stand-ins at low zoom (LOD)', async ({ page }) => {
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: -200, y: -200, zoom: 0.1 }))
    await page.waitForFunction(() => {
      const s = window.__e2e.canvas().getStats()
      return s.lod && s.mountedArtboards === 0 && document.querySelectorAll('.ic-thumb').length >= 2
    })
  })
})

test.describe('selection', () => {
  test('click selects the artboard child; Ctrl-click deep-selects; Shift toggles; empty clears', async ({
    page,
  }) => {
    const n = await ids(page)
    const title = await centerOf(page, 'title')
    await page.mouse.click(title.x, title.y)
    expect(await selection(page)).toEqual([n.section])
    await page.keyboard.down('Control')
    await page.mouse.click(title.x, title.y)
    await page.keyboard.up('Control')
    expect(await selection(page)).toEqual([n.title])
    const second = await centerOf(page, 'second')
    await page.keyboard.down('Shift')
    await page.mouse.click(second.x, second.y)
    await page.keyboard.up('Shift')
    expect(await selection(page)).toEqual([n.title, n.second])
    await page.mouse.click(950, 650)
    expect(await selection(page)).toEqual([])
  })

  test('clicking an artboard label selects the artboard and turns the label blue', async ({
    page,
  }) => {
    const n = await ids(page)
    await page.mouse.click(560, 38)
    expect(await selection(page)).toEqual([n.boardB])
    await frames(page)
    // Label text pixels are blue once selected.
    const found = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.ic-overlay')
      const d = c?.getContext('2d')?.getImageData(550, 31, 50, 14).data
      if (!d) return false
      for (let i = 0; i < d.length; i += 4)
        if ((d[i + 2] ?? 0) > 200 && (d[i] ?? 255) < 120 && (d[i + 3] ?? 0) > 200) return true
      return false
    })
    expect(found).toBe(true)
  })

  test('draws the selection look: blue outline, white handles, size pill', async ({ page }) => {
    await page.evaluate(() => window.__e2e.canvas().select([window.__e2e.ids.boardB]))
    await frames(page)
    expect(isColor(await overlayPixel(page, 549, 200), BLUE)).toBe(true)
    // Handle centre is white, its border blue.
    expect(isColor(await overlayPixel(page, 550, 50), [255, 255, 255], 10)).toBe(true)
    expect(isColor(await overlayPixel(page, 547, 50), BLUE, 60)).toBe(true)
    // Size pill sits 7px below the box, centred: blue background.
    expect(isColor(await overlayPixel(page, 700, 358), BLUE)).toBe(true)
    await page.screenshot({
      path: test.info().outputPath('selection.png'),
      clip: { x: 500, y: 0, width: 400, height: 400 },
    })
  })

  test('hover reports the node a click would select', async ({ page }) => {
    const n = await ids(page)
    const box = await centerOf(page, 'box')
    await page.mouse.move(box.x, box.y)
    await frames(page)
    const last = await page.evaluate(() => window.__e2e.events.hover.at(-1))
    expect(last).toBe(n.section)
  })

  test('marquee on an artboard background selects its children', async ({ page }) => {
    const n = await ids(page)
    await page.mouse.move(340, 290)
    await page.mouse.down()
    await page.mouse.move(200, 200, { steps: 4 })
    await page.mouse.move(60, 80, { steps: 4 })
    await page.mouse.up()
    expect(await selection(page)).toEqual([n.section, n.second, n.icon])
  })

  test('marquee on empty canvas selects enclosed artboards', async ({ page }) => {
    const n = await ids(page)
    await page.mouse.move(980, 380)
    await page.mouse.down()
    await page.mouse.move(520, 20, { steps: 6 })
    await page.mouse.up()
    expect(await selection(page)).toEqual([n.boardB])
  })

  test('context menu selects the target and notifies the host', async ({ page }) => {
    const n = await ids(page)
    const box = await centerOf(page, 'box')
    await page.mouse.click(box.x, box.y, { button: 'right' })
    expect(await selection(page)).toEqual([n.section])
    expect(await page.evaluate(() => window.__e2e.events.context)).toBe(1)
  })
})

test.describe('editing', () => {
  test('dragging an artboard previews with a transform and commits once on pointerup', async ({
    page,
  }) => {
    const n = await ids(page)
    await page.mouse.move(560, 38)
    await page.mouse.down()
    await page.mouse.move(600, 60, { steps: 5 })
    await page.mouse.move(660, 78, { steps: 5 })
    const during = await page.evaluate(() => {
      const e = window.__e2e
      const wrapper = document.querySelector<HTMLElement>(`[data-top="${e.ids.boardB}"]`)
      return {
        left: e.node(e.ids.boardB)?.styles['left'],
        transform: wrapper?.style.transform,
        transient: e.events.transient.length,
      }
    })
    expect(during.left).toBe(500)
    expect(during.transform).toBe('translate(600px, 40px)')
    expect(during.transient).toBeGreaterThan(0)
    await page.mouse.up()
    await frames(page)
    const after = await page.evaluate(() => {
      const e = window.__e2e
      return {
        left: e.node(e.ids.boardB)?.styles['left'],
        top: e.node(e.ids.boardB)?.styles['top'],
        lastTransient: e.events.transient.at(-1),
      }
    })
    expect(after).toEqual({ left: 600, top: 40, lastTransient: null })
    expect(await selection(page)).toEqual([n.boardB])
    // One undo step restores the original position.
    await page.evaluate(() => window.__e2e.canvas().undo())
    await frames(page)
    expect(
      await page.evaluate(() => window.__e2e.node(window.__e2e.ids.boardB)?.styles['left']),
    ).toBe(500)
  })

  test('dragging an absolutely positioned layer moves it; snapping aligns to the parent edge', async ({
    page,
  }) => {
    const c = await centerOf(page, 'floating')
    await page.mouse.click(c.x, c.y)
    await page.mouse.down()
    // Move right by 48 → right edge at 398, within 6px of the artboard edge (400) → snaps to +50.
    await page.mouse.move(c.x + 20, c.y, { steps: 3 })
    await page.mouse.move(c.x + 48, c.y, { steps: 3 })
    await page.mouse.up()
    await frames(page)
    const left = await page.evaluate(
      () => window.__e2e.node(window.__e2e.ids.floating)?.styles['left'],
    )
    expect(left).toBe(350)
  })

  test('dragging a flex child reorders it among its siblings', async ({ page }) => {
    const n = await ids(page)
    const c = await centerOf(page, 'second')
    await page.mouse.click(c.x, c.y)
    await page.mouse.down()
    await page.mouse.move(c.x, c.y - 30, { steps: 4 })
    // Board A's top padding (above Section): over Section itself the drag would reparent into it.
    await page.mouse.move(c.x, 62, { steps: 4 })
    await page.mouse.up()
    await frames(page)
    expect(await page.evaluate((id) => window.__e2e.children(id), n.boardA)).toEqual([
      n.second,
      n.section,
      n.icon,
      n.floating,
    ])
  })

  test('corner resize with Shift keeps the aspect ratio', async ({ page }) => {
    await page.evaluate(() => window.__e2e.canvas().select([window.__e2e.ids.boardB]))
    await frames(page)
    await page.mouse.move(850, 350)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    await page.mouse.move(880, 360, { steps: 3 })
    await page.mouse.move(910, 370, { steps: 3 })
    const during = await page.evaluate(
      () => window.__e2e.node(window.__e2e.ids.boardB)?.styles['width'],
    )
    expect(during).toBe(300)
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await frames(page)
    const s = await page.evaluate(() => window.__e2e.node(window.__e2e.ids.boardB)?.styles)
    expect(s?.['width']).toBe(360)
    expect(s?.['height']).toBe(360)
    expect(s?.['left']).toBe(500)
  })

  test('edge resize of a flex child sets a fixed width', async ({ page }) => {
    const n = await ids(page)
    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.second)
    await frames(page)
    const b = await page.evaluate((id) => window.__e2e.canvas().getNodeBounds(id), n.second)
    if (!b) throw new Error('no bounds')
    const x = b.x + 50 + b.width
    const y = b.y + 50 + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 30, y, { steps: 4 })
    await page.mouse.up()
    await frames(page)
    expect(await page.evaluate((id) => window.__e2e.node(id)?.styles['width'], n.second)).toBe(150)
  })

  test('nodePathAt: the top-level node down to the deepest layer under a point', async ({
    page,
  }) => {
    const n = await ids(page)
    await frames(page)
    const r = await page.evaluate((id) => {
      const c = window.__e2e.canvas()
      const b = c.getNodeBounds(id)
      if (!b) return null
      return {
        path: c.nodePathAt({ x: b.x + b.width / 2, y: b.y + b.height / 2 }),
        empty: c.nodePathAt({ x: -99_999, y: -99_999 }),
      }
    }, n.second)
    expect(r?.path?.at(-1)).toBe(n.second)
    expect(r?.path?.length).toBeGreaterThan(1)
    expect(r?.empty).toBeNull()
  })

  test('keyboard: nudge, delete, undo, duplicate, escape', async ({ page }) => {
    const n = await ids(page)
    const c = await centerOf(page, 'floating')
    await page.mouse.click(c.x, c.y)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await frames(page)
    let s = await page.evaluate((id) => window.__e2e.node(id)?.styles, n.floating)
    expect([s?.['left'], s?.['top']]).toEqual([302, 210])
    await page.keyboard.press('Delete')
    await frames(page)
    expect(await page.evaluate((id) => window.__e2e.node(id), n.floating)).toBeUndefined()
    expect(await selection(page)).toEqual([])
    await page.keyboard.press('Control+z')
    await frames(page)
    // Loro's UndoManager re-creates a deleted node under a new TreeID; the canvas selects it.
    const restored = await page.evaluate((board) => {
      const e = window.__e2e
      return e
        .children(board)
        .map((id) => e.node(id))
        .find((x) => x?.name === 'Floating')
    }, n.boardA)
    expect(restored?.styles['left']).toBe(302)
    expect(await selection(page)).toEqual([restored?.id])

    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.boardB)
    await page.keyboard.press('Control+d')
    await frames(page)
    const tops = await page.evaluate(() => window.__e2e.children(window.__e2e.pageId))
    expect(tops).toHaveLength(4)
    const copy = tops[2] as string
    expect(await selection(page)).toEqual([copy])
    expect(await page.evaluate((id) => window.__e2e.node(id)?.styles['left'], copy)).toBe(880)

    await page.evaluate((id) => window.__e2e.canvas().select([id]), n.title)
    await page.keyboard.press('Escape')
    expect(await selection(page)).toEqual([n.section])
  })

  test('artboard tool draws a top-level frame; rectangle tool draws inside an artboard', async ({
    page,
  }) => {
    const n = await ids(page)
    await page.mouse.click(950, 650)
    await page.keyboard.press('a')
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('artboard')
    await page.mouse.move(100, 450)
    await page.mouse.down()
    await page.mouse.move(200, 520, { steps: 3 })
    await page.mouse.move(300, 600, { steps: 3 })
    await page.mouse.up()
    await frames(page)
    const tops = await page.evaluate(() => window.__e2e.children(window.__e2e.pageId))
    const frame = await page.evaluate((id) => window.__e2e.node(id), tops.at(-1) as string)
    expect(frame?.type).toBe('frame')
    expect(frame?.styles).toMatchObject({
      left: 50,
      top: 400,
      width: 200,
      height: 150,
      backgroundColor: '#FFFFFF',
    })
    expect(await selection(page)).toEqual([frame?.id])
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('select')

    await page.keyboard.press('r')
    await page.mouse.move(600, 100)
    await page.mouse.down()
    await page.mouse.move(650, 150, { steps: 3 })
    await page.mouse.up()
    await frames(page)
    const kids = await page.evaluate((id) => window.__e2e.children(id), n.boardB)
    expect(kids).toHaveLength(1)
    const rect = await page.evaluate((id) => window.__e2e.node(id), kids[0] as string)
    expect(rect?.type).toBe('rect')
    expect(rect?.styles).toMatchObject({
      position: 'absolute',
      left: 50,
      top: 50,
      width: 50,
      height: 50,
    })
  })

  test('text tool creates a text node and edits it in place (bound to LoroText)', async ({
    page,
  }) => {
    const n = await ids(page)
    await page.mouse.click(950, 650)
    await page.keyboard.press('t')
    await page.mouse.click(700, 250)
    await page.waitForFunction(
      () =>
        window.__e2e.events.textEdit.at(-1) !== undefined &&
        window.__e2e.events.textEdit.at(-1) !== null,
    )
    const id = (await page.evaluate(() => window.__e2e.events.textEdit.at(-1))) as string
    await page.keyboard.type('Hi there')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line 2')
    await frames(page)
    const node = await page.evaluate((x) => window.__e2e.node(x), id)
    expect(node?.text).toBe('Hi there\nline 2')
    expect(node?.parentId).toBe(n.boardB)
    await page.keyboard.press('Escape')
    await frames(page)
    expect(await page.evaluate(() => window.__e2e.events.textEdit.at(-1))).toBeNull()
    expect(await selection(page)).toEqual([id])
    // One undo removes the whole text session (creation + typing).
    await page.evaluate(() => window.__e2e.canvas().undo())
    await frames(page)
    expect(await page.evaluate((x) => window.__e2e.node(x), id)).toBeUndefined()

    // An abandoned empty text node is removed.
    await page.keyboard.press('t')
    await page.mouse.click(700, 150)
    await page.waitForFunction(() => window.__e2e.events.textEdit.at(-1) !== null)
    const empty = (await page.evaluate(() => window.__e2e.events.textEdit.at(-1))) as string
    await page.keyboard.press('Escape')
    await frames(page)
    expect(await page.evaluate((x) => window.__e2e.node(x), empty)).toBeUndefined()
  })

  test('double-click edits text; remote inserts keep the caret in place', async ({ page }) => {
    const n = await ids(page)
    const t = await centerOf(page, 'title')
    await page.mouse.click(t.x, t.y)
    await page.mouse.dblclick(t.x, t.y)
    await page.mouse.dblclick(t.x, t.y)
    await page.waitForFunction((id) => window.__e2e.events.textEdit.at(-1) === id, n.title)
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await page.evaluate((id) => window.__e2e.remoteInsertText(id, 0, '>> '), n.title)
    await frames(page)
    await page.keyboard.type('?')
    await frames(page)
    expect(await page.evaluate((id) => window.__e2e.node(id)?.text, n.title)).toBe('>> Hello!?')
    expect(await page.evaluate((id) => window.__e2e.elementOf(id)?.textContent, n.title)).toBe(
      '>> Hello!?',
    )
    await page.keyboard.press('Escape')
  })

  test('read-only mode allows selection but no edits', async ({ page }) => {
    const n = await ids(page)
    await page.evaluate(() => window.__e2e.canvas().setReadOnly(true))
    await page.mouse.move(560, 38)
    await page.mouse.down()
    await page.mouse.move(660, 78, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('Delete')
    await page.keyboard.press('r')
    await frames(page)
    expect(await selection(page)).toEqual([n.boardB])
    expect(await page.evaluate((id) => window.__e2e.node(id)?.styles['left'], n.boardB)).toBe(500)
    expect(await page.evaluate(() => window.__e2e.canvas().getTool())).toBe('select')
  })
})

test.describe('viewport', () => {
  test('Ctrl+wheel zooms at the cursor; wheel pans', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const c = window.__e2e.canvas()
      const root = document.querySelector('.ic-root') as HTMLElement
      const before = c.screenToCanvas({ x: 300, y: 200 })
      root.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 200,
          deltaY: -20,
          ctrlKey: true,
        }),
      )
      const after = c.screenToCanvas({ x: 300, y: 200 })
      const zoom = c.getViewport().zoom
      root.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 200,
          deltaX: 40,
          deltaY: 10,
        }),
      )
      return { before, after, zoom, v: c.getViewport() }
    })
    expect(r.zoom).toBeGreaterThan(1)
    expect(r.after.x).toBeCloseTo(r.before.x, 6)
    expect(r.after.y).toBeCloseTo(r.before.y, 6)
    const z = r.zoom
    expect(r.v.x).toBeCloseTo(r.after.x - 300 / z + 40 / z, 6)
  })

  test('Space+drag and the hand tool pan', async ({ page }) => {
    await page.mouse.click(950, 650)
    await page.mouse.move(500, 500)
    await page.keyboard.down(' ')
    await page.mouse.down()
    await page.mouse.move(400, 450, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up(' ')
    let v = await page.evaluate(() => window.__e2e.canvas().getViewport())
    expect([v.x, v.y]).toEqual([50, 0])
    await page.keyboard.press('h')
    await page.mouse.move(500, 500)
    await page.mouse.down()
    await page.mouse.move(550, 500, { steps: 3 })
    await page.mouse.up()
    v = await page.evaluate(() => window.__e2e.canvas().getViewport())
    expect([v.x, v.y]).toEqual([0, 0])
    expect(await selection(page)).toEqual([])
  })

  test('zoom presets, zoom to fit and zoom to selection', async ({ page }) => {
    await page.mouse.click(950, 650)
    await page.evaluate(() => {
      const c = window.__e2e.canvas()
      c.zoomIn()
    })
    await page.waitForFunction(() => window.__e2e.canvas().getViewport().zoom === 2)
    await page.keyboard.press('Control+0')
    await page.waitForFunction(() => window.__e2e.canvas().getViewport().zoom === 1)
    await page.keyboard.press('Shift+1')
    await page.waitForFunction(() => window.__e2e.canvas().getViewport().zoom < 0.1)
    await page.evaluate(() => window.__e2e.canvas().select([window.__e2e.ids.boardB]))
    await page.keyboard.press('Shift+2')
    await page.waitForFunction(
      () => Math.abs(window.__e2e.canvas().getViewport().zoom - (700 - 96) / 300) < 1e-6,
    )
  })

  test('re-rasters crisply after a zoom gesture settles', async ({ page }) => {
    const clip = { x: 60, y: 60, width: 180, height: 60 }
    const crisp = await page.screenshot({ clip })
    // Record will-change toggles on the world layer.
    await page.evaluate(() => {
      const world = document.querySelector<HTMLElement>('.ic-world') as HTMLElement & {
        __wc?: string[]
      }
      world.__wc = []
      new MutationObserver(() => world.__wc?.push(world.style.willChange)).observe(world, {
        attributes: true,
        attributeFilter: ['style'],
      })
    })
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: -200, y: -200, zoom: 0.3 }))
    await page.waitForTimeout(400)
    await page.evaluate(() => window.__e2e.canvas().setViewport({ x: -50, y: -50, zoom: 1 }))
    await page.waitForTimeout(400)
    const settled = await page.screenshot({ clip })
    expect(Buffer.compare(settled, crisp)).toBe(0)
    // After each settle the hint is dropped for one frame ('auto') and restored ('').
    const toggles = await page.evaluate(
      () => (document.querySelector('.ic-world') as HTMLElement & { __wc?: string[] }).__wc ?? [],
    )
    expect(toggles.filter((v) => v === 'auto').length).toBeGreaterThanOrEqual(2)
    expect(toggles.at(-1)).toBe('')
  })
})

test.describe('multiplayer', () => {
  test('renders remote cursors with name pills and remote selections', async ({ page }) => {
    const n = await ids(page)
    await page.evaluate(
      ([pageId, boardB]) =>
        window.__e2e.setPresence([
          {
            userId: 'u2',
            name: 'Ada',
            color: '#E5484D',
            pageId,
            cursor: { x: 100, y: 400 },
            selection: [boardB as string],
          },
        ]),
      [await page.evaluate(() => window.__e2e.pageId), n.boardB] as const,
    )
    await frames(page)
    const red = [0xe5, 0x48, 0x4d]
    // Arrow body just below the tip (world 100,400 → client 150,450).
    expect(isColor(await overlayPixel(page, 152, 458), red)).toBe(true)
    // Name pill.
    expect(isColor(await overlayPixel(page, 163, 470), red)).toBe(true)
    // Remote selection outline around Board B.
    expect(isColor(await overlayPixel(page, 549, 200), red)).toBe(true)
  })
})

test.describe('scheduling', () => {
  test('goes fully idle (no animation frames) once nothing changes', async ({ page }) => {
    await page.waitForTimeout(500)
    const calls = await page.evaluate(async () => {
      let n = 0
      const raf = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        n++
        return raf(cb)
      }
      await new Promise((r) => setTimeout(r, 500))
      window.requestAnimationFrame = raf
      return n
    })
    expect(calls).toBe(0)
  })

  test('a document change schedules exactly the frames it needs', async ({ page }) => {
    await page.waitForTimeout(300)
    const calls = await page.evaluate(async () => {
      let n = 0
      const raf = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        n++
        return raf(cb)
      }
      window.__e2e.setStyle(window.__e2e.ids.box, 'width', 60)
      await new Promise((r) => setTimeout(r, 300))
      window.requestAnimationFrame = raf
      return n
    })
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThanOrEqual(3)
  })
})
