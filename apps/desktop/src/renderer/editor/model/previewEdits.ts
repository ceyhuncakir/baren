/**
 * Live previews for scrubbed inspector values (number scrub, color picker drags).
 *
 * The canvas only re-renders on committed Loro changes, so previews must commit. They
 * commit with a `preview:` origin, which the canvas UndoManager is configured to ignore
 * (see PREVIEW_ORIGIN_PREFIX), so a whole scrub becomes ONE undo step: on the final value
 * the touched keys are reverted to their originals (also ignored) and the final patch is
 * committed with the normal editor origin. Collaborators see the scrub live.
 *
 * Refs may be real or virtual (instance content): reads go through the session's component
 * resolver and writes through `setStylesAt`, so an instance's edits become overrides (a value
 * equal to the main's removes the override again).
 */
import {
  refExists,
  setStylesAt,
  transact,
  type StylePatch,
  type StyleValue,
  type Styles,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { ORIGIN } from './docOps'
import { resolverOf } from './resolver'

export const PREVIEW_ORIGIN_PREFIX = 'preview'
const PREVIEW_ORIGIN = `${PREVIEW_ORIGIN_PREFIX}:inspector`

type PatchFor = (styles: Styles, id: string) => StylePatch | null

interface Session {
  /** id → key → original value (undefined = absent). */
  originals: Map<string, Map<string, StyleValue | undefined>>
}

const sessions = new WeakMap<LoroDoc, Session>()

function apply(doc: LoroDoc, ids: readonly string[], patchFor: PatchFor, session: Session | null) {
  const resolver = resolverOf(doc)
  for (const id of ids) {
    const node = resolver.resolveNode(id)
    if (!node) continue
    const patch = patchFor(node.styles, id)
    if (!patch) continue
    const keys = Object.keys(patch)
    if (keys.length === 0) continue
    if (session) {
      let orig = session.originals.get(id)
      if (!orig) session.originals.set(id, (orig = new Map()))
      for (const k of keys) if (!orig.has(k)) orig.set(k, node.styles[k])
    }
    setStylesAt(doc, id, patch, { resolver })
  }
}

function live(doc: LoroDoc, ids: readonly string[]): string[] {
  const resolver = resolverOf(doc)
  return ids.filter((id) => refExists(doc, id, resolver))
}

/** Apply a preview (not undoable on its own). */
export function previewStyles(doc: LoroDoc, ids: readonly string[], patchFor: PatchFor): void {
  let session = sessions.get(doc)
  if (!session) sessions.set(doc, (session = { originals: new Map() }))
  const targets = live(doc, ids)
  if (targets.length === 0) return
  transact(doc, () => apply(doc, targets, patchFor, session), { origin: PREVIEW_ORIGIN })
}

/** Revert any pending preview without committing a final value (Escape, unmount). */
export function cancelPreview(doc: LoroDoc): void {
  const session = sessions.get(doc)
  if (!session) return
  sessions.delete(doc)
  if (session.originals.size === 0) return
  const resolver = resolverOf(doc)
  transact(
    doc,
    () => {
      for (const [id, keys] of session.originals) {
        if (!refExists(doc, id, resolver)) continue
        const patch: StylePatch = {}
        for (const [k, v] of keys) patch[k] = v === undefined ? null : v
        setStylesAt(doc, id, patch, { resolver })
      }
    },
    { origin: PREVIEW_ORIGIN },
  )
}

/**
 * Final value: revert previews (ignored by undo), then one undoable commit. `finish` runs in
 * the same commit (group refits after geometry edits).
 */
export function commitStyles(
  doc: LoroDoc,
  ids: readonly string[],
  patchFor: PatchFor,
  origin: string = ORIGIN.inspector,
  finish?: (ids: readonly string[]) => void,
): void {
  cancelPreview(doc)
  const targets = live(doc, ids)
  if (targets.length === 0) return
  transact(
    doc,
    () => {
      apply(doc, targets, patchFor, null)
      finish?.(targets)
    },
    { origin },
  )
}

export function hasPreview(doc: LoroDoc): boolean {
  return sessions.has(doc)
}
