import type { LoroDoc, LoroEventBatch, TreeDiffItem } from 'loro-crdt'
import { CONTAINER, NODE_KEY } from './types.ts'

/**
 * Fine-grained change notifications derived from Loro event batches.
 *
 * Structural changes (`created`/`moved`/`deleted`) are listed in the order
 * they happened and can be applied sequentially. Content changes
 * (`styles`/`text`/`props`) are deduplicated per node and listed after the
 * structural ones; they are omitted for nodes created or deleted in the same
 * batch (read the full node with `getNode` on `created`).
 *
 * Deleting a node deletes its subtree; descendants get no separate event.
 */
export type NodeChange =
  | { kind: 'created'; id: string; parentId: string | null; index: number }
  | {
      kind: 'moved'
      id: string
      parentId: string | null
      index: number
      oldParentId: string | null
      oldIndex: number
    }
  | { kind: 'deleted'; id: string; oldParentId: string | null; oldIndex: number }
  /** `keys`: changed style properties (removed ones included). */
  | { kind: 'styles'; id: string; keys: string[] }
  | { kind: 'text'; id: string }
  /** `keys`: changed scalar data keys (`name`, `locked`, `hidden`, `svg`, `assetId`, `background`, `type`, `componentKey`, `nodeKey`, `mainId`). */
  | { kind: 'props'; id: string; keys: string[] }
  /** Instance overrides changed; `paths` are override paths (`''` = the instance root). */
  | { kind: 'overrides'; id: string; paths: string[] }
  /** Vector geometry or fill rule changed. */
  | { kind: 'vector'; id: string }

export type NodeChangeKind = NodeChange['kind']

export interface NodeChangeBatch {
  /** `local` = this doc's own commit, `import` = remote/sync, `checkout` = time travel. */
  by: LoroEventBatch['by']
  /** Commit origin (see `transact`); `undefined` when none was given. */
  origin: string | undefined
  changes: NodeChange[]
  /** Names of tokens that were added, changed or removed. */
  tokens: string[]
  /** True when the doc `meta` map (name, schemaVersion) changed. */
  meta: boolean
  /** Component registry keys that were added or changed. */
  components: string[]
  /** Comment threads that were added, changed or removed. */
  comments: string[]
  /** Versions that were added, renamed or removed. */
  versions: string[]
}

export type NodeChangeListener = (batch: NodeChangeBatch) => void

/** Keys of a node's data map whose changes are reported via their own change kind. */
const CHILD_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  NODE_KEY.styles,
  NODE_KEY.text,
  NODE_KEY.overrides,
  NODE_KEY.vector,
])

function structuralChange(item: TreeDiffItem): NodeChange {
  switch (item.action) {
    case 'create':
      return { kind: 'created', id: item.target, parentId: item.parent ?? null, index: item.index }
    case 'move':
      return {
        kind: 'moved',
        id: item.target,
        parentId: item.parent ?? null,
        index: item.index,
        oldParentId: item.oldParent ?? null,
        oldIndex: item.oldIndex,
      }
    case 'delete':
      return {
        kind: 'deleted',
        id: item.target,
        oldParentId: item.oldParent ?? null,
        oldIndex: item.oldIndex,
      }
  }
}

function addKeys(target: Map<string, Set<string>>, id: string, keys: Iterable<string>): void {
  let set = target.get(id)
  if (!set) {
    set = new Set()
    target.set(id, set)
  }
  for (const k of keys) set.add(k)
}

/** Translate one Loro event batch. Exported for tests and for custom subscribers. */
export function toNodeChangeBatch(batch: LoroEventBatch): NodeChangeBatch {
  const structural: NodeChange[] = []
  const styleKeys = new Map<string, Set<string>>()
  const propKeys = new Map<string, Set<string>>()
  const textIds = new Set<string>()
  const overridePaths = new Map<string, Set<string>>()
  const vectorIds = new Set<string>()
  const tokenNames = new Set<string>()
  const componentKeys = new Set<string>()
  const commentIds = new Set<string>()
  const versionIds = new Set<string>()
  let meta = false

  for (const event of batch.events) {
    const path = event.path
    const root = path[0]
    const diff = event.diff
    if (root === CONTAINER.nodes) {
      if (diff.type === 'tree') {
        for (const item of diff.diff) structural.push(structuralChange(item))
        continue
      }
      const nodeId = path[1]
      if (typeof nodeId !== 'string') continue
      if (path.length === 2 && diff.type === 'map') {
        const keys = Object.keys(diff.updated).filter((k) => !CHILD_CONTAINER_KEYS.has(k))
        if (keys.length > 0) addKeys(propKeys, nodeId, keys)
      } else if (path[2] === NODE_KEY.styles && diff.type === 'map') {
        addKeys(styleKeys, nodeId, Object.keys(diff.updated))
      } else if (path[2] === NODE_KEY.text && diff.type === 'text') {
        textIds.add(nodeId)
      } else if (path[2] === NODE_KEY.overrides) {
        const overridePath = path[3]
        if (path.length === 3) {
          if (diff.type === 'map') addKeys(overridePaths, nodeId, Object.keys(diff.updated))
        } else if (typeof overridePath === 'string') {
          addKeys(overridePaths, nodeId, [overridePath])
        }
      } else if (path[2] === NODE_KEY.vector) {
        vectorIds.add(nodeId)
      }
    } else if (root === CONTAINER.components) {
      if (path.length === 1 && diff.type === 'map') {
        for (const k of Object.keys(diff.updated)) componentKeys.add(k)
      } else if (typeof path[1] === 'string') {
        componentKeys.add(path[1])
      }
    } else if (root === CONTAINER.tokens) {
      if (path.length === 1 && diff.type === 'map') {
        for (const k of Object.keys(diff.updated)) tokenNames.add(k)
      } else if (typeof path[1] === 'string') {
        tokenNames.add(path[1])
      }
    } else if (root === CONTAINER.comments) {
      if (path.length === 1 && diff.type === 'map') {
        for (const k of Object.keys(diff.updated)) commentIds.add(k)
      } else if (typeof path[1] === 'string') {
        commentIds.add(path[1])
      }
    } else if (root === CONTAINER.versions) {
      if (path.length === 1 && diff.type === 'map') {
        for (const k of Object.keys(diff.updated)) versionIds.add(k)
      } else if (typeof path[1] === 'string') {
        versionIds.add(path[1])
      }
    } else if (root === CONTAINER.meta) {
      meta = true
    }
  }

  // Nodes created or deleted in this batch need no content events.
  const skip = new Set<string>()
  for (const c of structural) if (c.kind === 'created' || c.kind === 'deleted') skip.add(c.id)

  const changes: NodeChange[] = structural
  for (const [id, keys] of styleKeys) {
    if (!skip.has(id) && keys.size > 0) changes.push({ kind: 'styles', id, keys: [...keys] })
  }
  for (const id of textIds) if (!skip.has(id)) changes.push({ kind: 'text', id })
  for (const [id, keys] of propKeys) {
    if (!skip.has(id)) changes.push({ kind: 'props', id, keys: [...keys] })
  }
  for (const [id, paths] of overridePaths) {
    if (!skip.has(id) && paths.size > 0) changes.push({ kind: 'overrides', id, paths: [...paths] })
  }
  for (const id of vectorIds) if (!skip.has(id)) changes.push({ kind: 'vector', id })

  return {
    by: batch.by,
    origin: batch.origin || undefined,
    changes,
    tokens: [...tokenNames],
    meta,
    components: [...componentKeys],
    comments: [...commentIds],
    versions: [...versionIds],
  }
}

/**
 * Subscribe to node/token/meta/component/comment changes. Fires after each commit or import
 * (Loro emits events after a microtask). Returns an unsubscribe function.
 */
export function subscribeNodes(doc: LoroDoc, listener: NodeChangeListener): () => void {
  return doc.subscribe((batch) => {
    const out = toNodeChangeBatch(batch)
    if (
      out.changes.length > 0 ||
      out.tokens.length > 0 ||
      out.meta ||
      out.components.length > 0 ||
      out.comments.length > 0 ||
      out.versions.length > 0
    )
      listener(out)
  })
}
