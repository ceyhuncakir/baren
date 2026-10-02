/**
 * HTML export for the JS fallback core. It delegates to `renderHtml` from `@baren/schema`,
 * the TypeScript twin of the Rust core's exporter (same mapping, declaration order, escaping
 * and SVG sanitising; instances resolved; groups, vectors and rotation rendered), so a file
 * exports the same with or without the native module.
 */
import { getTokens, isNodeRef, refExists, renderHtml } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

/** HTML of one node's subtree (a real or virtual id), or `null` when it does not exist. */
export function exportNodeHtml(doc: LoroDoc, nodeId: string): string | null {
  if (!isNodeRef(nodeId) || !refExists(doc, nodeId)) return null
  return renderHtml(doc, [nodeId], { tokens: getTokens(doc) })
}
