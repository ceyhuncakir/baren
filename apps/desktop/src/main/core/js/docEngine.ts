/**
 * Loro operations the JS core needs, behind an interface so file handling
 * stays independent of how Loro is loaded (worker: loro-crdt/web initialised
 * from the bundled .wasm; tests: loro-crdt's Node build).
 */
import {
  createEmptyDoc,
  exportSnapshot,
  getDocName,
  isNodeRef,
  loadDoc,
  nodesTree,
  setDocName,
  toSnapshot,
} from '@baren/schema'
import { LoroDoc, decodeImportBlobMeta } from 'loro-crdt'
import { exportNodeHtml } from './htmlExport'

export interface CompactResult {
  snapshot: Uint8Array
  /** Blobs that could not be imported (corrupt records) and were dropped. */
  skipped: number
}

export interface ImportResult {
  snapshot: Uint8Array
  /** The document's name after the import (`name` override, else its own, else "Untitled"). */
  name: string
}

export interface DocEngine {
  /** Snapshot of a new design file (meta + "Page 1"). */
  createEmpty(name: string): Uint8Array
  /**
   * Validate a snapshot from elsewhere (e.g. the server) and normalise it like the Rust
   * core's `import_file`: `null` when it cannot be imported or depends on missing history.
   */
  importSnapshot(bytes: Uint8Array, name: string | null): ImportResult | null
  /** Merge a snapshot and its pending updates into one snapshot. */
  compact(blobs: readonly Uint8Array[]): CompactResult
  /** Cheap structural + checksum validation of an update blob (no import). */
  isValidBlob(bytes: Uint8Array): boolean
  exportJson(blobs: readonly Uint8Array[]): string
  /** `null` when the node (a real or virtual id) does not exist. */
  exportHtml(blobs: readonly Uint8Array[], nodeId: string): string | null
}

function load(blobs: readonly Uint8Array[]): { doc: LoroDoc; skipped: number } {
  try {
    return { doc: loadDoc(blobs), skipped: 0 }
  } catch {
    // One bad blob fails the whole batch: import individually and drop the bad ones.
    const doc = new LoroDoc()
    let skipped = 0
    for (const blob of blobs) {
      try {
        doc.import(blob)
      } catch {
        skipped++
      }
    }
    return { doc, skipped }
  }
}

export function createLoroDocEngine(): DocEngine {
  return {
    createEmpty: (name) => exportSnapshot(createEmptyDoc(name)),
    importSnapshot(bytes, name) {
      const doc = new LoroDoc()
      try {
        const status = doc.import(bytes)
        if (status.pending && status.pending.size > 0) return null
      } catch {
        return null
      }
      nodesTree(doc)
      const finalName = name ?? (getDocName(doc) || 'Untitled')
      // Unchanged names write no op (same rule as the Rust core).
      if (getDocName(doc) !== finalName) setDocName(doc, finalName)
      return { snapshot: exportSnapshot(doc), name: finalName }
    },
    compact(blobs) {
      const { doc, skipped } = load(blobs)
      return { snapshot: exportSnapshot(doc), skipped }
    },
    isValidBlob(bytes) {
      try {
        decodeImportBlobMeta(bytes, true)
        return true
      } catch {
        return false
      }
    },
    exportJson: (blobs) => JSON.stringify(toSnapshot(load(blobs).doc), null, 2),
    exportHtml(blobs, nodeId) {
      if (!isNodeRef(nodeId)) return null
      return exportNodeHtml(load(blobs).doc, nodeId)
    },
  }
}
