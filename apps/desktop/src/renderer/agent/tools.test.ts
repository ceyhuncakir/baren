/**
 * Executors against real Loro documents (contract §14.2): reads, layer writes (text, rename,
 * duplicate with descendantIdMap, move with affectedParents, delete), instances, groups,
 * vectors, locked layers, one undo step per call, headers and `touched`.
 */
import {
  createComponent,
  createEmptyDoc,
  createInstance,
  createNode,
  docGeometry,
  getChildIds,
  getNode,
  groupNodes,
  setNodeProps,
  setTokens,
  toSnapshot,
  virtualId,
  type Styles,
} from '@baren/schema'
import { UndoManager, type LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { dispatch, ok, testEnv } from './testing'
import { treeSummary } from './tools/read'

function setup() {
  const doc = createEmptyDoc('Test', { peerId: 7 })
  const page = getChildIds(doc, null)[0] as string
  const board = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Board',
    styles: { left: 0, top: 0, width: 400, height: 300, display: 'flex', flexDirection: 'column' },
  })
  const card = createNode(doc, {
    type: 'frame',
    parentId: board,
    name: 'Card',
    styles: { display: 'flex', width: 200, height: 100, backgroundColor: 'var(--color-surface)' },
  })
  const title = createNode(doc, {
    type: 'text',
    parentId: card,
    name: 'Title',
    text: 'Hello\nworld',
    styles: { fontSize: '16px', color: '#111111' },
  })
  const icon = createNode(doc, {
    type: 'rect',
    parentId: card,
    name: 'Icon',
    styles: { width: 24, height: 24 },
  })
  const second = createNode(doc, {
    type: 'frame',
    parentId: page,
    name: 'Second',
    styles: { left: 480, top: 0, width: 390, height: 844 },
  })
  setTokens(doc, { '--color-surface': { type: 'color', value: '#F7F7F7' } })
  return { doc, page, board, card, title, icon, second }
}

function undoManager(doc: LoroDoc): UndoManager {
  return new UndoManager(doc, {
    mergeInterval: 0,
    excludeOriginPrefixes: ['remote', 'sync', 'bench', 'fixture', 'preview', 'derived'],
  })
}

const stylesOf = (doc: LoroDoc, id: string): Styles => getNode(doc, id)?.styles ?? {}

interface Shape {
  type: string
  name: string
  styles: Styles
  text?: string
  children: Shape[]
}

/** The document without ids (Loro gives re-created nodes new ids on undo). */
function shape(doc: LoroDoc): Shape[] {
  const snap = toSnapshot(doc)
  const walk = (id: string): Shape => {
    const n = snap.nodes[id]
    if (!n) throw new Error(`missing ${id}`)
    const out: Shape = {
      type: n.type,
      name: n.name,
      styles: n.styles,
      children: n.children.map(walk),
    }
    if (n.text !== undefined) out.text = n.text
    return out
  }
  return snap.pageIds.map(walk)
}

describe('read tools', () => {
  it('get_basic_info lists artboards, pages, fonts, tokens and components', async () => {
    const { doc, page, board, second } = setup()
    const env = testEnv(doc)
    const info = await ok(env, 'get_basic_info')
    expect(info['pageId']).toBe(page)
    expect(info['rootNodeId']).toBe(page)
    expect(info['url']).toBe(`baren://file/file-1/${page}`)
    expect(info['artboardCount']).toBe(2)
    expect(info['artboards']).toEqual([
      {
        id: board,
        name: 'Board',
        component: 'Frame',
        childCount: 1,
        width: 400,
        height: 300,
        worldX: 0,
        worldY: 0,
      },
      {
        id: second,
        name: 'Second',
        component: 'Frame',
        childCount: 0,
        width: 390,
        height: 844,
        worldX: 480,
        worldY: 0,
      },
    ])
    expect(info['nodeCount']).toBe(5)
    expect(info['pages']).toEqual([{ id: page, name: 'Page 1', isActive: true }])
    expect(info['tokens']).toEqual({ items: [{ name: '--color-surface', value: '#F7F7F7' }] })
    expect(info['components']).toEqual([])
  })

  it('get_basic_info: unknown pageId → page_not_found; fonts resolve tokens and generics', async () => {
    const { doc, title } = setup()
    setTokens(doc, {
      '--font-sans': { type: 'fontFamily', value: "'Inter', system-ui, sans-serif" },
    })
    createNode(doc, {
      type: 'text',
      parentId: getNode(doc, title)?.parentId as string,
      text: 'x',
      styles: { fontFamily: 'var(--font-sans)' },
    })
    createNode(doc, {
      type: 'text',
      parentId: getNode(doc, title)?.parentId as string,
      text: 'y',
      styles: { fontFamily: 'system-ui, sans-serif' },
    })
    const env = testEnv(doc)
    const info = await ok(env, 'get_basic_info')
    expect(info['fontFamilies']).toEqual(['Inter', 'System Sans-Serif'])
    const res = await dispatch(env, 'get_basic_info', { pageId: 'nope' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('page_not_found')
  })

  it('get_tree_summary uses the contract format (⏎, children at the limit, ? sizes)', async () => {
    const { doc, board, card, title, icon } = setup()
    const env = testEnv(doc)
    const body = await ok(env, 'get_tree_summary', { nodeId: board, depth: 2 })
    expect(body['depth']).toBe(2)
    expect(body['summary']).toBe(
      [`Frame "Board" (${board}) 400×300`, `  Frame "Card" (${card}) 200×100 (2 children)`].join(
        '\n',
      ),
    )
    expect(treeSummary(env, board, 3)).toBe(
      [
        `Frame "Board" (${board}) 400×300`,
        `  Frame "Card" (${card}) 200×100`,
        `    Text "Title" (${title}) ?×? "Hello⏎world"`,
        `    Rectangle "Icon" (${icon}) 24×24`,
      ].join('\n'),
    )
  })

  it('get_tree_summary truncates after the line limit', () => {
    const { doc, board, card } = setup()
    for (let i = 0; i < 5; i++) {
      createNode(doc, {
        type: 'rect',
        parentId: card,
        name: `R${i}`,
        styles: { width: 1, height: 1 },
      })
    }
    const env = testEnv(doc)
    const text = treeSummary(env, board, 5, 3)
    const lines = text.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('… truncated (6 more nodes)')
  })

  it('get_children and get_node_info report geometry, text, parents and artboards', async () => {
    const { doc, board, card, title, icon } = setup()
    const env = testEnv(doc)
    const kids = await ok(env, 'get_children', { nodeId: card })
    expect(kids['count']).toBe(2)
    expect((kids['children'] as Record<string, unknown>[])[1]).toEqual({
      id: icon,
      name: 'Icon',
      component: 'Rectangle',
      childCount: 0,
      worldX: null,
      worldY: null,
      x: null,
      y: null,
      width: 24,
      height: 24,
    })
    const info = await ok(env, 'get_node_info', { nodeId: title })
    expect(info).toMatchObject({
      id: title,
      component: 'Text',
      textContent: 'Hello\nworld',
      parentId: card,
      artboardId: board,
      isVisible: true,
      isLocked: false,
      childIds: [],
      rotation: 0,
      image: null,
      mainComponent: null,
      isMainComponent: false,
      overrides: null,
    })
    const res = await dispatch(env, 'get_node_info', { nodeId: '999@1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('node_not_found')
  })

  it('every file-scoped result has the header; touched names the artboard', async () => {
    const { doc, board, title } = setup()
    const env = testEnv(doc)
    const res = await dispatch(env, 'get_node_info', { nodeId: title })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.header?.file).toEqual({ id: 'file-1', name: 'Test file' })
    expect(res.header?.contentHash.tokens).toMatch(/^[0-9a-f]{8}$/)
    expect(res.touched).toEqual([board])
  })

  it('get_selection reads the host selection', async () => {
    const { doc, board, icon } = setup()
    const env = testEnv(doc, { selection: [icon] })
    const body = await ok(env, 'get_selection')
    expect(body).toEqual({
      selectedNodes: [
        {
          id: icon,
          name: 'Icon',
          component: 'Rectangle',
          width: 24,
          height: 24,
          artboardId: board,
          artboardName: 'Board',
        },
      ],
      count: 1,
    })
  })

  it('open_file switches the page only on first open and answers like get_basic_info', async () => {
    const { doc, page } = setup()
    const env = testEnv(doc)
    const other = await ok<{ pageId: string }>(env, 'create_page', { name: 'Second' })
    const later = await ok(env, 'open_file', { pageId: other.pageId, firstOpen: false })
    expect(later['pageId']).toBe(other.pageId)
    expect(env.currentPageId()).toBe(page)
    const first = await ok(env, 'open_file', { pageId: other.pageId, firstOpen: true })
    expect(env.currentPageId()).toBe(other.pageId)
    expect((first['pages'] as { isActive: boolean }[]).map((p) => p.isActive)).toEqual([
      false,
      true,
    ])
    const bad = await dispatch(env, 'open_file', { pageId: 'nope', firstOpen: true })
    expect(!bad.ok && bad.error.code).toBe('page_not_found')
  })

  it('artboards_of maps ids to their artboards', async () => {
    const { doc, page, board, title } = setup()
    const env = testEnv(doc)
    const body = await ok(env, 'artboards_of', { nodeIds: [title, board, page, 'x'] })
    expect(body['artboards']).toEqual({ [title]: board, [board]: board, [page]: null, x: null })
  })
})

describe('layer tools', () => {
  it('set_text_content: text only, one commit, one undo step', async () => {
    const { doc, title, icon } = setup()
    const env = testEnv(doc)
    const um = undoManager(doc)
    const before = shape(doc)
    const body = await ok(env, 'set_text_content', {
      updates: [
        { nodeId: title, textContent: 'Bye' },
        { nodeId: icon, textContent: 'nope' },
      ],
    })
    expect(body['updated']).toEqual([title])
    expect((body['errors'] as { code: string }[])[0]?.code).toBe('invalid_target')
    expect(getNode(doc, title)?.text).toBe('Bye')
    um.undo()
    expect(shape(doc)).toEqual(before)
    // Every entry invalid: an unchanged document and per-entry errors (main sets isError).
    const all = await ok(env, 'set_text_content', {
      updates: [{ nodeId: icon, textContent: 'x' }],
    })
    expect(all['updated']).toEqual([])
    expect((all['errors'] as { code: string }[])[0]?.code).toBe('invalid_target')
  })

  it('rename_nodes trims and truncates to 50; pages and instance content are refused', async () => {
    const { doc, page, card } = setup()
    const env = testEnv(doc)
    const long = `  ${'x'.repeat(80)}  `
    const body = await ok(env, 'rename_nodes', {
      updates: [
        { nodeId: card, name: long },
        { nodeId: page, name: 'P' },
      ],
    })
    expect(body['renamed']).toEqual([card])
    expect(getNode(doc, card)?.name).toBe('x'.repeat(50))
    expect((body['errors'] as { code: string }[])[0]?.code).toBe('invalid_target')
  })

  it('duplicate_nodes copies after the source and maps every descendant', async () => {
    const { doc, board, card, title, icon } = setup()
    const env = testEnv(doc)
    const um = undoManager(doc)
    const before = shape(doc)
    const body = await ok(env, 'duplicate_nodes', { nodes: [{ id: card }] })
    const dup = (body['duplicates'] as { sourceId: string; newId: string; parentId: string }[])[0]
    expect(dup?.sourceId).toBe(card)
    expect(dup?.parentId).toBe(board)
    expect(getChildIds(doc, board)).toEqual([card, dup?.newId])
    const map = body['descendantIdMap'] as Record<string, string>
    const copyKids = getChildIds(doc, dup?.newId as string)
    expect(map).toEqual({ [title]: copyKids[0], [icon]: copyKids[1] })
    expect(getNode(doc, copyKids[0] as string)?.text).toBe('Hello\nworld')
    um.undo()
    expect(shape(doc)).toEqual(before)
  })

  it('duplicate_nodes places a duplicated artboard in a free spot; parentId appends', async () => {
    const { doc, page, board, card, second } = setup()
    const env = testEnv(doc)
    const body = await ok(env, 'duplicate_nodes', {
      nodes: [{ id: board }, { id: card, parentId: second }],
    })
    const [a, b] = body['duplicates'] as { newId: string; parentId: string }[]
    expect(a?.parentId).toBe(page)
    // Row band [0, 300]: Board and Second overlap it; Second ends at 870 → 950.
    expect(stylesOf(doc, a?.newId as string)).toMatchObject({ left: 950, top: 0 })
    expect(b?.parentId).toBe(second)
    expect(getChildIds(doc, second)).toEqual([b?.newId])
  })

  it('duplicate_nodes keeps instances as instances and maps virtual descendants', async () => {
    const { doc, page, card } = setup()
    const key = createComponent(doc, [card], docGeometry(doc)) as string
    const main = getNode(doc, card)?.componentKey ?? key
    const inst = createInstance(doc, {
      componentKey: main,
      parentId: page,
      styles: { left: 2000, top: 0 },
    })
    const env = testEnv(doc)
    const body = await ok(env, 'duplicate_nodes', { nodes: [{ id: inst }] })
    const dup = (body['duplicates'] as { newId: string }[])[0]?.newId as string
    expect(getNode(doc, dup)?.type).toBe('instance')
    const map = body['descendantIdMap'] as Record<string, string>
    const keys = Object.keys(map)
    expect(keys.length).toBe(2)
    for (const k of keys) {
      expect(k.startsWith(`${inst}/`)).toBe(true)
      expect(map[k]).toBe(k.replace(inst, dup))
    }
    const info = await ok(env, 'get_node_info', { nodeId: dup })
    expect(info['component']).toBe('Instance')
    expect((info['mainComponent'] as { key: string }).key).toBe(main)
    const mainInfo = await ok(env, 'get_node_info', { nodeId: card })
    expect(mainInfo['component']).toBe('Component')
    expect(mainInfo['isMainComponent']).toBe(true)
  })

  it('instance content: text writes become overrides, structural writes are refused', async () => {
    const { doc, page, card, title } = setup()
    createComponent(doc, [card], docGeometry(doc))
    const key = getNode(doc, card)?.componentKey as string
    const inst = createInstance(doc, {
      componentKey: key,
      parentId: page,
      styles: { left: 2000, top: 0 },
    })
    const env = testEnv(doc)
    const vTitle = (await ok(env, 'get_children', { nodeId: inst }))['children'] as { id: string }[]
    const vid = vTitle[0]?.id as string
    expect(vid.startsWith(`${inst}/`)).toBe(true)
    await ok(env, 'set_text_content', { updates: [{ nodeId: vid, textContent: 'Override' }] })
    expect(getNode(doc, title)?.text).toBe('Hello\nworld')
    const info = await ok(env, 'get_node_info', { nodeId: vid })
    expect(info['textContent']).toBe('Override')
    expect(info['overrides']).toEqual(['text'])
    expect(virtualId(inst, vid.slice(inst.length + 1))).toBe(vid)
    const moves = await ok(env, 'move_nodes', {
      moves: [
        { nodeId: vid, parentId: page },
        { nodeId: title, parentId: inst },
      ],
    })
    expect((moves['errors'] as { code: string }[]).map((e) => e.code)).toEqual([
      'instance_content',
      'instance_content',
    ])
    const del = await ok(env, 'delete_nodes', { nodeIds: [vid] })
    expect(del).toEqual({ deleted: [], hidden: [vid] })
  })

  it('move_nodes: before/after/parentId/root, sequential, affectedParents', async () => {
    const { doc, page, board, card, title, icon, second } = setup()
    const env = testEnv(doc)
    const um = undoManager(doc)
    const before = shape(doc)
    const body = await ok(env, 'move_nodes', {
      moves: [
        { nodeId: icon, before: title },
        { nodeId: title, parentId: second },
        { nodeId: card, parentId: 'root', index: 0 },
      ],
    })
    expect(body['moves']).toEqual([
      { nodeId: icon, parentId: card, index: 0 },
      { nodeId: title, parentId: second, index: 0 },
      { nodeId: card, parentId: page, index: 0 },
    ])
    expect(body['affectedParents']).toEqual({
      [card]: [icon],
      [second]: [title],
      [board]: [],
      [page]: [card, board, second],
    })
    // Leaving a flex parent for a page keeps the world position.
    expect(stylesOf(doc, card)).toMatchObject({ left: 0, top: 0 })
    um.undo()
    expect(shape(doc)).toEqual(before)
  })

  it('move_nodes refuses cycles, moves into leaves and into itself', async () => {
    const { doc, board, card, icon } = setup()
    const env = testEnv(doc)
    const body = await ok(env, 'move_nodes', {
      moves: [
        { nodeId: board, parentId: card },
        { nodeId: card, parentId: icon },
        { nodeId: card, parentId: card },
      ],
    })
    expect(body['moves']).toEqual([])
    expect((body['errors'] as { code: string }[]).map((e) => e.code)).toEqual([
      'invalid_target',
      'invalid_target',
      'invalid_target',
    ])
  })

  it('delete_nodes: topmost, emptied groups go, pages refused, one undo step', async () => {
    const { doc, page, board, card, icon } = setup()
    const a = createNode(doc, {
      type: 'rect',
      parentId: page,
      name: 'A',
      styles: { left: 0, top: 1000, width: 10, height: 10 },
    })
    const b = createNode(doc, {
      type: 'rect',
      parentId: page,
      name: 'B',
      styles: { left: 20, top: 1000, width: 10, height: 10 },
    })
    const group = groupNodes(doc, [a, b], docGeometry(doc)) as string
    const env = testEnv(doc)
    const um = undoManager(doc)
    const before = shape(doc)
    const body = await ok(env, 'delete_nodes', { nodeIds: [icon, card, a, b, page] })
    expect(body['deleted']).toEqual([icon, card, a, b])
    expect(getNode(doc, group)).toBeUndefined()
    expect((body['errors'] as { code: string }[])[0]?.code).toBe('invalid_target')
    expect(getChildIds(doc, board)).toEqual([])
    um.undo()
    expect(shape(doc)).toEqual(before)
  })

  it('locked layers and their content are never changed', async () => {
    const { doc, card, title } = setup()
    setNodeProps(doc, card, { locked: true })
    const env = testEnv(doc)
    for (const [tool, args] of [
      ['set_text_content', { updates: [{ nodeId: title, textContent: 'x' }] }],
      ['delete_nodes', { nodeIds: [title] }],
      ['move_nodes', { moves: [{ nodeId: title, parentId: 'root' }] }],
    ] as const) {
      const res = await ok(env, tool, args)
      expect((res['errors'] as { message: string }[])[0]?.message, tool).toContain('locked')
    }
    expect(getNode(doc, title)?.text).toBe('Hello\nworld')
  })

  it('groups: duplicates keep group geometry and moves into a group are absolute', async () => {
    const { doc, page, icon } = setup()
    const a = createNode(doc, {
      type: 'rect',
      parentId: page,
      name: 'A',
      styles: { left: 0, top: 1000, width: 10, height: 10 },
    })
    const b = createNode(doc, {
      type: 'rect',
      parentId: page,
      name: 'B',
      styles: { left: 40, top: 1020, width: 10, height: 10 },
    })
    const group = groupNodes(doc, [a, b], docGeometry(doc)) as string
    const env = testEnv(doc)
    const dup = await ok(env, 'duplicate_nodes', { nodes: [{ id: a }] })
    const copy = (dup['duplicates'] as { newId: string; parentId: string }[])[0]
    expect(copy?.parentId).toBe(group)
    await ok(env, 'move_nodes', { moves: [{ nodeId: icon, parentId: group }] })
    expect(stylesOf(doc, icon)['position']).toBe('absolute')
    const g = stylesOf(doc, group)
    expect(g['left']).toBeLessThanOrEqual(0)
  })

  it('vectors are read like other layers', async () => {
    const { doc, board } = setup()
    const v = createNode(doc, {
      type: 'vector',
      parentId: board,
      name: 'Path',
      styles: { position: 'absolute', left: 5, top: 5, width: 20, height: 10, stroke: '#000' },
      vector: {
        fillRule: 'nonzero',
        subpaths: [
          {
            id: 'sp1',
            closed: false,
            points: [
              { x: 0, y: 0 },
              { x: 20, y: 10 },
            ],
          },
        ],
      },
    })
    const env = testEnv(doc)
    const info = await ok(env, 'get_node_info', { nodeId: v })
    expect(info).toMatchObject({ component: 'Vector', worldX: 5, worldY: 5, width: 20, height: 10 })
    const img = await ok(env, 'node_image', { nodeId: v })
    expect(String(img['svg'])).toContain('<path')
  })
})

describe('dispatch', () => {
  it('maps unknown tools, read-only files and deadlines', async () => {
    const { doc, title } = setup()
    const env = testEnv(doc, { readOnly: true })
    const unknown = await dispatch(env, 'get_screenshot', { nodeId: title })
    expect(!unknown.ok && unknown.error.code).toBe('unsupported')
    const ro = await dispatch(env, 'set_text_content', {
      updates: [{ nodeId: title, textContent: 'x' }],
    })
    expect(!ro.ok && ro.error.code).toBe('read_only')
    const reads = await dispatch(env, 'get_node_info', { nodeId: title })
    expect(reads.ok).toBe(true)
    const late = await dispatch(
      env,
      'get_node_info',
      { nodeId: title },
      { deadline: Date.now() - 1 },
    )
    expect(!late.ok && late.error.code).toBe('timeout')
  })
})
