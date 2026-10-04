/**
 * MCP end to end (contract docs/phase4/contract.md §14.5): the built app, hidden, with a scratch
 * profile and an ephemeral port, driven by an SDK client through a full design session. Nothing
 * is shown; the user's profile and ports 8787/5173 are never used.
 *
 * Opt-in: `pnpm --filter @baren/desktop build`, then
 * `BAREN_MCP_E2E=1 pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts`.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, test, type Page } from '@playwright/test'
import {
  call,
  connect,
  jsxToHtml,
  launchApp,
  readEndpoint,
  shape,
  waitFor,
  type LaunchedApp,
} from './harness'

test.skip(!process.env['BAREN_MCP_E2E'], 'set BAREN_MCP_E2E=1 (needs a build)')

type Created = {
  createdNodes: { id: string; name: string; component: string }[]
  summary: string
  warnings: unknown[]
}

let launched: LaunchedApp
const clients: Client[] = []

test.afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  await launched?.close()
})

/** The app window that shows `fileId` (an editor route). */
async function editorWindow(fileId: string): Promise<Page> {
  return waitFor(
    () =>
      launched.app
        .windows()
        .find((w) => decodeURIComponent(w.url()).includes(`#/file/${fileId}`)) ?? null,
    20_000,
    `a window on file ${fileId}`,
  )
}

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('a full design session through the MCP server', async () => {
  launched = await launchApp()
  const { app } = launched
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  // A fresh profile starts on the sign-in screen: continue offline (local files only).
  await first.evaluate(() => {
    localStorage.setItem('baren.offline', '1')
    location.hash = '#/recents'
    location.reload()
  })
  await first.waitForLoadState('domcontentloaded')

  const endpoint = await readEndpoint(launched.userData)
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const client = await connect(endpoint)
  clients.push(client)

  // 1. Tools, guide, files.
  await test.step('lists the tools, the guide and the files', async () => {
    const tools = (await client.listTools()).tools
    expect(tools).toHaveLength(33)
    const guide = await call(client, 'get_guide', { topic: 'baren-mcp-instructions' })
    expect(String(guide.body)).toMatch(/^# Working in Baren/)
    const files = (await call(client, 'list_files')).body as { files: unknown[] }
    expect(Array.isArray(files.files)).toBe(true)
  })

  // 2. create_file → open_file.
  const file = (await call(client, 'create_file', { name: 'MCP e2e' })).body as { fileId: string }
  const opened = await call(client, 'open_file', { fileId: file.fileId })
  expect(opened.header).toMatchObject({ file: { id: file.fileId, name: 'MCP e2e' } })
  const page = await editorWindow(file.fileId)
  const info = (await call(client, 'get_basic_info', { fileId: file.fileId })).body as {
    fileName: string
    pageId: string
    artboardCount: number
  }
  expect(info.fileName).toBe('MCP e2e')

  // 3. Artboard, several write_html calls, styles, text, duplicate.
  const artboard = (
    await call(client, 'create_artboard', {
      fileId: file.fileId,
      name: 'Desktop',
      styles: { width: '1440px', height: '900px' },
    })
  ).body as { id: string }
  const write = async (target: string, html: string): Promise<Created> =>
    (
      await call(client, 'write_html', {
        fileId: file.fileId,
        targetNodeId: target,
        mode: 'insert-children',
        html,
      })
    ).body as Created
  const headerNode = await write(
    artboard.id,
    '<div layer-name="Header" style="display: flex; align-items: center; justify-content: space-between; padding: 24px 40px; background-color: #1F7A50; height: 96px"><p layer-name="Logo" style="color: #ffffff; font-size: 20px; font-weight: 600">baren</p></div>',
  )
  await write(
    artboard.id,
    '<div layer-name="Hero" style="display: flex; flex-direction: column; gap: 12px; padding: 48px 40px"><h1 style="font-size: 40px; color: #14213D">Design with agents</h1><p style="font-size: 16px; color: #555555">Live, on the canvas.</p></div>',
  )
  const card = (
    await write(
      artboard.id,
      '<div layer-name="Card" style="display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 20px; border-radius: 12px; background-color: #F5F7FB; width: 480px"></div>',
    )
  ).createdNodes[0]!
  const row = (
    await write(
      card.id,
      '<div layer-name="Row" style="display: flex; justify-content: space-between; padding: 8px 0"><span style="font-size: 14px">Seats</span><span style="font-size: 14px; font-weight: 600">5</span></div>',
    )
  ).createdNodes[0]!
  await write(
    card.id,
    '<div layer-name="Row 2" style="display: flex; justify-content: space-between; padding: 8px 0"><span style="font-size: 14px">Storage</span><span style="font-size: 14px; font-weight: 600">1 TB</span></div>',
  )
  const styled = (
    await call(client, 'update_styles', {
      fileId: file.fileId,
      updates: [
        { nodeIds: [artboard.id], styles: { height: 'fit-content' } },
        { nodeIds: [headerNode.createdNodes[0]!.id], styles: { objectFit: 'cover' } },
      ],
    })
  ).body as { updated: string[]; ignoredStyles?: Record<string, string[]> }
  expect(styled.updated).toContain(artboard.id)
  expect(styled.ignoredStyles?.[headerNode.createdNodes[0]!.id]).toContain('objectFit')
  const title = (
    await write(
      artboard.id,
      '<p layer-name="Footnote" style="font-size: 12px; padding: 0 40px 24px">Draft</p>',
    )
  ).createdNodes[0]!
  expect(title.component).toBe('Text')
  await call(client, 'set_text_content', {
    fileId: file.fileId,
    updates: [{ nodeId: title.id, textContent: 'Final' }],
  })
  const dup = (
    await call(client, 'duplicate_nodes', { fileId: file.fileId, nodes: [{ id: row.id }] })
  ).body as {
    duplicates: { sourceId: string; newId: string }[]
    descendantIdMap: Record<string, string>
  }
  expect(dup.duplicates[0]!.sourceId).toBe(row.id)
  const rowChildren = (await call(client, 'get_children', { fileId: file.fileId, nodeId: row.id }))
    .body as {
    children: { id: string; component: string }[]
  }
  const copiedLabel = dup.descendantIdMap[rowChildren.children[0]!.id]!
  await call(client, 'set_text_content', {
    fileId: file.fileId,
    updates: [{ nodeId: copiedLabel, textContent: 'Members' }],
  })
  const copiedInfo = (
    await call(client, 'get_node_info', { fileId: file.fileId, nodeId: copiedLabel })
  ).body as {
    textContent: string
  }
  expect(copiedInfo.textContent).toBe('Members')

  // 4. Screenshot: a JPEG with the artboard's aspect ratio and the header colour.
  await test.step('screenshots the artboard', async () => {
    const shot = await call(client, 'get_screenshot', { fileId: file.fileId, nodeId: artboard.id })
    const image = shot.content.find((c) => c.type === 'image')!
    expect(image.mimeType).toBe('image/jpeg')
    const node = (await call(client, 'get_node_info', { fileId: file.fileId, nodeId: artboard.id }))
      .body as {
      width: number
      height: number
    }
    const decoded = await app.evaluate(({ nativeImage }, b64) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
      const size = img.getSize()
      const bitmap = img.toBitmap() // BGRA
      const at = (x: number, y: number) => {
        const i = (y * size.width + x) * 4
        return [bitmap[i + 2], bitmap[i + 1], bitmap[i]]
      }
      return { size, header: at(5, 5) }
    }, image.data!)
    expect(
      Math.abs(decoded.size.width / decoded.size.height - node.width / node.height),
    ).toBeLessThan(0.02)
    if (process.env['BAREN_MCP_E2E_SAVE']) {
      writeFileSync(process.env['BAREN_MCP_E2E_SAVE'], Buffer.from(image.data!, 'base64'))
      console.log('header pixel', decoded.header, decoded.size)
    }
    const [r, g, b] = decoded.header as number[]
    expect(Math.abs(r! - 0x1f)).toBeLessThanOrEqual(2)
    expect(Math.abs(g! - 0x7a)).toBeLessThanOrEqual(2)
    expect(Math.abs(b! - 0x50)).toBeLessThanOrEqual(2)
  })

  // 5. JSX round trip: get_jsx(inline-styles) → HTML → write_html into a new artboard.
  await test.step('round-trips JSX', async () => {
    const jsx = String(
      (
        await call(client, 'get_jsx', {
          fileId: file.fileId,
          nodeId: card.id,
          format: 'inline-styles',
        })
      ).body,
    )
    const second = (
      await call(client, 'create_artboard', {
        fileId: file.fileId,
        name: 'Round trip',
        styles: { width: '600px', height: 'fit-content' },
      })
    ).body as { id: string }
    const copy = (await write(second.id, jsxToHtml(jsx))).createdNodes[0]!
    const a = (
      await call(client, 'get_tree_summary', { fileId: file.fileId, nodeId: card.id, depth: 5 })
    ).body as { summary: string }
    const b = (
      await call(client, 'get_tree_summary', { fileId: file.fileId, nodeId: copy.id, depth: 5 })
    ).body as { summary: string }
    expect(shape(b.summary)).toEqual(shape(a.summary))
    const styles = (
      await call(client, 'get_computed_styles', {
        fileId: file.fileId,
        nodeIds: [card.id, copy.id],
      })
    ).body as {
      styles: Record<string, Record<string, unknown>>
    }
    expect(styles.styles[copy.id]).toEqual(styles.styles[card.id])
  })

  // 6. The agent shows in the inspector header; finish_working_on_nodes releases it.
  await test.step('shows the agent and releases its working indicator', async () => {
    await expect(page.locator('[title="baren-e2e (agent)"]').first()).toBeVisible({
      timeout: 10_000,
    })
    const before = await page.evaluate(() => window.baren!.mcp.status())
    const me = before.agents.find((a) => a.name === 'baren-e2e')!
    expect(me.connected).toBe(true)
    expect(me.files.find((f) => f.fileId === file.fileId)?.working).toContain(artboard.id)
    const done = (await call(client, 'finish_working_on_nodes', { fileId: file.fileId })).body as {
      released: string[]
    }
    expect(done.released).toContain(artboard.id)
    const after = await page.evaluate(() => window.baren!.mcp.status())
    expect(after.agents.find((a) => a.name === 'baren-e2e')!.files).toEqual([])
  })

  // 7. Undo: Ctrl+Z in the window removes the last write only; Ctrl+Shift+Z brings it back.
  await test.step('undoes one tool call per step', async () => {
    const count = async () =>
      (
        (await call(client, 'get_children', { fileId: file.fileId, nodeId: artboard.id })).body as {
          count: number
        }
      ).count
    await write(
      artboard.id,
      '<div layer-name="Last" style="height: 40px; background-color: #eeeeee"></div>',
    )
    const n = await count()
    await page.bringToFront()
    await page.mouse.click(700, 450)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+z')
    await expect.poll(count, { timeout: 5_000 }).toBe(n - 1)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(count, { timeout: 5_000 }).toBe(n)
  })

  // 8. A file nobody has open: a hidden host serves it, then hands it to a window.
  await test.step('serves a file without a window, then hands it off', async () => {
    const other = (await call(client, 'create_file', { name: 'MCP e2e headless' })).body as {
      fileId: string
    }
    const board = (
      await call(client, 'create_artboard', {
        fileId: other.fileId,
        name: 'Phone',
        styles: { width: '390px', height: '844px' },
      })
    ).body as { id: string }
    await call(client, 'write_html', {
      fileId: other.fileId,
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div layer-name="Bar" style="height: 64px; background-color: #d21f75"></div>',
    })
    const shot = await call(client, 'get_screenshot', { fileId: other.fileId, nodeId: board.id })
    expect(shot.content.some((c) => c.type === 'image')).toBe(true)
    expect(launched.app.windows().some((w) => w.url().includes(`#/file/${other.fileId}`))).toBe(
      false,
    )
    await call(client, 'open_file', { fileId: other.fileId })
    await editorWindow(other.fileId)
    const children = (
      await call(client, 'get_children', { fileId: other.fileId, nodeId: board.id })
    ).body as {
      count: number
    }
    expect(children.count).toBe(1)
  })

  // 9. Export png@2x and an SVG icon.
  await test.step('exports files', async () => {
    const icon = (
      await write(
        artboard.id,
        '<svg layer-name="Star" width="24" height="24" viewBox="0 0 24 24"><path d="M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z" fill="#d21f75"/></svg>',
      )
    ).createdNodes[0]!
    const exported = (
      await call(client, 'export', {
        fileId: file.fileId,
        nodes: {
          [card.id]: [{ format: 'png', scale: '2x' }],
          [icon.id]: [{ format: 'svg', scale: '1x' }],
        },
      })
    ).body as {
      files: { path: string; format: string; width: number; height: number; bytes: number }[]
    }
    const png = exported.files.find((f) => f.format === 'png')!
    const svg = exported.files.find((f) => f.format === 'svg')!
    expect(png.path.startsWith(launched.exportDir)).toBe(true)
    expect(statSync(png.path).size).toBe(png.bytes)
    expect(pngSize(png.path)).toEqual({ width: png.width, height: png.height })
    expect(png.width).toBe(960)
    expect(readFileSync(svg.path, 'utf8')).toContain('<svg')
  })

  // 10. Token reset: the old client gets 401, a new one with the new token works.
  await test.step('resets the token', async () => {
    const setup = await page.evaluate(() => window.baren!.mcp.resetToken())
    expect(setup.token).not.toBe(endpoint.token)
    await expect(client.callTool({ name: 'list_files', arguments: {} })).rejects.toThrow()
    const fresh = await connect({ url: endpoint.url, token: setup.token }, 'baren-e2e-2')
    clients.push(fresh)
    expect((await fresh.listTools()).tools).toHaveLength(33)
  })
  if (process.env['BAREN_MCP_E2E_VERBOSE']) console.log('mcp e2e: all ten steps passed')
})
