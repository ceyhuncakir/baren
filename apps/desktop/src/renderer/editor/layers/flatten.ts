/**
 * Layer tree → flat, virtualizable rows, plus the per-row states of artboard 14
 * (selected, and "ancestor" for rows inside the selection's parent). Pure, unit-tested.
 * Frames, groups and instances (their resolved content) are expandable.
 */
import { isContainerType } from '../model/layerTree'

export interface TreeSource {
  children(id: string): readonly string[]
  meta(id: string): { type: string } | null
}

export interface FlatRow {
  id: string
  /** 0 = artboard (direct child of the page). */
  depth: number
  /** Index of the parent row in the flat list, -1 for artboards. */
  parentIndex: number
  expandable: boolean
  expanded: boolean
}

/** Depth-first rows of `pageId`'s subtree, descending only into expanded nodes. */
export function flattenLayers(
  tree: TreeSource,
  pageId: string,
  expanded: ReadonlySet<string>,
): FlatRow[] {
  const rows: FlatRow[] = []
  const stack: { id: string; depth: number; parentIndex: number }[] = []
  const top = tree.children(pageId)
  for (let i = top.length - 1; i >= 0; i--) {
    stack.push({ id: top[i] as string, depth: 0, parentIndex: -1 })
  }
  while (stack.length > 0) {
    const item = stack.pop() as { id: string; depth: number; parentIndex: number }
    const meta = tree.meta(item.id)
    if (!meta) continue
    const container = isContainerType(meta.type)
    const kids = container ? tree.children(item.id) : []
    const expandable = kids.length > 0
    const isOpen = expandable && expanded.has(item.id)
    const index = rows.length
    rows.push({
      id: item.id,
      depth: item.depth,
      parentIndex: item.parentIndex,
      expandable,
      expanded: isOpen,
    })
    if (isOpen) {
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ id: kids[i] as string, depth: item.depth + 1, parentIndex: index })
      }
    }
  }
  return rows
}

export type RowState = 'idle' | 'selected' | 'ancestor'

/**
 * State of one row. `scopeParents` holds the parents of selected nodes: a row inside
 * such a parent's subtree (or the parent itself) is drawn with the faint "ancestor" tint
 * when it is not a page.
 */
export function rowState(
  rows: readonly FlatRow[],
  index: number,
  selected: ReadonlySet<string>,
  scopeParents: ReadonlySet<string>,
): RowState {
  const row = rows[index]
  if (!row) return 'idle'
  if (selected.has(row.id)) return 'selected'
  if (scopeParents.size === 0) return 'idle'
  for (let i = index; i !== -1;) {
    const r = rows[i]
    if (!r) break
    if (scopeParents.has(r.id)) return 'ancestor'
    i = r.parentIndex
  }
  return 'idle'
}

/** Index of `id` in the rows, or -1. */
export function indexOfRow(rows: readonly FlatRow[], id: string): number {
  for (let i = 0; i < rows.length; i++) if (rows[i]?.id === id) return i
  return -1
}
