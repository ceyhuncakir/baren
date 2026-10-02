import { describe, expect, it } from 'vitest'
import {
  BENCH_MAIN_NODE_COUNT,
  benchDocNodeCount,
  createComponent,
  createComponentResolver,
  createInstance,
  createNode,
  decodeNode,
  docAssetRefs,
  docGeometry,
  editVector,
  generateBenchDoc,
  getNode,
  isComponentKey,
  isNodeKey,
  isNodeRef,
  isVirtualId,
  listComponents,
  newComponentKey,
  newNodeKey,
  newSubpathId,
  nodeAssetRefs,
  parseVirtualId,
  setNodeProps,
  setPropsAt,
  setStylesAt,
  subscribeNodes,
  toSnapshot,
  virtualId,
  type NodeChangeBatch,
} from '../src/index.ts'
import { docWithPage, flushEvents, seeded } from './helpers.ts'
import { checkInvariants } from './invariants.ts'

describe('ids', () => {
  it('generates and validates keys', () => {
    expect(newComponentKey()).toMatch(/^[0-9a-z]{16}$/)
    expect(newNodeKey()).toMatch(/^[0-9a-z]{10}$/)
    expect(newSubpathId()).toMatch(/^[0-9a-z]{8}$/)
    expect(newNodeKey(seeded(1))).toBe(newNodeKey(seeded(1)))
    expect(isComponentKey('0123456789abcdef')).toBe(true)
    expect(isComponentKey('0123456789ABCDEF')).toBe(false)
    expect(isNodeKey('abcdefghij')).toBe(true)
    expect(isNodeKey('abc')).toBe(false)
  })

  it('parses virtual ids', () => {
    expect(parseVirtualId('12@3/abcdefghij')).toEqual({ instanceId: '12@3', path: 'abcdefghij' })
    expect(parseVirtualId('12@3/abcdefghij/klmnopqrst')).toEqual({
      instanceId: '12@3',
      path: 'abcdefghij/klmnopqrst',
    })
    expect(parseVirtualId('12@3/~4@5')).toEqual({ instanceId: '12@3', path: '~4@5' })
    expect(parseVirtualId('12@3')).toBeNull()
    expect(parseVirtualId('12@3/')).toBeNull()
    expect(parseVirtualId('12@3/short')).toBeNull()
    expect(parseVirtualId('x/abcdefghij')).toBeNull()
    expect(virtualId('1@1', '')).toBe('1@1')
    expect(virtualId('1@1', 'abcdefghij')).toBe('1@1/abcdefghij')
    expect(isVirtualId('1@1/abcdefghij')).toBe(true)
    expect(isNodeRef('1@1')).toBe(true)
    expect(isNodeRef('1@1/abcdefghij')).toBe(true)
    expect(isNodeRef('nope')).toBe(false)
  })
})

describe('decoding the new keys', () => {
  it('decodes componentKey/nodeKey/mainId/overrides/vector by type, omitting empty data', () => {
    const data = {
      type: 'instance',
      name: '',
      styles: { left: 1 },
      componentKey: 'k'.repeat(16),
      nodeKey: 'n'.repeat(10),
      mainId: '1@1',
      overrides: {
        '': { styles: { color: 'red', gone: null, bad: true } },
        empty: { styles: {} },
        p: { text: 't', hidden: false, assetId: 'x', assetName: 'y', junk: 1 },
      },
      vector: { subpaths: {} },
    }
    const n = decodeNode('5@1', '1@1', [], data)
    expect(JSON.stringify(n)).toBe(
      JSON.stringify({
        id: '5@1',
        type: 'instance',
        name: '',
        parentId: '1@1',
        children: [],
        styles: { left: 1 },
        componentKey: 'k'.repeat(16),
        nodeKey: 'n'.repeat(10),
        mainId: '1@1',
        overrides: {
          '': { styles: { color: 'red', gone: null } },
          p: { text: 't', hidden: false, assetId: 'x', assetName: 'y' },
        },
      }),
    )
    const rect = decodeNode('6@1', null, [], {
      type: 'rect',
      componentKey: 'x',
      mainId: 'y',
      overrides: {},
      nodeKey: 'z',
    })
    expect(rect).toEqual({
      id: '6@1',
      type: 'rect',
      name: '',
      parentId: null,
      children: [],
      styles: {},
      nodeKey: 'z',
    })
    const vec = decodeNode('7@1', null, [], {
      type: 'vector',
      vector: {
        fillRule: 'bogus',
        subpaths: {
          b: {
            closed: true,
            order: 1,
            points: [{ x: 1, y: 2, in: [1, 2], out: [1], mode: 'smooth' }, { x: 'a' }],
          },
          a: { order: 1, points: [{ x: 0, y: 0, mode: 'weird' }] },
          z: { order: 0, points: [] },
        },
      },
    })
    expect(vec.vector).toEqual({
      fillRule: 'nonzero',
      subpaths: [
        { id: 'a', closed: false, points: [{ x: 0, y: 0 }] },
        { id: 'b', closed: true, points: [{ x: 1, y: 2, in: [1, 2], mode: 'smooth' }] },
      ],
    })
    expect(decodeNode('8@1', null, [], { type: 'group' }).type).toBe('group')
    expect(decodeNode('9@1', null, [], { type: 'widget' }).type).toBe('frame')
  })

  it('validates createNode inputs for the new keys', () => {
    const { doc, pageId } = docWithPage()
    expect(() => createNode(doc, { type: 'instance', parentId: pageId })).toThrow(/componentKey/)
    expect(() =>
      createNode(doc, { type: 'rect', parentId: pageId, componentKey: 'k'.repeat(16) }),
    ).toThrow(/componentKey/)
    expect(() => createNode(doc, { type: 'frame', parentId: pageId, overrides: {} })).toThrow(
      /overrides/,
    )
    const inst = createNode(doc, {
      type: 'instance',
      parentId: pageId,
      componentKey: 'k'.repeat(16),
    })
    expect(() => createNode(doc, { type: 'rect', parentId: inst })).toThrow(/cannot contain/)
    const g = createNode(doc, { type: 'group', parentId: pageId })
    expect(getNode(doc, createNode(doc, { type: 'rect', parentId: g }))!.parentId).toBe(g)
    expect(toSnapshot(doc).components).toBeUndefined()
  })
})

describe('events', () => {
  it('reports override paths, vector edits, registry keys and component props', async () => {
    const { doc, pageId } = docWithPage()
    const f = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
    })
    const t = createNode(doc, { type: 'text', parentId: f, text: 'x' })
    const vec = createNode(doc, {
      type: 'vector',
      parentId: pageId,
      vector: {
        fillRule: 'nonzero',
        subpaths: [{ id: 'aaaaaaaa', closed: false, points: [{ x: 0, y: 0 }] }],
      },
    })
    await flushEvents()
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (b) => batches.push(b))
    const main = createComponent(doc, [f], docGeometry(doc))!
    await flushEvents()
    const key = getNode(doc, main)!.componentKey!
    expect(batches[0]!.components).toEqual([key])
    expect(batches[0]!.changes).toContainEqual({ kind: 'props', id: f, keys: ['componentKey'] })
    expect(batches[0]!.changes).toContainEqual({ kind: 'props', id: t, keys: ['nodeKey'] })
    const inst = createInstance(doc, { componentKey: key, parentId: pageId })
    await flushEvents()
    setStylesAt(doc, `${inst}/${getNode(doc, t)!.nodeKey!}`, { color: 'red' })
    setStylesAt(doc, inst, { opacity: 0.5 })
    editVector(doc, vec, [{ kind: 'set', subpathId: 'aaaaaaaa', index: 0, point: { x: 1, y: 1 } }])
    await flushEvents()
    const changes = batches.slice(2).flatMap((b) => b.changes)
    expect(changes).toContainEqual({
      kind: 'overrides',
      id: inst,
      paths: [getNode(doc, t)!.nodeKey!],
    })
    expect(changes).toContainEqual({ kind: 'overrides', id: inst, paths: [''] })
    expect(changes).toContainEqual({ kind: 'vector', id: vec })
    expect(changes.some((c) => c.kind === 'props' && c.id === inst)).toBe(false)
  })
})

describe('assets in overrides', () => {
  it('counts override asset ids and urls as references', () => {
    const h1 = '1'.repeat(64)
    const h2 = '2'.repeat(64)
    expect(
      nodeAssetRefs({
        type: 'instance',
        styles: {},
        overrides: {
          a: { assetId: h1 },
          b: { styles: { backgroundImage: `url("baren-asset://${h2}")`, x: null } },
        },
      }),
    ).toEqual([h1, h2])
    const { doc, pageId } = docWithPage()
    const f = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
    })
    const img = createNode(doc, { type: 'image', parentId: f, assetId: h1 })
    const main = createComponent(doc, [f], docGeometry(doc))!
    const inst = createInstance(doc, {
      componentKey: getNode(doc, main)!.componentKey!,
      parentId: pageId,
    })
    setPropsAt(doc, `${inst}/${getNode(doc, img)!.nodeKey!}`, { assetId: h2 })
    expect(docAssetRefs(doc)).toEqual(new Set([h1, h2]))
  })
})

describe('generateBenchDoc presets (20k-mixed)', () => {
  it('adds mains on a Components page, instances and vectors without changing the default output', () => {
    const plain = toSnapshot(generateBenchDoc({ artboards: 2, nodesPerArtboard: 60, peerId: 3 }))
    const again = toSnapshot(
      generateBenchDoc({
        artboards: 2,
        nodesPerArtboard: 60,
        peerId: 3,
        components: { mains: 0, everyNth: 10 },
      }),
    )
    expect(again).toEqual(plain)
    const opts = {
      artboards: 2,
      nodesPerArtboard: 60,
      peerId: 3,
      components: { mains: 3, everyNth: 10 },
      vectors: { everyNth: 20 },
    }
    const doc = generateBenchDoc(opts)
    const snap = toSnapshot(doc)
    expect(Object.keys(snap.nodes)).toHaveLength(benchDocNodeCount(opts))
    expect(benchDocNodeCount(opts)).toBe(1 + 2 * 61 + 1 + 3 * BENCH_MAIN_NODE_COUNT)
    const nodes = Object.values(snap.nodes)
    const instances = nodes.filter((n) => n.type === 'instance')
    const vectors = nodes.filter((n) => n.type === 'vector')
    expect(instances.length).toBeGreaterThan(8)
    expect(vectors.length).toBeGreaterThan(3)
    expect(listComponents(doc).map((c) => c.name)).toEqual(['Card 1', 'Card 2', 'Card 3'])
    const r = createComponentResolver(doc)
    for (const i of instances) expect(r.expandInstance(i.id)!.status).toBe('ok')
    expect(Object.keys(r.expandInstance(instances[0]!.id)!.nodes)).toHaveLength(
      BENCH_MAIN_NODE_COUNT,
    )
    expect(checkInvariants(doc)).toEqual([])
    setNodeProps(doc, instances[0]!.id, { name: 'renamed' })
  })
})
