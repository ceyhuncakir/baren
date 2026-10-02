import type RBush from 'rbush'
import {
  frameAabb,
  readRotation,
  type DesignNode,
  type NodeFrame,
  type NodeType,
  type Styles,
} from '@baren/schema'
import type { IndexedNode } from '../math/hit.ts'
import { toBBox, unionRects } from '../math/rect.ts'
import type { Point, Rect } from '../types.ts'
import type { Scene } from './scene.ts'
import { pxValue, stylesToCssText, type AssetCssRewrite } from './styles.ts'

/** Where a top-level node's scene DOM currently lives. */
export type Where = 'none' | 'live' | 'offscreen' | 'measure'

export interface TopItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

/** A direct child of the page (usually an artboard) and its rendering state. */
export interface TopRecord {
  id: string
  order: number
  type: NodeType
  name: string
  styles: Styles
  hidden: boolean
  locked: boolean
  /** Main components (frames with a component key) and instances. */
  componentKey: string | null
  /** Frame box in world px (the unrotated box; see `rotation`). */
  bounds: Rect
  /** Own rotation in degrees (about the centre of `bounds`). */
  rotation: number
  /** Visible extent incl. overflow (what the top-level index stores). */
  extent: Rect
  measuredSize: { width: number; height: number } | null
  wrapper: HTMLDivElement
  standin: HTMLDivElement
  /** LOD thumbnail: a plain <img> (painted into the world layer; canvases would each be a compositor layer). */
  thumb: HTMLImageElement | null
  thumbUrl: string | null
  thumbVersion: number
  scene: Scene | null
  where: Where
  contentVersion: number
  measuredVersion: number
  index: RBush<IndexedNode> | null
  rects: Map<string, Rect> | null
  /** World frames of measured nodes with a non-zero accumulated rotation. */
  frames: Map<string, NodeFrame> | null
  /** Component keys the loaded scene's instances depend on (kept after disposal, for thumbnails). */
  instanceDeps: ReadonlySet<string> | null
  lastUsed: number
  item: TopItem
  /** World-space offset applied while a move gesture previews this node. */
  preview: Point | null
  /** Shrink-to-fit container used while the scene is laid out in the measuring host. */
  measureWrap: HTMLDivElement | null
  /** Assets the last thumbnail had to draw as placeholders because they were still loading. */
  thumbWaiting: ReadonlySet<string> | null
}

export const DEFAULT_TOP_SIZE = 100

/** Artboard styles the stand-in copies (so LOD boxes keep their fill and shape). */
const STANDIN_KEYS: ReadonlySet<string> = new Set([
  'background',
  'backgroundColor',
  'backgroundImage',
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'borderRadius',
  'opacity',
])

/** Wrapper (positioned in the world layer) + stand-in for a top-level node. */
export function createTopRecord(
  node: DesignNode,
  order: number,
  rewrite?: AssetCssRewrite,
): TopRecord {
  const wrapper = document.createElement('div')
  wrapper.className = 'ic-top'
  wrapper.setAttribute('data-top', node.id)
  const standin = document.createElement('div')
  standin.className = 'ic-standin'
  wrapper.appendChild(standin)
  const empty = { x: 0, y: 0, width: DEFAULT_TOP_SIZE, height: DEFAULT_TOP_SIZE }
  const rec: TopRecord = {
    id: node.id,
    order,
    type: node.type,
    name: node.name,
    styles: { ...node.styles },
    hidden: node.hidden === true,
    locked: node.locked === true,
    componentKey: node.componentKey ?? null,
    bounds: empty,
    rotation: 0,
    extent: empty,
    measuredSize: null,
    wrapper,
    standin,
    thumb: null,
    thumbUrl: null,
    thumbVersion: -1,
    scene: null,
    where: 'none',
    contentVersion: 0,
    measuredVersion: -1,
    index: null,
    rects: null,
    frames: null,
    instanceDeps: null,
    lastUsed: 0,
    item: { minX: 0, minY: 0, maxX: 0, maxY: 0, id: node.id },
    preview: null,
    measureWrap: null,
    thumbWaiting: null,
  }
  computeTopBounds(rec)
  rec.item = { ...toBBox(rec.extent), id: rec.id }
  applyTopWrapper(rec)
  applyStandinStyles(rec, rewrite)
  if (rec.hidden) wrapper.classList.add('ic-hidden')
  return rec
}

/** Declared bounds from styles; unknown sizes fall back to the last measurement. */
export function computeTopBounds(rec: TopRecord): void {
  const s = rec.styles
  const x = pxValue(s['left']) ?? 0
  const y = pxValue(s['top']) ?? 0
  const w = pxValue(s['width']) ?? rec.measuredSize?.width ?? DEFAULT_TOP_SIZE
  const h = pxValue(s['height']) ?? rec.measuredSize?.height ?? Math.round(w * 0.625)
  rec.bounds = { x, y, width: w, height: h }
  rec.rotation = readRotation(s)
  const box = topAabb(rec)
  rec.extent = rec.measuredVersion >= 0 ? (unionRects([box, rec.extent]) ?? box) : box
}

/** The record's world frame (unrotated box + own rotation). */
export function topFrame(rec: TopRecord): NodeFrame {
  return { ...rec.bounds, rotation: rec.rotation }
}

/** Axis-aligned bounds of the (possibly rotated) top-level box. */
export function topAabb(rec: TopRecord): Rect {
  return rec.rotation === 0 ? rec.bounds : frameAabb(topFrame(rec))
}

/** Position the wrapper (plus any move preview) and size the stand-in. */
export function applyTopWrapper(rec: TopRecord): void {
  const p = rec.preview
  const x = rec.bounds.x + (p?.x ?? 0)
  const y = rec.bounds.y + (p?.y ?? 0)
  rec.wrapper.style.transform = `translate(${x}px, ${y}px)`
  rec.standin.style.width = `${rec.bounds.width}px`
  rec.standin.style.height = `${rec.bounds.height}px`
  rec.standin.style.rotate = rec.rotation === 0 ? '' : `${rec.rotation}deg`
}

/** Stand-in box styles (fill, shape); image fills go through `rewrite` (asset URLs). */
export function applyStandinStyles(rec: TopRecord, rewrite?: AssetCssRewrite): void {
  const picked: Styles = {}
  for (const k of STANDIN_KEYS) {
    const v = rec.styles[k]
    if (v !== undefined) picked[k] = v
  }
  const css = stylesToCssText(picked, undefined, rewrite) ?? ''
  const rotate = rec.rotation === 0 ? '' : `rotate:${rec.rotation}deg;`
  rec.standin.style.cssText = `${css}width:${rec.bounds.width}px;height:${rec.bounds.height}px;${rotate}`
  rec.standin.classList.toggle('ic-hidden', rec.where === 'live')
}
