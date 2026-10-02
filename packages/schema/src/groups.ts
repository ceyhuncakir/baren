/**
 * Groups (contract §2.5): real boxes whose children are always `position: absolute` in
 * group-local coordinates. The box is the union of the children's rotated bounds, refitted
 * (`fitGroups`) by whoever changes geometry, in the same transaction.
 */
import type { LoroDoc } from 'loro-crdt'
import { nodesTree, transact } from './doc.ts'
import {
  docGeometry,
  frameAabb,
  frameOrDeclared,
  placementStyles,
  positionContextOf,
  rotatePoint,
  unionRects,
} from './geometry.ts'
import { wouldCreateCycle } from './graph.ts'
import { isTreeId } from './ids.ts'
import { createNode, deleteNode, getNode, getParentId, moveNode } from './nodes.ts'
import { topmostRefs } from './refs.ts'
import { createComponentResolver, type ComponentResolver } from './resolve.ts'
import { readRotation } from './rotation.ts'
import type { DesignNode, GeometrySource, NodeFrame, StylePatch, Styles } from './types.ts'
import { isAbsolutePosition, realIdOf, round2, run, toPx, writeStyles } from './util.ts'
import { scaleVector, setVector } from './vector.ts'

const ZERO: NodeFrame = { x: 0, y: 0, width: 0, height: 0, rotation: 0 }

/** Declared px size of a node, else its resolved (instance) size, else the measured one. */
function sizeOf(
  doc: LoroDoc,
  node: DesignNode,
  geo: GeometrySource,
  resolver: ComponentResolver,
): { width: number; height: number } {
  let w = toPx(node.styles['width'])
  let h = toPx(node.styles['height'])
  if ((w === null || h === null) && node.type === 'instance') {
    const resolved = resolver.resolveNode(node.id)
    w ??= toPx(resolved?.styles['width'])
    h ??= toPx(resolved?.styles['height'])
  }
  if (w === null || h === null) {
    const f = geo.frameOf(node.id)
    w ??= f?.width ?? 0
    h ??= f?.height ?? 0
  }
  return { width: w, height: h }
}

function depthOf(doc: LoroDoc, id: string): number {
  let d = 0
  for (let n = nodesTree(doc).getNodeByID(id as never); n; n = n.parent()) d++
  return d
}

/**
 * Refit every group that is (or is an ancestor of) one of `ids`, deepest first (§2.5.1).
 * Joins the caller's transaction (no commit of its own inside one).
 */
export function fitGroups(doc: LoroDoc, ids: readonly string[], geo: GeometrySource): void {
  const groups = new Set<string>()
  const tree = nodesTree(doc)
  for (const raw of ids) {
    const id = realIdOf(raw)
    if (!isTreeId(id) || !tree.has(id) || tree.isNodeDeleted(id)) continue
    for (let n = tree.getNodeByID(id); n; n = n.parent()) {
      if (n.data.get('type') === 'group') groups.add(n.id)
    }
  }
  if (groups.size === 0) return
  const ordered = [...groups]
    .map((id) => ({ id, depth: depthOf(doc, id) }))
    .sort((a, b) => b.depth - a.depth)
  const resolver = createComponentResolver(doc)
  transact(doc, () => {
    for (const { id } of ordered) fitGroup(doc, id, geo, resolver)
  })
}

function fitGroup(
  doc: LoroDoc,
  groupId: string,
  geo: GeometrySource,
  resolver: ComponentResolver,
): void {
  const g = getNode(doc, groupId)
  if (!g || g.type !== 'group') return
  const children = g.children.map((c) => getNode(doc, c)).filter((c) => c !== undefined)
  if (children.length === 0) return
  const locals = children.map((c) => {
    const size = sizeOf(doc, c, geo, resolver)
    return {
      node: c,
      left: toPx(c.styles['left']) ?? 0,
      top: toPx(c.styles['top']) ?? 0,
      ...size,
    }
  })
  const u = unionRects(
    locals.map((l) =>
      frameAabb({
        x: l.left,
        y: l.top,
        width: l.width,
        height: l.height,
        rotation: readRotation(l.node.styles),
      }),
    ),
  )
  if (!u) return
  const gw = toPx(g.styles['width'])
  const gh = toPx(g.styles['height'])
  const shifted = Math.abs(u.x) >= 0.01 || Math.abs(u.y) >= 0.01
  const resized =
    gw === null || gh === null || Math.abs(u.width - gw) >= 0.01 || Math.abs(u.height - gh) >= 0.01
  if (!shifted && !resized) return
  for (const l of locals) {
    const patch: StylePatch = {}
    if (!isAbsolutePosition(l.node.styles)) patch['position'] = 'absolute'
    if (shifted) {
      patch['left'] = round2(l.left - u.x)
      patch['top'] = round2(l.top - u.y)
    }
    writeStyles(doc, l.node.id, patch)
  }
  const patch: StylePatch = { width: round2(u.width), height: round2(u.height) }
  const parent = g.parentId === null ? undefined : getNode(doc, g.parentId)
  const flow = positionContextOf(parent) === 'flow' && !isAbsolutePosition(g.styles)
  // The box's centre moves when it shifts or resizes; for a rotated box that moves the rotation
  // pivot, so the position is recomputed from the centre (unchanged values write no op).
  if (!flow) {
    const oldW = gw ?? u.width
    const oldH = gh ?? u.height
    const left = toPx(g.styles['left']) ?? 0
    const top = toPx(g.styles['top']) ?? 0
    const d = rotatePoint(
      { x: u.x + u.width / 2 - oldW / 2, y: u.y + u.height / 2 - oldH / 2 },
      { x: 0, y: 0 },
      readRotation(g.styles),
    )
    patch['left'] = round2(left + oldW / 2 + d.x - u.width / 2)
    patch['top'] = round2(top + oldH / 2 + d.y - u.height / 2)
  }
  writeStyles(doc, groupId, patch)
}

/**
 * Delete groups left without children by a local action, walking up through groups that
 * become empty in turn. Returns the remaining (non-deleted) parents.
 */
export function deleteEmptiedGroups(doc: LoroDoc, parents: readonly (string | null)[]): string[] {
  const out = new Set<string>()
  for (const start of parents) {
    let id: string | null = start
    while (id !== null) {
      const n = getNode(doc, id)
      if (!n) break
      if (n.type !== 'group' || n.children.length > 0) {
        out.add(id)
        break
      }
      const parent: string | null = n.parentId
      deleteNode(doc, id)
      id = parent
    }
  }
  return [...out].filter((id) => getNode(doc, id) !== undefined)
}

/**
 * Give a non-top-level frame that now holds absolutely positioned children a containing
 * block (`position: relative`) when its position is unset or static.
 */
export function ensureContainingBlock(doc: LoroDoc, frameId: string): void {
  const n = getNode(doc, frameId)
  if (!n || n.type !== 'frame' || n.parentId === null) return
  const parent = getNode(doc, n.parentId)
  if (!parent || parent.type === 'page') return
  const pos = n.styles['position']
  if (pos === undefined || pos === 'static') writeStyles(doc, frameId, { position: 'relative' })
}

/**
 * Freeze sizes that are not px (`%`, `auto`, flex sizing) to the measured size, for nodes
 * that move into an absolute context. Text keeps an absent width/height (auto size);
 * instances without a size keep following their main.
 */
export function freezeSize(doc: LoroDoc, id: string, frame: NodeFrame | null): void {
  const n = getNode(doc, id)
  if (!n || !frame || n.type === 'instance') return
  const patch: StylePatch = {}
  for (const [key, size] of [
    ['width', frame.width],
    ['height', frame.height],
  ] as const) {
    const v = n.styles[key]
    if (toPx(v) !== null) continue
    if (v === undefined && n.type === 'text') continue
    patch[key] = round2(size)
  }
  writeStyles(doc, id, patch)
}

function indexIn(doc: LoroDoc, parentId: string, id: string): number {
  return getNode(doc, parentId)?.children.indexOf(id) ?? -1
}

/**
 * True when a new container for `ids` under a flex `parentId` must be a flow item: at least one
 * of the nodes is a flow item of that parent. Otherwise (absolutely positioned children, nodes
 * from elsewhere) the container is positioned absolutely so nothing moves.
 */
function containerInFlow(doc: LoroDoc, parentId: string, ids: readonly string[]): boolean {
  if (positionContextOf(getNode(doc, parentId)) !== 'flow') return false
  return ids.some((id) => {
    const n = getNode(doc, id)
    return n !== undefined && n.parentId === parentId && !isAbsolutePosition(n.styles)
  })
}

/** Box styles of a new container (group/frame) with world frame `box` under `parentId`. */
function containerBoxStyles(
  doc: LoroDoc,
  parentId: string,
  box: NodeFrame,
  parentFrame: NodeFrame | null,
  inFlow: boolean,
): Styles {
  const parent = getNode(doc, parentId)
  const styles: Styles = { width: round2(box.width), height: round2(box.height) }
  if (inFlow) {
    styles['flexShrink'] = 0
    return styles
  }
  const flex = positionContextOf(parent) === 'flow'
  const placement = placementStyles(doc, parentId, box, parentFrame, { absolute: flex })
  for (const key in placement) {
    const v = placement[key]
    if (v !== null && v !== undefined) styles[key] = v
  }
  return styles
}

/**
 * Ctrl+G. Normalises to topmost real refs (no virtual ids, no pages); the group goes into the
 * parent of the top-most painted node, at that node's index; children keep their world frames.
 * Returns the group id, or null (nothing to group, or a component cycle).
 */
export function groupNodes(
  doc: LoroDoc,
  ids: readonly string[],
  geo: GeometrySource,
  opts: { name?: string; origin?: string } = {},
): string | null {
  return run(doc, opts.origin ?? 'editor:group', () => {
    const resolver = createComponentResolver(doc)
    const top = topmostRefs(doc, ids, resolver, { virtual: false })
    const last = top[top.length - 1]
    if (last === undefined) return null
    const parentId = getParentId(doc, last)
    if (parentId === null || wouldCreateCycle(doc, top, parentId)) return null
    const declared = docGeometry(doc, resolver)
    const frames = top.map((id) => frameOrDeclared(doc, geo, id, declared) ?? ZERO)
    const union = unionRects(frames.map((f) => frameAabb(f))) ?? ZERO
    const box: NodeFrame = { ...union, rotation: 0 }
    const parent = getNode(doc, parentId)
    const context = positionContextOf(parent)
    const parentFrame = context === 'page' ? null : frameOrDeclared(doc, geo, parentId, declared)
    const inFlow = containerInFlow(doc, parentId, top)
    const groupId = createNode(doc, {
      type: 'group',
      parentId,
      index: indexIn(doc, parentId, last) + 1,
      name: opts.name ?? 'Group',
      styles: containerBoxStyles(doc, parentId, box, parentFrame, inFlow),
    })
    if (context === 'absolute' || (context === 'flow' && !inFlow)) {
      ensureContainingBlock(doc, parentId)
    }
    const oldParents = top.map((id) => getParentId(doc, id))
    top.forEach((id, i) => {
      moveNode(doc, id, groupId, i)
      const f = frames[i] ?? ZERO
      writeStyles(doc, id, placementStyles(doc, groupId, f, box))
      freezeSize(doc, id, f)
    })
    const remaining = deleteEmptiedGroups(doc, oldParents)
    fitGroups(doc, [groupId, ...remaining], geo)
    return groupId
  })
}

/**
 * Ctrl+Shift+G. Children go to the group's parent at the group's index, in order, keeping
 * world frames (rotation baked: child rotation += group rotation); into a flex parent they
 * become flow items. Deletes the groups. Returns the former children.
 */
export function ungroupNodes(
  doc: LoroDoc,
  groupIds: readonly string[],
  geo: GeometrySource,
  opts: { origin?: string } = {},
): string[] {
  return run(doc, opts.origin ?? 'editor:ungroup', () => {
    const resolver = createComponentResolver(doc)
    const declared = docGeometry(doc, resolver)
    const out: string[] = []
    const parents: string[] = []
    for (const gid of new Set(groupIds)) {
      const g = isTreeId(gid) ? getNode(doc, gid) : undefined
      if (!g || g.type !== 'group' || g.parentId === null) continue
      const parentId = g.parentId
      const parent = getNode(doc, parentId)
      const context = positionContextOf(parent)
      const parentFrame = context === 'page' ? null : frameOrDeclared(doc, geo, parentId, declared)
      const frames = g.children.map((c) => frameOrDeclared(doc, geo, c, declared))
      const index = indexIn(doc, parentId, gid)
      // An absolutely positioned group in a flex frame hands its children absolute positions.
      const absolute = context === 'flow' && isAbsolutePosition(g.styles)
      g.children.forEach((c, i) => {
        moveNode(doc, c, parentId, index + i)
        const f = frames[i]
        if (f) writeStyles(doc, c, placementStyles(doc, parentId, f, parentFrame, { absolute }))
      })
      deleteNode(doc, gid)
      if (context === 'absolute') ensureContainingBlock(doc, parentId)
      out.push(...g.children)
      parents.push(parentId)
    }
    fitGroups(doc, parents, geo)
    return out
  })
}

function swapsAxes(rotation: number): boolean {
  const a = Math.abs(rotation) % 180
  return Math.min(a, 180 - a) >= 45
}

/** Scale the px boxes of a group's descendants by (sx, sy) in the group's local axes. */
function scaleChildren(doc: LoroDoc, groupId: string, sx: number, sy: number): void {
  const g = getNode(doc, groupId)
  if (!g) return
  for (const id of g.children) {
    const c = getNode(doc, id)
    if (!c) continue
    const swap = swapsAxes(readRotation(c.styles))
    const [fx, fy] = swap ? [sy, sx] : [sx, sy]
    const left = toPx(c.styles['left']) ?? 0
    const top = toPx(c.styles['top']) ?? 0
    const w = toPx(c.styles['width'])
    const h = toPx(c.styles['height'])
    const patch: StylePatch = {}
    if (w !== null && h !== null) {
      const nw = w * fx
      const nh = h * fy
      patch['left'] = round2((left + w / 2) * sx - nw / 2)
      patch['top'] = round2((top + h / 2) * sy - nh / 2)
      patch['width'] = round2(nw)
      patch['height'] = round2(nh)
      if (c.type === 'vector' && c.vector && w > 0 && h > 0) {
        setVector(doc, id, scaleVector(c.vector, nw / w, nh / h))
      }
    } else {
      patch['left'] = round2(left * sx)
      patch['top'] = round2(top * sy)
      if (w !== null) patch['width'] = round2(w * fx)
      if (h !== null) patch['height'] = round2(h * fy)
    }
    writeStyles(doc, id, patch)
    if (c.type === 'group') scaleChildren(doc, id, fx, fy)
  }
}

/**
 * Resize a group's box and scale its descendants' px left/top/width/height (recursively
 * through nested groups; frames keep their own layout inside; vectors rescale their points).
 * `left/top` are in the group's parent coordinates.
 */
export function resizeGroup(
  doc: LoroDoc,
  groupId: string,
  box: { left?: number; top?: number; width: number; height: number },
  opts: { origin?: string } = {},
): void {
  run(doc, opts.origin ?? 'canvas:resize', () => {
    const g = getNode(doc, groupId)
    if (!g || g.type !== 'group') return
    const oldW = toPx(g.styles['width']) ?? box.width
    const oldH = toPx(g.styles['height']) ?? box.height
    const sx = oldW > 0 ? box.width / oldW : 1
    const sy = oldH > 0 ? box.height / oldH : 1
    scaleChildren(doc, groupId, sx, sy)
    const patch: StylePatch = { width: round2(box.width), height: round2(box.height) }
    if (box.left !== undefined) patch['left'] = round2(box.left)
    if (box.top !== undefined) patch['top'] = round2(box.top)
    writeStyles(doc, groupId, patch)
    fitGroups(doc, [groupId], docGeometry(doc))
  })
}

/**
 * Wrap in a new frame (rotation-aware successor of the editor's wrapInFrame). Flow items of a
 * flex parent become flow items of a new flex frame (same direction) at the first item's
 * place; anything else goes into an absolute frame sized to the union of the items, at the
 * top-most item's index. Returns the frame id or null.
 */
export function wrapInFrame(
  doc: LoroDoc,
  ids: readonly string[],
  geo: GeometrySource,
  opts: { name?: string; origin?: string } = {},
): string | null {
  return run(doc, opts.origin ?? 'editor:menu', () => {
    const resolver = createComponentResolver(doc)
    const top = topmostRefs(doc, ids, resolver, { virtual: false })
    const last = top[top.length - 1]
    if (last === undefined) return null
    const parentId = getParentId(doc, last)
    if (parentId === null || wouldCreateCycle(doc, top, parentId)) return null
    const parent = getNode(doc, parentId)
    const context = positionContextOf(parent)
    const nodes = top.map((id) => getNode(doc, id))
    const flowWrap =
      context === 'flow' &&
      nodes.every((n) => n && n.parentId === parentId && !isAbsolutePosition(n.styles))
    const oldParents = top.map((id) => getParentId(doc, id))
    if (flowWrap) {
      const first = top[0] as string
      const frameId = createNode(doc, {
        type: 'frame',
        parentId,
        index: indexIn(doc, parentId, first),
        name: opts.name ?? 'Frame',
        styles: {
          display: 'flex',
          flexDirection: parent?.styles['flexDirection'] === 'row' ? 'row' : 'column',
        },
      })
      top.forEach((id, i) => moveNode(doc, id, frameId, i))
      fitGroups(doc, [frameId], geo)
      return frameId
    }
    const declared = docGeometry(doc, resolver)
    const frames = top.map((id) => frameOrDeclared(doc, geo, id, declared) ?? ZERO)
    const union = unionRects(frames.map((f) => frameAabb(f))) ?? ZERO
    const box: NodeFrame = { ...union, rotation: 0 }
    const parentFrame = context === 'page' ? null : frameOrDeclared(doc, geo, parentId, declared)
    const inFlow = containerInFlow(doc, parentId, top)
    const frameId = createNode(doc, {
      type: 'frame',
      parentId,
      index: indexIn(doc, parentId, last) + 1,
      name: opts.name ?? 'Frame',
      styles: containerBoxStyles(doc, parentId, box, parentFrame, inFlow),
    })
    if (context === 'absolute' || (context === 'flow' && !inFlow)) {
      ensureContainingBlock(doc, parentId)
    }
    top.forEach((id, i) => {
      moveNode(doc, id, frameId, i)
      const f = frames[i] ?? ZERO
      writeStyles(doc, id, placementStyles(doc, frameId, f, box))
      freezeSize(doc, id, f)
    })
    ensureContainingBlock(doc, frameId)
    const remaining = deleteEmptiedGroups(doc, oldParents)
    fitGroups(doc, [frameId, ...remaining], geo)
    return frameId
  })
}
