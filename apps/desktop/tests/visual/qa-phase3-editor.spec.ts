/**
 * QA (Phase 3): adversarial editor tests in browser mode (mock bridge) — every new action is
 * exactly one undo step (and redoes exactly), paste never lands inside a locked or hidden
 * frame, deleting a main from the canvas keeps its instances and undo restores it, detach then
 * edit, picker inserts that would nest a component in itself, instance content refuses
 * structure commands, and pasting instances into a file without their components (twice).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const EMPTY_FILE = '/?fixture=design#/file/f-baren'
const COMPONENTS_FILE = '/?fixture=design&editorScene=components#/file/f-acme'
const ROTATION_FILE = '/?fixture=design&editorScene=rotation#/file/f-acme'

interface Node {
  id: string
  type: string
  name: string
  parentId: string | null
  children: string[]
  styles: Record<string, string | number>
  text?: string
  componentKey?: string
  hidden?: boolean
  locked?: boolean
  mainDeleted?: boolean
  status?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Hook = any

async function openEditor(page: Page, url: string) {
  await page.goto(url)
  await page.getByTestId('editor').waitFor()
  await page.waitForFunction(
    () =>
      (window as unknown as { __barenEditor?: { canvas: unknown } }).__barenEditor?.canvas != null,
  )
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await idle(page)
}

async function idle(page: Page) {
  await page.waitForFunction(
    () =>
      (window as unknown as { __barenEditor: Hook }).__barenEditor.canvas.getStats().pendingWork ===
      0,
  )
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

async function inPage<T, A>(page: Page, fn: (hook: Hook, arg: A) => T, arg: A): Promise<T> {
  return page.evaluate(
    ([source, a]) => {
      const hook = (window as unknown as { __barenEditor: Hook }).__barenEditor
      // eslint-disable-next-line no-new-func
      return (
        new Function('hook', 'arg', `return (${source})(hook, arg)`) as (h: Hook, x: unknown) => T
      )(hook, a)
    },
    [fn.toString(), arg] as const,
  )
}

/** Id-free structure of the whole document (undo of a delete re-creates nodes under new ids). */
async function shape(page: Page): Promise<string> {
  return inPage(
    page,
    (hook) => {
      const snap = hook.snapshot()
      const walk = (id: string): unknown => {
        const n = snap.nodes[id]
        const { id: _i, parentId: _p, mainId: _m, children, ...rest } = n
        return { ...rest, children: children.map(walk) }
      }
      return JSON.stringify({
        pages: snap.pageIds.map(walk),
        tokens: snap.tokens,
        components: Object.keys(snap.components ?? {}).sort(),
      })
    },
    null,
  )
}

async function select(page: Page, ids: string[]) {
  await inPage(page, (hook, list) => hook.canvas.select(list), ids)
}

async function selection(page: Page): Promise<string[]> {
  return inPage(page, (hook) => hook.canvas.getSelection(), null)
}

async function node(page: Page, id: string): Promise<Node | undefined> {
  return inPage(page, (hook, ref) => hook.session.resolver.resolveNode(ref), id)
}

async function nodes(page: Page): Promise<Node[]> {
  return inPage(page, (hook) => Object.values(hook.snapshot().nodes), null)
}

async function idByPath(page: Page, path: string[]): Promise<string> {
  return inPage(
    page,
    (hook, names) => {
      const { tree, store } = hook.session
      let id = store.getState().pageId
      for (const name of names) {
        const next = tree.children(id).find((c: string) => tree.meta(c)?.name === name)
        if (!next) throw new Error(`no layer ${name}`)
        id = next
      }
      return id
    },
    path,
  )
}

async function focusCanvas(page: Page) {
  await page
    .locator('.ic-root')
    .first()
    .focus()
    .catch(() => undefined)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

async function grantClipboard(context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
}

/** An artboard with two rectangles on the empty file's page. */
async function seedBoard(page: Page): Promise<{ board: string; a: string; b: string }> {
  const ids = await inPage(
    page,
    (hook) => {
      const { schema, session } = hook
      const doc = session.doc
      const pageId = session.store.getState().pageId
      const board = schema.createNode(doc, {
        type: 'frame',
        parentId: pageId,
        name: 'Board',
        styles: { left: 0, top: 0, width: 600, height: 400, backgroundColor: '#FFFFFF' },
      })
      const rect = (name: string, left: number, top: number, color: string) =>
        schema.createNode(doc, {
          type: 'rect',
          parentId: board,
          name,
          styles: {
            position: 'absolute',
            left,
            top,
            width: 120,
            height: 80,
            backgroundColor: color,
          },
        })
      const a = rect('Red', 40, 40, '#FF3B30')
      const b = rect('Blue', 240, 160, '#007AFF')
      hook.canvas.setViewport({ x: -100, y: -100, zoom: 1 }, { animate: false })
      return { board, a, b }
    },
    null,
  )
  await idle(page)
  return ids
}

/**
 * `act` changes the document in exactly one undo step: Ctrl+Z restores the structure from
 * before, Ctrl+Shift+Z the one after.
 */
async function expectOneStep(page: Page, label: string, act: () => Promise<void>) {
  await idle(page)
  const before = await shape(page)
  await act()
  await expect.poll(() => shape(page), { message: `${label}: changed` }).not.toBe(before)
  await idle(page)
  const after = await shape(page)
  await focusCanvas(page)
  await page.keyboard.press('Control+z')
  await expect.poll(() => shape(page), { message: `${label}: undo` }).toBe(before)
  await idle(page)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => shape(page), { message: `${label}: redo` }).toBe(after)
  await idle(page)
}

async function childrenOf(page: Page, id: string): Promise<string[]> {
  return (await node(page, id))?.children ?? []
}

async function waitClipboard(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const items = await navigator.clipboard.read()
        return items.some((i) => i.types.includes('web application/x-baren-clipboard+json'))
      }),
    )
    .toBe(true)
}

test.describe('QA: one undo step per action', () => {
  test.beforeEach(async ({ context }) => grantClipboard(context))

  test('group, ungroup, rotation, create component, paste, paste in place, duplicate, cut, delete', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const { board, a, b } = await seedBoard(page)
    await expectOneStep(page, 'group', async () => {
      await select(page, [a, b])
      await focusCanvas(page)
      await page.keyboard.press('Control+g')
    })
    const group = (await childrenOf(page, board))[0] as string
    expect((await node(page, group))?.type).toBe('group')
    await expectOneStep(page, 'ungroup', async () => {
      await select(page, [group])
      await focusCanvas(page)
      await page.keyboard.press('Control+Shift+g')
    })
    expect(await childrenOf(page, board)).toEqual([a, b])
    await expectOneStep(page, 'rotation field', async () => {
      await select(page, [a])
      const field = page.getByRole('textbox', { name: 'Rotation' })
      await field.fill('30')
      await field.press('Enter')
    })
    await expectOneStep(page, 'paste', async () => {
      await select(page, [b])
      await focusCanvas(page)
      await page.keyboard.press('Control+c')
      await waitClipboard(page)
      await select(page, [board])
      await page.keyboard.press('Control+v')
    })
    await expectOneStep(page, 'paste in place', async () => {
      await select(page, [board])
      await focusCanvas(page)
      await page.keyboard.press('Control+Shift+v')
    })
    await expectOneStep(page, 'duplicate', async () => {
      await select(page, [a])
      await focusCanvas(page)
      await page.keyboard.press('Control+d')
    })
    await expectOneStep(page, 'cut', async () => {
      await select(page, [a])
      await focusCanvas(page)
      await page.keyboard.press('Control+x')
    })
    await expectOneStep(page, 'delete', async () => {
      await select(page, [b])
      await focusCanvas(page)
      await page.keyboard.press('Delete')
    })
    await expectOneStep(page, 'create component', async () => {
      await select(page, [board])
      await focusCanvas(page)
      await page.keyboard.press('Control+Alt+k')
    })
    expect((await node(page, board))?.componentKey).toMatch(/^[0-9a-z]{16}$/)
  })

  test('insert instance, text override, hide override, reset overrides, detach', async ({
    page,
  }) => {
    await openEditor(page, COMPONENTS_FILE)
    const desktop = await idByPath(page, ['Pricing — Desktop'])
    await expectOneStep(page, 'insert instance (picker)', async () => {
      await select(page, [desktop])
      await focusCanvas(page)
      await page.keyboard.press('k')
      const picker = page.getByRole('dialog', { name: 'Components' })
      await picker.getByRole('button', { name: 'Insert Badge / New' }).click()
      await expect(picker).toBeHidden()
    })
    const button = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team', 'Button / Primary'])
    const label = (await childrenOf(page, button))[0] as string
    await expectOneStep(page, 'text override', async () => {
      await inPage(page, (hook, id) => hook.canvas.editText(id), label)
      await page.keyboard.press('Control+a')
      await page.keyboard.type('Buy')
      await page.keyboard.press('Escape')
    })
    await expectOneStep(page, 'hide override', async () => {
      await select(page, [button])
      const row = page
        .getByRole('treeitem')
        .filter({ has: page.getByText('Button / Primary', { exact: true }) })
        .last()
      await row.hover()
      await row.getByRole('button', { name: 'Hide' }).click()
    })
    await expectOneStep(page, 'reset overrides', async () => {
      await select(page, [button])
      await page.getByRole('button', { name: 'Reset overrides' }).click()
    })
    const starter = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Starter'])
    await expectOneStep(page, 'detach', async () => {
      await select(page, [starter])
      await focusCanvas(page)
      await page.keyboard.press('Control+Alt+b')
    })
    expect((await node(page, starter))?.type).toBe('frame')
  })
})

test.describe('QA: groups keep what you see', () => {
  /** Measured world frames (canvas) of `ids`. */
  async function framesOf(page: Page, ids: string[]) {
    return inPage(page, (hook, list) => list.map((id: string) => hook.canvas.getNodeFrame(id)), ids)
  }

  function expectSameFrames(
    a: ({ x: number; y: number; width: number; height: number; rotation: number } | null)[],
    b: ({ x: number; y: number; width: number; height: number; rotation: number } | null)[],
  ) {
    expect(b).toHaveLength(a.length)
    a.forEach((f, i) => {
      const g = b[i]
      for (const k of ['x', 'y', 'width', 'height', 'rotation'] as const) {
        expect(Math.abs((g?.[k] ?? NaN) - (f?.[k] ?? NaN)), `frame ${i}.${k}`).toBeLessThan(0.6)
      }
    })
  }

  test('ungroup and regroup a rotated sticker inside a flex frame: nothing moves', async ({
    page,
  }) => {
    await openEditor(page, ROTATION_FILE)
    const group = await idByPath(page, ['Landing — Desktop', 'Hero', 'Launch sticker'])
    const hero = await idByPath(page, ['Landing — Desktop', 'Hero'])
    const children = (await node(page, group))?.children ?? []
    expect(children).toHaveLength(2)
    // Turn the whole group too (Layout rotation field), then ungroup.
    await select(page, [group])
    const field = page.getByRole('textbox', { name: 'Rotation' })
    await field.fill('20')
    await field.press('Enter')
    await idle(page)
    const before = await framesOf(page, children)
    await focusCanvas(page)
    await page.keyboard.press('Control+Shift+g')
    await expect.poll(async () => node(page, group)).toBeUndefined()
    await idle(page)
    for (const id of children) {
      expect((await node(page, id))?.parentId).toBe(hero)
      // Still out of the Hero's flex flow.
      expect((await node(page, id))?.styles['position']).toBe('absolute')
    }
    expectSameFrames(before, await framesOf(page, children))
    // Group them again: the new group is absolute in the flex frame, the children stay put.
    await select(page, children)
    await focusCanvas(page)
    await page.keyboard.press('Control+g')
    await expect
      .poll(async () => (await node(page, children[0] as string))?.parentId)
      .not.toBe(hero)
    const regrouped = (await node(page, children[0] as string))?.parentId as string
    expect((await node(page, regrouped))?.type).toBe('group')
    expect((await node(page, regrouped))?.styles['position']).toBe('absolute')
    await idle(page)
    expectSameFrames(before, await framesOf(page, children))
  })
})

test.describe('QA: paste targets', () => {
  test.beforeEach(async ({ context }) => grantClipboard(context))

  test('paste with a locked or hidden frame selected lands beside it, not inside', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const { board, a } = await seedBoard(page)
    await select(page, [a])
    await focusCanvas(page)
    await page.keyboard.press('Control+c')
    await waitClipboard(page)
    const pageId = await inPage(page, (hook) => hook.session.store.getState().pageId, null)
    // Locked artboard selected (e.g. from the layers panel).
    await inPage(
      page,
      (hook, id) => hook.schema.setNodeProps(hook.session.doc, id, { locked: true }),
      board,
    )
    await select(page, [board])
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await nodes(page)).filter((n) => n.name === 'Red').length)
      .toBe(2)
    let pasted = (await nodes(page)).filter((n) => n.name === 'Red').find((n) => n.id !== a)
    expect(pasted?.parentId).toBe(pageId)
    // A child of the locked artboard selected: the paste goes next to the artboard too.
    await select(page, [a])
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await nodes(page)).filter((n) => n.name === 'Red').length)
      .toBe(3)
    expect((await childrenOf(page, board)).length).toBe(2)
    // Hidden artboard selected: the paste must stay visible.
    await inPage(
      page,
      (hook, id) => hook.schema.setNodeProps(hook.session.doc, id, { locked: false, hidden: true }),
      board,
    )
    await select(page, [board])
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await nodes(page)).filter((n) => n.name === 'Red').length)
      .toBe(4)
    pasted = (await nodes(page))
      .filter((n) => n.name === 'Red' && n.parentId !== board)
      .find((n) => n.parentId === pageId)
    expect(pasted).toBeDefined()
    expect((await childrenOf(page, board)).length).toBe(2)
  })

  test('pasting an instance twice into a file without its component creates the mains once', async ({
    page,
  }) => {
    await openEditor(page, COMPONENTS_FILE)
    await select(page, [await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])])
    await focusCanvas(page)
    await page.keyboard.press('Control+c')
    await waitClipboard(page)
    // Other apps get the resolved content as HTML (overrides applied) and the name as text.
    const html = await page.evaluate(async () => {
      for (const item of await navigator.clipboard.read())
        if (item.types.includes('text/html')) return (await item.getType('text/html')).text()
      return ''
    })
    expect(html).toContain('Start free trial')
    expect(html).toContain('$24')
    expect(html).not.toContain('baren-asset://')
    await openEditor(page, EMPTY_FILE)
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await nodes(page)).filter((n) => n.type === 'instance').length)
      .toBeGreaterThan(0)
    await idle(page)
    await focusCanvas(page)
    await page.keyboard.press('Control+v')
    await expect
      .poll(
        async () =>
          (await nodes(page)).filter((n) => n.type === 'instance' && n.name === 'Team').length,
      )
      .toBe(2)
    // Card / Plan, Button / Primary and Badge / New: one main each on the Components page.
    const mains = (await nodes(page)).filter((n) => n.type === 'frame' && n.componentKey)
    expect(mains.map((m) => m.name).sort()).toEqual([
      'Badge / New',
      'Button / Primary',
      'Card / Plan',
    ])
    // Both instances resolve, keep the Team overrides and follow an edit of the new main.
    const team = (await nodes(page)).filter((n) => n.type === 'instance' && n.name === 'Team')
    for (const t of team) {
      const r = await node(page, t.id)
      expect(r?.status).toBe('ok')
      expect(r?.styles['backgroundColor']).toBe('#F7F8FC')
    }
    const card = mains.find((m) => m.name === 'Card / Plan') as Node
    await inPage(
      page,
      (hook, id) =>
        hook.schema.transact(
          hook.session.doc,
          () => hook.schema.setStyles(hook.session.doc, id, { borderRadius: 3 }),
          { origin: 'editor:inspector' },
        ),
      card.id,
    )
    for (const t of team) {
      await expect.poll(async () => (await node(page, t.id))?.styles['borderRadius']).toBe(3)
    }
    // The pasted content renders on the canvas.
    await expect(page.locator('.ic-root').getByText('Start free trial').first()).toBeVisible()
  })
})

test.describe('QA: components through the UI', () => {
  test.beforeEach(async ({ context }) => grantClipboard(context))

  test('deleting a main from the canvas keeps instances; undo restores it and Go to main works', async ({
    page,
  }) => {
    await openEditor(page, COMPONENTS_FILE)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const main = await idByPath(page, ['Button / Primary'])
    const team = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])
    await select(page, [main])
    await focusCanvas(page)
    await page.keyboard.press('Delete')
    await expect.poll(async () => node(page, main)).toBeUndefined()
    await idle(page)
    // The Team card's nested button still renders from the retained main.
    await expect(page.locator('.ic-root').getByText('Start free trial')).toBeVisible()
    const button = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team', 'Button / Primary'])
    await select(page, [button])
    await expect(page.getByText('Main component deleted')).toBeVisible()
    await focusCanvas(page)
    await page.keyboard.press('Control+z')
    await expect
      .poll(async () =>
        (await nodes(page)).some((n) => n.componentKey && n.name === 'Button / Primary'),
      )
      .toBe(true)
    await select(page, [team])
    await page.getByRole('button', { name: 'Go to main component' }).click()
    await expect
      .poll(async () => {
        const id = (await selection(page))[0]
        return id ? (await node(page, id))?.name : null
      })
      .toBe('Card / Plan')
    expect(errors).toEqual([])
  })

  test('detach, then edit: the main and the detached copy no longer affect each other', async ({
    page,
  }) => {
    await openEditor(page, COMPONENTS_FILE)
    const starter = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Starter'])
    await select(page, [starter])
    await focusCanvas(page)
    await page.keyboard.press('Control+Alt+b')
    await expect.poll(async () => (await node(page, starter))?.type).toBe('frame')
    const planName = await idByPath(page, [
      'Pricing — Desktop',
      'Plans',
      'Starter',
      'Header',
      'Plan name',
    ])
    const mainCard = (await nodes(page)).find(
      (n) => n.type === 'frame' && n.componentKey && n.name === 'Card / Plan',
    ) as Node
    await inPage(
      page,
      (hook, id) =>
        hook.schema.transact(
          hook.session.doc,
          () => hook.schema.setStyles(hook.session.doc, id, { borderRadius: 2 }),
          { origin: 'editor:inspector' },
        ),
      mainCard.id,
    )
    expect((await node(page, starter))?.styles['borderRadius']).toBe(14)
    await inPage(
      page,
      (hook, id) => hook.schema.setTextAt(hook.session.doc, id, 'Detached', { origin: 'x' }),
      planName,
    )
    // The main's plan name is unchanged, and the Team instance still shows its own override.
    const mainHeader = (await childrenOf(page, mainCard.id))[0] as string
    const mainPlan = (await childrenOf(page, mainHeader))[0] as string
    expect((await node(page, mainPlan))?.text).toBe('Starter')
  })

  test('the picker never nests a component in itself', async ({ page }) => {
    await openEditor(page, COMPONENTS_FILE)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // Go to the Card / Plan main and select its header (inside the main).
    const team = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team'])
    await select(page, [team])
    await page.getByRole('button', { name: 'Go to main component' }).click()
    await expect
      .poll(async () => {
        const id = (await selection(page))[0]
        return id ? (await node(page, id))?.name : null
      })
      .toBe('Card / Plan')
    const main = (await selection(page))[0] as string
    const header = (await childrenOf(page, main))[0] as string
    await select(page, [header])
    await focusCanvas(page)
    await page.keyboard.press('k')
    const picker = page.getByRole('dialog', { name: 'Components' })
    await picker.getByRole('button', { name: 'Insert Card / Plan' }).click()
    await expect(picker).toBeHidden()
    const inserted = (await selection(page))[0] as string
    await expect
      .poll(async () => (inserted ? (await node(page, inserted))?.type : null))
      .toBe('instance')
    // Not inside its own main: nothing below the main is an instance of it.
    const key = (await node(page, main))?.componentKey
    const inside = await inPage(
      page,
      (hook, args) => {
        const out: string[] = []
        const stack = [args.main]
        const snap = hook.snapshot()
        for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
          const n = snap.nodes[id]
          if (n.type === 'instance' && n.componentKey === args.key) out.push(id)
          stack.push(...n.children)
        }
        return out
      },
      { main, key },
    )
    expect(inside).toEqual([])
    expect((await node(page, inserted))?.status).toBe('ok')
    expect(errors).toEqual([])
  })

  test('structure commands ignore instance content', async ({ page }) => {
    await openEditor(page, COMPONENTS_FILE)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const label = await idByPath(page, ['Pricing — Desktop', 'Plans', 'Team', 'Button / Primary'])
    const before = await shape(page)
    await select(page, [label])
    await focusCanvas(page)
    for (const keys of ['Control+g', 'Control+Alt+k', 'Control+Shift+g', 'Control+Alt+b']) {
      await page.keyboard.press(keys)
    }
    await idle(page)
    expect(await shape(page)).toBe(before)
    expect(errors).toEqual([])
  })
})
