/**
 * QA: a realistic agent design session through a real MCP client (SDK Client over Streamable
 * HTTP) against the built app, hidden, with a scratch profile — the way Claude Code works when it
 * follows the guide: list_files → create_file → open_file → get_basic_info → tokens → artboard →
 * many small write_html calls → update/text/rename/duplicate/move/delete → reads, JSX, styles and
 * screenshots → finish_working_on_nodes. Checks the document (through MCP), the canvas DOM of
 * the visible window and the screenshot pixels, then undoes every tool call with Ctrl+Z (one
 * step each, back to the exact previous state) and redoes them all.
 *
 * Opt-in: `pnpm --filter @baren/desktop build`, then
 * `BAREN_MCP_E2E=1 pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts qa-session`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, test, type Page } from '@playwright/test'
import {
  call,
  connect,
  decodeImage,
  docState,
  editorWindow,
  launchOffline,
  near,
  type OfflineApp,
} from './qa-helpers'

test.skip(!process.env['BAREN_MCP_E2E'], 'set BAREN_MCP_E2E=1 (needs a build)')

let app: OfflineApp
let client: Client

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await app?.launched.close()
})

type Created = {
  createdNodes: {
    id: string
    name: string
    component: string
    parentId: string
    worldX: number | null
    worldY: number | null
    width: number | null
    height: number | null
  }[]
  summary: string
  warnings: { code: string; message: string }[]
}

/** 2×1 PNG (red, blue). */
const PNG_2x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='

const ICON_CARD =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>'
const ICON_DB =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/></svg>'

function onCanvas(page: Page, id: string) {
  return page.locator(`.ic-root [data-nid="${id}"]`).first()
}

test('a full agent design session, checked in the document, the canvas and the pixels; one undo step per call', async () => {
  test.setTimeout(240_000)
  app = await launchOffline()
  const { launched } = app
  client = await connect(app.endpoint, 'claude-code') // Claude Code's clientInfo.name

  // A local avatar image (written by main with nativeImage: a solid #E8590C square).
  const avatarPath = join(launched.userData, '..', 'avatar.png')
  const pngB64 = await launched.app.evaluate(({ nativeImage }) => {
    const size = 48
    const bitmap = Buffer.alloc(size * size * 4)
    for (let i = 0; i < size * size; i++) bitmap.set([0x0c, 0x59, 0xe8, 0xff], i * 4) // BGRA
    return nativeImage
      .createFromBitmap(bitmap, { width: size, height: size })
      .toPNG()
      .toString('base64')
  })
  writeFileSync(avatarPath, Buffer.from(pngB64, 'base64'))

  // --- Orientation (guide §1) -------------------------------------------------------------
  const guide = String((await call(client, 'get_guide', { topic: 'baren-mcp-instructions' })).body)
  expect(guide).toContain('finish_working_on_nodes')
  const before = (await call(client, 'list_files')).body as { files: { id: string }[] }
  const file = (await call(client, 'create_file', { name: 'QA — Billing' })).body as {
    fileId: string
    url: string
  }
  expect(file.url).toBe(`baren://file/${file.fileId}`)
  const after = (await call(client, 'list_files')).body as {
    files: { id: string; name: string; isOpen: boolean }[]
  }
  expect(after.files.length).toBe(before.files.length + 1)
  expect(after.files.find((f) => f.id === file.fileId)).toMatchObject({ name: 'QA — Billing' })

  // The user's Recents list shows the new file right away (files:changed).
  await expect(app.first.locator(`[data-file-id="${file.fileId}"]`)).toBeVisible({
    timeout: 10_000,
  })

  await call(client, 'open_file', { fileId: file.fileId })
  const page = await editorWindow(launched, file.fileId)
  // The home window itself was navigated (no second window).
  expect(page).toBe(app.first)
  await page.locator('.ic-root').waitFor({ state: 'attached', timeout: 20_000 })
  // Without fileId the tools use the file the user is looking at.
  const info = await call(client, 'get_basic_info')
  expect(info.header).toMatchObject({ file: { id: file.fileId, name: 'QA — Billing' } })
  const basic = info.body as {
    pageId: string
    rootNodeId: string
    artboardCount: number
    pages: { id: string; isActive: boolean }[]
  }
  expect(basic.artboardCount).toBe(0)
  expect(basic.rootNodeId).toBe(basic.pageId)
  expect(basic.pages.find((p) => p.id === basic.pageId)?.isActive).toBe(true)
  const fonts = (
    await call(client, 'get_font_family_info', {
      familyNames: ['Inter', 'JetBrains Mono', 'No Such Font QA'],
    })
  ).body as { families: { familyName: string; available: boolean; source: string | null }[] }
  expect(fonts.families.map((f) => [f.familyName, f.available])).toEqual([
    ['Inter', true],
    ['JetBrains Mono', true],
    ['No Such Font QA', false],
  ])
  const sel = (await call(client, 'get_selection')).body as { count: number }
  expect(sel.count).toBe(0)

  const fileId = file.fileId
  const pageId = basic.pageId
  /** State before each write, for the undo walk at the end. */
  const history: { tool: string; state: string }[] = []
  const write = async (tool: string, args: Record<string, unknown>) => {
    history.push({ tool, state: await docState(client, fileId, pageId) })
    return call(client, tool, { fileId, ...args })
  }
  const html = async (target: string, markup: string): Promise<Created> => {
    const body = (
      await write('write_html', { targetNodeId: target, mode: 'insert-children', html: markup })
    ).body as Created
    expect(body.createdNodes.length).toBeGreaterThan(0)
    return body
  }

  // --- Tokens and the artboard (guide §5, §6) ------------------------------------------------
  const tokens = (
    await write('create_tokens', {
      tokens: [
        { type: 'color', name: '--color-background', value: '#FFFFFF' },
        { type: 'color', name: '--color-surface', value: '#F6F7F9' },
        { type: 'color', name: '--color-foreground', value: '#14171F' },
        { type: 'color', name: '--color-muted', value: '#5B6472' },
        { type: 'color', name: '--color-border', value: '#E3E6EB' },
        { type: 'color', name: '--color-primary', value: '#1F6FEB' },
        { type: 'spacing', name: '--spacing-2', value: '8px' },
        { type: 'spacing', name: '--spacing-4', value: '16px' },
        { type: 'spacing', name: '--spacing-6', value: '24px' },
        { type: 'radius', name: '--radius-md', value: '10px' },
        { type: 'fontSize', name: '--text-sm', value: '14px' },
        { type: 'fontSize', name: '--text-2xl', value: '28px' },
        { type: 'fontFamily', name: '--font-sans', value: 'Inter' },
      ],
    })
  ).body as { results: { name: string; result: string }[] }
  expect(tokens.results.every((r) => r.result === 'created')).toBe(true)

  const board = (
    await write('create_artboard', {
      name: 'Billing',
      styles: {
        width: '1440px',
        height: '900px',
        backgroundColor: 'var(--color-background)',
        fontFamily: 'var(--font-sans)',
      },
    })
  ).body as { id: string; worldX: number; worldY: number; width: number; height: number }
  expect(board).toMatchObject({ worldX: 0, worldY: 0, width: 1440, height: 900 })
  await expect(onCanvas(page, board.id)).toBeAttached()

  // --- Eight+ small write_html calls (guide §3) -----------------------------------------------
  const topBar = await html(
    board.id,
    `<div layer-name="Top bar" style="display:flex;align-items:center;justify-content:space-between;height:64px;padding:0 32px;background-color:#14171F;flex-shrink:0">
  <div layer-name="Brand" style="display:flex;align-items:center;gap:10px;color:#FFFFFF">
    <svg layer-name="Logo" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 2 22h20z"/></svg>
    <span style="font-size:16px;font-weight:600;color:#FFFFFF">Northwind</span>
  </div>
  <nav layer-name="Nav" style="display:flex;gap:24px">
    <span style="font-size:var(--text-sm);color:#AEB4BE">Overview</span>
    <span style="font-size:var(--text-sm);color:#FFFFFF">Billing</span>
    <span style="font-size:var(--text-sm);color:#AEB4BE">Team</span>
  </nav>
  <img layer-name="Avatar" src="${avatarPath}" style="width:32px;height:32px;border-radius:16px;object-fit:cover">
</div>`,
  )
  expect(topBar.warnings.filter((w) => /image|source/.test(w.code))).toEqual([])
  const topBarId = topBar.createdNodes[0]!.id
  expect(topBar.createdNodes[0]).toMatchObject({
    name: 'Top bar',
    component: 'Frame',
    worldX: 0,
    worldY: 0,
    width: 1440,
    height: 64,
  })
  expect(topBar.summary).toContain('Text "Billing"')
  expect(topBar.summary).toMatch(/Image "Avatar" \([^)]+\) 32×32/)

  const heading = await html(
    board.id,
    `<div layer-name="Page header" style="display:flex;flex-direction:column;gap:var(--spacing-2);padding:40px 32px 24px">
  <h1 layer-name="Title" style="font-size:var(--text-2xl);font-weight:700;line-height:36px;color:var(--color-foreground)">Billing</h1>
  <p layer-name="Subtitle" style="font-size:var(--text-sm);line-height:20px;color:var(--color-muted)">Manage your plan, payment method and invoices.</p>
</div>`,
  )
  const titleId = (
    (await call(client, 'get_children', { fileId, nodeId: heading.createdNodes[0]!.id })).body as {
      children: { id: string; name: string }[]
    }
  ).children.find((c) => c.name === 'Title')!.id

  const content = await html(
    board.id,
    `<div layer-name="Content" style="display:flex;gap:var(--spacing-6);padding:0 32px 32px;align-items:flex-start"></div>`,
  )
  const contentId = content.createdNodes[0]!.id

  const plan = await html(
    contentId,
    `<div layer-name="Plan card" style="display:flex;flex-direction:column;gap:var(--spacing-4);padding:24px;width:560px;border:1px solid var(--color-border);border-radius:var(--radius-md);background-color:var(--color-surface)">
  <div layer-name="Card header" style="display:flex;align-items:center;justify-content:space-between">
    <span style="font-size:18px;font-weight:600;color:var(--color-foreground)">Pro plan</span>
    <span layer-name="Badge" style="padding:2px 8px;border-radius:999px;background-color:color-mix(in srgb, var(--color-primary) 15%, transparent);color:var(--color-primary);font-size:12px;font-weight:600">Active</span>
  </div>
</div>`,
  )
  const planId = plan.createdNodes[0]!.id

  const row1 = await html(
    planId,
    `<div layer-name="Row" style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--color-border)">
  <div layer-name="Icon slot" style="display:flex;width:20px;flex-shrink:0;color:var(--color-muted)">${ICON_CARD}</div>
  <span layer-name="Label" style="flex-grow:1;font-size:var(--text-sm);color:var(--color-foreground)">Seats</span>
  <span layer-name="Value" style="width:96px;flex-shrink:0;text-align:right;font-size:var(--text-sm);font-weight:600;color:var(--color-foreground)">12 of 20</span>
</div>`,
  )
  const row1Id = row1.createdNodes[0]!.id

  await html(
    planId,
    `<div layer-name="Row" style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--color-border)">
  <div layer-name="Icon slot" style="display:flex;width:20px;flex-shrink:0;color:var(--color-muted)">${ICON_DB}</div>
  <span layer-name="Label" style="flex-grow:1;font-size:var(--text-sm);color:var(--color-foreground)">Storage</span>
  <span layer-name="Value" style="width:96px;flex-shrink:0;text-align:right;font-size:var(--text-sm);font-weight:600;color:var(--color-foreground)">1.2 TB</span>
</div>`,
  )

  const buttons = await html(
    planId,
    `<div layer-name="Actions" style="display:flex;gap:12px;padding-top:8px">
  <div layer-name="Primary button" style="display:flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:8px;background-color:var(--color-primary)"><span style="font-size:var(--text-sm);font-weight:600;color:#FFFFFF">Upgrade plan</span></div>
  <div layer-name="Secondary button" style="display:flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:8px;border:1px solid var(--color-border);background-color:#FFFFFF"><span style="font-size:var(--text-sm);font-weight:600;color:var(--color-foreground)">Cancel</span></div>
</div>`,
  )
  const primaryId = (
    (await call(client, 'get_children', { fileId, nodeId: buttons.createdNodes[0]!.id })).body as {
      children: { id: string; name: string }[]
    }
  ).children[0]!.id

  const usage = await html(
    contentId,
    `<div layer-name="Usage card" style="display:flex;flex-direction:column;gap:12px;padding:24px;width:360px;border:1px solid var(--color-border);border-radius:var(--radius-md)">
  <span style="font-size:var(--text-sm);font-weight:600;color:var(--color-foreground)">API usage</span>
  <div layer-name="Meter" style="position:relative;height:8px;border-radius:4px;background-color:var(--color-surface)">
    <div layer-name="Meter fill" style="position:absolute;left:0;top:0;width:62%;height:8px;border-radius:4px;background-color:var(--color-primary)"></div>
  </div>
  <p layer-name="Note" style="font-size:12px;color:var(--color-muted)">You used <b>62%</b> of this month's quota.</p>
</div>`,
  )
  const usageId = usage.createdNodes[0]!.id
  // Rich text is flattened with a warning (guide §4).
  expect(usage.warnings.map((w) => w.code).join(' ')).toMatch(/rich-text/)
  expect(usage.summary).toContain("You used 62% of this month's quota.")

  // A clone of the primary button, restyled.
  const clone = await html(
    usageId,
    `<x-baren-clone node-id="${primaryId}" style="background-color:var(--color-foreground);align-self:flex-start"></x-baren-clone>`,
  )
  expect(clone.createdNodes[0]).toMatchObject({ name: 'Primary button', component: 'Frame' })
  expect(clone.summary).toContain('Text "Upgrade plan"')

  const footer = await html(
    board.id,
    `<div layer-name="Footer" style="display:flex;align-items:center;gap:8px;padding:16px 32px;border-top:1px solid var(--color-border)">
  <img layer-name="Swatch" src="${PNG_2x1}" style="width:16px;height:8px">
  <span style="font-size:12px;color:var(--color-muted)">Invoices are emailed on the 1st of each month.</span>
</div>`,
  )
  expect(footer.summary).toMatch(/Image "Swatch" \([^)]+\) 16×8/)

  // --- Targeted edits ------------------------------------------------------------------------
  const styled = (
    await write('update_styles', {
      updates: [
        { nodeIds: [board.id], styles: { height: 'fit-content' } },
        {
          nodeIds: [topBar.createdNodes[0]!.id],
          styles: { paddingLeft: '40px', paddingRight: '40px' },
        },
        // gap is inert on an image layer: reported, not applied.
        {
          nodeIds: [
            (
              (await call(client, 'find_nodes', { fileId, filters: [{ styleName: 'objectFit' }] }))
                .body as {
                nodes: { id: string }[]
              }
            ).nodes[0]!.id,
          ],
          styles: { gap: '12px' },
        },
      ],
    })
  ).body as { updated: string[]; ignoredStyles?: Record<string, string[]> }
  expect(styled.updated).toContain(board.id)
  expect(Object.values(styled.ignoredStyles ?? {}).flat()).toContain('gap')

  await write('set_text_content', {
    updates: [{ nodeId: titleId, textContent: 'Billing & plans' }],
  })
  const renamed = (
    await write('rename_nodes', { updates: [{ nodeId: row1Id, name: '  Row / Seats  ' }] })
  ).body as { renamed: string[] }
  expect(renamed.renamed).toEqual([row1Id])

  const dup = (await write('duplicate_nodes', { nodes: [{ id: row1Id }] })).body as {
    duplicates: { sourceId: string; newId: string; parentId: string }[]
    descendantIdMap: Record<string, string>
  }
  expect(dup.duplicates[0]).toMatchObject({ sourceId: row1Id, parentId: planId })
  const rowKids = (await call(client, 'get_children', { fileId, nodeId: row1Id })).body as {
    children: { id: string; name: string }[]
  }
  expect(Object.keys(dup.descendantIdMap).sort()).toEqual(
    expect.arrayContaining(rowKids.children.map((c) => c.id)),
  )
  const copyLabel = dup.descendantIdMap[rowKids.children.find((c) => c.name === 'Label')!.id]!
  const copyValue = dup.descendantIdMap[rowKids.children.find((c) => c.name === 'Value')!.id]!
  await write('set_text_content', {
    updates: [
      { nodeId: copyLabel, textContent: 'Members' },
      { nodeId: copyValue, textContent: '9 active' },
    ],
  })

  const moved = (
    await write('move_nodes', {
      moves: [
        { nodeId: dup.duplicates[0]!.newId, before: row1Id },
        { nodeId: usageId, parentId: contentId, index: 0 },
      ],
    })
  ).body as {
    moves: { nodeId: string; parentId: string; index: number }[]
    affectedParents: Record<string, string[]>
  }
  expect(moved.moves).toEqual([
    { nodeId: dup.duplicates[0]!.newId, parentId: planId, index: 1 },
    { nodeId: usageId, parentId: contentId, index: 0 },
  ])
  expect(moved.affectedParents[contentId]).toEqual([usageId, planId])
  expect(moved.affectedParents[planId]![1]).toBe(dup.duplicates[0]!.newId)

  const noteId = (
    (await call(client, 'find_nodes', { fileId, textValue: 'you used*' })).body as {
      nodes: { id: string }[]
    }
  ).nodes[0]!.id
  const deleted = (await write('delete_nodes', { nodeIds: [noteId] })).body as { deleted: string[] }
  expect(deleted.deleted).toEqual([noteId])

  // --- Reads: structure, code, styles, search ------------------------------------------------
  const tree = (await call(client, 'get_tree_summary', { fileId, nodeId: board.id, depth: 6 }))
    .body as {
    summary: string
  }
  const lines = tree.summary.split('\n')
  expect(lines[0]).toMatch(/^Frame "Billing" \([^)]+\) 1440×\d+/)
  expect(tree.summary).toContain('Text "Title" (')
  expect(tree.summary).toContain('"Billing & plans"')
  expect(tree.summary.indexOf('"Members"')).toBeLessThan(tree.summary.indexOf('"Seats"'))
  expect(tree.summary).not.toContain('You used')
  expect(tree.summary).toContain('Frame "Row / Seats"')

  const jsx = String((await call(client, 'get_jsx', { fileId, nodeId: planId })).body)
  expect(jsx).toContain('Upgrade plan')
  expect(jsx).toMatch(/bg-primary|bg-\(--color-primary\)|var\(--color-primary\)/)
  const inline = String(
    (await call(client, 'get_jsx', { fileId, nodeId: planId, format: 'inline-styles' })).body,
  )
  expect(inline).toContain("backgroundColor: 'var(--color-primary)'")

  const declared = (
    await call(client, 'get_computed_styles', { fileId, nodeIds: [primaryId, board.id] })
  ).body as {
    styles: Record<string, Record<string, unknown>>
  }
  expect(declared.styles[primaryId]).toMatchObject({
    backgroundColor: 'var(--color-primary)',
    height: '40px',
  })
  expect(declared.styles[board.id]).toMatchObject({ height: 'fit-content', width: '1440px' })
  const resolved = (
    await call(client, 'get_computed_styles', { fileId, nodeIds: [primaryId], resolved: true })
  ).body as { styles: Record<string, Record<string, unknown>> }
  expect(resolved.styles[primaryId]).toMatchObject({
    backgroundColor: 'rgb(31, 111, 235)',
    height: '40px',
  })

  const byColour = (
    await call(client, 'find_nodes', {
      fileId,
      filters: [{ styleName: 'background-color', styleValue: '#1f6feb' }],
    })
  ).body as { nodes: { id: string; matched: { styleValue: string }[] }[] }
  expect(byColour.nodes.map((n) => n.id)).toContain(primaryId)
  expect(byColour.nodes.find((n) => n.id === primaryId)!.matched[0]!.styleValue).toBe(
    'var(--color-primary)',
  )

  // --- The canvas DOM of the user's window --------------------------------------------------
  const boardInfo = (await call(client, 'get_node_info', { fileId, nodeId: board.id })).body as {
    width: number
    height: number
    childIds: string[]
  }
  expect(boardInfo.childIds).toHaveLength(4)
  await page.keyboard.press('Shift+1').catch(() => undefined)
  for (const id of [
    board.id,
    topBarId,
    titleId,
    planId,
    primaryId,
    usageId,
    dup.duplicates[0]!.newId,
  ]) {
    await expect(onCanvas(page, id), id).toBeAttached()
  }
  await expect(onCanvas(page, titleId)).toHaveText('Billing & plans')
  await expect(onCanvas(page, copyLabel)).toHaveText('Members')
  expect(await page.locator(`.ic-root [data-nid="${noteId}"]`).count()).toBe(0)
  const primaryBg = await onCanvas(page, primaryId).evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  )
  expect(primaryBg).toBe('rgb(31, 111, 235)')

  // --- Screenshot: proportions and pixels ---------------------------------------------------
  const shot = await call(client, 'get_screenshot', { fileId, nodeId: board.id })
  const image = shot.content.find((c) => c.type === 'image')!
  expect(image.mimeType).toBe('image/jpeg')
  if (process.env['BAREN_MCP_E2E_SAVE']) {
    writeFileSync(
      join(process.env['BAREN_MCP_E2E_SAVE'], 'qa-session.jpg'),
      Buffer.from(image.data!, 'base64'),
    )
  }
  const primaryInfo = (await call(client, 'get_node_info', { fileId, nodeId: primaryId })).body as {
    worldX: number
    worldY: number
    width: number
    height: number
  }
  const avatarInfo = (
    await call(client, 'get_node_info', {
      fileId,
      nodeId: (
        (await call(client, 'find_nodes', { fileId, filters: [{ styleName: 'objectFit' }] }))
          .body as {
          nodes: { id: string }[]
        }
      ).nodes[0]!.id,
    })
  ).body as { worldX: number; worldY: number; width: number; height: number }
  const probe = await decodeImage(launched, image.data!, [])
  const k = probe.size.width / boardInfo.width
  expect(Math.abs(probe.size.height / k - boardInfo.height)).toBeLessThan(3)
  const decoded = await decodeImage(launched, image.data!, [
    [6 * k, 6 * k], // top bar
    [(primaryInfo.worldX + 4) * k, (primaryInfo.worldY + primaryInfo.height / 2) * k], // primary button, left padding
    [
      (avatarInfo.worldX + avatarInfo.width / 2) * k,
      (avatarInfo.worldY + avatarInfo.height / 2) * k,
    ], // avatar
    [(boardInfo.width - 20) * k, (boardInfo.height - 60) * k], // white ground
  ])
  const [bar, button, avatar, ground] = decoded.pixels
  expect(near(bar!, [0x14, 0x17, 0x1f], 4), String(bar)).toBe(true)
  expect(near(button!, [0x1f, 0x6f, 0xeb], 6), String(button)).toBe(true)
  expect(near(avatar!, [0xe8, 0x59, 0x0c], 8), String(avatar)).toBe(true)
  expect(near(ground!, [0xff, 0xff, 0xff], 3), String(ground)).toBe(true)
  // A child node screenshot at 2× (small text) has twice the node's size.
  const small = await call(client, 'get_screenshot', { fileId, nodeId: primaryId, scale: 2 })
  const smallSize = (
    await decodeImage(launched, small.content.find((c) => c.type === 'image')!.data!, [])
  ).size
  expect(smallSize.width).toBe(Math.ceil(primaryInfo.width * 2))

  // --- Presence, then release --------------------------------------------------------------
  await expect(page.locator('[title="Claude Code (agent)"]').first()).toBeVisible({
    timeout: 10_000,
  })
  const done = (await call(client, 'finish_working_on_nodes', { fileId, nodeIds: [primaryId] }))
    .body as {
    released: string[]
    remaining: string[]
  }
  expect(done.released).toEqual([board.id])
  expect(done.remaining).toEqual([])

  // --- Undo every tool call, one step each; then redo them all ------------------------------
  const final = await docState(client, fileId, pageId)
  await page.bringToFront()
  await page.mouse.click(5, 450) // the layers panel edge: focus the editor without editing
  await page.keyboard.press('Escape')
  for (let i = history.length - 1; i >= 0; i--) {
    await page.keyboard.press('Control+z')
    const expected = history[i]!.state
    await expect
      .poll(() => docState(client, fileId, pageId), {
        timeout: 10_000,
        message: `undo of ${history[i]!.tool} #${i}`,
      })
      .toBe(expected)
  }
  expect(await page.locator('.ic-root [data-nid]').count()).toBe(0)
  // Nothing more to undo: one more Ctrl+Z changes nothing.
  await page.keyboard.press('Control+z')
  expect(await docState(client, fileId, pageId)).toBe(history[0]!.state)
  for (let i = 1; i <= history.length; i++) {
    await page.keyboard.press('Control+Shift+z')
    const expected = i < history.length ? history[i]!.state : final
    await expect
      .poll(() => docState(client, fileId, pageId), { timeout: 10_000, message: `redo #${i}` })
      .toBe(expected)
  }
  // The redone page renders again.
  const redone = (await call(client, 'get_basic_info', { fileId })).body as {
    artboards: { id: string }[]
  }
  expect(redone.artboards).toHaveLength(1)
  await expect(onCanvas(page, redone.artboards[0]!.id)).toBeAttached()
  console.log(`qa-session: ${history.length} write calls, each undone and redone as one step`)
})
