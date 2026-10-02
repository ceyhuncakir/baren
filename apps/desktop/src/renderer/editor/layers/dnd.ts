/**
 * Drop-target computation for dragging rows in the layers panel. Pure, unit-tested.
 */
import type { FlatRow } from './flatten'

export type DropPosition = 'before' | 'after' | 'inside'

export interface DropTarget {
  /** Row showing the indicator. */
  rowId: string
  position: DropPosition
  /** Resulting parent and insertion slot (index in the parent's current child list). */
  parentId: string
  index: number
}

export interface DndTree {
  children(id: string): readonly string[]
  meta(id: string): { type: string; virtual?: boolean } | null
  parent(id: string): string | null
}

/** Real containers that accept dropped layers (instances and their content never do). */
function acceptsChildren(meta: { type: string; virtual?: boolean } | null): boolean {
  if (!meta || meta.virtual) return false
  return meta.type === 'frame' || meta.type === 'group'
}

/**
 * @param y        pointer y in list-content coordinates
 * @param dragged  ids being dragged (their subtrees are invalid targets)
 * @param accept   extra check of the resulting parent (e.g. `canReparent`: cycles)
 */
export function dropTargetAt(
  rows: readonly FlatRow[],
  y: number,
  rowHeight: number,
  tree: DndTree,
  pageId: string,
  dragged: ReadonlySet<string>,
  accept?: (parentId: string) => boolean,
): DropTarget | null {
  if (rows.length === 0) return null
  const clampedY = Math.max(0, y)
  let index = Math.floor(clampedY / rowHeight)
  // Below the last row: append to the page.
  if (index >= rows.length) {
    return {
      rowId: (rows[rows.length - 1] as FlatRow).id,
      position: 'after',
      parentId: pageId,
      index: tree.children(pageId).length,
    }
  }
  index = Math.max(0, index)
  const row = rows[index] as FlatRow
  const within = (clampedY - index * rowHeight) / rowHeight
  const container = acceptsChildren(tree.meta(row.id))
  let position: DropPosition
  if (container) position = within < 0.25 ? 'before' : within > 0.75 ? 'after' : 'inside'
  else position = within < 0.5 ? 'before' : 'after'

  let parentId: string
  let slot: number
  if (position === 'inside' || (position === 'after' && row.expanded && container)) {
    parentId = row.id
    slot = 0
    position = position === 'after' ? 'after' : 'inside'
  } else {
    parentId = tree.parent(row.id) ?? pageId
    const siblings = tree.children(parentId)
    const at = siblings.indexOf(row.id)
    slot = position === 'before' ? Math.max(0, at) : at + 1
  }

  // Never drop into a dragged node or its subtree, nor into an instance's content.
  for (let p: string | null = parentId; p !== null; p = tree.parent(p)) {
    if (dragged.has(p)) return null
  }
  const parentMeta = tree.meta(parentId)
  if (parentMeta && parentMeta.type !== 'page' && !acceptsChildren(parentMeta)) return null
  if (accept && !accept(parentId)) return null
  return { rowId: row.id, position, parentId, index: slot }
}
