/**
 * Reusable components (contract §2.7, §4.6): a main component is a `frame` with a
 * `componentKey`; instances are tree leaves resolved at render time (`resolve.ts`). The root
 * map `components` is the registry `componentKey → { mainId }`.
 */
import { LoroMap, type LoroDoc, type LoroTreeNode } from 'loro-crdt'
import { isRecord } from './decode.ts'
import { nodesTree } from './doc.ts'
import { SchemaError } from './errors.ts'
import { docGeometry } from './geometry.ts'
import {
  anyNode,
  componentsMap,
  fillNodeKeys,
  findMainComponent as findMain,
  isInsideMain,
  rawSubtree,
  writeRegistry,
} from './graph.ts'
import { ensureContainingBlock, fitGroups, wrapInFrame } from './groups.ts'
import { isNodeKey, isTreeId, newComponentKey, newNodeKey } from './ids.ts'
import {
  createNode,
  decodeNode,
  getNode,
  nodeTypeOf,
  requireNode,
  type CreateNodeInput,
} from './nodes.ts'
import { topmostRefs } from './refs.ts'
import { createComponentResolver, type ExpandedInstance, type ResolvedNode } from './resolve.ts'
import {
  COMPONENTS_PAGE_NAME,
  DEFAULT_PAGE_BACKGROUND,
  NODE_KEY,
  PLACEMENT_KEYS,
  isInstanceOwnKey,
  type DesignNode,
  type GeometrySource,
  type OverrideEntry,
  type OverrideStyles,
  type Styles,
} from './types.ts'
import { run, toPx } from './util.ts'

export {
  componentDependencies,
  wouldCreateCycle,
  wouldCreateCycleForKeys,
  type FoundMain,
} from './graph.ts'

export interface ComponentInfo {
  key: string
  mainId: string
  name: string
  pageId: string
}

/**
 * Deterministic main lookup (§2.7.4). `hint` is an instance's `mainId`, used to find the
 * retained data of a deleted main that the registry no longer points at.
 */
export function findMainComponent(
  doc: LoroDoc,
  key: string,
  hint?: string,
): { mainId: string; deleted: boolean } | null {
  return findMain(doc, key, hint)
}

function pageOf(doc: LoroDoc, id: string): string {
  let cur = getNode(doc, id)
  while (cur && cur.parentId !== null) cur = getNode(doc, cur.parentId)
  return cur?.id ?? ''
}

/** Live mains from the registry, sorted by name, then key. */
export function listComponents(doc: LoroDoc): ComponentInfo[] {
  const out: ComponentInfo[] = []
  const seen = new Set<string>()
  for (const key of componentsMap(doc).keys()) {
    const found = findMain(doc, key)
    if (!found || found.deleted || seen.has(found.mainId)) continue
    seen.add(found.mainId)
    const node = getNode(doc, found.mainId)
    if (!node) continue
    out.push({ key, mainId: found.mainId, name: node.name, pageId: pageOf(doc, found.mainId) })
  }
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

/** True for a live frame carrying a `componentKey`. */
export function isMainComponent(doc: LoroDoc, id: string): boolean {
  const node = isTreeId(id) ? getNode(doc, id) : undefined
  return node?.type === 'frame' && typeof node.componentKey === 'string'
}

/**
 * Re-key nodes whose `nodeKey` repeats another one in the main's subtree, except inside
 * nested mains (their keys address their own instances' overrides): keys used inside nested
 * mains are reserved first, then other nodes keep the first occurrence (document order).
 */
function dedupeNodeKeys(doc: LoroDoc, mainId: string, random?: () => number): void {
  const tree = nodesTree(doc)
  const walk = (visit: (node: LoroTreeNode, inNested: boolean) => void): void => {
    const stack: { id: string; inNested: boolean; root: boolean }[] = [
      { id: mainId, inNested: false, root: true },
    ]
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      const node = isTreeId(item.id) ? tree.getNodeByID(item.id) : undefined
      if (!node) continue
      const isNestedMain =
        !item.root &&
        typeof node.data.get(NODE_KEY.componentKey) === 'string' &&
        nodeTypeOf(node) === 'frame'
      const inNested = item.inNested || isNestedMain
      if (!item.root) visit(node, inNested)
      const children = node.children() ?? []
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ id: (children[i] as { id: string }).id, inNested, root: false })
      }
    }
  }
  const used = new Set<string>()
  walk((node, inNested) => {
    const key = node.data.get(NODE_KEY.nodeKey)
    if (inNested && typeof key === 'string' && isNodeKey(key)) used.add(key)
  })
  walk((node, inNested) => {
    if (inNested) return
    const key = node.data.get(NODE_KEY.nodeKey)
    if (typeof key !== 'string' || !isNodeKey(key)) return
    if (!used.has(key)) {
      used.add(key)
      return
    }
    let fresh = newNodeKey(random)
    while (used.has(fresh)) fresh = newNodeKey(random)
    node.data.set(NODE_KEY.nodeKey, fresh)
    used.add(fresh)
  })
}

/** Make `mainId` (a frame) a main with a fresh key: node keys, registry. */
export function convertToMain(doc: LoroDoc, mainId: string, random?: () => number): string {
  const node = requireNode(nodesTree(doc), mainId)
  const existing = node.data.get(NODE_KEY.componentKey)
  if (typeof existing === 'string') {
    writeRegistry(doc, existing, mainId)
    return existing
  }
  const key = newComponentKey(random)
  node.data.set(NODE_KEY.componentKey, key)
  fillNodeKeys(doc, [mainId], { includeRoots: false, ...(random ? { random } : {}) })
  dedupeNodeKeys(doc, mainId, random)
  writeRegistry(doc, key, mainId)
  return key
}

/**
 * Create a component from the selection: a single selected frame is converted in place,
 * anything else is wrapped in a new frame first (wrap-in-frame rules). Returns the main id.
 */
export function createComponent(
  doc: LoroDoc,
  ids: readonly string[],
  geo: GeometrySource,
  opts: { name?: string; origin?: string; random?: () => number } = {},
): string | null {
  return run(doc, opts.origin ?? 'editor:component', () => {
    const resolver = createComponentResolver(doc)
    const top = topmostRefs(doc, ids, resolver, { virtual: false })
    const first = top[0]
    if (first === undefined) return null
    let mainId: string | null
    if (top.length === 1 && getNode(doc, first)?.type === 'frame') {
      mainId = first
      if (opts.name !== undefined)
        requireNode(nodesTree(doc), first).data.set(NODE_KEY.name, opts.name)
    } else {
      mainId = wrapInFrame(doc, top, geo, { name: opts.name ?? 'Component' })
    }
    if (mainId === null) return null
    convertToMain(doc, mainId, opts.random)
    return mainId
  })
}

/** Insert an instance. `styles` keeps own keys only; the cycle check throws `'cycle'`. */
export function createInstance(
  doc: LoroDoc,
  input: {
    componentKey: string
    parentId: string
    index?: number
    styles?: Styles
    name?: string
  },
  opts: { origin?: string; random?: () => number } = {},
): string {
  return run(doc, opts.origin ?? 'editor:insert', () => {
    const found = findMain(doc, input.componentKey)
    if (!found) {
      throw new SchemaError('invalid-ref', `No main component with key ${input.componentKey}`)
    }
    const styles: Styles = {}
    for (const key in input.styles) {
      if (isInstanceOwnKey(key)) styles[key] = input.styles[key] as Styles[string]
    }
    const id = createNode(
      doc,
      {
        type: 'instance',
        parentId: input.parentId,
        ...(input.index !== undefined ? { index: input.index } : {}),
        name: input.name ?? '',
        componentKey: input.componentKey,
        mainId: found.mainId,
        styles,
      },
      opts.random ? { random: opts.random } : {},
    )
    if (styles['position'] === 'absolute') ensureContainingBlock(doc, input.parentId)
    fitGroups(doc, [id], docGeometry(doc))
    return id
  })
}

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

function mergeStyles(
  base: OverrideStyles | undefined,
  top: OverrideStyles | undefined,
): OverrideStyles | undefined {
  if (!base && !top) return undefined
  return { ...base, ...top }
}

/** Outer entry applied over an inner one (outer wins field by field). */
function mergeEntries(
  inner: OverrideEntry | undefined,
  outer: OverrideEntry | undefined,
): OverrideEntry | undefined {
  if (!inner) return outer
  if (!outer) return inner
  const out: OverrideEntry = {}
  const styles = mergeStyles(inner.styles, outer.styles)
  if (styles) out.styles = styles
  const text = outer.text ?? inner.text
  if (text !== undefined) out.text = text
  const hidden = outer.hidden ?? inner.hidden
  if (hidden !== undefined) out.hidden = hidden
  const assetId = outer.assetId ?? inner.assetId
  if (assetId !== undefined) out.assetId = assetId
  const assetName = outer.assetName ?? inner.assetName
  if (assetName !== undefined) out.assetName = assetName
  return out
}

/** Stored data of a main node (live or retained). */
function storedNode(doc: LoroDoc, id: string): DesignNode | undefined {
  const node = anyNode(nodesTree(doc), id)
  if (!node) return undefined
  return decodeNode(id, null, [], node.data.toJSON() as unknown)
}

/**
 * A nested instance of an expansion (`node`, at any depth) as a standalone instance: its stored
 * own styles and overrides, with the overrides of every enclosing instance level rebased on top
 * (innermost first, the outermost instance — whose overrides are `outer` — last). `nodes` is the
 * outer instance's full expansion (to find the intermediate nested instances).
 */
export function rebaseNestedInstance(
  doc: LoroDoc,
  node: ResolvedNode,
  outer: Record<string, OverrideEntry> | undefined,
  nodes: Record<string, ResolvedNode>,
): Omit<CreateNodeInput, 'parentId'> | null {
  const source = node.source
  const stored = source ? storedNode(doc, source.mainNodeId) : undefined
  if (!source || !stored || stored.type !== 'instance' || !stored.componentKey) return null
  const segments = source.path.split('/')
  const styles: Styles = { ...stored.styles }
  const overrides: Record<string, OverrideEntry> = {}
  for (const [p, e] of Object.entries(stored.overrides ?? {})) overrides[p] = e
  let hidden = stored.hidden
  // Level k: the instance at segments[0..k) (k = 0: the outer instance itself).
  for (let k = segments.length - 1; k >= 0; k--) {
    let levelOverrides: Record<string, OverrideEntry> | undefined
    if (k === 0) levelOverrides = outer
    else {
      const levelNode = nodes[`${source.instanceId}/${segments.slice(0, k).join('/')}`]
      const levelStored = levelNode?.source
        ? storedNode(doc, levelNode.source.mainNodeId)
        : undefined
      levelOverrides = levelStored?.overrides
    }
    if (!levelOverrides) continue
    const prefix = segments.slice(k).join('/')
    const root = levelOverrides[prefix]
    if (root) {
      const rest: OverrideStyles = {}
      let hasRest = false
      for (const [key, v] of Object.entries(root.styles ?? {})) {
        if (isInstanceOwnKey(key)) {
          if (v === null) delete styles[key]
          else styles[key] = v
        } else {
          rest[key] = v
          hasRest = true
        }
      }
      if (hasRest) overrides[''] = mergeEntries(overrides[''], { styles: rest }) ?? {}
      if (root.hidden !== undefined) hidden = root.hidden
    }
    for (const [p, e] of Object.entries(levelOverrides)) {
      if (!p.startsWith(`${prefix}/`)) continue
      const rel = p.slice(prefix.length + 1)
      const merged = mergeEntries(overrides[rel], e)
      if (merged) overrides[rel] = merged
    }
  }
  const out: Omit<CreateNodeInput, 'parentId'> = {
    type: 'instance',
    name: stored.name,
    componentKey: stored.componentKey,
    styles,
    overrides,
  }
  if (stored.mainId !== undefined) out.mainId = stored.mainId
  if (hidden !== undefined) out.hidden = hidden
  if (stored.locked !== undefined) out.locked = stored.locked
  if (stored.nodeKey !== undefined) out.nodeKey = stored.nodeKey
  return out
}

/** Create real nodes for the expanded children of `ref` under `parentId`. */
function materialise(
  doc: LoroDoc,
  exp: ExpandedInstance,
  ref: string,
  parentId: string,
  outer: Record<string, OverrideEntry> | undefined,
  keepKeys: boolean,
  created: string[] = [],
): string[] {
  const n = exp.nodes[ref]
  if (!n) return created
  for (const childRef of n.children) {
    const c = exp.nodes[childRef]
    if (!c) continue
    if (c.type === 'instance') {
      const input = rebaseNestedInstance(doc, c, outer, exp.nodes)
      if (!input) continue
      if (!keepKeys) delete input.nodeKey
      created.push(createNode(doc, { ...input, parentId }))
      continue
    }
    const input: CreateNodeInput = { type: c.type, parentId, name: c.name, styles: { ...c.styles } }
    if (c.type === 'text') input.text = c.text ?? ''
    if (c.svg !== undefined) input.svg = c.svg
    if (c.assetId !== undefined) input.assetId = c.assetId
    if (c.assetName !== undefined) input.assetName = c.assetName
    if (c.locked !== undefined) input.locked = c.locked
    if (c.hidden !== undefined) input.hidden = c.hidden
    if (c.vector !== undefined) input.vector = c.vector
    if (keepKeys && c.nodeKey !== undefined) input.nodeKey = c.nodeKey
    const id = createNode(doc, input)
    created.push(id)
    materialise(doc, exp, childRef, id, outer, keepKeys, created)
  }
  return created
}

/**
 * Detach one level: the instance becomes a frame with real children (resolved, overrides
 * baked in); nested instances stay instances with their overrides rebased. The TreeID is kept.
 */
export function detachInstance(
  doc: LoroDoc,
  instanceId: string,
  opts: { origin?: string } = {},
): string {
  return run(doc, opts.origin ?? 'editor:detach', () => {
    const inst = isTreeId(instanceId) ? getNode(doc, instanceId) : undefined
    if (!inst || inst.type !== 'instance') {
      throw new SchemaError('invalid-ref', `Node ${instanceId} is not an instance`)
    }
    const exp = createComponentResolver(doc).expandInstance(instanceId)
    const root = exp?.nodes[instanceId]
    if (!exp || !root) throw new SchemaError('invalid-ref', `Cannot resolve ${instanceId}`)
    const keepKeys = !isInsideMain(doc, inst.parentId)
    const data = requireNode(nodesTree(doc), instanceId).data
    const overrides = data.get(NODE_KEY.overrides)
    if (overrides instanceof LoroMap) {
      for (const path of overrides.keys()) {
        const entry = overrides.get(path)
        if (!(entry instanceof LoroMap)) continue
        const styles = entry.get('styles')
        if (styles instanceof LoroMap) for (const k of styles.keys()) styles.delete(k)
        for (const k of entry.keys()) if (k !== 'styles') entry.delete(k)
      }
      data.delete(NODE_KEY.overrides)
    }
    data.set(NODE_KEY.type, 'frame')
    if (data.get(NODE_KEY.componentKey) !== undefined) data.delete(NODE_KEY.componentKey)
    if (data.get(NODE_KEY.mainId) !== undefined) data.delete(NODE_KEY.mainId)
    if (inst.name === '') data.set(NODE_KEY.name, root.name)
    const styles = data.get(NODE_KEY.styles)
    const target = styles instanceof LoroMap ? styles : data.ensureMergeableMap(NODE_KEY.styles)
    if (root.status === 'ok') {
      for (const [k, v] of Object.entries(root.styles)) if (target.get(k) !== v) target.set(k, v)
    }
    if (exp.status === 'ok') {
      const created = materialise(doc, exp, instanceId, instanceId, inst.overrides, keepKeys)
      // Groups now real: overrides may have moved, resized or rotated their children (a
      // virtual group box cannot follow them), so refit them like any local geometry edit.
      fitGroups(doc, created, docGeometry(doc))
    }
    return instanceId
  })
}

// ---------------------------------------------------------------------------
// Components page and restore
// ---------------------------------------------------------------------------

/** The page named "Components" (created at the end of the pages when missing). */
export function ensureComponentsPage(doc: LoroDoc): string {
  for (const root of nodesTree(doc).roots()) {
    if (
      root.data.get(NODE_KEY.type) === 'page' &&
      root.data.get(NODE_KEY.name) === COMPONENTS_PAGE_NAME
    ) {
      return root.id
    }
  }
  return createNode(doc, {
    type: 'page',
    parentId: null,
    name: COMPONENTS_PAGE_NAME,
    background: DEFAULT_PAGE_BACKGROUND,
  })
}

/** Top-left for a new top-level artboard right of a page's content (gap 80, top-aligned). */
export function nextArtboardSlot(doc: LoroDoc, pageId: string): { left: number; top: number } {
  const page = getNode(doc, pageId)
  if (!page || page.children.length === 0) return { left: 0, top: 0 }
  let right = -Infinity
  let firstTop: number | null = null
  for (const id of page.children) {
    const n = getNode(doc, id)
    if (!n) continue
    const left = toPx(n.styles['left']) ?? 0
    const w = toPx(n.styles['width']) ?? 0
    right = Math.max(right, left + w)
    firstTop ??= toPx(n.styles['top']) ?? 0
  }
  return { left: right === -Infinity ? 0 : right + 80, top: firstTop ?? 0 }
}

interface RawNode {
  id: string
  meta: unknown
  children: unknown[]
}

function asRaw(v: unknown): RawNode | null {
  if (!isRecord(v) || typeof v['id'] !== 'string') return null
  return {
    id: v['id'],
    meta: v['meta'],
    children: Array.isArray(v['children']) ? v['children'] : [],
  }
}

/** Copy raw (possibly retained) subtree data under `parentId`, keeping keys and overrides. */
function copyRaw(doc: LoroDoc, raw: RawNode, parentId: string, rootStyles?: Styles): string {
  const d = decodeNode(raw.id, null, [], raw.meta)
  const input: CreateNodeInput = {
    type: d.type === 'page' ? 'frame' : d.type,
    parentId,
    name: d.name,
    styles: rootStyles ?? d.styles,
  }
  if (d.type === 'text') input.text = d.text ?? ''
  if (d.svg !== undefined) input.svg = d.svg
  if (d.assetId !== undefined) input.assetId = d.assetId
  if (d.assetName !== undefined) input.assetName = d.assetName
  if (d.locked !== undefined) input.locked = d.locked
  if (d.hidden !== undefined) input.hidden = d.hidden
  if (d.componentKey !== undefined) input.componentKey = d.componentKey
  if (d.nodeKey !== undefined && !rootStyles) input.nodeKey = d.nodeKey
  if (d.mainId !== undefined) input.mainId = d.mainId
  if (d.overrides !== undefined) input.overrides = d.overrides
  if (d.vector !== undefined) input.vector = d.vector
  const id = createNode(doc, input)
  if (input.type !== 'instance') {
    for (const c of raw.children) {
      const child = asRaw(c)
      if (child) copyRaw(doc, child, id)
    }
  }
  return id
}

function instanceHints(doc: LoroDoc, key: string): string[] {
  const out: string[] = []
  for (const node of nodesTree(doc).getNodes({ withDeleted: false })) {
    if (node.data.get(NODE_KEY.type) !== 'instance') continue
    if (node.data.get(NODE_KEY.componentKey) !== key) continue
    const hint = node.data.get(NODE_KEY.mainId)
    if (typeof hint === 'string' && !out.includes(hint)) out.push(hint)
  }
  return out
}

/**
 * Re-create a deleted main from its retained data (same key, same node keys) as a top-level
 * artboard on the "Components" page, and point the registry at it. A live main is returned
 * as is; null when nothing with that key can be found.
 */
export function restoreMainComponent(
  doc: LoroDoc,
  key: string,
  opts: { origin?: string } = {},
): string | null {
  return run(doc, opts.origin ?? 'editor:component', () => {
    let found = findMain(doc, key)
    if (!found) {
      for (const hint of instanceHints(doc, key)) {
        found = findMain(doc, key, hint)
        if (found) break
      }
    }
    if (!found) return null
    if (!found.deleted) return found.mainId
    const raw = asRaw(rawSubtree(doc, found.mainId))
    if (!raw) return null
    const main = decodeNode(raw.id, null, [], raw.meta)
    const pageId = ensureComponentsPage(doc)
    const slot = nextArtboardSlot(doc, pageId)
    const styles: Styles = {}
    for (const [k, v] of Object.entries(main.styles)) {
      if (PLACEMENT_KEYS.has(k) && k !== 'rotate') continue
      styles[k] = v
    }
    styles['left'] = slot.left
    styles['top'] = slot.top
    if (toPx(styles['width']) === null) styles['width'] = 100
    if (toPx(styles['height']) === null) styles['height'] = 100
    const id = copyRaw(doc, raw, pageId, styles)
    writeRegistry(doc, key, id)
    return id
  })
}
