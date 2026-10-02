/**
 * QA: tool latency through a real MCP client on a 20k-node file, in a visible editor window and
 * in a hidden host: p50/p95 of client round trips (main + IPC + renderer) for reads and small
 * writes, after one warm-up call each. Budgets are the contract's renderer budgets (§11.7) plus
 * room for the round trip.
 *
 * Opt-in: `pnpm --filter @baren/desktop build`, then
 * `BAREN_MCP_E2E=1 pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts qa-perf`.
 * `BAREN_MCP_PERF_OUT=<file>` writes the numbers as JSON.
 */
import { writeFileSync } from 'node:fs'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, test } from '@playwright/test'
import {
  call,
  connect,
  disconnect,
  editorWindow,
  latency,
  launchOffline,
  type OfflineApp,
} from './qa-helpers'

test.skip(!process.env['BAREN_MCP_E2E'], 'set BAREN_MCP_E2E=1 (needs a build)')

let app: OfflineApp

test.afterAll(async () => {
  await app?.launched.close()
})

const ARTBOARDS = 10
const ROWS = 666 // × 3 layers + the list = 1,999 per artboard → 20k nodes with the artboards

function rows(n: number, board: number): string {
  let out = ''
  for (let i = 0; i < n; i++) {
    const colour = ((board * 7919 + i * 104729) % 0xffffff).toString(16).padStart(6, '0')
    out += `<div style="display:flex;gap:8px;padding:4px 8px;align-items:center"><span style="font-size:12px;color:#222222">Item ${board}-${i}</span><div style="width:10px;height:10px;border-radius:5px;background-color:#${colour}"></div></div>`
  }
  return out
}

const FIFTEEN_LINES = `<div layer-name="Card" style="display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:12px;background-color:#F6F7F9;width:360px">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:16px;font-weight:600">Weekly report</span>
    <span style="font-size:12px;color:#5B6472">Mon</span>
  </div>
  <div style="display:flex;gap:8px">
    <div style="width:8px;height:8px;border-radius:4px;background-color:#1F6FEB"></div>
    <span style="font-size:14px">Sessions up 12%</span>
  </div>
  <div style="display:flex;gap:8px">
    <div style="width:8px;height:8px;border-radius:4px;background-color:#E8590C"></div>
    <span style="font-size:14px">Churn down 3%</span>
  </div>
  <div style="display:flex;justify-content:flex-end"><span style="font-size:14px;color:#1F6FEB">Open</span></div>
</div>`

async function buildFile(
  c: Client,
  name: string,
): Promise<{ fileId: string; boards: string[]; buildMs: number }> {
  const fileId = ((await call(c, 'create_file', { name })).body as { fileId: string }).fileId
  const boards: string[] = []
  const t = Date.now()
  for (let b = 0; b < ARTBOARDS; b++) {
    const board = (
      await call(c, 'create_artboard', {
        fileId,
        name: `Board ${b}`,
        styles: { width: '480px', height: 'fit-content' },
      })
    ).body as { id: string }
    await call(c, 'write_html', {
      fileId,
      targetNodeId: board.id,
      mode: 'insert-children',
      html: `<div layer-name="List" style="display:flex;flex-direction:column">${rows(ROWS, b)}</div>`,
    })
    boards.push(board.id)
  }
  return { fileId, boards, buildMs: Date.now() - t }
}

type Stats = { p50: number; p95: number; max: number }

async function measure(
  c: Client,
  fileId: string,
  boards: string[],
): Promise<Record<string, Stats>> {
  const board = boards[3]!
  const list = (
    (await call(c, 'get_children', { fileId, nodeId: board })).body as {
      children: { id: string }[]
    }
  ).children[0]!.id
  const someRows = (
    (await call(c, 'get_children', { fileId, nodeId: list })).body as { children: { id: string }[] }
  ).children
    .slice(0, 30)
    .map((r) => r.id)
  const leaf = (
    (await call(c, 'get_children', { fileId, nodeId: someRows[0]! })).body as {
      children: { id: string }[]
    }
  ).children[0]!.id
  const sandbox = (
    await call(c, 'create_artboard', {
      fileId,
      name: 'Sandbox',
      styles: { width: '800px', height: 'fit-content' },
    })
  ).body as { id: string }
  const runs = 20
  const out: Record<string, Stats> = {}
  const run = async (
    name: string,
    fn: (i: number) => Promise<unknown>,
    n = runs,
  ): Promise<void> => {
    await fn(-1) // warm-up (the first whole-file read loads the document mirror)
    out[name] = await latency(n, fn)
  }
  await run('get_basic_info', () => call(c, 'get_basic_info', { fileId }))
  await run('get_tree_summary (artboard, depth 3)', () =>
    call(c, 'get_tree_summary', { fileId, nodeId: board }),
  )
  await run('get_children (666 rows)', () => call(c, 'get_children', { fileId, nodeId: list }))
  await run('get_node_info', () => call(c, 'get_node_info', { fileId, nodeId: leaf }))
  await run('find_nodes (text, whole file)', (i) =>
    call(c, 'find_nodes', { fileId, textValue: `Item ${(i + 10) % 10}-4*` }),
  )
  await run('find_nodes (colour, whole file)', () =>
    call(c, 'find_nodes', { fileId, filters: [{ styleName: 'color', styleValue: '#222222' }] }),
  )
  await run('get_computed_styles (30 nodes)', () =>
    call(c, 'get_computed_styles', { fileId, nodeIds: someRows }),
  )
  await run('get_jsx (one row)', () => call(c, 'get_jsx', { fileId, nodeId: someRows[1]! }))
  await run('get_tokens', () => call(c, 'get_tokens', { fileId }))
  await run('write_html (15 lines)', () =>
    call(c, 'write_html', {
      fileId,
      targetNodeId: sandbox.id,
      mode: 'insert-children',
      html: FIFTEEN_LINES,
    }),
  )
  await run('update_styles (1 node)', (i) =>
    call(c, 'update_styles', {
      fileId,
      updates: [{ nodeIds: [leaf], styles: { fontSize: `${12 + (i & 1)}px` } }],
    }),
  )
  await run('set_text_content', (i) =>
    call(c, 'set_text_content', {
      fileId,
      updates: [{ nodeId: leaf, textContent: `Item edited ${i}` }],
    }),
  )
  await run('rename_nodes', (i) =>
    call(c, 'rename_nodes', { fileId, updates: [{ nodeId: leaf, name: `Label ${i}` }] }),
  )
  const copies: string[] = []
  await run('duplicate_nodes (one row)', async () => {
    const d = (await call(c, 'duplicate_nodes', { fileId, nodes: [{ id: someRows[2]! }] }))
      .body as {
      duplicates: { newId: string }[]
    }
    copies.push(d.duplicates[0]!.newId)
  })
  await run('move_nodes', (i) =>
    call(c, 'move_nodes', {
      fileId,
      moves: [{ nodeId: copies[0]!, parentId: list, index: (i + 2) * 7 }],
    }),
  )
  await run(
    'delete_nodes',
    async () => {
      const id = copies.pop()
      if (id) await call(c, 'delete_nodes', { fileId, nodeIds: [id] })
    },
    Math.min(runs, copies.length - 1),
  )
  await run(
    'get_screenshot (480 px artboard)',
    () => call(c, 'get_screenshot', { fileId, nodeId: board }),
    8,
  )
  return out
}

test('tool latency on a 20k-node file (visible window and hidden host)', async () => {
  test.setTimeout(600_000)
  app = await launchOffline()
  const c = await connect(app.endpoint, 'claude-code')
  const report: Record<string, unknown> = {}
  try {
    // Visible: the file is open in the user's window.
    const visible = await buildFile(c, 'Perf 20k visible')
    await call(c, 'open_file', { fileId: visible.fileId })
    await editorWindow(app.launched, visible.fileId)
    const info = (await call(c, 'get_basic_info', { fileId: visible.fileId })).body as {
      nodeCount: number
    }
    expect(info.nodeCount).toBeGreaterThanOrEqual(20_000)
    report['visible'] = {
      nodeCount: info.nodeCount,
      buildMs: visible.buildMs,
      ...(await measure(c, visible.fileId, visible.boards)),
    }
    // Hidden host: a file nobody has open.
    const hidden = await buildFile(c, 'Perf 20k hidden')
    report['hidden'] = {
      buildMs: hidden.buildMs,
      ...(await measure(c, hidden.fileId, hidden.boards)),
    }
  } finally {
    await disconnect(c)
  }
  console.log(JSON.stringify(report, null, 1))
  if (process.env['BAREN_MCP_PERF_OUT'])
    writeFileSync(process.env['BAREN_MCP_PERF_OUT'], JSON.stringify(report, null, 2))
  for (const where of ['visible', 'hidden'] as const) {
    const r = report[where] as Record<string, Stats>
    // Contract §11.7 (renderer time) + the client round trip.
    expect(r['get_basic_info']!.p50, `${where} get_basic_info`).toBeLessThan(150 + 50)
    expect(r['write_html (15 lines)']!.p50, `${where} write_html`).toBeLessThan(50 + 100)
    for (const [name, s] of Object.entries(r)) {
      if (typeof s !== 'object' || name.startsWith('get_screenshot')) continue
      expect(s.p95, `${where} ${name}`).toBeLessThan(1_000)
    }
  }
})
