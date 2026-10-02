/**
 * Editor-level document operations. Each public function is ONE Loro commit (one undo
 * step, one sync update) with an `editor:*` origin, built only from @baren/schema
 * helpers. No DOM, no React: unit-tested against real Loro docs.
 */
import {
  createNode,
  deleteNode,
  docGeometry,
  getChildIds,
  getNode,
  getNodeType,
  getParentId,
  hasNode,
  isTreeId,
  moveNode,
  parseVirtualId,
  refExists,
  removeNodes,
  reparentNodes,
  setNodeProps,
  setPropsAt,
  setStyles,
  setStylesAt,
  toSubtreeSnapshot,
  transact,
  wrapInFrame as schemaWrapInFrame,
  type DesignNode,
  type GeometrySource,
  type NodePropsPatch,
  type NodeType,
  type StylePatch,
  type Styles,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { resolverOf } from './resolver'
import { addFlexPatch, pxValue, removeFlexPatch, toPx } from './styles'

export const ORIGIN = {
  inspector: 'editor:inspector',
  layers: 'editor:layers',
  pages: 'editor:pages',
  theme: 'editor:theme',
  clipboard: 'editor:clipboard',
  menu: 'editor:menu',
  /** Images inserted from files (picker, drop, paste) and component instances. */
  insert: 'editor:insert',
  group: 'editor:group',
  ungroup: 'editor:ungroup',
  component: 'editor:component',
  detach: 'editor:detach',
  resetOverrides: 'editor:reset-overrides',
} as const

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** World bounds of a node when known (the canvas measures them). */
export type BoundsOf = (id: string) => Rect | null

const isTop = (doc: LoroDoc, id: string): boolean => {
  const parent = getParentId(doc, id)
  return parent !== null && getNodeType(doc, parent) === 'page'
}

/** Nearest page ancestor (the node itself when it is a page). */
export function pageOf(doc: LoroDoc, id: string): string | null {
  let cur: string | null = id
  while (cur !== null) {
    if (!hasNode(doc, cur)) return null
    if (getNodeType(doc, cur) === 'page') return cur
    cur = getParentId(doc, cur)
  }
  return null
}

/** Ancestor chain from the parent up to the page (closest first). */
export function ancestorsOf(doc: LoroDoc, id: string): string[] {
  const out: string[] = []
  let cur = hasNode(doc, id) ? getParentId(doc, id) : null
  while (cur !== null) {
    out.push(cur)
    cur = getParentId(doc, cur)
  }
  return out
}

/** Drop ids that are descendants of other ids in the list (keeps list order). Real ids only. */
export function topmostIds(doc: LoroDoc, ids: readonly string[]): string[] {
  const set = new Set(ids)
  return ids.filter((id) => hasNode(doc, id) && !ancestorsOf(doc, id).some((a) => set.has(a)))
}

/** The real node a ref renders through: itself, or the instance owning a virtual id. */
export function realIdOf(ref: string): string {
  return parseVirtualId(ref)?.instanceId ?? ref
}

/** Refs that exist (real nodes or instance content). */
export function liveRefs(doc: LoroDoc, refs: readonly string[]): string[] {
  const resolver = resolverOf(doc)
  return refs.filter((ref) => refExists(doc, ref, resolver))
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export function renameNode(doc: LoroDoc, id: string, name: string, origin: string = ORIGIN.layers) {
  const trimmed = name.trim()
  if (!trimmed || !hasNode(doc, id)) return
  transact(doc, () => setNodeProps(doc, id, { name: trimmed }), { origin })
}

/**
 * Lock/hide. Virtual refs (instance content) can only be hidden: the flag becomes a `hidden`
 * override of their instance (contract §2.7.3); locking them is ignored.
 */
export function setFlag(
  doc: LoroDoc,
  ids: readonly string[],
  flag: 'locked' | 'hidden',
  value: boolean,
  origin: string = ORIGIN.layers,
) {
  const live = liveRefs(doc, ids).filter((id) => flag === 'hidden' || isTreeId(id))
  if (live.length === 0) return
  const resolver = resolverOf(doc)
  transact(
    doc,
    () => {
      for (const id of live) {
        if (isTreeId(id)) setNodeProps(doc, id, { [flag]: value ? true : null })
        else setPropsAt(doc, id, { hidden: value }, { resolver })
      }
    },
    { origin },
  )
}

/** Apply a per-node style patch to every ref (real or virtual) in one commit. */
export function patchStyles(
  doc: LoroDoc,
  ids: readonly string[],
  patchFor: (styles: Styles, id: string) => StylePatch | null,
  origin: string = ORIGIN.inspector,
) {
  const live = liveRefs(doc, ids)
  if (live.length === 0) return
  const resolver = resolverOf(doc)
  transact(
    doc,
    () => {
      for (const id of live) {
        const node = resolver.resolveNode(id)
        if (!node) continue
        const patch = patchFor(node.styles, id)
        if (patch && Object.keys(patch).length > 0) setStylesAt(doc, id, patch, { resolver })
      }
    },
    { origin },
  )
}

/**
 * Style patch plus scalar props per node in ONE commit (image replace/remove: the fill or
 * `assetId` changes together with the displayed file name).
 */
export function patchStylesAndProps(
  doc: LoroDoc,
  ids: readonly string[],
  patchFor: (styles: Styles, id: string) => StylePatch | null,
  props: NodePropsPatch | null,
  origin: string = ORIGIN.inspector,
) {
  const live = liveRefs(doc, ids)
  if (live.length === 0) return
  const resolver = resolverOf(doc)
  transact(
    doc,
    () => {
      for (const id of live) {
        const node = resolver.resolveNode(id)
        if (!node) continue
        const patch = patchFor(node.styles, id)
        if (patch && Object.keys(patch).length > 0) setStylesAt(doc, id, patch, { resolver })
        if (props) {
          if (isTreeId(id)) setNodeProps(doc, id, props)
          else {
            const virtualProps: Parameters<typeof setPropsAt>[2] = {}
            if (props.assetId !== undefined) virtualProps.assetId = props.assetId
            if (props.assetName !== undefined) virtualProps.assetName = props.assetName
            if (props.hidden !== undefined) virtualProps.hidden = props.hidden
            setPropsAt(doc, id, virtualProps, { resolver })
          }
        }
      }
    },
    { origin },
  )
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * Delete real nodes (topmost only; pages kept), hide virtual ones (override), delete groups
 * the deletion empties and refit the others — schema `removeNodes` in one commit.
 */
export function deleteNodes(
  doc: LoroDoc,
  ids: readonly string[],
  origin: string = ORIGIN.menu,
  geo: GeometrySource = docGeometry(doc, resolverOf(doc)),
) {
  const live = liveRefs(doc, ids).filter((id) => !isTreeId(id) || getNodeType(doc, id) !== 'page')
  if (live.length === 0) return
  removeNodes(doc, live, geo, { origin })
}

/** Bring to front = last child (paints on top); send to back = first child. */
export function reorder(doc: LoroDoc, ids: readonly string[], where: 'front' | 'back') {
  const top = topmostIds(doc, ids)
  if (top.length === 0) return
  transact(
    doc,
    () => {
      const list = where === 'front' ? top : [...top].reverse()
      for (const id of list) {
        const parent = getParentId(doc, id)
        if (parent === null) continue
        const count = getChildIds(doc, parent).length
        moveNode(doc, id, parent, where === 'front' ? count - 1 : 0)
      }
    },
    { origin: ORIGIN.menu },
  )
}

export function addFlexLayout(doc: LoroDoc, ids: readonly string[]) {
  const frames = ids.filter((id) => hasNode(doc, id) && getNodeType(doc, id) === 'frame')
  patchStyles(doc, frames, (styles) => (styles['display'] === 'flex' ? null : addFlexPatch()))
}

export function removeFlexLayout(doc: LoroDoc, ids: readonly string[]) {
  patchStyles(doc, ids, () => removeFlexPatch())
}

/**
 * Wrap the selection in a new frame (schema `wrapInFrame`: rotation-aware; flow items of a
 * flex parent get a flex frame in the flow, everything else an absolute frame sized to the
 * union). `geo` comes from the canvas (`canvas.geometry()`).
 */
export function wrapInFrame(
  doc: LoroDoc,
  ids: readonly string[],
  geo: GeometrySource | BoundsOf,
): string | null {
  const live = ids.filter((id) => hasNode(doc, id))
  if (live.length === 0) return null
  return schemaWrapInFrame(doc, live, asGeometry(doc, geo), { origin: ORIGIN.menu })
}

/** A `GeometrySource` from the canvas, or from axis-aligned bounds (tests, fallbacks). */
export function asGeometry(doc: LoroDoc, geo: GeometrySource | BoundsOf): GeometrySource {
  if (typeof geo !== 'function') return geo
  const declared = docGeometry(doc, resolverOf(doc))
  return {
    frameOf: (id) => {
      const b = geo(id)
      return b ? { ...b, rotation: 0 } : declared.frameOf(id)
    },
  }
}

export function unionRect(rects: readonly Rect[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * Layers-panel drag and drop: move `ids` under `parentId` at slot `index` (an index into the
 * parent's current child list, as the drop indicator shows it). Schema `reparentNodes` keeps
 * world positions across contexts (page, absolute, flex flow, groups), fixes the containing
 * block, assigns node keys inside mains, refuses component cycles, refits and deletes
 * emptied groups — one commit (`editor:layers`). Returns false when refused.
 */
export function moveLayers(
  doc: LoroDoc,
  ids: readonly string[],
  parentId: string,
  index: number,
  geo: GeometrySource | BoundsOf,
): boolean {
  if (!hasNode(doc, parentId)) return false
  const top = topmostIds(doc, ids).filter(
    (id) =>
      getNodeType(doc, id) !== 'page' &&
      id !== parentId &&
      !ancestorsOf(doc, parentId).includes(id),
  )
  if (top.length === 0) return false
  // Slot in the current list → final index of the first moved node (moved nodes that sit
  // before the slot in the same parent free their places).
  const siblings = getChildIds(doc, parentId)
  const before = top.filter((id) => {
    const i = siblings.indexOf(id)
    return i !== -1 && i < index
  }).length
  const moved = reparentNodes(
    doc,
    top.map((id) => ({ id })),
    { parentId, index: Math.max(0, index - before) },
    asGeometry(doc, geo),
    { origin: ORIGIN.layers },
  )
  return moved.length > 0
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function createPage(doc: LoroDoc, name: string, background = '#EEEEEE'): string {
  let id = ''
  transact(
    doc,
    () => {
      id = createNode(doc, { type: 'page', parentId: null, name, background })
    },
    { origin: ORIGIN.pages },
  )
  return id
}

export function nextPageName(doc: LoroDoc): string {
  const names = new Set(getChildIds(doc, null).map((id) => getNode(doc, id)?.name ?? ''))
  for (let i = names.size + 1; ; i++) {
    const n = `Page ${i}`
    if (!names.has(n)) return n
  }
}

export function deletePage(doc: LoroDoc, pageId: string): boolean {
  const pages = getChildIds(doc, null)
  if (pages.length <= 1 || !pages.includes(pageId)) return false
  transact(doc, () => deleteNode(doc, pageId), { origin: ORIGIN.pages })
  return true
}

export function setPageBackground(doc: LoroDoc, pageId: string, color: string) {
  if (!hasNode(doc, pageId)) return
  transact(doc, () => setNodeProps(doc, pageId, { background: color }), {
    origin: ORIGIN.inspector,
  })
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export interface ClipNode {
  type: NodeType
  name: string
  styles: Styles
  text?: string
  svg?: string
  assetId?: string
  assetName?: string
  locked?: boolean
  hidden?: boolean
  children: ClipNode[]
}

export interface ClipPayload {
  kind: 'baren/nodes'
  version: 1
  nodes: ClipNode[]
}

export function isClipPayload(value: unknown): value is ClipPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<ClipPayload>
  return v.kind === 'baren/nodes' && v.version === 1 && Array.isArray(v.nodes)
}

function toClip(nodes: Record<string, DesignNode>, id: string): ClipNode | null {
  const n = nodes[id]
  if (!n) return null
  const out: ClipNode = { type: n.type, name: n.name, styles: { ...n.styles }, children: [] }
  if (n.text !== undefined) out.text = n.text
  if (n.svg !== undefined) out.svg = n.svg
  if (n.assetId !== undefined) out.assetId = n.assetId
  if (n.assetName !== undefined) out.assetName = n.assetName
  if (n.locked) out.locked = true
  if (n.hidden) out.hidden = true
  for (const c of n.children) {
    const child = toClip(nodes, c)
    if (child) out.children.push(child)
  }
  return out
}

export function serializeNodes(doc: LoroDoc, ids: readonly string[]): ClipPayload | null {
  const out: ClipNode[] = []
  for (const id of topmostIds(doc, ids)) {
    if (getNodeType(doc, id) === 'page') continue
    const sub = toSubtreeSnapshot(doc, id)
    const clip = sub ? toClip(sub.nodes, id) : null
    if (clip) out.push(clip)
  }
  return out.length > 0 ? { kind: 'baren/nodes', version: 1, nodes: out } : null
}

function createClip(doc: LoroDoc, clip: ClipNode, parentId: string, index?: number): string {
  const id = createNode(doc, {
    type: clip.type === 'page' ? 'frame' : clip.type,
    parentId,
    ...(index !== undefined ? { index } : {}),
    name: clip.name,
    styles: clip.styles,
    ...(clip.type === 'text' ? { text: clip.text ?? '' } : {}),
    ...(clip.svg !== undefined ? { svg: clip.svg } : {}),
    ...(clip.assetId !== undefined ? { assetId: clip.assetId } : {}),
    ...(clip.assetName !== undefined ? { assetName: clip.assetName } : {}),
    ...(clip.locked ? { locked: true } : {}),
    ...(clip.hidden ? { hidden: true } : {}),
  })
  if (clip.type === 'frame' || clip.type === 'page') {
    for (const child of clip.children) createClip(doc, child, id)
  }
  return id
}

export interface PasteTarget {
  /** Page or frame receiving the nodes. */
  parentId: string
  index?: number
  /** For page-level pastes: where to put the top-left of the pasted group (world). */
  at?: { x: number; y: number }
  /** For page-level pastes without `at`: shift relative to the source position. */
  offset?: number
}

/** Paste a payload; returns the new top-level ids (one commit). */
export function pasteNodes(doc: LoroDoc, payload: ClipPayload, target: PasteTarget): string[] {
  if (!hasNode(doc, target.parentId)) return []
  const parentType = getNodeType(doc, target.parentId)
  if (parentType !== 'page' && parentType !== 'frame') return []
  const toPage = parentType === 'page'
  const ids: string[] = []
  transact(
    doc,
    () => {
      const lefts = payload.nodes.map((n) => toPx(n.styles['left']) ?? 0)
      const tops = payload.nodes.map((n) => toPx(n.styles['top']) ?? 0)
      const minX = Math.min(...lefts)
      const minY = Math.min(...tops)
      payload.nodes.forEach((clip, i) => {
        const styles = { ...clip.styles }
        if (toPage) {
          const x = lefts[i] ?? 0
          const y = tops[i] ?? 0
          const nx = target.at ? target.at.x + (x - minX) : x + (target.offset ?? 0)
          const ny = target.at ? target.at.y + (y - minY) : y + (target.offset ?? 0)
          styles['left'] = pxValue(styles['left'], Math.round(nx))
          styles['top'] = pxValue(styles['top'], Math.round(ny))
          delete styles['position']
        } else if (styles['position'] !== 'absolute') {
          delete styles['left']
          delete styles['top']
        }
        const index = target.index === undefined ? undefined : target.index + i
        ids.push(createClip(doc, { ...clip, styles }, target.parentId, index))
      })
    },
    { origin: ORIGIN.clipboard },
  )
  return ids
}

/** A text layer from pasted plain text. */
export function pasteText(
  doc: LoroDoc,
  text: string,
  parentId: string,
  at: { x: number; y: number } | null,
): string | null {
  if (!hasNode(doc, parentId)) return null
  const toPage = getNodeType(doc, parentId) === 'page'
  let id: string | null = null
  transact(
    doc,
    () => {
      const styles: Styles = {
        fontFamily: 'Inter',
        fontSize: '16px',
        lineHeight: '20px',
        color: '#000000',
      }
      if (toPage && at) {
        styles['left'] = Math.round(at.x)
        styles['top'] = Math.round(at.y)
      }
      id = createNode(doc, {
        type: 'text',
        parentId,
        name: text.slice(0, 40).replace(/\s+/g, ' ').trim() || 'Text',
        text,
        styles,
      })
    },
    { origin: ORIGIN.clipboard },
  )
  return id
}

/** An image layer for an uploaded asset (image tool, paste, drop). */
export function insertImage(
  doc: LoroDoc,
  parentId: string,
  assetId: string,
  size: { width: number; height: number },
  at: { x: number; y: number } | null,
  name = 'Image',
): string | null {
  if (!hasNode(doc, parentId)) return null
  const toPage = getNodeType(doc, parentId) === 'page'
  let id: string | null = null
  transact(
    doc,
    () => {
      const styles: Styles = { width: Math.round(size.width), height: Math.round(size.height) }
      if (toPage && at) {
        styles['left'] = Math.round(at.x)
        styles['top'] = Math.round(at.y)
      }
      id = createNode(doc, { type: 'image', parentId, name, assetId, styles })
    },
    { origin: ORIGIN.clipboard },
  )
  return id
}

/**
 * Resolve a paste/insert target from the selection: inside a selected frame, else beside it
 * (a group child's group, an instance's own parent — never inside instance content). Like the
 * canvas drop targets, a locked or hidden container (or one inside a locked or hidden
 * ancestor) is never a target: the content goes beside the outermost such ancestor instead.
 */
export function containerForInsert(
  doc: LoroDoc,
  selection: readonly string[],
  pageId: string,
): string {
  const first = selection[0]
  if (first === undefined) return pageId
  const real = realIdOf(first)
  if (!hasNode(doc, real)) return pageId
  const candidate =
    real === first && getNodeType(doc, real) === 'frame' ? real : (getParentId(doc, real) ?? pageId)
  let target = candidate
  for (let id: string | null = candidate; id !== null; id = getParentId(doc, id)) {
    const n = getNode(doc, id)
    if (!n || n.type === 'page') break
    if (n.locked === true || n.hidden === true) target = n.parentId ?? pageId
  }
  return target
}

export { isTop as isTopLevel }
