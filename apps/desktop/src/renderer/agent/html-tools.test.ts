/**
 * Executors built on `@baren/html` against real Loro documents: write_html, create_artboard,
 * update_styles, find_nodes, get_jsx, get_computed_styles, get_tokens, set_tokens renames and
 * render_job. Geometry is declared-only here (no DOM); the browser spec covers measurement.
 */
import {
  createComponent,
  createEmptyDoc,
  createInstance,
  createNode,
  docGeometry,
  getChildIds,
  getNode,
  getTokens,
  groupNodes,
  setNodeProps,
  setTokens,
} from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { dispatch, ok, testEnv } from './testing'

function setup() {
  const doc = createEmptyDoc('Test', { peerId: 9 })
  const page = getChildIds(doc, null)[0] as string
  setTokens(doc, {
    '--color-primary': { type: 'color', value: '#2563EB' },
    '--color-brand': { type: 'color', value: 'var(--color-primary)' },
    '--spacing-4': { type: 'spacing', value: '16px' },
  })
  const env = testEnv(doc)
  return { doc, page, env }
}

async function artboard(env: ReturnType<typeof testEnv>, name = 'Board', w = 800, h = 600) {
  return ok<{
    id: string
    worldX: number
    worldY: number
    width: number
    height: number
    warnings: unknown[]
  }>(env, 'create_artboard', { name, styles: { width: `${w}px`, height: `${h}px` } })
}

describe('create_artboard (contract §6.21)', () => {
  it('defaults to a white flex column and places artboards next to each other', async () => {
    const { doc, env } = setup()
    const a = await artboard(env, 'A', 1440, 900)
    expect(a).toMatchObject({ worldX: 0, worldY: 0, width: 1440, height: 900, warnings: [] })
    expect(getNode(doc, a.id)?.styles).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#FFFFFF',
      left: 0,
      top: 0,
    })
    const b = await artboard(env, 'B', 390, 844)
    expect([b.worldX, b.worldY]).toEqual([1520, 0])
    const c = await ok<{ id: string; worldX: number; worldY: number }>(env, 'create_artboard', {
      name: 'C',
      styles: {
        width: 390,
        height: 'fit-content',
        left: -1000,
        top: 50,
        background: 'var(--color-primary)',
      },
    })
    expect([c.worldX, c.worldY]).toEqual([-1000, 50])
    expect(getNode(doc, c.id)?.styles['backgroundColor']).toBe('var(--color-primary)')
    const bad = await dispatch(env, 'create_artboard', {
      name: 'D',
      styles: { width: '50%', height: '10px' },
    })
    expect(!bad.ok && bad.error.code).toBe('invalid_argument')
  })

  it('the anchor is the last artboard this agent created on the page', async () => {
    const { env } = setup()
    await artboard(env, 'A', 400, 300)
    // Another agent's artboard far to the right in a lower row.
    await ok(
      env,
      'create_artboard',
      { name: 'Other', styles: { width: '100px', height: '100px', left: 0, top: 2000 } },
      {
        agent: { sessionId: 's2', presenceId: 'p2', name: 'Other' },
      },
    )
    const b = await artboard(env, 'B', 400, 300)
    expect([b.worldX, b.worldY]).toEqual([480, 0])
  })
})

describe('write_html (contract §6.22, §7)', () => {
  it('inserts children, names layers, reports createdNodes, summary and warnings', async () => {
    const { doc, env } = setup()
    const board = await artboard(env)
    const res = await ok<{
      createdNodes: {
        id: string
        name: string
        component: string
        parentId: string
        width: number | null
      }[]
      summary: string
      warnings: { code: string }[]
    }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div layer-name="Row" class="x" style="display:flex;gap:var(--spacing-4);padding:8px 16px;width:200px"><p>A</p><h3>B</h3></div>',
    })
    expect(res.createdNodes).toHaveLength(1)
    const row = res.createdNodes[0] as {
      id: string
      name: string
      component: string
      parentId: string
      width: number | null
    }
    expect(row).toMatchObject({ name: 'Row', component: 'Frame', parentId: board.id, width: 200 })
    expect(getNode(doc, row.id)?.styles).toMatchObject({
      display: 'flex',
      gap: 'var(--spacing-4)',
      paddingBlock: '8px',
      paddingInline: '16px',
    })
    const kids = getChildIds(doc, row.id).map((id) => getNode(doc, id))
    expect(kids.map((k) => [k?.type, k?.text])).toEqual([
      ['text', 'A'],
      ['text', 'B'],
    ])
    expect(res.summary.split('\n')[0]).toBe(`Frame "Row" (${row.id}) 200×?`)
    expect(res.warnings.map((w) => w.code)).toContain('class-ignored')
  })

  it('replace keeps the place in the parent; artboard replacements keep their position', async () => {
    const { doc, page, env } = setup()
    const board = await artboard(env)
    const r1 = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<p>One</p><p>Two</p><p>Three</p>',
    })
    const two = r1.createdNodes[1]?.id as string
    const r2 = await ok<{ createdNodes: { id: string }[]; replacedNodeId: string }>(
      env,
      'write_html',
      {
        targetNodeId: two,
        mode: 'replace',
        html: '<p>2a</p><p>2b</p>',
      },
    )
    expect(r2.replacedNodeId).toBe(two)
    expect(getChildIds(doc, board.id).map((id) => getNode(doc, id)?.text)).toEqual([
      'One',
      '2a',
      '2b',
      'Three',
    ])
    const r3 = await ok<{
      createdNodes: { id: string; worldX: number | null; worldY: number | null }[]
    }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'replace',
      html: '<div style="width:300px;height:200px"></div>',
    })
    expect(r3.createdNodes[0]).toMatchObject({ worldX: 0, worldY: 0 })
    expect(getChildIds(doc, page)).toEqual([r3.createdNodes[0]?.id])
  })

  it('a page target creates artboards in free spots', async () => {
    const { page, env } = setup()
    await artboard(env, 'A', 400, 300)
    const res = await ok<{
      createdNodes: { worldX: number; worldY: number }[]
      warnings: { code: string }[]
    }>(env, 'write_html', {
      targetNodeId: page,
      mode: 'insert-children',
      html: '<div style="width:200px;height:100px"></div><div style="height:100px"></div>',
    })
    expect(res.createdNodes.map((n) => [n.worldX, n.worldY])).toEqual([
      [480, 0],
      [760, 0],
    ])
    expect(res.warnings.map((w) => w.code)).toContain('artboard-size-defaulted')
  })

  it('images: data URIs become stored assets with their natural size; unknown sources are placeholders', async () => {
    const { doc, env } = setup()
    const board = await artboard(env)
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='
    const res = await ok<{ createdNodes: { id: string }[]; warnings: { code: string }[] }>(
      env,
      'write_html',
      {
        targetNodeId: board.id,
        mode: 'insert-children',
        html: `<img src="${png}" alt="Swatch"><img src="relative/missing.png">`,
      },
    )
    const [img, missing] = res.createdNodes.map((n) => getNode(doc, n.id))
    expect(img?.type).toBe('image')
    expect(img?.name).toBe('Swatch')
    expect(img?.assetId).toMatch(/^[0-9a-f]{64}$/)
    // testEnv's natural size is 64×32.
    expect(img?.styles).toMatchObject({ width: 64, height: 32 })
    expect(missing?.assetId).toBeUndefined()
    expect(res.warnings.map((w) => w.code)).toContain('image-unresolved')
  })

  it('clones copy existing layers with the clone element styles applied', async () => {
    const { doc, env } = setup()
    const board = await artboard(env)
    const src = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div layer-name="Chip" style="display:flex;padding:4px"><p>Tag</p></div>',
    })
    const chip = src.createdNodes[0]?.id as string
    const res = await ok<{ createdNodes: { id: string; name: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: `<x-baren-clone node-id="${chip}" layer-name="Chip 2" style="padding:8px"></x-baren-clone>`,
    })
    const copy = res.createdNodes[0] as { id: string; name: string }
    expect(copy.name).toBe('Chip 2')
    expect(getNode(doc, copy.id)?.styles['padding']).toBe('8px')
    expect(getChildIds(doc, copy.id).map((id) => getNode(doc, id)?.text)).toEqual(['Tag'])
  })

  it('refuses leaf targets, instance content and locked layers', async () => {
    const { doc, page, env } = setup()
    const board = await artboard(env)
    const t = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<p>Text</p>',
    })
    const text = t.createdNodes[0]?.id as string
    const leaf = await dispatch(env, 'write_html', {
      targetNodeId: text,
      mode: 'insert-children',
      html: '<p>x</p>',
    })
    expect(!leaf.ok && leaf.error.code).toBe('invalid_target')
    const pageReplace = await dispatch(env, 'write_html', {
      targetNodeId: page,
      mode: 'replace',
      html: '<p>x</p>',
    })
    expect(!pageReplace.ok && pageReplace.error.code).toBe('invalid_target')
    createComponent(doc, [board.id], docGeometry(doc))
    const key = getNode(doc, board.id)?.componentKey as string
    const inst = createInstance(doc, {
      componentKey: key,
      parentId: page,
      styles: { left: 3000, top: 0 },
    })
    const vChild = (await ok<{ children: { id: string }[] }>(env, 'get_children', { nodeId: inst }))
      .children[0]?.id as string
    const virt = await dispatch(env, 'write_html', {
      targetNodeId: vChild,
      mode: 'replace',
      html: '<p>x</p>',
    })
    expect(!virt.ok && virt.error.code).toBe('instance_content')
    const intoInstance = await dispatch(env, 'write_html', {
      targetNodeId: inst,
      mode: 'insert-children',
      html: '<p>x</p>',
    })
    expect(!intoInstance.ok && intoInstance.error.code).toBe('invalid_target')
    setNodeProps(doc, board.id, { locked: true })
    const locked = await dispatch(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<p>x</p>',
    })
    expect(!locked.ok && locked.error.code).toBe('invalid_target')
  })

  it('children written into a group are absolute and the group refits', async () => {
    const { doc, page, env } = setup()
    const a = createNode(doc, {
      type: 'rect',
      parentId: page,
      styles: { left: 0, top: 0, width: 10, height: 10 },
    })
    const b = createNode(doc, {
      type: 'rect',
      parentId: page,
      styles: { left: 20, top: 0, width: 10, height: 10 },
    })
    const group = groupNodes(doc, [a, b], docGeometry(doc)) as string
    const res = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: group,
      mode: 'insert-children',
      html: '<div style="width:50px;height:50px;left:40px;top:40px;position:absolute"></div>',
    })
    const id = res.createdNodes[0]?.id as string
    expect(getNode(doc, id)?.styles['position']).toBe('absolute')
    expect(getNode(doc, group)?.styles).toMatchObject({ width: 90, height: 90 })
  })
})

describe('update_styles (contract §6.23)', () => {
  it('normalises, clears shorthand families, reports inert keys, removes with null', async () => {
    const { doc, page, env } = setup()
    const board = await artboard(env)
    const t = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div style="padding:4px 8px;display:flex"><p style="color:red">T</p></div>',
    })
    const frame = t.createdNodes[0]?.id as string
    const text = getChildIds(doc, frame)[0] as string
    const res = await ok<{
      updated: string[]
      ignoredStyles?: Record<string, string[]>
      warnings: { code: string }[]
    }>(env, 'update_styles', {
      updates: [
        { nodeIds: [frame], styles: { padding: '12px', margin: '4px' } },
        { nodeIds: [text], styles: { gap: '10px', color: null, fontSize: 18 } },
        { nodeIds: [page], styles: { backgroundColor: '#000000', width: '10px' } },
        { nodeIds: [board.id], styles: { left: 100, top: 200 } },
      ],
    })
    expect(res.updated).toEqual([frame, text, page, board.id])
    expect(getNode(doc, frame)?.styles['padding']).toBe('12px')
    expect(getNode(doc, frame)?.styles['paddingBlock']).toBeUndefined()
    expect(res.warnings.map((w) => w.code)).toContain('discouraged-property')
    expect(res.ignoredStyles).toEqual({ [text]: ['gap'], [page]: ['width'] })
    expect(getNode(doc, text)?.styles['color']).toBeUndefined()
    expect(getNode(doc, text)?.styles['fontSize']).toBe(18)
    expect(getNode(doc, page)?.background).toBe('#000000')
    expect(getNode(doc, board.id)?.styles).toMatchObject({ left: 100, top: 200 })
  })

  it('instance content gets overrides; groups resize their children', async () => {
    const { doc, page, env } = setup()
    const main = createNode(doc, {
      type: 'frame',
      parentId: page,
      name: 'Button',
      styles: { left: 0, top: 0, width: 100, height: 40, display: 'flex' },
    })
    const label = createNode(doc, {
      type: 'text',
      parentId: main,
      text: 'OK',
      styles: { color: '#000' },
    })
    createComponent(doc, [main], docGeometry(doc))
    const key = getNode(doc, main)?.componentKey as string
    const inst = createInstance(doc, {
      componentKey: key,
      parentId: page,
      styles: { left: 500, top: 0 },
    })
    const vLabel = (await ok<{ children: { id: string }[] }>(env, 'get_children', { nodeId: inst }))
      .children[0]?.id as string
    await ok(env, 'update_styles', {
      updates: [{ nodeIds: [vLabel], styles: { color: '#FF0000' } }],
    })
    expect(getNode(doc, label)?.styles['color']).toBe('#000')
    expect(Object.values(getNode(doc, inst)?.overrides ?? {})[0]?.styles).toEqual({
      color: '#FF0000',
    })
    const a = createNode(doc, {
      type: 'rect',
      parentId: page,
      styles: { left: 0, top: 500, width: 10, height: 10 },
    })
    const b = createNode(doc, {
      type: 'rect',
      parentId: page,
      styles: { left: 90, top: 590, width: 10, height: 10 },
    })
    const group = groupNodes(doc, [a, b], docGeometry(doc)) as string
    const g = await ok<{ ignoredStyles?: Record<string, string[]> }>(env, 'update_styles', {
      updates: [{ nodeIds: [group], styles: { width: '200px', height: '200px', gap: '4px' } }],
    })
    expect(g.ignoredStyles).toEqual({ [group]: ['gap'] })
    expect(getNode(doc, b)?.styles).toMatchObject({ left: 180, top: 180, width: 20, height: 20 })
  })
})

describe('find_nodes (contract §6.12)', () => {
  async function scene() {
    const { doc, page, env } = setup()
    const board = await artboard(env)
    await ok(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: `<div layer-name="Bar" style="background-color:var(--color-brand);border:1px solid #CCCCCC">
  <p style="color:rgb(37, 99, 235)">Get started</p>
  <p style="color:#111111;box-shadow:0 1px 2px rgba(0,0,0,0.2)">Submit</p>
</div>`,
    })
    return { doc, page, env, board }
  }

  it('matches literal colours by equivalence and token-bound usages', async () => {
    const { env } = await scene()
    const res = await ok<{ nodes: { name: string; matched: unknown[] }[]; count: number }>(
      env,
      'find_nodes',
      {
        filters: [{ styleValue: '#2563eb' }],
      },
    )
    expect(res.nodes.map((n) => [n.name, n.matched])).toEqual([
      ['Bar', [{ styleName: 'backgroundColor', styleValue: 'var(--color-brand)' }]],
      ['Get started', [{ styleName: 'color', styleValue: 'rgb(37, 99, 235)' }]],
    ])
  })

  it('matches tokens, kebab-case names, composite fragments, wildcards and text', async () => {
    const { env } = await scene()
    const byToken = await ok<{ nodes: { name: string }[] }>(env, 'find_nodes', {
      filters: [{ styleValue: '--color-brand' }],
    })
    expect(byToken.nodes.map((n) => n.name)).toEqual(['Bar'])
    const fragment = await ok<{
      nodes: { name: string; matched: { styleName: string; styleValue: string }[] }[]
    }>(env, 'find_nodes', { filters: [{ styleName: 'border*color', styleValue: '#ccc' }] })
    expect(fragment.nodes[0]?.name).toBe('Bar')
    const shadow = await ok<{ nodes: { matched: { styleValue: string }[] }[] }>(env, 'find_nodes', {
      filters: [{ styleName: 'boxShadow', styleValue: 'rgba(0, 0, 0, 0.2)' }],
    })
    expect(shadow.nodes[0]?.matched[0]?.styleValue).toBe('rgba(0,0,0,0.2)')
    const text = await ok<{ nodes: { name: string; matched: unknown[] }[] }>(env, 'find_nodes', {
      textValue: 'get *',
      filters: [{ styleName: 'color' }],
    })
    expect(text.nodes.map((n) => n.name)).toEqual(['Get started'])
    const none = await dispatch(env, 'find_nodes', {})
    expect(!none.ok && none.error.code).toBe('invalid_argument')
  })
})

describe('code readers', () => {
  it('get_jsx (both formats), get_computed_styles, get_tokens', async () => {
    const { env, page } = setup()
    const board = await artboard(env)
    const card = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div style="display:flex;padding:16px;background-color:var(--color-primary);color:#fff"><p>Hi</p></div>',
    })
    const id = card.createdNodes[0]?.id as string
    const inline = await ok<string>(env, 'get_jsx', { nodeId: id, format: 'inline-styles' })
    expect(inline.startsWith('(\n    <div style={{')).toBe(true)
    expect(inline).toContain("backgroundColor: 'var(--color-primary)'")
    expect(inline).toContain('Hi')
    const tw = await ok<string>(env, 'get_jsx', { nodeId: id })
    expect(tw).toContain('bg-primary')
    const onPage = await dispatch(env, 'get_jsx', { nodeId: page })
    expect(!onPage.ok && onPage.error.code).toBe('invalid_target')
    const styles = await ok<{ styles: Record<string, Record<string, string>>; errors?: unknown[] }>(
      env,
      'get_computed_styles',
      { nodeIds: [id, 'nope'] },
    )
    expect(styles.styles[id]).toEqual({
      backgroundColor: 'var(--color-primary)',
      color: '#fff',
      display: 'flex',
      padding: '16px',
    })
    expect(styles.errors).toHaveLength(1)
    const json = await ok<{ tokens: { name: string }[] }>(env, 'get_tokens', {
      namePattern: '--color-*',
    })
    expect(json.tokens.map((t) => t.name)).toEqual(['--color-brand', '--color-primary'])
    const css = await ok<string>(env, 'get_tokens', { format: 'tailwind', types: ['spacing'] })
    expect(css).toBe('@theme {\n  --spacing-4: 16px;\n}\n')
  })

  it('set_tokens renames rewrite var() references across styles and token values', async () => {
    const { doc, env } = setup()
    const board = await artboard(env)
    const card = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div style="border:1px solid var(--color-primary)"></div>',
    })
    const res = await ok<{ results: unknown[] }>(env, 'set_tokens', {
      tokens: [{ name: '--color-primary', newName: '--color-accent', value: '#000000' }],
    })
    expect(res.results).toEqual([
      { name: '--color-primary', result: 'renamed', newName: '--color-accent' },
    ])
    const tokens = getTokens(doc)
    expect(tokens['--color-accent']?.value).toBe('#000000')
    expect(tokens['--color-brand']?.value).toBe('var(--color-accent)')
    expect(tokens['--color-primary']).toBeUndefined()
    const id = card.createdNodes[0]?.id as string
    expect(getNode(doc, id)?.styles['borderColor']).toBe('var(--color-accent)')
    const clash = await ok(env, 'set_tokens', {
      tokens: [{ name: '--color-brand', newName: '--color-accent' }],
    })
    expect(clash['results']).toEqual([
      { name: '--color-brand', result: 'error', message: 'Token --color-accent already exists.' },
    ])
  })

  it('render_job builds the stage, the screenshot background and inherited text styles', async () => {
    const { env } = setup()
    const board = await artboard(env)
    const card = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
      targetNodeId: board.id,
      mode: 'insert-children',
      html: '<div style="display:flex;color:#333333;font-size:14px;width:100px;height:50px"><p>Hi</p></div>',
    })
    const id = card.createdNodes[0]?.id as string
    const text = (await ok<{ children: { id: string }[] }>(env, 'get_children', { nodeId: id }))
      .children[0]?.id as string
    const job = await ok<{
      nodeId: string
      stage: { html: string; css: string }
      background: string | null
      inherited: Record<string, unknown>
      ids: string[]
    }>(env, 'render_job', { nodeId: text, scale: 1, purpose: 'screenshot' })
    expect(job.nodeId).toBe(text)
    expect(job.ids).toEqual([text])
    expect(job.background).toBe('#FFFFFF')
    expect(job.inherited).toEqual({ color: '#333333', fontSize: '14px' })
    expect(job.stage.html).toContain(`data-node-id="${text}"`)
    const exp = await ok<{ background: string | null }>(env, 'render_job', {
      nodeId: id,
      scale: 2,
      purpose: 'export',
    })
    expect(exp.background).toBeNull()
  })
})
