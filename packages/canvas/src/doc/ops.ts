import type { LoroDoc } from 'loro-crdt'
import {
  createNode,
  deleteNode,
  fitGroups,
  getChildIds,
  getNodeType,
  hasNode,
  moveNode,
  resizeGroup,
  setStyles,
  setStylesAt,
  toSubtreeSnapshot,
  transact,
  type ComponentResolver,
  type CreateNodeInput,
  type DesignNode,
  type GeometrySource,
  type StylePatch,
  type StyleValue,
  type Styles,
} from '@baren/schema'
import { readStyleValues } from './read.ts'

/** Commit origins used by the canvas (visible on event batches and undo). */
export const ORIGIN = {
  move: 'canvas:move',
  resize: 'canvas:resize',
  reorder: 'canvas:reorder',
  create: 'canvas:create',
  text: 'canvas:text',
  delete: 'canvas:delete',
  duplicate: 'canvas:duplicate',
  nudge: 'canvas:nudge',
  reparent: 'canvas:reparent',
  rotate: 'canvas:rotate',
  pen: 'canvas:pen',
  vector: 'canvas:vector',
  groupFit: 'derived:group-fit',
} as const

/** Gap between an artboard and its duplicate (the usual artboard spacing). */
export const DUPLICATE_GAP = 80

/** Numeric geometry value written in the same format as the existing one (`"12px"` stays a px string). */
export function geometryValue(existing: StyleValue | undefined, n: number): StyleValue {
  const v = Math.round(n * 100) / 100
  if (typeof existing === 'string' && /px\s*$/.test(existing)) return `${v}px`
  return v
}

export interface GeometryPatch {
  id: string
  left?: number
  top?: number
  width?: number
  height?: number
}

const GEOMETRY_KEYS = ['left', 'top', 'width', 'height'] as const

export interface GeometryCommitOptions {
  /** Refit groups that contain the changed nodes (contract 2.5.1). */
  geo?: GeometrySource
  /** Resolves virtual ids (their geometry is written as instance overrides). */
  resolver?: ComponentResolver
  /** Current values of virtual nodes (resolved styles), to keep `"12px"` formats. */
  current?: (id: string) => Record<string, StyleValue | undefined> | null
}

/**
 * Apply geometry changes to many nodes in one transaction (one undo step, one sync update).
 * Virtual ids (instance content) write overrides; groups resize with their content scaled;
 * enclosing groups are refitted when `geo` is given.
 */
export function commitGeometry(
  doc: LoroDoc,
  patches: readonly GeometryPatch[],
  origin: string,
  opts: GeometryCommitOptions = {},
): void {
  if (patches.length === 0) return
  transact(
    doc,
    () => {
      const touched: string[] = []
      for (const p of patches) {
        const virtual = p.id.includes('/')
        if (!virtual && !hasNode(doc, p.id)) continue
        const current = virtual
          ? (opts.current?.(p.id) ?? {})
          : readStyleValues(doc, p.id, GEOMETRY_KEYS)
        const patch: StylePatch = {}
        for (const k of GEOMETRY_KEYS) {
          const n = p[k]
          if (n !== undefined && Number.isFinite(n)) patch[k] = geometryValue(current[k], n)
        }
        if (virtual) {
          setStylesAt(doc, p.id, patch, opts.resolver ? { resolver: opts.resolver } : {})
          touched.push(p.id.slice(0, p.id.indexOf('/')))
          continue
        }
        const resized =
          (p.width !== undefined || p.height !== undefined) && getNodeType(doc, p.id) === 'group'
        if (resized) {
          const box: { left?: number; top?: number; width: number; height: number } = {
            width: p.width ?? (Number(current['width']) || 0),
            height: p.height ?? (Number(current['height']) || 0),
          }
          if (p.left !== undefined) box.left = p.left
          if (p.top !== undefined) box.top = p.top
          resizeGroup(doc, p.id, box)
        } else setStyles(doc, p.id, patch)
        touched.push(p.id)
      }
      if (opts.geo) fitGroups(doc, touched, opts.geo)
    },
    { origin },
  )
}

/**
 * Move `ids` (in order) under `parentId` so the first lands at final position `index` among
 * the siblings that are not moved (the others follow it).
 */
export function commitReorder(
  doc: LoroDoc,
  ids: readonly string[],
  parentId: string,
  index: number,
  origin: string,
): void {
  const live = ids.filter((id) => hasNode(doc, id))
  if (live.length === 0) return
  transact(
    doc,
    () => {
      // To the end first, so earlier moved siblings don't shift the final indices.
      for (const id of live) moveNode(doc, id, parentId)
      live.forEach((id, i) => moveNode(doc, id, parentId, index + i))
    },
    { origin },
  )
}

export function createNodeWithOrigin(doc: LoroDoc, input: CreateNodeInput, origin: string): string {
  return transact(doc, () => createNode(doc, input), { origin })
}

export function deleteNodes(
  doc: LoroDoc,
  ids: readonly string[],
  origin: string = ORIGIN.delete,
): void {
  if (ids.length === 0) return
  transact(
    doc,
    () => {
      for (const id of ids) if (hasNode(doc, id)) deleteNode(doc, id)
    },
    { origin },
  )
}

function copyInput(
  node: DesignNode,
  parentId: string,
  styles: Styles,
  index?: number,
): CreateNodeInput {
  const input: CreateNodeInput = { type: node.type, parentId, styles, name: node.name }
  if (index !== undefined) input.index = index
  if (node.type === 'text') input.text = node.text ?? ''
  if (node.svg !== undefined) input.svg = node.svg
  if (node.assetId !== undefined) input.assetId = node.assetId
  if (node.hidden !== undefined) input.hidden = node.hidden
  return input
}

/**
 * Deep-copy each node (with its subtree) right after the original. `place`
 * returns style overrides for a copy root (e.g. shift an artboard to the
 * right). Returns the new root ids in order.
 */
export function duplicateNodes(
  doc: LoroDoc,
  ids: readonly string[],
  place: (node: DesignNode) => Styles | null,
  origin: string = ORIGIN.duplicate,
): string[] {
  const created: string[] = []
  transact(
    doc,
    () => {
      for (const id of ids) {
        const snap = toSubtreeSnapshot(doc, id)
        const root = snap?.nodes[id]
        if (!snap || !root || root.parentId === null) continue
        const siblings = getChildIds(doc, root.parentId)
        const index = siblings.indexOf(id) + 1
        const styles = { ...root.styles, ...(place(root) ?? {}) }
        const newRoot = createNode(doc, copyInput(root, root.parentId, styles, index))
        created.push(newRoot)
        const stack: { from: DesignNode; to: string }[] = [{ from: root, to: newRoot }]
        for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
          for (const childId of cur.from.children) {
            const child = snap.nodes[childId]
            if (!child) continue
            const newId = createNode(doc, copyInput(child, cur.to, { ...child.styles }))
            if (child.children.length > 0) stack.push({ from: child, to: newId })
          }
        }
      }
    },
    { origin },
  )
  return created
}
