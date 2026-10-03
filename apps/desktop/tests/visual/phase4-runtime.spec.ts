/**
 * Phase 4 runtime (docs/phase4/contract.md §14.2) in browser mode: every host tool runs in the
 * editor's renderer through the mock bridge's in-page agent loop (`window.__barenAgent`),
 * against the live Loro document and a real canvas — create_artboard, write_html (several
 * calls, images, clones), geometry measured, update_styles (ignoredStyles), set_text_content,
 * duplicate_nodes (descendantIdMap), move_nodes (affectedParents), delete_nodes, the readers,
 * one undo step per call, instance overrides, the viewer refusal and agent presence.
 */
import { expect, test, type Page } from '@playwright/test'

const EMPTY_FILE = '/?fixture=design#/file/f-baren'
const COMPONENTS_FILE = '/?fixture=design&editorScene=components#/file/f-acme'

interface AgentResponse {
  id: string
  ok: boolean
  header?: { file: { id: string; name: string }; contentHash: { tokens: string } } | null
  result?: unknown
  touched?: string[]
  error?: { code: string; message: string; data?: Record<string, unknown> }
}

interface NodeLike {
  id: string
  type: string
  name: string
  parentId: string | null
  children: string[]
  styles: Record<string, string | number>
  text?: string
  overrides?: Record<string, { styles?: Record<string, unknown>; text?: string }>
}

interface Shape {
  type: string
  name: string
  styles: Record<string, string | number>
  text?: string
  children: Shape[]
}

async function openEditor(page: Page, url: string) {
  await page.goto(url)
  await page.getByTestId('editor').waitFor()
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __barenEditor?: { canvas: unknown }
      __barenAgent?: { hosts(): unknown[] }
    }
    return w.__barenEditor?.canvas != null && (w.__barenAgent?.hosts().length ?? 0) > 0
  })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

/** One tool call through the mock bridge's agent loop (as main would send it). */
async function call(
  page: Page,
  tool: string,
  args: Record<string, unknown> = {},
  opts: Record<string, unknown> = {},
): Promise<AgentResponse> {
  return page.evaluate(
    ([t, a, o]) =>
      (
        window as unknown as {
          __barenAgent: {
            dispatch(tool: string, args: unknown, opts: unknown): Promise<AgentResponse>
          }
        }
      ).__barenAgent.dispatch(t, a, o),
    [tool, args, opts] as const,
  )
}

/** The successful body of a call. */
async function body<T = Record<string, unknown>>(
  page: Page,
  tool: string,
  args: Record<string, unknown> = {},
  opts: Record<string, unknown> = {},
): Promise<T> {
  const res = await call(page, tool, args, opts)
  if (!res.ok) throw new Error(`${tool}: ${res.error?.code} ${res.error?.message}`)
  return res.result as T
}

async function node(page: Page, id: string): Promise<NodeLike | undefined> {
  return page.evaluate(
    (ref) =>
      (
        window as unknown as {
          __barenEditor: { session: { resolver: { resolveNode(id: string): NodeLike } } }
        }
      ).__barenEditor.session.resolver.resolveNode(ref),
    id,
  )
}

/** The document without ids (undo re-creates nodes with new ids), plus its tokens. */
async function shape(page: Page): Promise<{ pages: Shape[]; tokens: unknown }> {
  return page.evaluate(() => {
    const hook = (
      window as unknown as {
        __barenEditor: {
          snapshot(): { pageIds: string[]; nodes: Record<string, NodeLike>; tokens: unknown }
        }
      }
    ).__barenEditor
    const snap = hook.snapshot()
    const walk = (id: string): Shape => {
      const n = snap.nodes[id] as NodeLike
      const out: Shape = {
        type: n.type,
        name: n.name,
        styles: n.styles,
        children: n.children.map(walk),
      }
      if (n.text !== undefined) out.text = n.text
      return out
    }
    return { pages: snap.pageIds.map(walk), tokens: snap.tokens }
  })
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __barenEditor: { canvas: { undo(): boolean } } }
    ).__barenEditor.canvas.undo(),
  )
}

async function redo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __barenEditor: { canvas: { redo(): boolean } } }
    ).__barenEditor.canvas.redo(),
  )
}

async function fit(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __barenEditor: { canvas: { zoomToFit(o: unknown): void } } }
    ).__barenEditor.canvas.zoomToFit({ animate: false }),
  )
}

/** A canvas element of a node (the canvas renders design layers as real DOM). */
function onCanvas(page: Page, id: string) {
  return page.locator(`.ic-root [data-nid="${id}"]`).first()
}

/** 2×1 PNG (red, blue) as a data URI. */
const PNG_2x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='

test.describe('agent runtime: a design session', () => {
  test('create_artboard → write_html × 4 → reads → updates → duplicate → move → delete', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)

    // --- create_artboard: placed at the origin of the empty page, flex column, white
    const board = await body<{ id: string; worldX: number; worldY: number; width: number }>(
      page,
      'create_artboard',
      { name: 'Landing', styles: { width: '1440px', height: '900px' } },
    )
    expect(board).toMatchObject({ name: 'Landing', worldX: 0, worldY: 0, width: 1440, height: 900 })
    expect((await node(page, board.id))?.styles).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#FFFFFF',
    })
    await fit(page)
    await expect(onCanvas(page, board.id)).toBeAttached()

    // --- write_html: header with an SVG icon and a nav
    const header = await body<{
      createdNodes: {
        id: string
        name: string
        component: string
        parentId: string
        worldX: number | null
        width: number | null
      }[]
      summary: string
      warnings: { code: string }[]
    }>(page, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: `<div layer-name="Header" style="display:flex;justify-content:space-between;align-items:center;padding:24px 48px;background-color:#111111">
  <div style="display:flex;gap:8px;align-items:center">
    <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#FFFFFF"/></svg>
    <p style="color:#FFFFFF;font-size:18px;font-weight:600">Acme</p>
  </div>
  <div style="display:flex;gap:24px"><p style="color:#CCCCCC;font-size:14px">Docs</p><p style="color:#CCCCCC;font-size:14px">Pricing</p></div>
</div>`,
    })
    expect(header.createdNodes).toHaveLength(1)
    const headerNode = header.createdNodes[0] as {
      id: string
      worldX: number | null
      width: number | null
    }
    expect(header.createdNodes[0]).toMatchObject({
      name: 'Header',
      component: 'Frame',
      parentId: board.id,
    })
    // Flex children are measured: position and size known right after the commit.
    expect(headerNode.worldX).toBe(0)
    expect(headerNode.width).toBe(1440)
    expect(header.summary).toContain('Frame "Header"')
    expect(header.summary).toContain('Text "Acme"')
    await expect(onCanvas(page, headerNode.id)).toBeAttached()
    // The icon's <svg> has no xmlns (as HTML inlines it): the canvas still draws its content.
    await expect(
      onCanvas(page, headerNode.id).locator('svg.ic-node circle[r="8"][fill="#FFFFFF"]'),
    ).toBeAttached()

    // --- hero with an image (data URI → stored asset, natural size)
    const hero = await body<{ createdNodes: { id: string }[] }>(page, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: `<div layer-name="Hero" style="display:flex;flex-direction:column;gap:16px;padding:64px 48px">
  <h1 style="font-size:48px;line-height:56px;color:#111111">Design live with agents</h1>
  <img alt="Swatch" src="${PNG_2x1}">
</div>`,
    })
    const heroId = hero.createdNodes[0]?.id as string
    const heroKids = await body<{
      children: {
        id: string
        component: string
        width: number
        height: number
        worldY: number | null
      }[]
    }>(page, 'get_children', { nodeId: heroId })
    expect(heroKids.children.map((c) => c.component)).toEqual(['Text', 'Image'])
    const img = heroKids.children[1] as { id: string; width: number; height: number }
    expect([img.width, img.height]).toEqual([2, 1])
    expect(heroKids.children[0]?.worldY).not.toBeNull()

    // --- a card shell, then two rows into it
    const card = await body<{ createdNodes: { id: string }[] }>(page, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div layer-name="Card" style="display:flex;flex-direction:column;gap:8px;padding:16px;width:480px;border:1px solid #E5E5E5;border-radius:12px"></div>',
    })
    const cardId = card.createdNodes[0]?.id as string
    const rows = await body<{ createdNodes: { id: string; name: string }[] }>(page, 'write_html', {
      targetNodeId: cardId,
      mode: 'insert-children',
      html: `<div layer-name="Row 1" style="display:flex;justify-content:space-between"><p>Starter</p><p>$9</p></div>
<div layer-name="Row 2" style="display:flex;justify-content:space-between"><p>Pro</p><p>$29</p></div>`,
    })
    expect(rows.createdNodes.map((n) => n.name)).toEqual(['Row 1', 'Row 2'])
    const [row1, row2] = rows.createdNodes.map((n) => n.id) as [string, string]

    // --- readers
    const tree = await body<{ summary: string }>(page, 'get_tree_summary', {
      nodeId: board.id,
      depth: 2,
    })
    expect(tree.summary.split('\n')[0]).toBe(`Frame "Landing" (${board.id}) 1440×900`)
    const kids = await body<{
      children: { id: string; worldX: number | null; worldY: number | null; y: number | null }[]
    }>(page, 'get_children', { nodeId: board.id })
    expect(kids.children.map((c) => c.id)).toEqual([headerNode.id, heroId, cardId])
    for (const c of kids.children) expect(c.worldY).not.toBeNull()
    // Stacked in a flex column: each child starts below the previous one.
    const ys = kids.children.map((c) => c.y as number)
    expect(ys[0]).toBe(0)
    expect(ys[1]).toBeGreaterThan(ys[0] as number)
    expect(ys[2]).toBeGreaterThan(ys[1] as number)

    // --- update_styles: artboard fit-content, an inert key on a text layer is ignored
    const text = (
      await body<{ children: { id: string }[] }>(page, 'get_children', { nodeId: row1 })
    ).children[0]?.id as string
    const upd = await body<{
      updated: string[]
      ignoredStyles?: Record<string, string[]>
      warnings: unknown[]
    }>(page, 'update_styles', {
      updates: [
        { nodeIds: [board.id], styles: { height: 'fit-content' } },
        { nodeIds: [text], styles: { gap: '12px', color: '#2563EB' } },
      ],
    })
    expect(upd.updated).toEqual([board.id, text])
    expect(upd.ignoredStyles).toEqual({ [text]: ['gap'] })
    expect((await node(page, text))?.styles['color']).toBe('#2563EB')
    const fitted = await body<{ height: number | null }>(page, 'get_node_info', {
      nodeId: board.id,
    })
    expect(fitted.height).not.toBeNull()
    expect(fitted.height as number).toBeLessThan(900)

    // --- set_text_content
    await body(page, 'set_text_content', { updates: [{ nodeId: text, textContent: 'Hobby' }] })
    expect((await node(page, text))?.text).toBe('Hobby')
    await expect(onCanvas(page, text)).toHaveText('Hobby')

    // --- duplicate_nodes: the map addresses the copy's layers right away
    const dup = await body<{
      duplicates: { sourceId: string; newId: string; parentId: string }[]
      descendantIdMap: Record<string, string>
    }>(page, 'duplicate_nodes', { nodes: [{ id: row2 }] })
    const copy = dup.duplicates[0] as { newId: string; parentId: string }
    expect(copy.parentId).toBe(cardId)
    const row2Text = (await node(page, row2))?.children[0] as string
    const copyText = dup.descendantIdMap[row2Text] as string
    expect((await node(page, copyText))?.parentId).toBe(copy.newId)
    await body(page, 'set_text_content', { updates: [{ nodeId: copyText, textContent: 'Team' }] })
    await expect(onCanvas(page, copyText)).toHaveText('Team')

    // --- move_nodes: the copy first, then the card into the header
    const moved = await body<{ moves: unknown[]; affectedParents: Record<string, string[]> }>(
      page,
      'move_nodes',
      { moves: [{ nodeId: copy.newId, before: row1 }] },
    )
    expect(moved.moves).toEqual([{ nodeId: copy.newId, parentId: cardId, index: 0 }])
    expect(moved.affectedParents[cardId]).toEqual([copy.newId, row1, row2])

    // --- delete_nodes
    const del = await body<{ deleted: string[]; hidden: string[] }>(page, 'delete_nodes', {
      nodeIds: [row2],
    })
    expect(del).toEqual({ deleted: [row2], hidden: [] })
    await expect(onCanvas(page, row2)).not.toBeAttached()

    // --- code readers
    const jsx = await body<string>(page, 'get_jsx', { nodeId: cardId, format: 'inline-styles' })
    expect(jsx).toContain('Hobby')
    expect(jsx).toContain("boxSizing: 'border-box'")
    const tw = await body<string>(page, 'get_jsx', { nodeId: cardId })
    expect(tw).toContain('className=')
    const styles = await body<{ styles: Record<string, Record<string, string>> }>(
      page,
      'get_computed_styles',
      {
        nodeIds: [cardId],
      },
    )
    expect(styles.styles[cardId]).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    })
    const resolved = await body<{ styles: Record<string, Record<string, string>> }>(
      page,
      'get_computed_styles',
      {
        nodeIds: [cardId],
        resolved: true,
      },
    )
    expect(resolved.styles[cardId]?.['width']).toBe('480px')
    const found = await body<{ nodes: { id: string; matched: unknown[] }[] }>(page, 'find_nodes', {
      textValue: 'hob*',
    })
    expect(found.nodes.map((n) => n.id)).toEqual([text])
    const blue = await body<{
      nodes: { id: string; matched: { styleName: string; styleValue: string }[] }[]
    }>(page, 'find_nodes', { filters: [{ styleName: 'color', styleValue: 'rgb(37, 99, 235)' }] })
    expect(blue.nodes[0]?.matched).toEqual([{ styleName: 'color', styleValue: '#2563EB' }])

    // --- tokens
    await body(page, 'create_tokens', {
      tokens: [{ type: 'color', name: '--color-brand', value: '#2563EB' }],
    })
    const css = await body<string>(page, 'get_tokens', {
      format: 'css',
      namePattern: '--color-brand',
    })
    expect(css).toBe(':root {\n  --color-brand: #2563EB;\n}\n')
    await body(page, 'update_styles', {
      updates: [{ nodeIds: [text], styles: { color: 'var(--color-brand)' } }],
    })
    await body(page, 'set_tokens', {
      tokens: [{ name: '--color-brand', newName: '--color-accent' }],
    })
    expect((await node(page, text))?.styles['color']).toBe('var(--color-accent)')
  })

  test('a page target creates placed artboards; replace keeps the artboard position', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const pageId = (await body<{ pageId: string }>(page, 'get_basic_info')).pageId
    const first = await body<{ id: string }>(page, 'create_artboard', {
      name: 'Phone',
      styles: { width: '390px', height: '844px' },
    })
    const out = await body<{
      createdNodes: { id: string; worldX: number; worldY: number }[]
      warnings: { code: string }[]
    }>(page, 'write_html', {
      targetNodeId: pageId,
      mode: 'insert-children',
      html: '<div layer-name="Tablet" style="width:768px;height:1024px;background:#fff"></div><div layer-name="Desk" style="background:#fff"></div>',
    })
    expect(out.createdNodes.map((n) => [n.worldX, n.worldY])).toEqual([
      [470, 0],
      [1318, 0],
    ])
    expect(out.warnings.map((w) => w.code)).toContain('artboard-size-defaulted')
    const replaced = await body<{
      createdNodes: { id: string; worldX: number }[]
      replacedNodeId: string
    }>(page, 'write_html', {
      targetNodeId: first.id,
      mode: 'replace',
      html: '<div layer-name="Phone 2" style="width:390px;height:844px;display:flex"></div>',
    })
    expect(replaced.replacedNodeId).toBe(first.id)
    expect(replaced.createdNodes[0]?.worldX).toBe(0)
    expect(await node(page, first.id)).toBeUndefined()
  })

  test('each write is exactly one undo step', async ({ page }) => {
    await openEditor(page, EMPTY_FILE)
    const writes: [string, (ids: Record<string, string>) => Record<string, unknown>][] = [
      ['create_artboard', () => ({ name: 'A', styles: { width: '600px', height: '400px' } })],
      [
        'write_html',
        (ids) => ({
          targetNodeId: ids['A'],
          mode: 'insert-children',
          html: '<div layer-name="Box" style="display:flex;gap:8px;padding:8px"><p>One</p><p>Two</p></div>',
        }),
      ],
      [
        'update_styles',
        (ids) => ({ updates: [{ nodeIds: [ids['Box']], styles: { padding: '24px 12px' } }] }),
      ],
      ['set_text_content', (ids) => ({ updates: [{ nodeId: ids['One'], textContent: 'Uno' }] })],
      ['rename_nodes', (ids) => ({ updates: [{ nodeId: ids['Box'], name: 'Card' }] })],
      ['duplicate_nodes', (ids) => ({ nodes: [{ id: ids['Card'] }] })],
      ['move_nodes', (ids) => ({ moves: [{ nodeId: ids['Two'], parentId: ids['A'] }] })],
      ['delete_nodes', (ids) => ({ nodeIds: [ids['Two']] })],
      [
        'create_tokens',
        () => ({ tokens: [{ type: 'color', name: '--color-x', value: '#123456' }] }),
      ],
      ['set_tokens', () => ({ tokens: [{ name: '--color-x', value: '#654321' }] })],
    ]
    for (const [tool, args] of writes) {
      const ids = await page.evaluate(() => {
        const hook = (
          window as unknown as {
            __barenEditor: { snapshot(): { nodes: Record<string, NodeLike> } }
          }
        ).__barenEditor
        const out: Record<string, string> = {}
        for (const n of Object.values(hook.snapshot().nodes)) {
          out[n.type === 'text' ? (n.text ?? n.name) : n.name] = n.id
        }
        return out
      })
      const before = await shape(page)
      const res = await call(page, tool, args(ids))
      expect(res.ok, `${tool}: ${res.error?.message ?? ''}`).toBe(true)
      const after = await shape(page)
      expect(after, tool).not.toEqual(before)
      await undo(page)
      expect(await shape(page), `${tool} undo`).toEqual(before)
      await redo(page)
      expect(await shape(page), `${tool} redo`).toEqual(after)
    }
  })
})

test.describe('agent runtime: components, permissions, presence', () => {
  test('instance content: styles and text become overrides, structure is refused', async ({
    page,
  }) => {
    await openEditor(page, COMPONENTS_FILE)
    const instance = await page.evaluate(() => {
      const hook = (
        window as unknown as {
          __barenEditor: { snapshot(): { nodes: Record<string, NodeLike> } }
        }
      ).__barenEditor
      return Object.values(hook.snapshot().nodes).find((n) => n.type === 'instance')?.id ?? null
    })
    expect(instance).not.toBeNull()
    const kids = await body<{ children: { id: string; component: string }[] }>(
      page,
      'get_children',
      {
        nodeId: instance as string,
      },
    )
    const virtual = kids.children[0]?.id as string
    expect(virtual.startsWith(`${instance}/`)).toBe(true)
    const upd = await body<{ updated: string[] }>(page, 'update_styles', {
      updates: [{ nodeIds: [virtual], styles: { opacity: 0.5 } }],
    })
    expect(upd.updated).toEqual([virtual])
    const overrides = await page.evaluate(
      (id) =>
        (
          window as unknown as {
            __barenEditor: { snapshot(): { nodes: Record<string, NodeLike> } }
          }
        ).__barenEditor.snapshot().nodes[id]?.overrides ?? {},
      instance as string,
    )
    const entries = Object.values(overrides)
    expect(entries.some((e) => e.styles?.['opacity'] === 0.5)).toBe(true)
    const info = await body<{ overrides: string[]; mainComponent: { key: string } | null }>(
      page,
      'get_node_info',
      { nodeId: virtual },
    )
    expect(info.overrides).toContain('opacity')
    expect(info.mainComponent).not.toBeNull()
    const refused = await call(page, 'write_html', {
      targetNodeId: virtual,
      mode: 'insert-children',
      html: '<div></div>',
    })
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe('instance_content')
  })

  test('a viewer of a shared file gets read_only for writes, reads still work', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    await page.evaluate(() => {
      const hook = (
        window as unknown as {
          __barenEditor: { session: { store: { setState(s: Record<string, unknown>): void } } }
        }
      ).__barenEditor
      hook.session.store.setState({
        self: {
          type: 'welcome',
          clientId: 'c',
          userId: 'u',
          name: 'V',
          color: '#000',
          role: 'viewer',
        },
      })
    })
    const res = await call(page, 'create_artboard', {
      name: 'X',
      styles: { width: '10px', height: '10px' },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('read_only')
    expect((await call(page, 'get_basic_info')).ok).toBe(true)
  })

  test('agent presence shows in the inspector header and as a canvas agent entry', async ({
    page,
  }) => {
    await openEditor(page, EMPTY_FILE)
    const board = await body<{ id: string }>(page, 'create_artboard', {
      name: 'Board',
      styles: { width: '400px', height: '300px' },
    })
    const fileId = await page.evaluate(
      () =>
        (window as unknown as { __barenEditor: { session: { fileId: string } } }).__barenEditor
          .session.fileId,
    )
    // Record what the canvas is given (the overlay drawing itself is the ui workstream's).
    await page.evaluate(() => {
      const w = window as unknown as {
        __barenEditor: { canvas: { setRemotePresence(list: unknown[]): void } }
        __presence: unknown[][]
      }
      const canvas = w.__barenEditor.canvas
      const original = canvas.setRemotePresence.bind(canvas)
      w.__presence = []
      canvas.setRemotePresence = (list: unknown[]) => {
        w.__presence.push(list)
        original(list)
      }
    })
    await page.evaluate(
      ([f, b]) =>
        (
          window as unknown as { __barenAgent: { presence(u: unknown): void } }
        ).__barenAgent.presence({
          fileId: f,
          agents: [{ id: 'p-claude', name: 'Claude Code', working: [b], activeAt: Date.now() }],
        }),
      [fileId, board.id] as const,
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __barenEditor: { session: { store: { getState(): { agents: unknown[] } } } }
              }
            ).__barenEditor.session.store.getState().agents,
        ),
      )
      .toEqual([
        {
          id: 'p-claude',
          name: 'Claude Code',
          working: [board.id],
          activeAt: expect.any(Number),
          origin: 'local',
          via: null,
        },
      ])
    await expect(
      page.getByTestId('collaborators').locator('[title="Claude Code (agent)"]'),
    ).toBeVisible()
    const last = await page.evaluate(() => {
      const list = (window as unknown as { __presence: unknown[][] }).__presence
      return list[list.length - 1]
    })
    expect(last).toEqual([
      {
        userId: 'p-claude',
        name: 'Claude Code',
        color: '',
        pageId: null,
        cursor: null,
        selection: [board.id],
        kind: 'agent',
        badge: 'Claude Code',
      },
    ])
    // Clearing the working set and the agent removes the avatar.
    await page.evaluate(
      (f) =>
        (
          window as unknown as { __barenAgent: { presence(u: unknown): void } }
        ).__barenAgent.presence({
          fileId: f,
          agents: [],
        }),
      fileId,
    )
    await expect(
      page.getByTestId('collaborators').locator('[title="Claude Code (agent)"]'),
    ).toHaveCount(0)
  })
})

test.describe('agent runtime: hidden windows', () => {
  test('a headless host opens the file, runs tools with measured geometry and releases', async ({
    page,
  }) => {
    await page.goto('/#/agent-host/f-baren')
    await page.waitForFunction(() =>
      (
        window as unknown as {
          __barenAgent?: { hosts(): { fileId: string; headless: boolean }[] }
        }
      ).__barenAgent
        ?.hosts()
        .some((h) => h.fileId === 'f-baren' && h.headless),
    )
    await expect(page.getByTestId('agent-headless-canvas')).toBeAttached()
    const info = await body<{ pages: { isActive: boolean }[] }>(page, 'get_basic_info')
    expect(info.pages.every((p) => !p.isActive)).toBe(true)
    const board = await body<{ id: string }>(page, 'create_artboard', {
      name: 'Headless',
      styles: { width: '600px', height: 'fit-content' },
    })
    await body(page, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div style="display:flex;flex-direction:column;gap:10px;padding:20px"><p style="height:30px">A</p><p style="height:30px">B</p></div>',
    })
    const geo = await body<{ height: number }>(page, 'get_node_info', { nodeId: board.id })
    expect(geo.height).toBe(110)
    expect((await body<{ count: number }>(page, 'get_selection')).count).toBe(0)
    const released = await call(page, 'release')
    expect(released.ok).toBe(true)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __barenAgent: { hosts(): unknown[] } }).__barenAgent.hosts(),
        ),
      )
      .toEqual([])
  })

  test('the render window stages a render job, scales it and answers the pixel tools', async ({
    browser,
  }) => {
    const host = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await openEditor(host, EMPTY_FILE)
    const board = await body<{ id: string }>(host, 'create_artboard', {
      name: 'Card',
      styles: { width: '200px', height: '100px', backgroundColor: '#FF0000' },
    })
    const job = await body<Record<string, unknown>>(host, 'render_job', {
      nodeId: board.id,
      scale: 1,
      purpose: 'screenshot',
    })
    await host.close()

    const render = await browser.newPage({ viewport: { width: 400, height: 300 } })
    await render.goto('/#/agent-render')
    await render.waitForFunction(() => '__barenAgent' in window)
    // The page registers its listener asynchronously; main probes with stage_clear the same way.
    await expect
      .poll(
        async () => (await call(render, 'stage_clear', {}, { fileId: null, timeoutMs: 300 })).ok,
      )
      .toBe(true)
    const prepared = await body<Record<string, number>>(
      render,
      'stage_prepare',
      { job, scale: 2, maxSide: 300, maxPixels: null, transparent: false },
      { fileId: null },
    )
    expect(prepared).toEqual({ width: 200, height: 100, scale: 1.5, outWidth: 300, outHeight: 150 })
    const shot = await render.screenshot({ clip: { x: 0, y: 0, width: 300, height: 150 } })
    const pixel = await render.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = new OffscreenCanvas(img.width, img.height)
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(img, 0, 0)
      return [...ctx.getImageData(150, 75, 1, 1).data]
    }, shot.toString('base64'))
    expect(pixel.slice(0, 3)).toEqual([255, 0, 0])
    const styles = await body<{ styles: Record<string, Record<string, string>> }>(
      render,
      'stage_styles',
      { job, nodeIds: [board.id] },
      { fileId: null },
    )
    expect(styles.styles[board.id]).toMatchObject({
      backgroundColor: 'rgb(255, 0, 0)',
      width: '200px',
      height: '100px',
    })
    const fonts = await body<{
      families: { familyName: string; available: boolean; source: string | null }[]
    }>(render, 'fonts_probe', { familyNames: ['Inter', 'Definitely Not A Font'] }, { fileId: null })
    expect(fonts.families.map((f) => [f.familyName, f.available, f.source])).toEqual([
      ['Inter', true, 'bundled'],
      ['Definitely Not A Font', false, null],
    ])
    const png = [...Buffer.from(PNG_2x1.split(',')[1] as string, 'base64')]
    const out = await render.evaluate(
      async (bytes) =>
        (
          window as unknown as {
            __barenAgent: {
              dispatch(
                t: string,
                a: unknown,
                o: unknown,
              ): Promise<{ ok: boolean; result: { bytes: Uint8Array; width: number } }>
            }
          }
        ).__barenAgent.dispatch(
          'image_transcode',
          { png: new Uint8Array(bytes), to: 'jpeg', maxSide: 1 },
          { fileId: null },
        ),
      png,
    )
    expect(out.ok).toBe(true)
    expect(out.result.width).toBe(1)
    expect(Object.values(out.result.bytes).slice(0, 2)).toEqual([0xff, 0xd8])
    await render.close()
  })
})

test.describe('agent runtime: budgets (contract §11.7)', () => {
  /**
   * Renderer time of `runs` calls (the mock loop adds only structured clones), with an agent's
   * think time between them (the host warms its whole-file mirror in idle time).
   */
  async function timed(
    page: Page,
    tool: string,
    args: Record<string, unknown>,
    runs: number,
  ): Promise<{ first: number; median: number; result: AgentResponse }> {
    return page.evaluate(
      async ([t, a, n]) => {
        const loop = (
          window as unknown as {
            __barenAgent: { dispatch(t: string, a: unknown): Promise<AgentResponse> }
          }
        ).__barenAgent
        const times: number[] = []
        let result: AgentResponse | null = null
        for (let i = 0; i < n; i++) {
          const t0 = performance.now()
          result = await loop.dispatch(t, a)
          times.push(performance.now() - t0)
          await new Promise((r) => setTimeout(r, 400))
        }
        const first = times[0] as number
        times.sort((x, y) => x - y)
        return {
          first,
          median: times[Math.floor(times.length / 2)] as number,
          result: result as AgentResponse,
        }
      },
      [tool, args, runs] as const,
    )
  }

  test('get_basic_info on 20k nodes, find_nodes over 50k nodes, a 15-line write_html', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await openEditor(page, '/?fixture=design&editorScene=perf20k#/file/f-baren')
    const info = await timed(page, 'get_basic_info', {}, 5)
    expect(info.result.ok).toBe(true)
    expect((info.result.result as { nodeCount: number }).nodeCount).toBeGreaterThan(19_000)

    await openEditor(page, '/?fixture=design&editorScene=perf50k#/file/f-baren')
    // An agent starts with get_basic_info; the mirror warms while it reads the answer.
    const info50 = await timed(page, 'get_basic_info', {}, 1)
    await page.waitForTimeout(1_500)
    const find = await timed(
      page,
      'find_nodes',
      { filters: [{ styleName: 'backgroundColor', styleValue: '#ff0000' }] },
      3,
    )
    expect(find.result.ok).toBe(true)

    await openEditor(page, EMPTY_FILE)
    const board = await body<{ id: string }>(page, 'create_artboard', {
      name: 'B',
      styles: { width: '1440px', height: 'fit-content' },
    })
    const rows = Array.from(
      { length: 13 },
      (_, i) =>
        `  <div style="display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid #EEE"><p style="font-size:14px">Row ${i}</p><p style="color:#666">Detail</p></div>`,
    ).join('\n')
    const html = `<div layer-name="List" style="display:flex;flex-direction:column;width:640px">\n${rows}\n</div>`
    expect(html.split('\n')).toHaveLength(15)
    const write = await timed(
      page,
      'write_html',
      { targetNodeId: board.id, mode: 'insert-children', html },
      5,
    )
    expect(write.result.ok).toBe(true)
    const ms = (n: number) => `${n.toFixed(1)} ms`
    console.log(
      `[budgets] get_basic_info 20k: ${ms(info.median)} (first ${ms(info.first)}; ≤ 150) · ` +
        `get_basic_info 50k first: ${ms(info50.first)} · ` +
        `find_nodes 50k: ${ms(find.median)} (first ${ms(find.first)}; ≤ 500) · ` +
        `write_html 15 lines: ${ms(write.median)} (first ${ms(write.first)}; ≤ 50)`,
    )
    // Steady state (mirror warm). The first call of a session is logged above.
    expect(info.median).toBeLessThan(150)
    expect(find.median).toBeLessThan(500)
    // Twice the budget: layout and DOM timing vary on shared machines (the log has the number).
    expect(write.median).toBeLessThan(100)
  })
})

test.describe('agent runtime: file links in results', () => {
  test("a result's url opens that file at its page; a layer link selects the layer", async ({
    page,
  }) => {
    type Hook = {
      __barenEditor: {
        snapshot(): { pageIds: string[]; nodes: Record<string, NodeLike> }
        session: { store: { getState(): { pageId: string; selection: readonly string[] } } }
      }
      __barenTest: { emitDeepLink(url: string): void }
    }
    const emit = (url: string) =>
      page.evaluate((u) => (window as unknown as Hook).__barenTest.emitDeepLink(u), url)
    const state = () =>
      page.evaluate(() => {
        const s = (window as unknown as Hook).__barenEditor.session.store.getState()
        return { pageId: s.pageId, selection: [...s.selection] }
      })

    await openEditor(page, '/?fixture=design#/file/f-acme')
    const { first, logo, board } = await page.evaluate(() => {
      const snap = (window as unknown as Hook).__barenEditor.snapshot()
      const first = snap.pageIds[0] as string
      const logo = snap.pageIds.find((id) => snap.nodes[id]?.name === 'Logo') as string
      return { first, logo, board: snap.nodes[first]?.children[0] as string }
    })
    // get_basic_info's url names the local file and the page (baren://file/<id>/<page id>).
    const info = await body<{ url: string }>(page, 'get_basic_info', { pageId: logo })
    expect(info.url).toBe(`baren://file/f-acme/${logo}`)

    // Clicked from Home (the OS hands the link to the app): the file opens on that page.
    await page.evaluate(() => (location.hash = '#/recents'))
    await expect(page.getByTestId('editor')).toHaveCount(0)
    await emit(info.url)
    await expect(page).toHaveURL(/#\/file\/f-acme$/)
    await page.getByTestId('editor').waitFor()
    await expect.poll(async () => (await state()).pageId).toBe(logo)

    // A layer link while the file is open: back to the layer's page, selected.
    await emit(`baren://file/f-acme?node=${encodeURIComponent(board)}`)
    await expect.poll(state).toEqual({ pageId: first, selection: [board] })
  })
})
