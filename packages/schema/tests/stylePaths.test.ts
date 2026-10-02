/**
 * The resolver's fast path for style-only main edits (integration, contract §9 propagation):
 * `stylePaths(batch)` (before `apply`) names the template paths a batch restyles, and
 * `resolveStyles(instance, path)` must equal the full expansion's styles for that node.
 */
import { describe, expect, it } from 'vitest'
import type { LoroDoc } from 'loro-crdt'
import {
  createComponent,
  createComponentResolver,
  createInstance,
  createNode,
  docGeometry,
  getChildIds,
  getNode,
  setStyles,
  setStylesAt,
  setText,
  subscribeNodes,
  transact,
  type ComponentResolver,
  type NodeChangeBatch,
} from '../src/index.ts'
import { docWithPage, flushEvents, seeded } from './helpers.ts'

/** Badge (frame > Dot) nested in Card (frame > Title, Icon, badge instance); three Cards. */
function build(doc: LoroDoc, pageId: string) {
  const badge = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Badge',
    styles: { left: 0, top: 0, width: 40, height: 20, backgroundColor: '#EEEEEE' },
  })
  const dot = createNode(doc, {
    type: 'rect',
    parentId: badge,
    name: 'Dot',
    styles: { width: 6, height: 6, backgroundColor: '#00AA00', opacity: 0.5 },
  })
  const badgeMain = createComponent(doc, [badge], docGeometry(doc), { random: seeded(3) })!
  const badgeKey = getNode(doc, badgeMain)!.componentKey!
  const card = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Card',
    styles: { left: 200, top: 0, width: 200, height: 100, backgroundColor: '#FFFFFF' },
  })
  const title = createNode(doc, {
    type: 'text',
    parentId: card,
    name: 'Title',
    text: 'Hello',
    styles: { color: '#111111', fontSize: '14px' },
  })
  const icon = createNode(doc, {
    type: 'rect',
    parentId: card,
    name: 'Icon',
    styles: { width: 16, height: 16, backgroundColor: 'red', borderRadius: 4 },
  })
  const nested = createInstance(doc, {
    componentKey: badgeKey,
    parentId: card,
    styles: { position: 'absolute', left: 150, top: 10 },
  })
  const cardMain = createComponent(doc, [card], docGeometry(doc), { random: seeded(4) })!
  const cardKey = getNode(doc, cardMain)!.componentKey!
  const k = (id: string) => getNode(doc, id)!.nodeKey!
  const instances = [0, 1, 2].map((i) =>
    createInstance(doc, {
      componentKey: cardKey,
      parentId: pageId,
      styles: { left: 500 + i * 250, top: 0 },
    }),
  )
  const badgeInstance = createInstance(doc, {
    componentKey: badgeKey,
    parentId: pageId,
    styles: { left: 0, top: 300 },
  })
  // Overrides: a colour, a removed style, the root, nested content.
  setStylesAt(doc, `${instances[1]}/${k(icon)}`, { backgroundColor: 'blue', borderRadius: null })
  setStylesAt(doc, instances[1]!, { backgroundColor: '#FAFAFA' })
  setStylesAt(doc, `${instances[2]}/${k(nested)}/${k(dot)}`, { opacity: 1 })
  return {
    badgeMain,
    badgeKey,
    dot,
    cardMain,
    cardKey,
    title,
    icon,
    nested,
    instances,
    badgeInstance,
    k,
  }
}

/** Every node of every given instance: `resolveStyles` equals the full expansion. */
function expectEquivalent(r: ComponentResolver, ids: readonly string[]): void {
  for (const id of ids) {
    const exp = r.expandInstance(id)!
    for (const [vid, node] of Object.entries(exp.nodes)) {
      const path = vid === id ? '' : vid.slice(id.length + 1)
      expect(r.resolveStyles(id, path), `${vid}`).toEqual(node.styles)
    }
  }
}

async function setup() {
  const { doc, pageId } = docWithPage('Styles', 1)
  const b = build(doc, pageId)
  await flushEvents()
  const r = createComponentResolver(doc)
  const all = [...b.instances, b.badgeInstance]
  for (const id of all) r.expandInstance(id) // templates cached, as a canvas would have them
  const batches: NodeChangeBatch[] = []
  const off = subscribeNodes(doc, (x) => batches.push(x))
  const next = async (edit: () => void) => {
    const before = batches.length
    edit()
    await flushEvents()
    expect(batches.length).toBe(before + 1)
    const batch = batches[batches.length - 1]!
    const plan = r.stylePaths(batch)
    r.apply(batch)
    return plan
  }
  return { doc, b, r, all, next, off }
}

describe('resolver: resolveStyles', () => {
  it('equals the full expansion for every node (overrides, removals, nesting, roots)', async () => {
    const { r, all, off } = await setup()
    expectEquivalent(r, all)
    expect(r.resolveStyles('not-an-id', '')).toBeUndefined()
    expect(r.resolveStyles(all[0]!, 'nope')).toBeUndefined()
    off()
  })
})

describe('resolver: stylePaths (before apply)', () => {
  it('maps a restyled main node to its path in every template that shows it', async () => {
    const { doc, b, r, all, next, off } = await setup()
    const plan = await next(() => setStyles(doc, b.icon, { backgroundColor: 'green' }))
    expect(plan).toEqual(new Map([[b.cardKey, new Set([b.k(b.icon)])]]))
    expectEquivalent(r, all)
    // Nested: Badge's Dot shows in Badge instances and inside every Card instance.
    const nestedPlan = await next(() => setStyles(doc, b.dot, { backgroundColor: '#123456' }))
    expect(nestedPlan).toEqual(
      new Map([
        [b.badgeKey, new Set([b.k(b.dot)])],
        [b.cardKey, new Set([`${b.k(b.nested)}/${b.k(b.dot)}`])],
      ]),
    )
    expectEquivalent(r, all)
    expect(r.resolveStyles(b.instances[2]!, `${b.k(b.nested)}/${b.k(b.dot)}`)).toMatchObject({
      backgroundColor: '#123456',
      opacity: 1,
    })
    // The root of a main nothing nests: path ''.
    const rootPlan = await next(() => setStyles(doc, b.cardMain, { backgroundColor: '#000001' }))
    expect(rootPlan).toEqual(new Map([[b.cardKey, new Set([''])]]))
    expectEquivalent(r, all)
    off()
  })

  it('falls back (null) whenever the batch needs a full re-expansion', async () => {
    const { doc, b, r, all, next, off } = await setup()
    // The root of a main that another component nests.
    expect(await next(() => setStyles(doc, b.badgeMain, { backgroundColor: '#ABCDEF' }))).toBeNull()
    // Text, overrides, structure, mixed batches.
    expect(await next(() => setText(doc, b.title, 'Changed'))).toBeNull()
    expect(
      await next(() => setStylesAt(doc, `${b.instances[0]}/${b.k(b.icon)}`, { opacity: 0.3 })),
    ).toBeNull()
    expect(
      await next(() =>
        transact(doc, () => {
          setStyles(doc, b.icon, { width: 20 })
          createNode(doc, { type: 'rect', parentId: b.cardMain, name: 'Extra' })
        }),
      ),
    ).toBeNull()
    // The instance's own styles.
    expect(await next(() => setStyles(doc, b.instances[0]!, { left: 520 }))).toBeNull()
    expectEquivalent(r, all)
    off()
  })

  it('falls back when the affected template was never built (nothing expanded yet)', async () => {
    const { doc, pageId } = docWithPage('Cold', 1)
    const b = build(doc, pageId)
    await flushEvents()
    const r = createComponentResolver(doc)
    const batches: NodeChangeBatch[] = []
    const off = subscribeNodes(doc, (x) => batches.push(x))
    setStyles(doc, b.icon, { backgroundColor: 'green' })
    await flushEvents()
    expect(r.stylePaths(batches[0]!)).toBeNull()
    off()
  })

  it('needs nothing for style edits outside every main', async () => {
    const { doc, r, off } = await setup()
    const loose = createNode(doc, {
      type: 'rect',
      parentId: getChildIds(doc, null)[0]!,
      styles: { left: 0, top: 900, width: 10, height: 10 },
    })
    await flushEvents()
    const batches: NodeChangeBatch[] = []
    const stop = subscribeNodes(doc, (x) => batches.push(x))
    setStyles(doc, loose, { backgroundColor: 'pink' })
    await flushEvents()
    // Nothing is affected: no fast path needed (the caller skips unaffected batches).
    expect(r.affectedBy(batches[0]!).components.size).toBe(0)
    expect(r.stylePaths(batches[0]!)).toBeNull()
    stop()
    off()
  })
})
