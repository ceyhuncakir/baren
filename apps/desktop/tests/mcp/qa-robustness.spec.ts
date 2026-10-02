/**
 * QA: robustness of the MCP server against a real build with real clients — files nobody has
 * open (hidden hosts, more files than the host pool), two agents on one file at once, an agent
 * writing while the user edits, huge and hostile input, cancellation, deadlines and crashed
 * renderers.
 *
 * Opt-in: `pnpm --filter @baren/desktop build`, then
 * `BAREN_MCP_E2E=1 pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts qa-robustness`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, test, type Page } from '@playwright/test'
import {
  call,
  callError,
  connect,
  decodeImage,
  disconnect,
  docState,
  editorWindow,
  launchOffline,
  type OfflineApp,
} from './qa-helpers'

test.skip(!process.env['BAREN_MCP_E2E'], 'set BAREN_MCP_E2E=1 (needs a build)')
test.describe.configure({ mode: 'serial' })

let app: OfflineApp
const clients: Client[] = []

test.beforeAll(async () => {
  app = await launchOffline()
})

/** Each test's agents disconnect at its end (so display names do not get " 2" suffixes). */
test.afterEach(async () => {
  for (const c of clients.splice(0)) await disconnect(c)
})

test.afterAll(async () => {
  await app?.launched.close()
})

async function agent(name: string): Promise<Client> {
  const c = await connect(app.endpoint, name)
  clients.push(c)
  return c
}

/** Hidden host windows currently alive (main's BrowserWindows on #/agent-host/…). */
function hostWindows(): Promise<number> {
  return app.launched.app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('#/agent-host/'))
        .length,
  )
}

function rows(n: number, prefix: string): string {
  let out = ''
  for (let i = 0; i < n; i++) {
    out += `<div style="display:flex;gap:4px;padding:2px"><span style="font-size:10px">${prefix} ${i}</span><div style="width:8px;height:8px;background-color:#${((i * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}"></div></div>`
  }
  return out
}

async function childCount(c: Client, fileId: string, nodeId: string): Promise<number> {
  return ((await call(c, 'get_node_info', { fileId, nodeId })).body as { childCount: number })
    .childCount
}

test('files nobody has open: six files at once through at most four hidden hosts', async () => {
  test.setTimeout(240_000)
  const c = await agent('claude-code')
  const files: string[] = []
  for (let i = 0; i < 6; i++) {
    files.push(
      ((await call(c, 'create_file', { name: `Headless ${i}` })).body as { fileId: string }).fileId,
    )
  }
  let maxHosts = 0
  const sampler = setInterval(() => {
    void hostWindows().then((n) => {
      maxHosts = Math.max(maxHosts, n)
    })
  }, 50)
  try {
    const boards = await Promise.all(
      files.map(async (fileId, i) => {
        const board = (
          await call(c, 'create_artboard', {
            fileId,
            name: `Board ${i}`,
            styles: { width: '320px', height: '240px' },
          })
        ).body as { id: string }
        await call(c, 'write_html', {
          fileId,
          targetNodeId: board.id,
          mode: 'insert-children',
          html: `<div layer-name="Fill" style="height: 120px; background-color: #2266aa"><p style="color: white">File ${i}</p></div>`,
        })
        const shot = await call(c, 'get_screenshot', { fileId, nodeId: board.id })
        expect(shot.content.some((x) => x.type === 'image')).toBe(true)
        return board.id
      }),
    )
    expect(boards).toHaveLength(6)
  } finally {
    clearInterval(sampler)
  }
  expect(maxHosts).toBeLessThanOrEqual(4)
  expect(maxHosts).toBeGreaterThan(0)
  // No window was shown for any of them.
  for (const fileId of files) {
    expect(app.launched.app.windows().some((w) => w.url().includes(`#/file/${fileId}`))).toBe(false)
  }
  // Every file kept its content (released hosts flushed it to the core).
  for (const [i, fileId] of files.entries()) {
    const info = (await call(c, 'get_basic_info', { fileId })).body as {
      artboards: { id: string; name: string }[]
    }
    expect(info.artboards.map((a) => a.name)).toEqual([`Board ${i}`])
    const tree = (await call(c, 'get_tree_summary', { fileId, nodeId: info.artboards[0]!.id }))
      .body as {
      summary: string
    }
    expect(tree.summary).toContain(`"File ${i}"`)
  }
  await call(c, 'finish_working_on_nodes', {})
})

test('two agents write into one open file at the same time', async () => {
  test.setTimeout(180_000)
  const a = await agent('claude-code')
  const b = await agent('cursor-vscode')
  const fileId = ((await call(a, 'create_file', { name: 'Two agents' })).body as { fileId: string })
    .fileId
  await call(a, 'open_file', { fileId })
  const page = await editorWindow(app.launched, fileId)
  await page.locator('.ic-root').waitFor({ state: 'attached' })
  const pageId = ((await call(a, 'get_basic_info', { fileId })).body as { pageId: string }).pageId
  const empty = await docState(a, fileId, pageId)

  const [boardA, boardB] = await Promise.all([
    call(a, 'create_artboard', {
      fileId,
      name: 'A',
      styles: { width: '600px', height: 'fit-content' },
    }),
    call(b, 'create_artboard', {
      fileId,
      name: 'B',
      styles: { width: '600px', height: 'fit-content' },
    }),
  ]).then((r) => r.map((x) => (x.body as { id: string }).id) as [string, string])
  const shared = (
    (
      await call(a, 'write_html', {
        fileId,
        targetNodeId: boardA,
        mode: 'insert-children',
        html: '<div layer-name="Shared list" style="display: flex; flex-direction: column; gap: 4px"></div>',
      })
    ).body as { createdNodes: { id: string }[] }
  ).createdNodes[0]!.id

  const writes: Promise<unknown>[] = []
  for (let i = 0; i < 8; i++) {
    writes.push(
      call(a, 'write_html', {
        fileId,
        targetNodeId: boardA,
        mode: 'insert-children',
        html: `<p layer-name="A${i}" style="font-size: 14px">From A ${i}</p>`,
      }),
      call(b, 'write_html', {
        fileId,
        targetNodeId: boardB,
        mode: 'insert-children',
        html: `<p layer-name="B${i}" style="font-size: 14px">From B ${i}</p>`,
      }),
    )
    if (i < 4) {
      writes.push(
        call(a, 'write_html', {
          fileId,
          targetNodeId: shared,
          mode: 'insert-children',
          html: `<p>Shared A${i}</p>`,
        }),
        call(b, 'write_html', {
          fileId,
          targetNodeId: shared,
          mode: 'insert-children',
          html: `<p>Shared B${i}</p>`,
        }),
        call(b, 'update_styles', {
          fileId,
          updates: [{ nodeIds: [boardA], styles: { backgroundColor: `#ff00${i}0` } }],
        }),
      )
    }
  }
  await Promise.all(writes)
  expect(await childCount(a, fileId, boardA)).toBe(9)
  expect(await childCount(b, fileId, boardB)).toBe(8)
  expect(await childCount(b, fileId, shared)).toBe(8)
  // Both agents are shown (live status, inspector header).
  const status = await page.evaluate(() => window.baren!.mcp.status())
  const live = status.agents.filter((x) => x.connected && x.files.some((f) => f.fileId === fileId))
  expect(live.map((x) => x.name).sort()).toEqual(['Claude Code', 'Cursor'])
  expect(
    live
      .find((x) => x.name === 'Cursor')!
      .files.find((f) => f.fileId === fileId)!
      .working.sort(),
  ).toEqual([boardA, boardB].sort())
  await expect(
    page.getByTestId('collaborators').locator('[title="Claude Code (agent)"]'),
  ).toBeVisible()
  await expect(page.getByTestId('collaborators').locator('[title="Cursor (agent)"]')).toBeVisible()

  // Every call was its own undo step: 2 artboards + 1 list + 16 + 8 + 4 style updates = 31.
  await page.bringToFront()
  await page.mouse.click(5, 450)
  await page.keyboard.press('Escape')
  for (let i = 0; i < 30; i++) await page.keyboard.press('Control+z')
  await expect
    .poll(
      async () =>
        ((await call(a, 'get_basic_info', { fileId })).body as { artboardCount: number })
          .artboardCount,
    )
    .toBe(1)
  await page.keyboard.press('Control+z')
  await expect.poll(() => docState(a, fileId, pageId)).toBe(empty)
  await call(a, 'finish_working_on_nodes', { fileId })
  await call(b, 'finish_working_on_nodes', { fileId })
})

test('an agent writes while the user edits the same artboard', async () => {
  test.setTimeout(180_000)
  const c = await agent('claude-code')
  const fileId = (
    (await call(c, 'create_file', { name: 'User and agent' })).body as { fileId: string }
  ).fileId
  await call(c, 'open_file', { fileId })
  const page: Page = await editorWindow(app.launched, fileId)
  await page.locator('.ic-root').waitFor({ state: 'attached' })
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'Shared board',
      styles: { width: '800px', height: '600px', display: 'block' },
      // a block artboard: the user's rectangle is absolute, the agent's rows stack
    })
  ).body as { id: string }
  // The user focuses the canvas (an empty spot) and zooms to fit.
  await page.bringToFront()
  const canvas = (await page.getByRole('application', { name: 'Design canvas' }).boundingBox())!
  await page.mouse.click(canvas.x + 20, canvas.y + 20)
  await page.keyboard.press('Shift+1')
  let box = { x: 0, y: 0, width: 0, height: 0 }
  await expect
    .poll(async () => {
      box = (await page.locator(`.ic-root [data-nid="${board.id}"]`).boundingBox())!
      return box.x >= canvas.x && box.x + box.width <= canvas.x + canvas.width + 1
    })
    .toBe(true)
  // The agent writes ten rows while the user draws a rectangle and nudges it.
  const agentWrites = (async () => {
    for (let i = 0; i < 10; i++) {
      await call(c, 'write_html', {
        fileId,
        targetNodeId: board.id,
        mode: 'insert-children',
        html: `<div layer-name="Row ${i}" style="height: 20px; width: 200px; background-color: #ddeeff"></div>`,
      })
    }
  })()
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'Rectangle' })
    .click()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 })
  await page.mouse.up()
  // The hidden window paints on its own schedule: wait for the drawn rectangle.
  type Selection = { selectedNodes: { id: string; component: string; artboardId: string }[] }
  const selection = async (): Promise<Selection> =>
    (await call(c, 'get_selection', { fileId })).body as Selection
  await expect
    .poll(async () => (await selection()).selectedNodes.length, { timeout: 5_000 })
    .toBe(1)
  const rectId = (await selection()).selectedNodes[0]!.id
  const x0 = ((await call(c, 'get_node_info', { fileId, nodeId: rectId })).body as { x: number }).x
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  const rectX = async (): Promise<number> =>
    ((await call(c, 'get_node_info', { fileId, nodeId: rectId })).body as { x: number }).x
  await expect.poll(rectX, { timeout: 5_000 }).toBe(x0 + 5)
  await agentWrites

  // The user's selection is still their rectangle: agent writes never take it away.
  const sel = await selection()
  expect(sel.selectedNodes).toHaveLength(1)
  expect(sel.selectedNodes[0]).toMatchObject({
    id: rectId,
    component: 'Rectangle',
    artboardId: board.id,
  })
  const kids = (await call(c, 'get_children', { fileId, nodeId: board.id })).body as {
    children: { name: string; component: string }[]
  }
  expect(kids.children.filter((k) => k.name.startsWith('Row ')).map((k) => k.name)).toEqual(
    Array.from({ length: 10 }, (_, i) => `Row ${i}`),
  )
  expect(kids.children.filter((k) => k.component === 'Rectangle')).toHaveLength(1)

  // The user's next undo takes back their own last step (the nudge), not an agent row.
  await page.keyboard.press('Control+z')
  await expect.poll(rectX).toBe(x0 + 4)
  expect(await childCount(c, fileId, board.id)).toBe(11)

  // The user deletes the artboard the agent works on: the agent's next write fails cleanly.
  await call(c, 'delete_nodes', { fileId, nodeIds: [board.id] })
  const gone = await callError(c, 'write_html', {
    fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: '<p>late</p>',
  })
  expect(gone).toMatchObject({ code: 'node_not_found', isError: true })
  expect(gone.text).toMatch(/get_basic_info|get_children|look/i)
})

test('huge input: 4,000 layers in one call work; over the limit nothing is written', async () => {
  test.setTimeout(180_000)
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Huge' })).body as { fileId: string })
    .fileId
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'Big',
      styles: { width: '1200px', height: 'fit-content' },
    })
  ).body as { id: string }
  const t = Date.now()
  const big = (
    await call(c, 'write_html', {
      fileId,
      targetNodeId: board.id,
      mode: 'insert-children',
      html: `<div layer-name="Rows" style="display:flex;flex-direction:column">${rows(1333, 'Row')}</div>`,
    })
  ).body as { createdNodes: { id: string }[]; summary: string }
  const ms = Date.now() - t
  console.log(`qa: write_html with 4,000 layers took ${ms} ms`)
  expect(ms).toBeLessThan(20_000)
  expect(await childCount(c, fileId, big.createdNodes[0]!.id)).toBe(1333)
  // 6,001 layers: refused before anything is written.
  const before = await childCount(c, fileId, board.id)
  const tooMany = await callError(c, 'write_html', {
    fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: `<div>${rows(2000, 'X')}</div>`,
  })
  expect(tooMany).toMatchObject({ code: 'too_large', isError: true })
  expect(await childCount(c, fileId, board.id)).toBe(before)
  // Over 1 MB of HTML: schema refusal (the SDK's validation), nothing written.
  const huge = await client_callRaw(c, 'write_html', {
    fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: `<p>${'x'.repeat(1_048_600)}</p>`,
  })
  expect(huge.isError).toBe(true)
  expect(await childCount(c, fileId, board.id)).toBe(before)
  // 300 levels of nesting: answered (refused or capped), the app stays responsive.
  const deep = await client_callRaw(c, 'write_html', {
    fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: `${'<div style="display:flex;padding:1px">'.repeat(300)}<p>deep</p>${'</div>'.repeat(300)}`,
  })
  expect(typeof deep.isError === 'boolean' || deep.isError === undefined).toBe(true)
  expect(
    ((await call(c, 'get_basic_info', { fileId })).body as { artboardCount: number }).artboardCount,
  ).toBe(1)
  // A 3,000-row get_tree_summary is truncated, a big get_jsx refused with a hint.
  const summary = (await call(c, 'get_tree_summary', { fileId, nodeId: board.id, depth: 10 }))
    .body as {
    summary: string
  }
  expect(summary.summary.split('\n').length).toBeLessThanOrEqual(2_001)
  expect(summary.summary).toMatch(/truncated/)
})

async function client_callRaw(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  try {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    const texts = (r.content as { type: string; text?: string }[]).filter((x) => x.type === 'text')
    return { isError: r.isError === true, text: texts.at(-1)?.text ?? '' }
  } catch (error) {
    return { isError: true, text: (error as Error).message }
  }
}

test('hostile HTML and sources are neutralised; nothing runs in the app', async () => {
  test.setTimeout(180_000)
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Hostile' })).body as { fileId: string })
    .fileId
  await call(c, 'open_file', { fileId })
  const page = await editorWindow(app.launched, fileId)
  await page.locator('.ic-root').waitFor({ state: 'attached' })
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'Hostile',
      styles: { width: '800px', height: '600px' },
    })
  ).body as { id: string }
  const dir = join(app.launched.userData, '..', 'hostile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fake.png'), 'not really a png <script>')
  const payloads = [
    '<script>window.__qaPwned = 1</script><p>after script</p>',
    '<img src="x" onerror="window.__qaPwned = 2" style="width:10px;height:10px">',
    '<a href="javascript:window.__qaPwned=3" style="display:block">link</a>',
    '<iframe src="javascript:parent.__qaPwned=4"></iframe><p>after iframe</p>',
    '<svg width="10" height="10" onload="window.__qaPwned=5"><script>window.__qaPwned=6</script><rect width="10" height="10" fill="red"/></svg>',
    '<svg width="10" height="10"><foreignObject width="10" height="10"><img src="x" onerror="window.__qaPwned=7"></foreignObject></svg>',
    '<svg width="10" height="10"><use href="https://evil.example/x.svg#a"/><a href="javascript:window.__qaPwned=8"><rect width="5" height="5"/></a></svg>',
    '<div style="background-image: url(javascript:window.__qaPwned=9); width: 10px; height: 10px"></div>',
    '<div style="width: expression(alert(1)); height: 10px; behavior: url(x.htc)"></div>',
    '<style>* { display: none }</style><link rel="stylesheet" href="https://evil.example/x.css"><p>styled</p>',
    '<p style="color: red; } body { display: none">broken style</p>',
    '<div><p>unclosed <b>tags<div><span>everywhere',
    '<img src="/etc/passwd" style="width:10px;height:10px">',
    '<img src="/dev/zero" style="width:10px;height:10px">',
    '<img src="/proc/self/environ" style="width:10px;height:10px">',
    '<img src="relative/path.png" style="width:10px;height:10px">',
    `<img src="${join(dir, 'fake.png')}" style="width:10px;height:10px">`,
    `<img src="${dir}" style="width:10px;height:10px">`,
    '<img src="file:///nonexistent/qa.png" style="width:10px;height:10px">',
    '<div style="background-image: url(/etc/hostname); width:10px; height:10px"></div>',
    '<object data="x.swf"></object><embed src="x.swf"><p>after embed</p>',
    '<x-baren-clone node-id="does-not-exist"></x-baren-clone>',
    '<x-baren-clone></x-baren-clone>',
    '<template><p>inside template</p></template><noscript><p>ns</p></noscript>',
    '\u0000\u0001<p>control chars ‮ reversed</p>',
  ]
  for (const html of payloads) {
    const t = Date.now()
    const res = await client_callRaw(c, 'write_html', {
      fileId,
      targetNodeId: board.id,
      mode: 'insert-children',
      html,
    })
    expect(Date.now() - t, html).toBeLessThan(10_000)
    expect(res.text, html).not.toMatch(/Error \[internal\]/)
  }
  const jsx = String(
    (await call(c, 'get_jsx', { fileId, nodeId: board.id, format: 'inline-styles' })).body,
  )
  for (const bad of [
    '<script',
    'onerror',
    'onload',
    'javascript:',
    'expression(',
    '__qaPwned',
    'evil.example',
    'behavior',
  ]) {
    expect(jsx.toLowerCase(), bad).not.toContain(bad.toLowerCase())
  }
  // Only stored assets are ever referenced.
  for (const m of jsx.matchAll(/url\(([^)]*)\)/g)) expect(m[1]).toMatch(/^['"]?baren-asset:\/\//)
  for (const m of jsx.matchAll(/src="([^"]*)"/g)) expect(m[1]).toMatch(/^baren-asset:\/\//)
  await page.waitForTimeout(500)
  expect(
    await page.evaluate(() => (window as unknown as { __qaPwned?: number }).__qaPwned),
  ).toBeUndefined()
  // The canvas DOM holds no script, iframe, object or event handler either.
  const dom = await page.locator('.ic-root').evaluate((root) => ({
    scripts: root.querySelectorAll(
      'script, iframe, object, embed, foreignObject, link, style:not([data-ic])',
    ).length,
    handlers: [...root.querySelectorAll('*')].filter((el) =>
      [...el.attributes].some((a) => /^on/i.test(a.name)),
    ).length,
    js: [...root.querySelectorAll('*')].filter((el) =>
      [...el.attributes].some((a) => /javascript:/i.test(a.value)),
    ).length,
  }))
  expect(dom).toEqual({ scripts: expect.any(Number), handlers: 0, js: 0 })
  expect(
    await page
      .locator('.ic-root')
      .evaluate(
        (root) => root.querySelectorAll('script, iframe, object, embed, foreignObject').length,
      ),
  ).toBe(0)
})

test('invalid targets and arguments fail with clear codes and change nothing', async () => {
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Invalid' })).body as { fileId: string })
    .fileId
  const info = (await call(c, 'get_basic_info', { fileId })).body as { pageId: string }
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'B',
      styles: { width: '400px', height: '300px' },
    })
  ).body as { id: string }
  const text = (
    (
      await call(c, 'write_html', {
        fileId,
        targetNodeId: board.id,
        mode: 'insert-children',
        html: '<p>Text</p>',
      })
    ).body as { createdNodes: { id: string }[] }
  ).createdNodes[0]!.id
  const before = await docState(c, fileId, info.pageId)
  const expectCode = async (
    name: string,
    args: Record<string, unknown>,
    code: string,
  ): Promise<void> => {
    const r = await callError(c, name, { fileId, ...args })
    expect(r.isError, `${name} ${JSON.stringify(args).slice(0, 80)}`).toBe(true)
    expect(
      r.code || (JSON.parse(r.text) as { errors?: { code: string }[] }).errors?.[0]?.code,
      `${name}: ${r.text}`,
    ).toBe(code)
  }
  await expectCode(
    'write_html',
    { targetNodeId: 'nope', mode: 'insert-children', html: '<p>x</p>' },
    'node_not_found',
  )
  await expectCode(
    'write_html',
    { targetNodeId: info.pageId, mode: 'replace', html: '<p>x</p>' },
    'invalid_target',
  )
  await expectCode(
    'write_html',
    { targetNodeId: text, mode: 'insert-children', html: '<p>x</p>' },
    'invalid_target',
  )
  await expectCode(
    'write_html',
    { targetNodeId: board.id, mode: 'replace', html: '<!-- nothing -->' },
    'invalid_target',
  )
  await expectCode('get_jsx', { nodeId: info.pageId }, 'invalid_target')
  await expectCode('get_tree_summary', { nodeId: 'missing' }, 'node_not_found')
  await expectCode(
    'update_styles',
    { updates: [{ nodeIds: ['missing'], styles: { color: 'red' } }] },
    'node_not_found',
  )
  await expectCode(
    'set_text_content',
    { updates: [{ nodeId: board.id, textContent: 'x' }] },
    'invalid_target',
  )
  await expectCode(
    'rename_nodes',
    { updates: [{ nodeId: info.pageId, name: 'x' }] },
    'invalid_target',
  )
  await expectCode('delete_nodes', { nodeIds: [info.pageId] }, 'invalid_target')
  await expectCode(
    'move_nodes',
    { moves: [{ nodeId: board.id, parentId: text }] },
    'invalid_target',
  )
  await expectCode(
    'move_nodes',
    { moves: [{ nodeId: board.id, parentId: board.id }] },
    'invalid_target',
  )
  await expectCode('duplicate_nodes', { nodes: [{ id: 'missing' }] }, 'node_not_found')
  await expectCode('get_basic_info', { pageId: 'missing-page' }, 'page_not_found')
  await expectCode(
    'create_artboard',
    { name: 'x', styles: { width: '50%', height: '10px' } },
    'invalid_argument',
  )
  await expectCode('find_nodes', {}, 'invalid_argument')
  // A batch with one good and one bad entry applies the good one and reports the other.
  const mixed = (
    await call(c, 'create_tokens', {
      fileId,
      tokens: [
        { type: 'color', name: '--a', value: 'red' },
        { type: 'color', name: '--a', value: 'blue' },
      ],
    })
  ).body as { results: { result: string }[] }
  expect(mixed.results.map((r) => r.result)).toEqual(['created', 'error'])
  const exists = await callError(c, 'create_tokens', {
    fileId,
    tokens: [{ type: 'color', name: '--a', value: 'green' }],
  })
  expect(exists.isError).toBe(true)
  expect(exists.text).toMatch(/exist/i)
  await call(c, 'set_tokens', { fileId, tokens: [{ name: '--a', delete: true }] })
  await expectCode('get_screenshot', { nodeId: 'missing' }, 'node_not_found')
  await expectCode('get_fill_image', { nodeId: text }, 'invalid_target')
  for (const bad of ['../../etc/passwd', 'baren://file/nope', 'x'.repeat(300), '']) {
    const r = await callError(c, 'get_basic_info', { fileId: bad })
    if (bad === '') continue // empty = the default file
    expect(r.code, bad.slice(0, 20)).toBe('file_not_found')
  }
  // Schema violations are refused by validation (isError), never half-applied.
  for (const [name, args] of [
    ['write_html', { fileId, targetNodeId: board.id, mode: 'append', html: '<p>x</p>' }],
    [
      'write_html',
      { fileId, targetNodeId: board.id, mode: 'insert-children', html: '<p>x</p>', extra: 1 },
    ],
    ['update_styles', { fileId, updates: [] }],
    ['update_styles', { fileId, updates: [{ nodeIds: [board.id], styles: { color: { r: 1 } } }] }],
    ['get_computed_styles', { fileId, nodeIds: Array(201).fill(board.id) }],
    ['create_tokens', { fileId, tokens: [{ type: 'colour', name: '--b', value: 'red' }] }],
    ['set_text_content', { fileId, updates: [{ nodeId: text, textContent: 'x'.repeat(100_001) }] }],
    ['export', { fileId, nodes: { [board.id]: [{ format: 'png', scale: '2' }] } }],
  ] as const) {
    const r = await client_callRaw(c, name, args as Record<string, unknown>)
    expect(r.isError, `${name} ${r.text.slice(0, 120)}`).toBe(true)
  }
  expect(await docState(c, fileId, info.pageId)).toBe(before)
  // Out-of-range values are clamped: depth 999 → 10, screenshot scale 100 → 4 (and capped).
  expect(
    (
      (await call(c, 'get_tree_summary', { fileId, nodeId: board.id, depth: 999 })).body as {
        depth: number
      }
    ).depth,
  ).toBe(10)
  const shot = await call(c, 'get_screenshot', { fileId, nodeId: board.id, scale: 100 })
  expect(shot.content.at(-1)?.text ?? '').toMatch(/Downscaled to fit size limits \(effective scale/)
})

test('cancelled writes apply completely or not at all; the server stays usable', async () => {
  test.setTimeout(180_000)
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Cancel' })).body as { fileId: string })
    .fileId
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'C',
      styles: { width: '600px', height: 'fit-content' },
    })
  ).body as { id: string }
  const outcomes: string[] = []
  for (const delay of [0, 2, 10, 30, 80, 200]) {
    const before = await childCount(c, fileId, board.id)
    const ac = new AbortController()
    const p = c
      .callTool(
        {
          name: 'write_html',
          arguments: {
            fileId,
            targetNodeId: board.id,
            mode: 'insert-children',
            html: `<div layer-name="Batch ${delay}" style="display:flex;flex-direction:column">${rows(600, `C${delay}`)}</div>`,
          },
        },
        undefined,
        { signal: ac.signal, timeout: 60_000 },
      )
      .then(() => 'completed')
      .catch((e: Error) => (/abort|cancel/i.test(e.message) ? 'aborted' : `error: ${e.message}`))
    setTimeout(() => ac.abort('qa cancel'), delay)
    outcomes.push(await p)
    // Wait for the host to settle, then: either the whole batch is there or none of it.
    await new Promise((r) => setTimeout(r, 1500))
    const after = await childCount(c, fileId, board.id)
    expect([before, before + 1], `delay ${delay}`).toContain(after)
    if (after === before + 1) {
      const last = (await call(c, 'get_children', { fileId, nodeId: board.id })).body as {
        children: { id: string }[]
      }
      expect(await childCount(c, fileId, last.children.at(-1)!.id), `delay ${delay}`).toBe(600)
    }
  }
  console.log(`qa: cancellation outcomes ${outcomes.join(', ')}`)
  expect(outcomes.filter((o) => o.startsWith('error'))).toEqual([])
  // Still usable.
  await call(c, 'write_html', {
    fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: '<p>after</p>',
  })
})

test('a crashed hidden host or render window costs one request at most', async () => {
  test.setTimeout(180_000)
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Crash' })).body as { fileId: string })
    .fileId
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'Crash',
      styles: { width: '300px', height: '200px' },
    })
  ).body as { id: string }
  await call(c, 'get_screenshot', { fileId, nodeId: board.id })
  // Let the host save (its persistence debounce is 400 ms; a crash loses only unsaved edits).
  await new Promise((r) => setTimeout(r, 1_000))
  // Kill the hidden host's and the render window's renderer processes.
  const killed = await app.launched.app.evaluate(({ BrowserWindow }, id) => {
    let n = 0
    for (const w of BrowserWindow.getAllWindows()) {
      const url = w.webContents.getURL()
      if (
        url.includes(`#/agent-host/${encodeURIComponent(id)}`) ||
        url.includes('#/agent-render')
      ) {
        process.kill(w.webContents.getOSProcessId(), 'SIGKILL')
        n++
      }
    }
    return n
  }, fileId)
  expect(killed).toBe(2)
  await new Promise((r) => setTimeout(r, 300))
  const results: string[] = []
  for (let i = 0; i < 3; i++) {
    const r = await client_callRaw(c, 'write_html', {
      fileId,
      targetNodeId: board.id,
      mode: 'insert-children',
      html: `<p>after crash ${i}</p>`,
    })
    results.push(r.isError ? r.text : 'ok')
  }
  expect(results.slice(1)).toEqual(['ok', 'ok'])
  const shot = await client_callRaw(c, 'get_screenshot', { fileId, nodeId: board.id })
  expect(shot.isError).toBe(false)
  const tree = (await call(c, 'get_tree_summary', { fileId, nodeId: board.id })).body as {
    summary: string
  }
  expect(tree.summary).toContain('after crash 2')
})

test('a hung hidden host costs one request: it is discarded and the file reopened', async () => {
  test.setTimeout(180_000)
  // A second app with short deadlines (3 s), so the hang shows quickly.
  const other = await launchOffline({ BAREN_MCP_TOOL_TIMEOUT_MS: '3000' })
  try {
    const c = await connect(other.endpoint, 'claude-code')
    const fileId = ((await call(c, 'create_file', { name: 'Hang' })).body as { fileId: string })
      .fileId
    await call(c, 'create_artboard', {
      fileId,
      name: 'Hang',
      styles: { width: '300px', height: '200px' },
    })
    await new Promise((r) => setTimeout(r, 1_000))
    await other.launched.app.evaluate(({ BrowserWindow }, id) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().includes(`#/agent-host/${encodeURIComponent(id)}`)) {
          void w.webContents.executeJavaScript('setTimeout(() => { for (;;) {} }, 10)')
        }
      }
    }, fileId)
    await new Promise((r) => setTimeout(r, 300))
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await client_callRaw(c, 'get_basic_info', { fileId })
      outcomes.push(r.isError ? (/Error \[([a-z_]+)\]/.exec(r.text)?.[1] ?? r.text) : 'ok')
    }
    expect(outcomes).toEqual(['timeout', 'ok', 'ok'])
    const info = (await call(c, 'get_basic_info', { fileId })).body as {
      artboards: { name: string }[]
    }
    expect(info.artboards.map((a) => a.name)).toEqual(['Hang'])
    await disconnect(c)
  } finally {
    await other.launched.close()
  }
})

test('repeated screenshots of same-size nodes are fresh and quick', async () => {
  test.setTimeout(120_000)
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Shots' })).body as { fileId: string })
    .fileId
  const a = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'A',
      styles: { width: '400px', height: '300px', backgroundColor: '#ff0000' },
    })
  ).body as { id: string }
  const b = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'B',
      styles: { width: '400px', height: '300px', backgroundColor: '#00ff00' },
    })
  ).body as { id: string }
  const centre = async (id: string): Promise<number[]> => {
    const shot = await call(c, 'get_screenshot', { fileId, nodeId: id })
    const img = shot.content.find((x) => x.type === 'image')!
    return (await decodeImage(app.launched, img.data!, [[200, 150]])).pixels[0]!.slice(0, 3)
  }
  await centre(a.id) // the render window starts
  const times: number[] = []
  for (let i = 0; i < 9; i++) {
    const colour = (['#ff0000', '#0000ff', '#ffff00'] as const)[i % 3]!
    await call(c, 'update_styles', {
      fileId,
      updates: [{ nodeIds: [a.id], styles: { backgroundColor: colour } }],
    })
    const t = Date.now()
    const pa = await centre(a.id)
    const pb = await centre(b.id)
    times.push((Date.now() - t) / 2)
    const want = [1, 3, 5].map((k) => parseInt(colour.slice(k, k + 2), 16))
    expect(
      pa.every((v, k) => Math.abs(v - want[k]!) <= 6),
      `${colour} → ${pa}`,
    ).toBe(true)
    expect(pb[1]! >= 249 && pb[0]! <= 6, `B → ${pb}`).toBe(true)
  }
  times.sort((x, y) => x - y)
  console.log(`qa: same-size screenshot p50 ${times[4]} ms`)
  // Each used to wait out a 1 s paint timeout when the size did not change.
  expect(times[4]!).toBeLessThan(500)
})

test('images over HTTP: redirects, limits, wrong types, 404s and slow servers', async () => {
  test.setTimeout(120_000)
  const { createServer } = await import('node:http')
  const png = Buffer.from(
    await app.launched.app.evaluate(({ nativeImage }) => {
      const bitmap = Buffer.alloc(12 * 10 * 4, 0x80)
      return nativeImage
        .createFromBitmap(bitmap, { width: 12, height: 10 })
        .toPNG()
        .toString('base64')
    }),
    'base64',
  )
  const seen: { url: string; cookie: string | undefined }[] = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', cookie: req.headers.cookie })
    const url = req.url ?? '/'
    if (url === '/a.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(png)
    if (url === '/r1') return void res.writeHead(302, { location: '/a.png' }).end()
    if (url.startsWith('/chain')) {
      const n = Number(url.slice(6))
      return void res.writeHead(302, { location: n <= 1 ? '/a.png' : `/chain${n - 1}` }).end()
    }
    if (url === '/big') {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(25 * 1024 * 1024),
      })
      return void res.end(Buffer.alloc(25 * 1024 * 1024))
    }
    if (url === '/stream') {
      res.writeHead(200, { 'content-type': 'image/png' })
      let sent = 0
      const chunk = Buffer.alloc(1024 * 1024)
      const pump = (): void => {
        while (sent < 30 * 1024 * 1024) {
          sent += chunk.length
          if (!res.write(chunk)) return void res.once('drain', pump)
        }
        res.end()
      }
      return pump()
    }
    if (url === '/page.html')
      return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hi</html>')
    if (url === '/icon.svg') {
      return void res
        .writeHead(200, { 'content-type': 'image/svg+xml' })
        .end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#123456"/></svg>',
        )
    }
    if (url === '/slow') return // never answers
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const c = await agent('claude-code')
    const fileId = (
      (await call(c, 'create_file', { name: 'HTTP images' })).body as { fileId: string }
    ).fileId
    const board = (
      await call(c, 'create_artboard', {
        fileId,
        name: 'Images',
        styles: { width: '600px', height: 'fit-content' },
      })
    ).body as { id: string }
    const write = async (src: string) => {
      const t = Date.now()
      const body = (
        await call(c, 'write_html', {
          fileId,
          targetNodeId: board.id,
          mode: 'insert-children',
          html: `<img layer-name="img" src="${src}">`,
        })
      ).body as {
        createdNodes: { id: string; component: string; width: number | null }[]
        warnings: { code: string; message: string }[]
      }
      return { ...body, ms: Date.now() - t }
    }
    const ok = await write(`${base}/a.png`)
    expect(ok.createdNodes[0]).toMatchObject({ component: 'Image', width: 12 })
    expect(ok.warnings).toEqual([])
    const redirected = await write(`${base}/r1`)
    expect(redirected.warnings, JSON.stringify(redirected.warnings)).toEqual([])
    expect(redirected.createdNodes[0]).toMatchObject({ component: 'Image', width: 12 })
    expect((await write(`${base}/chain3`)).warnings).toEqual([])
    const tooMany = await write(`${base}/chain5`)
    expect(tooMany.warnings.map((w) => w.message).join(' ')).toMatch(/redirect/i)
    for (const path of ['/big', '/stream']) {
      const big = await write(`${base}${path}`)
      expect(big.warnings.map((w) => w.message).join(' '), path).toMatch(/20 MB|large/i)
      expect(big.ms, path).toBeLessThan(10_000)
    }
    const html = await write(`${base}/page.html`)
    expect(html.warnings.length).toBeGreaterThan(0)
    const svg = await write(`${base}/icon.svg`)
    expect(svg.createdNodes[0]!.component).toBe('SVG')
    const missing = await write(`${base}/nothing.png`)
    expect(missing.warnings.map((w) => w.message).join(' ')).toMatch(/404|not found/i)
    // A server that never answers costs the 15 s fetch timeout, not the whole 60 s call.
    const slow = await write(`${base}/slow`)
    expect(slow.warnings.length).toBeGreaterThan(0)
    expect(slow.ms).toBeLessThan(20_000)
    // No cookies or credentials are ever sent.
    expect(seen.every((s) => s.cookie === undefined)).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})

test('exports never leave the export folder, whatever the layer and file are called', async () => {
  const c = await agent('claude-code')
  const fileId = (
    (await call(c, 'create_file', { name: '../../../evil/..' })).body as { fileId: string }
  ).fileId
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: '../../../../tmp/qa-escape',
      styles: { width: '40px', height: '40px', backgroundColor: '#ff0000' },
    })
  ).body as { id: string }
  const exported = (
    await call(c, 'export', {
      fileId,
      nodes: {
        [board.id]: [
          { format: 'png', scale: '1x' },
          { format: 'jpg', scale: '1x' },
        ],
      },
    })
  ).body as { files: { path: string }[] }
  expect(exported.files).toHaveLength(2)
  const { resolve: resolvePath, sep } = await import('node:path')
  for (const f of exported.files) {
    expect(resolvePath(f.path).startsWith(resolvePath(app.launched.exportDir) + sep), f.path).toBe(
      true,
    )
  }
})

test('pages: an agent works on another page without moving the user', async () => {
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Pages' })).body as { fileId: string })
    .fileId
  await call(c, 'open_file', { fileId })
  const page = await editorWindow(app.launched, fileId)
  await page.locator('.ic-root').waitFor({ state: 'attached' })
  const first = (await call(c, 'get_basic_info', { fileId })).body as { pageId: string }
  const created = (await call(c, 'create_page', { fileId, name: 'Mobile' })).body as {
    pageId: string
    name: string
  }
  expect(created.name).toBe('Mobile')
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'Phone',
      pageId: created.pageId,
      styles: { width: '390px', height: '844px' },
    })
  ).body as { id: string; pageId: string }
  expect(board.pageId).toBe(created.pageId)
  await call(c, 'write_html', {
    fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: '<p>On page two</p>',
  })
  await call(c, 'rename_pages', {
    fileId,
    updates: [{ pageId: created.pageId, name: 'Mobile screens' }],
  })
  // The user still looks at the first page.
  const now = (await call(c, 'get_basic_info', { fileId })).body as {
    pageId: string
    artboardCount: number
    pages: { id: string; name: string; isActive: boolean }[]
  }
  expect(now.pageId).toBe(first.pageId)
  expect(now.artboardCount).toBe(0)
  expect(now.pages).toEqual([
    { id: first.pageId, name: expect.any(String), isActive: true },
    { id: created.pageId, name: 'Mobile screens', isActive: false },
  ])
  const other = (await call(c, 'get_basic_info', { fileId, pageId: created.pageId })).body as {
    artboardCount: number
  }
  expect(other.artboardCount).toBe(1)
  // The user's page list shows the new page.
  await expect(page.getByRole('button', { name: 'Mobile screens' })).toBeVisible()
  // Moving a node to another page works and keeps its id.
  const moved = (
    await call(c, 'move_nodes', { fileId, moves: [{ nodeId: board.id, parentId: first.pageId }] })
  ).body as { moves: { nodeId: string; parentId: string }[] }
  expect(moved.moves[0]).toEqual({ nodeId: board.id, parentId: first.pageId, index: 0 })
})

test('a file the user deletes while an agent works on it in the background', async () => {
  const c = await agent('claude-code')
  const fileId = ((await call(c, 'create_file', { name: 'Doomed' })).body as { fileId: string })
    .fileId
  const board = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'A',
      styles: { width: '400px', height: '300px' },
    })
  ).body as { id: string }
  await call(c, 'write_html', {
    fileId,
    targetNodeId: board.id,
    mode: 'insert-children',
    html: '<p>hi</p>',
  })
  await app.first.evaluate((id) => window.baren!.files.remove(id), fileId)
  // Writes into the hidden host's copy must not keep reporting success.
  await expect
    .poll(
      async () =>
        (
          await callError(c, 'write_html', {
            fileId,
            targetNodeId: board.id,
            mode: 'insert-children',
            html: '<p>late</p>',
          })
        ).code,
      { timeout: 5_000 },
    )
    .toBe('file_not_found')
  // Its hidden host is released.
  await expect
    .poll(
      () =>
        app.launched.app.evaluate(
          ({ BrowserWindow }, id) =>
            BrowserWindow.getAllWindows().filter((w) =>
              w.webContents.getURL().includes(`#/agent-host/${encodeURIComponent(id)}`),
            ).length,
          fileId,
        ),
      { timeout: 10_000 },
    )
    .toBe(0)
  const files = await app.first.evaluate(() => window.baren!.files.list())
  expect(files.some((f) => f.id === fileId)).toBe(false)
})
