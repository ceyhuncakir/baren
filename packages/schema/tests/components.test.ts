import { describe, expect, it } from 'vitest'
import { UndoManager, type LoroDoc } from 'loro-crdt'
import {
  MISSING_FILL_COLOR,
  componentDependencies,
  createComponent,
  createComponentResolver,
  createInstance,
  createNode,
  deleteNode,
  detachInstance,
  docGeometry,
  findMainComponent,
  getChildIds,
  getNode,
  getOverrides,
  getResolvedNode,
  hasOverrides,
  isMainComponent,
  listComponents,
  nodesTree,
  refExists,
  resetOverrides,
  restoreMainComponent,
  setNodeProps,
  setPropsAt,
  setStyles,
  setStylesAt,
  setText,
  setTextAt,
  subscribeNodes,
  toRenderSubtree,
  toSnapshot,
  wouldCreateCycle,
  type NodeChangeBatch,
} from '../src/index.ts'
import { docWithPage, flushEvents, seeded } from './helpers.ts'
import { checkInvariants } from './invariants.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/** A card main: frame > title (text), icon (rect), body (frame > label text), photo (image). */
function buildCard(doc: LoroDoc, pageId: string, seed = 1) {
  const card = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Card',
    styles: {
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      display: 'flex',
      backgroundColor: '#FFFFFF',
      rotate: '5deg',
    },
  })
  const title = createNode(doc, {
    type: 'text',
    parentId: card,
    name: 'Title',
    text: 'Hello',
    styles: { color: '#000' },
  })
  const icon = createNode(doc, {
    type: 'rect',
    parentId: card,
    name: 'Icon',
    styles: { width: 16, height: 16, backgroundColor: 'red' },
  })
  const body = createNode(doc, {
    type: 'frame',
    parentId: card,
    name: 'Body',
    styles: { padding: 4 },
  })
  const label = createNode(doc, {
    type: 'text',
    parentId: body,
    name: 'Label',
    text: 'Label',
    styles: {},
  })
  const photo = createNode(doc, {
    type: 'image',
    parentId: card,
    name: 'Photo',
    assetId: HASH_A,
    styles: { width: 10, height: 10 },
  })
  const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(seed) })!
  const key = getNode(doc, main)!.componentKey!
  const k = (id: string) => getNode(doc, id)!.nodeKey!
  return { main, key, title, icon, body, label, photo, k }
}

describe('createComponent', () => {
  it('converts a single frame in place: key, node keys, registry', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    expect(c.main).toBeTruthy()
    expect(c.key).toMatch(/^[0-9a-z]{16}$/)
    expect(isMainComponent(doc, c.main)).toBe(true)
    expect(getNode(doc, c.main)!.nodeKey).toBeUndefined()
    for (const id of [c.title, c.icon, c.body, c.label, c.photo])
      expect(c.k(id)).toMatch(/^[0-9a-z]{10}$/)
    expect(toSnapshot(doc).components).toEqual({ [c.key]: { mainId: c.main } })
    expect(listComponents(doc)).toEqual([{ key: c.key, mainId: c.main, name: 'Card', pageId }])
    expect(checkInvariants(doc)).toEqual([])
    // New nodes created inside the main get keys too.
    const extra = createNode(doc, { type: 'rect', parentId: c.body })
    expect(getNode(doc, extra)!.nodeKey).toMatch(/^[0-9a-z]{10}$/)
  })

  it('wraps a multi-node selection in a new frame first', () => {
    const { doc, pageId } = docWithPage()
    const a = createNode(doc, {
      type: 'rect',
      parentId: pageId,
      styles: { left: 10, top: 10, width: 10, height: 10 },
    })
    const b = createNode(doc, {
      type: 'rect',
      parentId: pageId,
      styles: { left: 40, top: 10, width: 10, height: 10 },
    })
    const main = createComponent(doc, [a, b], docGeometry(doc), { name: 'Pair' })!
    const node = getNode(doc, main)!
    expect(node.name).toBe('Pair')
    expect(node.children).toEqual([a, b])
    expect(node.styles).toEqual({ left: 10, top: 10, width: 40, height: 10 })
    expect(getNode(doc, a)!.nodeKey).toBeDefined()
    expect(checkInvariants(doc)).toEqual([])
  })
})

describe('instances and resolution', () => {
  it('creates instances with own keys only and expands the main live', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const inst = createInstance(doc, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 300, top: 50, backgroundColor: 'blue' },
    })
    const raw = getNode(doc, inst)!
    expect(raw).toMatchObject({
      type: 'instance',
      name: '',
      componentKey: c.key,
      mainId: c.main,
      styles: { left: 300, top: 50 },
    })
    expect(raw.children).toEqual([])
    const r = createComponentResolver(doc)
    const exp = r.expandInstance(inst)!
    expect(exp.status).toBe('ok')
    expect(exp.dependsOn).toEqual(new Set([c.key]))
    const root = exp.nodes[inst]!
    expect(root.name).toBe('Card')
    expect(root.type).toBe('instance')
    expect(root.styles).toEqual({
      width: 200,
      height: 100,
      display: 'flex',
      backgroundColor: '#FFFFFF',
      left: 300,
      top: 50,
    })
    const titleRef = `${inst}/${c.k(c.title)}`
    expect(root.children).toEqual([
      titleRef,
      `${inst}/${c.k(c.icon)}`,
      `${inst}/${c.k(c.body)}`,
      `${inst}/${c.k(c.photo)}`,
    ])
    expect(exp.nodes[titleRef]).toMatchObject({
      id: titleRef,
      type: 'text',
      text: 'Hello',
      parentId: inst,
      source: { instanceId: inst, path: c.k(c.title), mainNodeId: c.title, componentKey: c.key },
    })
    expect(exp.nodes[`${inst}/${c.k(c.label)}`]!.parentId).toBe(`${inst}/${c.k(c.body)}`)
    expect(refExists(doc, titleRef)).toBe(true)
    expect(refExists(doc, `${inst}/zzzzzzzzzz`)).toBe(false)
    expect(r.childrenOf(`${inst}/${c.k(c.body)}`)).toEqual([`${inst}/${c.k(c.label)}`])
    // Live propagation.
    setText(doc, c.title, 'Hi there')
    expect(getResolvedNode(doc, titleRef)!.text).toBe('Hi there')
    expect(r.resolveNode(titleRef)!.text).toBe('Hi there') // guard: no apply() yet, still fresh
    expect(checkInvariants(doc)).toEqual([])
  })

  it('writes overrides through refs: root own keys, override styles, text, hidden, asset; equal-to-base removes', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const inst = createInstance(doc, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 300, top: 0 },
    })
    const ref = (id: string) => `${inst}/${c.k(id)}`
    setStylesAt(doc, inst, { width: 240, backgroundColor: '#EEE', left: 310 })
    expect(getNode(doc, inst)!.styles).toEqual({ left: 310, top: 0, width: 240 })
    expect(getOverrides(doc, inst)).toEqual({ '': { styles: { backgroundColor: '#EEE' } } })
    setStylesAt(doc, ref(c.icon), { backgroundColor: 'green', width: 16, borderRadius: null })
    setTextAt(doc, ref(c.title), 'Override')
    setPropsAt(doc, ref(c.label), { hidden: true })
    setPropsAt(doc, ref(c.photo), { assetId: HASH_B, assetName: 'b.png' })
    expect(getOverrides(doc, inst)[c.k(c.icon)]).toEqual({ styles: { backgroundColor: 'green' } })
    const r = createComponentResolver(doc)
    const exp = r.expandInstance(inst)!
    expect(exp.nodes[inst]!.styles['backgroundColor']).toBe('#EEE')
    expect(exp.nodes[inst]!.overridden).toEqual({
      styles: ['backgroundColor', 'width'],
      text: false,
      hidden: false,
      assetId: false,
    })
    expect(exp.nodes[ref(c.icon)]!.styles).toEqual({
      width: 16,
      height: 16,
      backgroundColor: 'green',
    })
    expect(exp.nodes[ref(c.icon)]!.overridden).toEqual({
      styles: ['backgroundColor'],
      text: false,
      hidden: false,
      assetId: false,
    })
    expect(exp.nodes[ref(c.title)]!.text).toBe('Override')
    expect(exp.nodes[ref(c.label)]!.hidden).toBe(true)
    expect(exp.nodes[ref(c.photo)]).toMatchObject({ assetId: HASH_B, assetName: 'b.png' })
    expect(hasOverrides(doc, inst)).toBe(true)
    expect(hasOverrides(doc, ref(c.icon))).toBe(true)
    expect(hasOverrides(doc, ref(c.body))).toBe(false)
    // null removes a property the base has; equal-to-base clears the override.
    setStylesAt(doc, ref(c.icon), { height: null })
    expect(getResolvedNode(doc, ref(c.icon))!.styles).toEqual({
      width: 16,
      backgroundColor: 'green',
    })
    setStylesAt(doc, ref(c.icon), { backgroundColor: 'red', height: 16 })
    expect(getOverrides(doc, inst)[c.k(c.icon)]).toBeUndefined()
    setTextAt(doc, ref(c.title), 'Hello')
    expect(getOverrides(doc, inst)[c.k(c.title)]).toBeUndefined()
    // Main edits propagate to keys that are not overridden.
    setStyles(doc, c.icon, { backgroundColor: 'purple', borderRadius: 4 })
    expect(getResolvedNode(doc, ref(c.icon))!.styles).toEqual({
      width: 16,
      height: 16,
      backgroundColor: 'purple',
      borderRadius: 4,
    })
    expect(checkInvariants(doc)).toEqual([])
  })

  it('resolves nested instances: main node → nested instance overrides → outer overrides', () => {
    const { doc, pageId } = docWithPage()
    const a = buildCard(doc, pageId, 1)
    const outer = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Outer',
      styles: { left: 0, top: 500, width: 400, height: 300 },
    })
    const outerMain = createComponent(doc, [outer], docGeometry(doc), { random: seeded(2) })!
    const outerKey = getNode(doc, outerMain)!.componentKey!
    const nested = createInstance(doc, {
      componentKey: a.key,
      parentId: outerMain,
      styles: { position: 'absolute', left: 10, top: 10 },
    })
    const nk = getNode(doc, nested)!.nodeKey!
    expect(nk).toMatch(/^[0-9a-z]{10}$/)
    // Overrides stored on the nested instance inside the outer main.
    setStylesAt(doc, `${nested}/${a.k(a.icon)}`, { backgroundColor: 'yellow', width: 20 })
    setTextAt(doc, `${nested}/${a.k(a.title)}`, 'Nested')
    const inst = createInstance(doc, {
      componentKey: outerKey,
      parentId: pageId,
      styles: { left: 600, top: 500 },
    })
    const path = `${nk}/${a.k(a.icon)}`
    setStylesAt(doc, `${inst}/${path}`, { width: 30 })
    setStylesAt(doc, `${inst}/${nk}`, { left: 50, opacity: 0.5 })
    const r = createComponentResolver(doc)
    const exp = r.expandInstance(inst)!
    expect(exp.dependsOn).toEqual(new Set([outerKey, a.key]))
    const nestedRoot = exp.nodes[`${inst}/${nk}`]!
    expect(nestedRoot).toMatchObject({
      type: 'instance',
      componentKey: a.key,
      status: 'ok',
      nodeKey: nk,
      name: 'Card',
    })
    expect(nestedRoot.styles).toMatchObject({
      position: 'absolute',
      left: 50,
      top: 10,
      opacity: 0.5,
      backgroundColor: '#FFFFFF',
    })
    expect(nestedRoot.styles['rotate']).toBeUndefined()
    const icon = exp.nodes[`${inst}/${path}`]!
    expect(icon.styles).toEqual({ width: 30, height: 16, backgroundColor: 'yellow' })
    expect(icon.overridden?.styles).toEqual(['width'])
    expect(icon.source).toEqual({ instanceId: inst, path, mainNodeId: a.icon, componentKey: a.key })
    expect(exp.nodes[`${inst}/${nk}/${a.k(a.title)}`]!.text).toBe('Nested')
    // Outer overrides win; null removes a value set by the nested level.
    setStylesAt(doc, `${inst}/${path}`, { backgroundColor: null })
    expect(getResolvedNode(doc, `${inst}/${path}`)!.styles).toEqual({ width: 30, height: 16 })
    expect(componentDependencies(doc, outerKey)).toEqual(new Set([a.key]))
    expect(checkInvariants(doc)).toEqual([])
  })

  it('reset clears entries (no resurfacing) and drops the instance size', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const inst = createInstance(doc, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 0, top: 300, width: 100 },
    })
    const icon = `${inst}/${c.k(c.icon)}`
    setStylesAt(doc, icon, { backgroundColor: 'green', borderRadius: 3 })
    setTextAt(doc, `${inst}/${c.k(c.title)}`, 'X')
    resetOverrides(doc, icon, { keys: ['borderRadius'] })
    expect(getOverrides(doc, inst)[c.k(c.icon)]).toEqual({ styles: { backgroundColor: 'green' } })
    resetOverrides(doc, inst)
    expect(getOverrides(doc, inst)).toEqual({})
    expect(getNode(doc, inst)!.styles).toEqual({ left: 0, top: 300 })
    setStylesAt(doc, icon, { opacity: 0.5 })
    expect(getOverrides(doc, inst)).toEqual({ [c.k(c.icon)]: { styles: { opacity: 0.5 } } })
    expect(getResolvedNode(doc, `${inst}/${c.k(c.title)}`)!.text).toBe('Hello')
  })

  it('keeps overrides valid across undo of a deleted main node (same nodeKey, new TreeID)', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const inst = createInstance(doc, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 0, top: 300 },
    })
    const key = c.k(c.icon)
    setStylesAt(doc, `${inst}/${key}`, { backgroundColor: 'green' })
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    deleteNode(doc, c.icon)
    doc.commit()
    expect(getResolvedNode(doc, `${inst}/${key}`)).toBeUndefined()
    undo.undo()
    const icon = getChildIds(doc, c.main).find((id) => getNode(doc, id)!.nodeKey === key)!
    expect(icon).not.toBe(c.icon)
    expect(getResolvedNode(doc, `${inst}/${key}`)!.styles['backgroundColor']).toBe('green')
  })
})

describe('main lookup (§2.7.4)', () => {
  it('step 2: finds the live main after undo re-creates it under a new TreeID', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    deleteNode(doc, c.main)
    doc.commit()
    expect(findMainComponent(doc, c.key)).toEqual({ mainId: c.main, deleted: true })
    undo.undo()
    const found = findMainComponent(doc, c.key)!
    expect(found.deleted).toBe(false)
    expect(found.mainId).not.toBe(c.main)
    expect(getNode(doc, found.mainId)!.componentKey).toBe(c.key)
  })

  it('step 3: instances of a deleted main render from its retained data; restore re-creates it', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const inst = createInstance(doc, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 0, top: 300 },
    })
    const titleKey = c.k(c.title)
    setTextAt(doc, `${inst}/${titleKey}`, 'Kept')
    deleteNode(doc, c.main)
    const exp = createComponentResolver(doc).expandInstance(inst)!
    expect(exp.status).toBe('ok')
    expect(exp.mainDeleted).toBe(true)
    expect(exp.nodes[inst]!.mainDeleted).toBe(true)
    expect(exp.nodes[`${inst}/${titleKey}`]!.text).toBe('Kept')
    expect(listComponents(doc)).toEqual([])
    const restored = restoreMainComponent(doc, c.key)!
    const restoredNode = getNode(doc, restored)!
    expect(restoredNode.componentKey).toBe(c.key)
    const page = getNode(doc, restoredNode.parentId!)!
    expect(page.name).toBe('Components')
    expect(restoredNode.styles).toMatchObject({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: '5deg',
    })
    expect(getNode(doc, restoredNode.children[0]!)!.nodeKey).toBe(titleKey)
    expect(findMainComponent(doc, c.key)).toEqual({ mainId: restored, deleted: false })
    const again = createComponentResolver(doc).expandInstance(inst)!
    expect(again.mainDeleted).toBe(false)
    expect(again.nodes[`${inst}/${titleKey}`]!.text).toBe('Kept')
    expect(restoreMainComponent(doc, c.key)).toBe(restored)
    expect(checkInvariants(doc)).toEqual([])
  })

  it('step 3 via the instance hint, and step 4: unresolved placeholder', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const inst = createInstance(doc, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 0, top: 300 },
    })
    deleteNode(doc, c.main)
    doc.getMap('components').delete(c.key)
    doc.commit()
    expect(findMainComponent(doc, c.key)).toBeNull()
    expect(findMainComponent(doc, c.key, c.main)).toEqual({ mainId: c.main, deleted: true })
    expect(createComponentResolver(doc).expandInstance(inst)!.mainDeleted).toBe(true)
    const orphan = createNode(doc, {
      type: 'instance',
      parentId: pageId,
      componentKey: 'zzzzzzzzzzzzzzzz',
      styles: { left: 5, top: 5 },
    })
    const exp = createComponentResolver(doc).expandInstance(orphan)!
    expect(exp.status).toBe('unresolved')
    expect(exp.nodes[orphan]!.styles).toEqual({
      left: 5,
      top: 5,
      width: 100,
      height: 100,
      backgroundColor: MISSING_FILL_COLOR,
    })
    expect(Object.keys(exp.nodes)).toEqual([orphan])
  })
})

describe('cycles and depth (§2.7.5)', () => {
  it('refuses placements that make a main contain itself', () => {
    const { doc, pageId } = docWithPage()
    const a = buildCard(doc, pageId, 1)
    const outer = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 400, width: 100, height: 100 },
    })
    const b = createComponent(doc, [outer], docGeometry(doc), { random: seeded(9) })!
    const bKey = getNode(doc, b)!.componentKey!
    createInstance(doc, { componentKey: a.key, parentId: b })
    // B contains A; putting an instance of B into A would cycle.
    expect(() => createInstance(doc, { componentKey: bKey, parentId: a.body })).toThrow(/itself/)
    expect(() => createInstance(doc, { componentKey: a.key, parentId: a.main })).toThrow(/itself/)
    const loose = createInstance(doc, { componentKey: bKey, parentId: pageId })
    expect(wouldCreateCycle(doc, [loose], a.main)).toBe(true)
    expect(wouldCreateCycle(doc, [loose], pageId)).toBe(false)
    expect(checkInvariants(doc)).toEqual([])
  })

  it('renders cycles created by concurrent edits as `cycle`, deep chains as `depth`', () => {
    const { doc, pageId } = docWithPage()
    const a = buildCard(doc, pageId, 1)
    const outer = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 400, width: 100, height: 100 },
    })
    const b = createComponent(doc, [outer], docGeometry(doc), { random: seeded(9) })!
    const bKey = getNode(doc, b)!.componentKey!
    createInstance(doc, { componentKey: a.key, parentId: b })
    // Bypass the helpers (as a merge would): an instance of B inside A.
    const raw = nodesTree(doc)
      .getNodeByID(a.body as never)!
      .createNode()
    raw.data.set('type', 'instance')
    raw.data.set('componentKey', bKey)
    raw.data.set('nodeKey', 'cyclecycle')
    raw.data.ensureMergeableMap('styles')
    doc.commit()
    const inst = createNode(doc, { type: 'instance', parentId: pageId, componentKey: a.key })
    const exp = createComponentResolver(doc).expandInstance(inst)!
    expect(exp.status).toBe('ok')
    const inner = Object.values(exp.nodes).find((n) => n.status === 'cycle')
    expect(inner).toBeDefined()
    expect(inner!.id.split('/')).toHaveLength(3) // inst/<B instance in A>/<A instance in B>: cycle
    expect(checkInvariants(doc).some((v) => v.includes('contains an instance of itself'))).toBe(
      true,
    )

    // Depth: a chain of 18 components, each containing an instance of the previous one.
    const { doc: d2, pageId: p2 } = docWithPage()
    let prevKey: string | null = null
    for (let i = 0; i < 18; i++) {
      const f = createNode(d2, {
        type: 'frame',
        parentId: p2,
        styles: { left: i * 200, top: 0, width: 100, height: 100 },
      })
      const m = createComponent(d2, [f], docGeometry(d2), { random: seeded(100 + i) })!
      if (prevKey) createInstance(d2, { componentKey: prevKey, parentId: m })
      prevKey = getNode(d2, m)!.componentKey!
    }
    const top = createNode(d2, { type: 'instance', parentId: p2, componentKey: prevKey! })
    const deep = createComponentResolver(d2).expandInstance(top)!
    const statuses = Object.values(deep.nodes)
      .map((n) => n.status)
      .filter(Boolean)
    // The top instance and 15 nested levels resolve; the next level sees 16 keys on the stack.
    expect(statuses.filter((s) => s === 'ok')).toHaveLength(16)
    expect(statuses).toContain('depth')
  })
})

describe('detachInstance', () => {
  it('turns the instance into a frame with real children and rebased nested instances', () => {
    const { doc, pageId } = docWithPage()
    const a = buildCard(doc, pageId, 1)
    const outer = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Outer',
      styles: { left: 0, top: 500, width: 400, height: 300 },
    })
    const outerMain = createComponent(doc, [outer], docGeometry(doc), { random: seeded(2) })!
    const outerKey = getNode(doc, outerMain)!.componentKey!
    const heading = createNode(doc, { type: 'text', parentId: outerMain, text: 'Heading' })
    const nested = createInstance(doc, {
      componentKey: a.key,
      parentId: outerMain,
      styles: { position: 'absolute', left: 10, top: 10 },
    })
    const nk = getNode(doc, nested)!.nodeKey!
    setTextAt(doc, `${nested}/${a.k(a.title)}`, 'Inner')
    const inst = createInstance(doc, {
      componentKey: outerKey,
      parentId: pageId,
      styles: { left: 600, top: 500 },
    })
    setTextAt(doc, `${inst}/${getNode(doc, heading)!.nodeKey!}`, 'Changed heading')
    setStylesAt(doc, `${inst}/${nk}`, { left: 99, opacity: 0.4 })
    setStylesAt(doc, `${inst}/${nk}/${a.k(a.icon)}`, { backgroundColor: 'teal' })
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    expect(detachInstance(doc, inst)).toBe(inst)
    const frameNode = getNode(doc, inst)!
    expect(frameNode.type).toBe('frame')
    expect(frameNode.name).toBe('Outer')
    expect(frameNode.componentKey).toBeUndefined()
    expect(frameNode.overrides).toBeUndefined()
    expect(frameNode.styles).toEqual({ width: 400, height: 300, left: 600, top: 500 })
    const [headingCopy, nestedCopy] = frameNode.children.map((id) => getNode(doc, id)!)
    expect(headingCopy).toMatchObject({
      type: 'text',
      text: 'Changed heading',
      nodeKey: getNode(doc, heading)!.nodeKey,
    })
    expect(nestedCopy).toMatchObject({ type: 'instance', componentKey: a.key, nodeKey: nk })
    expect(nestedCopy!.styles).toEqual({ position: 'absolute', left: 99, top: 10 })
    expect(nestedCopy!.overrides).toEqual({
      [a.k(a.title)]: { text: 'Inner' },
      '': { styles: { opacity: 0.4 } },
      [a.k(a.icon)]: { styles: { backgroundColor: 'teal' } },
    })
    const icon = getResolvedNode(doc, `${nestedCopy!.id}/${a.k(a.icon)}`)!
    expect(icon.styles['backgroundColor']).toBe('teal')
    expect(checkInvariants(doc)).toEqual([])
    undo.undo()
    expect(getNode(doc, inst)!.type).toBe('instance')
    expect(getResolvedNode(doc, `${inst}/${nk}/${a.k(a.icon)}`)!.styles['backgroundColor']).toBe(
      'teal',
    )
  })
})

describe('resolver caching and affectedBy', () => {
  it('reports affected components and instances, drops caches on apply', async () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const inst = createInstance(doc, {
      componentKey: c.key,
      parentId: pageId,
      styles: { left: 0, top: 300 },
    })
    const other = createNode(doc, { type: 'rect', parentId: pageId, styles: { left: 900, top: 0 } })
    await flushEvents()
    const r = createComponentResolver(doc)
    const first = r.expandInstance(inst)!
    expect(r.expandInstance(inst)).toBe(first)
    const batches: NodeChangeBatch[] = []
    const off = subscribeNodes(doc, (b) => batches.push(b))
    setStyles(doc, c.icon, { backgroundColor: 'black' })
    await flushEvents()
    expect(r.affectedBy(batches[0]!).components).toEqual(new Set([c.key]))
    r.apply(batches[0]!)
    expect(r.expandInstance(inst)).not.toBe(first)
    expect(r.resolveNode(`${inst}/${c.k(c.icon)}`)!.styles['backgroundColor']).toBe('black')
    setStyles(doc, other, { width: 5 })
    await flushEvents()
    const unrelated = r.affectedBy(batches[1]!)
    expect(unrelated.components.size).toBe(0)
    expect(unrelated.instances.size).toBe(0)
    setStylesAt(doc, `${inst}/${c.k(c.icon)}`, { opacity: 0.2 })
    await flushEvents()
    expect(r.affectedBy(batches[2]!).instances).toEqual(new Set([inst]))
    const exp = r.expandInstance(inst)!
    r.apply(batches[2]!)
    expect(r.expandInstance(inst)).not.toBe(exp)
    setNodeProps(doc, c.title, { name: 'Heading' })
    await flushEvents()
    expect(r.affectedBy(batches[3]!).components).toEqual(new Set([c.key]))
    off()
  })

  it('toRenderSubtree expands instances inside a subtree in document order', () => {
    const { doc, pageId } = docWithPage()
    const c = buildCard(doc, pageId)
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 400, width: 500, height: 500 },
    })
    const before = createNode(doc, { type: 'rect', parentId: board })
    const inst = createInstance(doc, { componentKey: c.key, parentId: board })
    const after = createNode(doc, { type: 'rect', parentId: board })
    const sub = toRenderSubtree(doc, board)!
    expect(Object.keys(sub.nodes)).toEqual([
      board,
      before,
      inst,
      `${inst}/${c.k(c.title)}`,
      `${inst}/${c.k(c.icon)}`,
      `${inst}/${c.k(c.body)}`,
      `${inst}/${c.k(c.label)}`,
      `${inst}/${c.k(c.photo)}`,
      after,
    ])
    expect(sub.nodes[inst]!.children).toHaveLength(4)
    const virtual = toRenderSubtree(doc, `${inst}/${c.k(c.body)}`)!
    expect(Object.keys(virtual.nodes)).toEqual([
      `${inst}/${c.k(c.body)}`,
      `${inst}/${c.k(c.label)}`,
    ])
  })
})
