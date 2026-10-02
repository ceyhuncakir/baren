import { LoroMap, LoroText, type LoroDoc, type LoroTree, type LoroTreeNode } from 'loro-crdt'
import { decodeOverrides, decodeVector, isRecord, isStyleValue } from './decode.ts'
import { autoCommit, nodesTree } from './doc.ts'
import { SchemaError, describeLoroError } from './errors.ts'
import {
  cycleAgainst,
  fillNodeKeys,
  instanceKeysIn,
  mainKeysAbove,
  rekeyCollisions,
} from './graph.ts'
import { asTreeId, isTreeId, newNodeKey } from './ids.ts'
import {
  CONTAINER_NODE_TYPES,
  DEFAULT_NODE_NAMES,
  NODE_KEY,
  isNodeType,
  type DesignNode,
  type NodeProps,
  type NodePropsPatch,
  type NodeType,
  type OverrideEntry,
  type StylePatch,
  type StyleValue,
  type Styles,
  type VectorData,
  type VectorPoint,
} from './types.ts'

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** True when `id` names a live (not deleted) node. */
export function hasNode(doc: LoroDoc, id: string): boolean {
  if (!isTreeId(id)) return false
  const tree = nodesTree(doc)
  return tree.has(id) && !tree.isNodeDeleted(id)
}

/** @internal Live node or `SchemaError('node-not-found')`. */
export function requireNode(tree: LoroTree, id: string): LoroTreeNode {
  const tid = asTreeId(id)
  const node = tree.has(tid) && !tree.isNodeDeleted(tid) ? tree.getNodeByID(tid) : undefined
  if (!node) throw new SchemaError('node-not-found', `Node ${id} does not exist`)
  return node
}

/** @internal Decoded type of a tree node (unknown → frame). */
export function nodeTypeOf(node: LoroTreeNode): NodeType {
  const type = node.data.get(NODE_KEY.type)
  return isNodeType(type) ? type : 'frame'
}

export function getNodeType(doc: LoroDoc, id: string): NodeType {
  return nodeTypeOf(requireNode(nodesTree(doc), id))
}

export function getParentId(doc: LoroDoc, id: string): string | null {
  return requireNode(nodesTree(doc), id).parent()?.id ?? null
}

/** Ordered child ids of `parentId`, or the page ids when `parentId` is `null`. */
export function getChildIds(doc: LoroDoc, parentId: string | null): string[] {
  const tree = nodesTree(doc)
  if (parentId === null) return tree.roots().map((n) => n.id)
  return (requireNode(tree, parentId).children() ?? []).map((n) => n.id)
}

/** Read one node. Cheaper than `toSnapshot` for incremental updates. */
export function getNode(doc: LoroDoc, id: string): DesignNode | undefined {
  const tree = nodesTree(doc)
  const tid = asTreeId(id)
  if (!tree.has(tid) || tree.isNodeDeleted(tid)) return undefined
  const node = tree.getNodeByID(tid)
  if (!node) return undefined
  const children = (node.children() ?? []).map((c) => c.id)
  return decodeNode(id, node.parent()?.id ?? null, children, node.data.toJSON() as unknown)
}

/** Known type, or `frame` (a `switch` is measurably cheaper than a list scan on 50k nodes). */
function decodeType(v: unknown): NodeType {
  switch (v) {
    case 'page':
    case 'frame':
    case 'text':
    case 'rect':
    case 'svg':
    case 'image':
    case 'group':
    case 'vector':
    case 'instance':
      return v
    default:
      return 'frame'
  }
}

/**
 * Turn a node's data-map JSON (as produced by Loro `toJSON`) into a `DesignNode`.
 * Unknown/missing types decode as `frame`; non-scalar style values are dropped.
 */
export function decodeNode(
  id: string,
  parentId: string | null,
  children: string[],
  data: unknown,
): DesignNode {
  // Hot path (50k nodes per toSnapshot): keys are literal copies of NODE_KEY — reading them
  // through the constant object measurably slows decoding.
  const d = isRecord(data) ? data : {}
  const type = decodeType(d['type'])
  const styles: Styles = {}
  const rawStyles = d['styles']
  if (isRecord(rawStyles)) {
    for (const key in rawStyles) {
      const v = rawStyles[key]
      if (isStyleValue(v)) styles[key] = v
    }
  }
  const name = d['name']
  const node: DesignNode = {
    id,
    type,
    name: typeof name === 'string' ? name : '',
    parentId,
    children,
    styles,
  }
  const text = d['text']
  if (type === 'text') node.text = typeof text === 'string' ? text : ''
  const svg = d['svg']
  if (typeof svg === 'string') node.svg = svg
  const assetId = d['assetId']
  if (typeof assetId === 'string') node.assetId = assetId
  const assetName = d['assetName']
  if (typeof assetName === 'string') node.assetName = assetName
  const locked = d['locked']
  if (typeof locked === 'boolean') node.locked = locked
  const hidden = d['hidden']
  if (typeof hidden === 'boolean') node.hidden = hidden
  const background = d['background']
  if (typeof background === 'string') node.background = background
  // Phase 3 keys (contract §2.2), in DesignNode field order.
  if (type === 'frame' || type === 'instance') {
    const componentKey = d['componentKey']
    if (typeof componentKey === 'string') node.componentKey = componentKey
  }
  const nodeKey = d['nodeKey']
  if (typeof nodeKey === 'string') node.nodeKey = nodeKey
  if (type === 'instance') {
    const mainId = d['mainId']
    if (typeof mainId === 'string') node.mainId = mainId
    const overrides = decodeOverrides(d['overrides'])
    if (overrides) node.overrides = overrides
  } else if (type === 'vector') {
    const vector = decodeVector(d['vector'])
    if (vector) node.vector = vector
  }
  return node
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export interface CreateNodeInput extends NodeProps {
  type: NodeType
  /** `null` creates a root, which only pages may be. */
  parentId: string | null
  /** Position among the new siblings; clamped. Default: append. */
  index?: number
  styles?: Styles
  /** Initial content (text nodes only). */
  text?: string
  /** Instances only. */
  overrides?: Record<string, OverrideEntry>
  /** Vectors only. */
  vector?: VectorData
}

export interface CreateNodeOptions {
  /** Random source for generated node keys (deterministic fixtures). */
  random?: () => number
}

function validateCreateInput(input: CreateNodeInput): void {
  if (input.vector !== undefined && input.type !== 'vector') {
    throw new SchemaError('invalid-type', `Only vector nodes have vector data (got ${input.type})`)
  }
  if (input.overrides !== undefined && input.type !== 'instance') {
    throw new SchemaError('invalid-type', `Only instances have overrides (got ${input.type})`)
  }
  if (input.type === 'instance' && typeof input.componentKey !== 'string') {
    throw new SchemaError('invalid-type', 'An instance needs a componentKey')
  }
  if (input.componentKey !== undefined && input.type !== 'frame' && input.type !== 'instance') {
    throw new SchemaError('invalid-type', `Only frames and instances have a componentKey`)
  }
}

function assertParentAllowed(tree: LoroTree, type: NodeType, parentId: string | null): void {
  if (type === 'page') {
    if (parentId !== null) throw new SchemaError('invalid-parent', 'Pages must be root nodes')
    return
  }
  if (parentId === null) {
    throw new SchemaError('invalid-parent', `A ${type} node needs a parent page or frame`)
  }
  const parentType = nodeTypeOf(requireNode(tree, parentId))
  if (!CONTAINER_NODE_TYPES.has(parentType)) {
    throw new SchemaError('invalid-parent', `A ${parentType} node cannot contain children`)
  }
}

/** @internal */
export function clampIndex(index: number | undefined, max: number): number {
  if (index === undefined || !Number.isFinite(index)) return max
  return Math.min(Math.max(0, Math.trunc(index)), max)
}

function childCount(tree: LoroTree, parentId: string | null): number {
  if (parentId === null) return tree.roots().length
  return requireNode(tree, parentId).children()?.length ?? 0
}

/**
 * Create a node and return its id. Inside a main component's subtree the node gets a fresh
 * `nodeKey` when it has none; an instance that would make a main contain itself throws
 * `SchemaError('cycle')`.
 */
export function createNode(
  doc: LoroDoc,
  input: CreateNodeInput,
  options: CreateNodeOptions = {},
): string {
  if (!isNodeType(input.type)) {
    throw new SchemaError('invalid-type', `Unknown node type ${JSON.stringify(input.type)}`)
  }
  if (input.text !== undefined && input.type !== 'text') {
    throw new SchemaError('invalid-type', `Only text nodes have text content (got ${input.type})`)
  }
  validateCreateInput(input)
  for (const key in input.styles) {
    const v = input.styles[key]
    if (v !== undefined && !isStyleValue(v)) {
      throw new SchemaError('invalid-type', `Style ${key} must be a string or finite number`)
    }
  }
  const tree = nodesTree(doc)
  assertParentAllowed(tree, input.type, input.parentId)
  const above = mainKeysAbove(doc, input.parentId)
  if (
    input.type === 'instance' &&
    above.length > 0 &&
    cycleAgainst(doc, [input.componentKey as string], above)
  ) {
    throw new SchemaError('cycle', 'An instance of a component cannot be placed inside itself')
  }
  // Appending needs no index: counting the children lists all of them (Loro has no child
  // count), which made creating N children of one parent O(N²).
  const index =
    input.index === undefined || !Number.isFinite(input.index)
      ? undefined
      : clampIndex(input.index, childCount(tree, input.parentId))
  const parent = input.parentId === null ? undefined : asTreeId(input.parentId)
  let node: LoroTreeNode
  try {
    node = tree.createNode(parent, index)
  } catch (err) {
    throw new SchemaError('loro', `createNode failed: ${describeLoroError(err)}`, { cause: err })
  }
  const data =
    above.length > 0 && input.nodeKey === undefined
      ? { ...input, nodeKey: newNodeKey(options.random) }
      : input
  writeNodeData(node.data, data)
  autoCommit(doc)
  return node.id
}

/** Fast path shared with the bench generator: no validation, no commit. */
export function writeNodeData(
  data: LoroMap,
  input: Omit<CreateNodeInput, 'parentId' | 'index'>,
): void {
  data.set(NODE_KEY.type, input.type)
  data.set(NODE_KEY.name, input.name ?? DEFAULT_NODE_NAMES[input.type])
  const styles = data.ensureMergeableMap(NODE_KEY.styles)
  if (input.styles) {
    for (const key in input.styles) {
      const v = input.styles[key]
      if (v !== undefined) styles.set(key, v)
    }
  }
  if (input.type === 'text') {
    const text = data.ensureMergeableText(NODE_KEY.text)
    if (input.text) text.insert(0, input.text)
  }
  if (input.svg !== undefined) data.set(NODE_KEY.svg, input.svg)
  if (input.assetId !== undefined) data.set(NODE_KEY.assetId, input.assetId)
  if (input.assetName !== undefined) data.set(NODE_KEY.assetName, input.assetName)
  if (input.locked !== undefined) data.set(NODE_KEY.locked, input.locked)
  if (input.hidden !== undefined) data.set(NODE_KEY.hidden, input.hidden)
  if (input.background !== undefined) data.set(NODE_KEY.background, input.background)
  if (input.componentKey !== undefined) data.set(NODE_KEY.componentKey, input.componentKey)
  if (input.nodeKey !== undefined) data.set(NODE_KEY.nodeKey, input.nodeKey)
  if (input.mainId !== undefined) data.set(NODE_KEY.mainId, input.mainId)
  if (input.type === 'instance') {
    writeOverrides(data.ensureMergeableMap(NODE_KEY.overrides), input.overrides ?? {})
  }
  if (input.type === 'vector') {
    writeVectorData(data.ensureMergeableMap(NODE_KEY.vector), input.vector)
  }
}

/** Plain Loro value of a vector point (no `undefined` fields). */
export function pointValue(p: VectorPoint): Record<string, unknown> {
  const out: Record<string, unknown> = { x: p.x, y: p.y }
  if (p.in) out['in'] = [p.in[0], p.in[1]]
  if (p.out) out['out'] = [p.out[0], p.out[1]]
  if (p.mode !== undefined && p.mode !== 'corner') out['mode'] = p.mode
  return out
}

/** Write a fresh vector map (creation only; edits go through `setVector`). */
export function writeVectorData(map: LoroMap, vector: VectorData | undefined): void {
  if (!vector) {
    map.ensureMergeableMap('subpaths')
    return
  }
  if (vector.fillRule === 'evenodd') map.set('fillRule', 'evenodd')
  const subpaths = map.ensureMergeableMap('subpaths')
  vector.subpaths.forEach((sp, order) => {
    const entry = subpaths.ensureMergeableMap(sp.id)
    entry.set('closed', sp.closed)
    entry.set('order', order)
    const points = entry.ensureMergeableMovableList('points')
    sp.points.forEach((p, i) => points.insert(i, pointValue(p)))
  })
}

/** Write override entries into an instance's (mergeable) overrides map. */
export function writeOverrides(map: LoroMap, overrides: Record<string, OverrideEntry>): void {
  for (const path in overrides) {
    const entry = overrides[path]
    if (!entry) continue
    const target = map.ensureMergeableMap(path)
    if (entry.styles) {
      const styles = target.ensureMergeableMap('styles')
      for (const key in entry.styles) {
        const v = entry.styles[key]
        if (v === null || isStyleValue(v)) styles.set(key, v)
      }
    }
    if (entry.text !== undefined) target.set('text', entry.text)
    if (entry.hidden !== undefined) target.set('hidden', entry.hidden)
    if (entry.assetId !== undefined) target.set('assetId', entry.assetId)
    if (entry.assetName !== undefined) target.set('assetName', entry.assetName)
  }
}

/**
 * Move `id` under `parentId` (null = root, pages only). `index` is the node's
 * final position among its new siblings (clamped); omitted = append.
 * Moving a node into its own subtree throws; so does a move that would make a main
 * component contain an instance of itself (`SchemaError('cycle')`). Nodes moved into a
 * main's subtree get node keys where they have none (existing keys are kept).
 */
export function moveNode(doc: LoroDoc, id: string, parentId: string | null, index?: number): void {
  const tree = nodesTree(doc)
  const node = requireNode(tree, id)
  assertParentAllowed(tree, nodeTypeOf(node), parentId)
  const above = mainKeysAbove(doc, parentId)
  if (above.length > 0 && cycleAgainst(doc, instanceKeysIn(doc, [id]), above)) {
    throw new SchemaError('cycle', 'A component cannot contain an instance of itself')
  }
  const currentParent = node.parent()?.id ?? null
  const sameParent = currentParent === parentId
  const max = childCount(tree, parentId) - (sameParent ? 1 : 0)
  const target = clampIndex(index, max)
  if (sameParent && node.index() === target) return
  try {
    tree.move(node.id, parentId === null ? undefined : asTreeId(parentId), target)
  } catch (err) {
    throw new SchemaError('invalid-parent', `Cannot move ${id}: ${describeLoroError(err)}`, {
      cause: err,
    })
  }
  if (above.length > 0) {
    fillNodeKeys(doc, [id])
    if (!sameParent) rekeyCollisions(doc, id)
  }
  autoCommit(doc)
}

/** Delete a node and its whole subtree. Descendants get no separate events. */
export function deleteNode(doc: LoroDoc, id: string): void {
  const tree = nodesTree(doc)
  const node = requireNode(tree, id)
  tree.delete(node.id)
  autoCommit(doc)
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** @internal */
export function stylesMapOf(node: LoroTreeNode): LoroMap {
  const existing = node.data.get(NODE_KEY.styles)
  return existing instanceof LoroMap ? existing : node.data.ensureMergeableMap(NODE_KEY.styles)
}

/** @internal Set or delete one key; unchanged values write no op. */
export function applyStyle(styles: LoroMap, key: string, value: StyleValue | null): void {
  if (value === null) {
    if (styles.get(key) !== undefined) styles.delete(key)
    return
  }
  if (!isStyleValue(value)) {
    throw new SchemaError('invalid-type', `Style ${key} must be a string or finite number`)
  }
  if (styles.get(key) !== value) styles.set(key, value)
}

/** Set one style property (`null` removes it). Unchanged values produce no op. */
export function setStyle(doc: LoroDoc, id: string, key: string, value: StyleValue | null): void {
  applyStyle(stylesMapOf(requireNode(nodesTree(doc), id)), key, value)
  autoCommit(doc)
}

/** Patch several style properties at once (`null` removes). */
export function setStyles(doc: LoroDoc, id: string, patch: StylePatch): void {
  const styles = stylesMapOf(requireNode(nodesTree(doc), id))
  for (const key in patch) {
    const v = patch[key]
    if (v !== undefined) applyStyle(styles, key, v)
  }
  autoCommit(doc)
}

/** Replace a text node's content; applied as a minimal diff so concurrent edits merge. */
export function setText(doc: LoroDoc, id: string, text: string): void {
  const node = requireNode(nodesTree(doc), id)
  const type = nodeTypeOf(node)
  if (type !== 'text') throw new SchemaError('invalid-type', `Node ${id} is a ${type}, not text`)
  const existing = node.data.get(NODE_KEY.text)
  const container =
    existing instanceof LoroText ? existing : node.data.ensureMergeableText(NODE_KEY.text)
  if (container.toString() !== text) container.update(text)
  autoCommit(doc)
}

const PROP_TYPES: Record<keyof NodeProps, 'string' | 'boolean'> = {
  name: 'string',
  svg: 'string',
  assetId: 'string',
  assetName: 'string',
  locked: 'boolean',
  hidden: 'boolean',
  background: 'string',
  componentKey: 'string',
  nodeKey: 'string',
  mainId: 'string',
}

/**
 * Patch scalar node props (name, locked, hidden, svg, assetId, assetName, background,
 * componentKey, nodeKey, mainId). The component registry is not touched: use the component
 * helpers to create or restore mains.
 */
export function setNodeProps(doc: LoroDoc, id: string, patch: NodePropsPatch): void {
  const data = requireNode(nodesTree(doc), id).data
  for (const key of Object.keys(patch) as (keyof NodeProps)[]) {
    const expected = PROP_TYPES[key]
    if (expected === undefined) continue
    const value = patch[key]
    if (value === undefined) continue
    if (value === null) {
      if (key === 'name') data.set(NODE_KEY.name, '')
      else if (data.get(key) !== undefined) data.delete(key)
      continue
    }
    if (typeof value !== expected) {
      throw new SchemaError('invalid-type', `Prop ${key} must be a ${expected}`)
    }
    if (data.get(key) !== value) data.set(key, value)
  }
  autoCommit(doc)
}
