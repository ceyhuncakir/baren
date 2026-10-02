import { LoroMap, LoroText, type LoroDoc, type LoroTreeNode, type TreeID } from 'loro-crdt'
import { NODE_KEY, isTreeId, nodesTree, type StyleValue } from '@baren/schema'

/**
 * Narrow, allocation-light reads for incremental updates. `getNode` /
 * `toSubtreeSnapshot` serialise whole data maps; these read only the keys
 * an event says changed.
 */

function treeNode(doc: LoroDoc, id: string): LoroTreeNode | undefined {
  if (!isTreeId(id)) return undefined
  const tree = nodesTree(doc)
  const tid = id as TreeID
  if (!tree.has(tid) || tree.isNodeDeleted(tid)) return undefined
  return tree.getNodeByID(tid)
}

function isStyleValue(v: unknown): v is StyleValue {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

/** Current values of `keys` in a node's styles map (`undefined` = removed). */
export function readStyleValues(
  doc: LoroDoc,
  id: string,
  keys: readonly string[],
): Record<string, StyleValue | undefined> {
  const out: Record<string, StyleValue | undefined> = {}
  const node = treeNode(doc, id)
  const styles = node?.data.get(NODE_KEY.styles)
  for (const k of keys) {
    const v = styles instanceof LoroMap ? styles.get(k) : undefined
    out[k] = isStyleValue(v) ? v : undefined
  }
  return out
}

export function readText(doc: LoroDoc, id: string): string {
  const text = treeNode(doc, id)?.data.get(NODE_KEY.text)
  return text instanceof LoroText ? text.toString() : ''
}

export function textContainer(doc: LoroDoc, id: string): LoroText | null {
  const text = treeNode(doc, id)?.data.get(NODE_KEY.text)
  return text instanceof LoroText ? text : null
}

/** Current scalar data values for `keys` (name, hidden, locked, svg, assetId, background, type). */
export function readProps(
  doc: LoroDoc,
  id: string,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const data = treeNode(doc, id)?.data
  for (const k of keys) {
    const v = data?.get(k)
    out[k] = v instanceof LoroMap || v instanceof LoroText ? undefined : v
  }
  return out
}

/** Parent id via Loro (null for roots or missing nodes). */
export function loroParentId(doc: LoroDoc, id: string): string | null {
  return treeNode(doc, id)?.parent()?.id ?? null
}

/**
 * The direct child of `pageId` that contains `id` (or `id` itself when it is
 * top-level). Null when `id` is missing or lives on another page.
 */
export function topLevelOf(doc: LoroDoc, id: string, pageId: string): string | null {
  let cur = treeNode(doc, id)
  let guard = 0
  while (cur && guard++ < 10_000) {
    const parent = cur.parent()
    if (!parent) return null
    if (parent.id === pageId) return cur.id
    cur = parent
  }
  return null
}

export function nodeExists(doc: LoroDoc, id: string): boolean {
  return treeNode(doc, id) !== undefined
}
