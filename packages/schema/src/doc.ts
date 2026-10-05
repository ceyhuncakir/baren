import { LoroDoc, type LoroMap, type LoroTree } from 'loro-crdt'
import {
  CONTAINER,
  DEFAULT_PAGE_BACKGROUND,
  DEFAULT_PAGE_NAME,
  NODE_KEY,
  SCHEMA_VERSION,
} from './types.ts'

/**
 * Fractional-index jitter for sibling ordering. 0 keeps position keys short;
 * Loro still orders concurrent inserts at the same slot deterministically.
 */
export const FRACTIONAL_INDEX_JITTER = 0

export function nodesTree(doc: LoroDoc): LoroTree {
  const tree = doc.getTree(CONTAINER.nodes)
  if (!tree.isFractionalIndexEnabled()) tree.enableFractionalIndex(FRACTIONAL_INDEX_JITTER)
  return tree
}

export function metaMap(doc: LoroDoc): LoroMap {
  return doc.getMap(CONTAINER.meta)
}

export function commentsMap(doc: LoroDoc): LoroMap {
  return doc.getMap(CONTAINER.comments)
}

export function versionsMap(doc: LoroDoc): LoroMap {
  return doc.getMap(CONTAINER.versions)
}

export function tokensMap(doc: LoroDoc): LoroMap {
  return doc.getMap(CONTAINER.tokens)
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface CommitOptions {
  /** Shows up as `origin` on the resulting event batch (e.g. `'ui'`, `'remote'`, `'undo'`). */
  origin?: string
  message?: string
}

const txDepth = new WeakMap<LoroDoc, number>()

/**
 * Run several mutations as one Loro commit: one event batch, one undo step,
 * one local update for sync. Mutating helpers called outside `transact`
 * commit immediately. Nested calls join the outermost transaction.
 *
 * Loro has no rollback: if `fn` throws, the ops applied so far are still
 * committed (so state and events stay consistent) and the error is rethrown.
 */
export function transact<T>(doc: LoroDoc, fn: () => T, options?: CommitOptions): T {
  const depth = txDepth.get(doc) ?? 0
  txDepth.set(doc, depth + 1)
  try {
    return fn()
  } finally {
    txDepth.set(doc, depth)
    if (depth === 0) commitDoc(doc, options)
  }
}

/** Commit pending ops unless a surrounding `transact` will do it. */
export function autoCommit(doc: LoroDoc): void {
  if ((txDepth.get(doc) ?? 0) === 0) doc.commit()
}

function commitDoc(doc: LoroDoc, options: CommitOptions | undefined): void {
  if (options?.origin === undefined && options?.message === undefined) {
    doc.commit()
    return
  }
  const commitOptions: { origin?: string; message?: string } = {}
  if (options.origin !== undefined) commitOptions.origin = options.origin
  if (options.message !== undefined) commitOptions.message = options.message
  doc.commit(commitOptions)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CreateEmptyDocOptions {
  /** Name of the initial page, or `null` for a doc without pages. Default `"Page 1"`. */
  pageName?: string | null
  /** Initial page background. Default `#EEEEEE` (the `--color-canvas` grey). */
  pageBackground?: string
  /** Fixed peer id (tests, fixtures). Defaults to Loro's random peer id. */
  peerId?: bigint | number | `${number}`
}

/** A new design file: `meta` (name, schemaVersion) and one empty page. */
export function createEmptyDoc(name: string, options: CreateEmptyDocOptions = {}): LoroDoc {
  const doc = new LoroDoc()
  if (options.peerId !== undefined) doc.setPeerId(options.peerId)
  const tree = nodesTree(doc)
  const meta = metaMap(doc)
  meta.set('name', name)
  meta.set('schemaVersion', SCHEMA_VERSION)
  const pageName = options.pageName === undefined ? DEFAULT_PAGE_NAME : options.pageName
  if (pageName !== null) {
    const page = tree.createNode()
    page.data.set(NODE_KEY.type, 'page')
    page.data.set(NODE_KEY.name, pageName)
    page.data.set(NODE_KEY.background, options.pageBackground ?? DEFAULT_PAGE_BACKGROUND)
    page.data.ensureMergeableMap(NODE_KEY.styles)
  }
  doc.commit()
  return doc
}

/** Load a design file from a Loro snapshot or update blob(s). */
export function loadDoc(bytes: Uint8Array | readonly Uint8Array[]): LoroDoc {
  const doc = new LoroDoc()
  if (bytes instanceof Uint8Array) doc.import(bytes)
  else if (bytes.length > 0) doc.importBatch([...bytes])
  nodesTree(doc)
  return doc
}

export function exportSnapshot(doc: LoroDoc): Uint8Array {
  return doc.export({ mode: 'snapshot' })
}

export function getDocName(doc: LoroDoc): string {
  const name = metaMap(doc).get('name')
  return typeof name === 'string' ? name : ''
}

export function setDocName(doc: LoroDoc, name: string): void {
  metaMap(doc).set('name', name)
  autoCommit(doc)
}

export function getSchemaVersion(doc: LoroDoc): number | null {
  const v = metaMap(doc).get('schemaVersion')
  return typeof v === 'number' ? v : null
}
