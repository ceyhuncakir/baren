import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import {
  createNode,
  deleteNode,
  moveNode,
  setDocName,
  setNodeProps,
  setStyles,
  setText,
  setTokens,
  subscribeNodes,
  transact,
  type NodeChangeBatch,
} from '../src/index.ts'
import { docWithPage, flushEvents } from './helpers.ts'

function collect(doc: LoroDoc): NodeChangeBatch[] {
  const out: NodeChangeBatch[] = []
  subscribeNodes(doc, (b) => out.push(b))
  return out
}

describe('subscribeNodes', () => {
  it('reports creation with position and suppresses content noise for new nodes', async () => {
    const { doc, pageId } = docWithPage()
    const batches = collect(doc)
    const id = createNode(doc, {
      type: 'text',
      parentId: pageId,
      text: 'a',
      styles: { color: 'red' },
    })
    await flushEvents()
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual({
      by: 'local',
      origin: undefined,
      changes: [{ kind: 'created', id, parentId: pageId, index: 0 }],
      tokens: [],
      meta: false,
      components: [],
      comments: [],
      versions: [],
    })
  })

  it('reports style keys, text and props per node', async () => {
    const { doc, pageId } = docWithPage()
    const id = createNode(doc, { type: 'text', parentId: pageId, styles: { width: 1 } })
    await flushEvents()
    const batches = collect(doc)
    transact(doc, () => {
      setStyles(doc, id, { width: null, height: 2 })
      setStyles(doc, id, { gap: '1px' })
      setText(doc, id, 'hello')
      setNodeProps(doc, id, { name: 'Label', locked: true })
    })
    await flushEvents()
    expect(batches).toHaveLength(1)
    const changes = batches[0]!.changes
    const styles = changes.find((c) => c.kind === 'styles')
    expect(styles && 'keys' in styles ? [...styles.keys].sort() : []).toEqual([
      'gap',
      'height',
      'width',
    ])
    expect(changes).toContainEqual({ kind: 'text', id })
    const props = changes.find((c) => c.kind === 'props')
    expect(props && 'keys' in props ? [...props.keys].sort() : []).toEqual(['locked', 'name'])
  })

  it('reports moves and deletes in order', async () => {
    const { doc, pageId } = docWithPage()
    const a = createNode(doc, { type: 'frame', parentId: pageId })
    const b = createNode(doc, { type: 'frame', parentId: pageId })
    const c = createNode(doc, { type: 'rect', parentId: a })
    await flushEvents()
    const batches = collect(doc)
    transact(doc, () => {
      moveNode(doc, c, b, 0)
      moveNode(doc, b, pageId, 0)
      deleteNode(doc, a)
    })
    await flushEvents()
    expect(batches[0]!.changes).toEqual([
      { kind: 'moved', id: c, parentId: b, index: 0, oldParentId: a, oldIndex: 0 },
      { kind: 'moved', id: b, parentId: pageId, index: 0, oldParentId: pageId, oldIndex: 1 },
      { kind: 'deleted', id: a, oldParentId: pageId, oldIndex: 1 },
    ])
  })

  it('reports token and meta changes', async () => {
    const { doc } = docWithPage()
    const batches = collect(doc)
    setTokens(doc, {
      '--a': { type: 'color', value: '#000' },
      '--b': { type: 'spacing', value: '4px' },
    })
    await flushEvents()
    setTokens(doc, { '--a': { type: 'color', value: '#111' } })
    await flushEvents()
    setDocName(doc, 'Renamed')
    await flushEvents()
    expect(batches.map((b) => [b.tokens.sort(), b.meta])).toEqual([
      [['--a', '--b'], false],
      [['--a'], false],
      [[], true],
    ])
  })

  it('marks remote changes as imports and stops after unsubscribe', async () => {
    const { doc, pageId } = docWithPage('t', 1)
    const remote = new LoroDoc()
    remote.setPeerId(2)
    remote.import(doc.export({ mode: 'snapshot' }))
    const batches: NodeChangeBatch[] = []
    const off = subscribeNodes(remote, (b) => batches.push(b))
    const id = createNode(doc, { type: 'rect', parentId: pageId })
    remote.import(doc.export({ mode: 'update', from: remote.oplogVersion() }))
    await flushEvents()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.by).toBe('import')
    expect(batches[0]!.changes).toEqual([{ kind: 'created', id, parentId: pageId, index: 0 }])
    off()
    setStyles(doc, id, { width: 1 })
    remote.import(doc.export({ mode: 'update', from: remote.oplogVersion() }))
    await flushEvents()
    expect(batches).toHaveLength(1)
  })
})
