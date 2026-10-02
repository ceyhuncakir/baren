import type { LoroDoc } from 'loro-crdt'
import { nodesTree } from './doc.ts'
import { asTreeId } from './ids.ts'
import { decodeNode, hasNode } from './nodes.ts'
import { decodeToken } from './tokens.ts'
import { CONTAINER, type DesignNode, type DocSnapshot, type Token } from './types.ts'

interface RawTreeNode {
  id: string
  meta: unknown
  children: RawTreeNode[]
}

function isRawTreeNode(v: unknown): v is RawTreeNode {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r['id'] === 'string' && Array.isArray(r['children'])
}

/** Iterative DFS over Loro tree JSON (documents can be deep; avoid recursion limits). */
function collectNodes(
  roots: readonly unknown[],
  parentId: string | null,
  out: Record<string, DesignNode>,
): void {
  const stack: { raw: RawTreeNode; parentId: string | null }[] = []
  for (let i = roots.length - 1; i >= 0; i--) {
    const raw = roots[i]
    if (isRawTreeNode(raw)) stack.push({ raw, parentId })
  }
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { raw } = item
    const childIds: string[] = []
    for (const child of raw.children) if (isRawTreeNode(child)) childIds.push(child.id)
    out[raw.id] = decodeNode(raw.id, item.parentId, childIds, raw.meta)
    for (let i = raw.children.length - 1; i >= 0; i--) {
      const child = raw.children[i]
      if (isRawTreeNode(child)) stack.push({ raw: child, parentId: raw.id })
    }
  }
}

/**
 * Materialise the whole document as plain objects. One wasm→JS call
 * (`doc.toJSON()`), then a linear walk — use for initial render, export and
 * tests; use `subscribeNodes` + `getNode` for incremental updates.
 */
export function toSnapshot(doc: LoroDoc): DocSnapshot {
  nodesTree(doc)
  const json = doc.toJSON() as Record<string, unknown>
  const meta = json[CONTAINER.meta] as Record<string, unknown> | undefined
  const rawRoots = Array.isArray(json[CONTAINER.nodes]) ? (json[CONTAINER.nodes] as unknown[]) : []
  const nodes: Record<string, DesignNode> = {}
  const pageIds: string[] = []
  for (const raw of rawRoots) if (isRawTreeNode(raw)) pageIds.push(raw.id)
  collectNodes(rawRoots, null, nodes)

  const tokens: Record<string, Token> = {}
  const rawTokens = json[CONTAINER.tokens]
  if (typeof rawTokens === 'object' && rawTokens !== null) {
    for (const [name, value] of Object.entries(rawTokens as Record<string, unknown>)) {
      const token = decodeToken(value)
      if (token) tokens[name] = token
    }
  }

  const snapshot: DocSnapshot = {
    name: typeof meta?.['name'] === 'string' ? (meta['name'] as string) : '',
    pageIds,
    nodes,
    tokens,
  }
  const components = decodeRegistry(json[CONTAINER.components])
  if (components) snapshot.components = components
  return snapshot
}

/** The component registry (`components` root map); `undefined` when empty. */
export function decodeRegistry(raw: unknown): Record<string, { mainId: string }> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  let out: Record<string, { mainId: string }> | undefined
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const mainId = (value as Record<string, unknown>)['mainId']
    if (typeof mainId === 'string') (out ??= {})[key] = { mainId }
  }
  return out
}

/**
 * Materialise one subtree (e.g. a single artboard) — lets renderers hydrate
 * only what is visible instead of paying `toSnapshot` for the whole file.
 * Returns `undefined` when the node does not exist.
 */
export function toSubtreeSnapshot(
  doc: LoroDoc,
  rootId: string,
): { rootId: string; nodes: Record<string, DesignNode> } | undefined {
  if (!hasNode(doc, rootId)) return undefined
  const node = nodesTree(doc).getNodeByID(asTreeId(rootId))
  if (!node) return undefined
  const nodes: Record<string, DesignNode> = {}
  collectNodes([node.toJSON() as unknown], node.parent()?.id ?? null, nodes)
  return { rootId, nodes }
}
