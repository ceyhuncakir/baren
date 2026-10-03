import { assetRefsInValue, readRotation, type NodeFrame } from '@baren/schema'
import type { IndexedNode } from '../math/hit.ts'
import type { Point, Rect } from '../types.ts'
import { MISSING_FILL_COLOR, isTaintFree, type AssetUrlCache } from './assets.ts'
import { backgroundTiles, fitImage } from './imageFit.ts'
import { NODE_ID_ATTR, type Scene, type SceneNode } from './scene.ts'
import { clipsContent, pxValue } from './styles.ts'

/** Drawing instructions for a level-of-detail thumbnail (artboard-local coordinates). */
export type ThumbOp =
  | {
      kind: 'box'
      rect: Rect
      fill: string | null
      radius: number
      stroke: string | null
      strokeWidth: number
      alpha: number
      /** Degrees about the centre of `rect` (then `rect` is the unrotated box). */
      rotation?: number
    }
  | {
      kind: 'path'
      /** Unrotated local box of the vector; the path is in its local px. */
      rect: Rect
      rotation: number
      d: string
      fillRule: CanvasFillRule
      fill: string | null
      stroke: string | null
      strokeWidth: number
      alpha: number
    }
  | { kind: 'text'; lines: Rect[]; color: string; alpha: number }
  | {
      kind: 'image'
      /** The element box; `clip` bounds what is painted (overflow, radius). */
      rect: Rect
      clip: Rect
      radius: number
      image: CanvasImageSource & { naturalWidth: number; naturalHeight: number }
      /** object-fit / object-position (image layers). */
      fit: string
      position: string
      alpha: number
    }
  | {
      kind: 'fill'
      /** Background painting area (the border box) and its clip. */
      rect: Rect
      clip: Rect
      radius: number
      image: CanvasImageSource & { naturalWidth: number; naturalHeight: number }
      /** Computed background-size / -position / -repeat. */
      size: string
      position: string
      repeat: string
      alpha: number
    }

export interface MeasureResult {
  /** Root border-box size in world px. */
  size: { width: number; height: number }
  /** Index items (world coordinates, clipped bboxes). */
  items: IndexedNode[]
  /** Unclipped world rect per node id (axis-aligned bounds for rotated nodes). */
  rects: Map<string, Rect>
  /** World frames of nodes whose accumulated rotation is not 0. */
  frames: Map<string, NodeFrame>
  /** Union of all visible boxes (world), including overflow outside the root. */
  extent: Rect
  thumbOps: ThumbOp[] | null
  /** Assets the thumbnail drew as placeholders because they were still loading. */
  thumbWaiting: Set<string> | null
}

const TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)'])

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.width, b.x + b.width)
  const btm = Math.min(a.y + a.height, b.y + b.height)
  if (r < x || btm < y) return null
  return { x, y, width: r - x, height: btm - y }
}

const INFINITE: Rect = { x: -1e12, y: -1e12, width: 2e12, height: 2e12 }

/**
 * Unrotated size of an element whose accumulated rotation is `deg` and whose axis-aligned
 * bounds are `w × h` (fallback for SVG elements without px sizes; exact away from 45°).
 */
export function unrotatedSize(
  w: number,
  h: number,
  deg: number,
): { width: number; height: number } {
  const rad = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  const det = c * c - s * s
  if (Math.abs(det) < 0.1) {
    const side = Math.max(w, h) / (c + s)
    return { width: side, height: side }
  }
  return {
    width: Math.max(0, (w * c - h * s) / det),
    height: Math.max(0, (h * c - w * s) / det),
  }
}

/**
 * The unrotated layout size of a rendered node: declared px sizes for SVG elements (vectors,
 * svg layers), `offsetWidth/offsetHeight` for HTML (layout sizes ignore transforms and are
 * already in world px: the zoom is a transform on the world layer).
 */
export function layoutSize(
  el: Element,
  styles: Record<string, unknown>,
  aabb: { width: number; height: number },
  deg: number,
): { width: number; height: number } {
  if (el instanceof HTMLElement) return { width: el.offsetWidth, height: el.offsetHeight }
  const w = pxValue(styles['width'] as never)
  const h = pxValue(styles['height'] as never)
  if (w !== null && h !== null) return { width: w, height: h }
  const est = unrotatedSize(aabb.width, aabb.height, deg)
  return { width: w ?? est.width, height: h ?? est.height }
}

/**
 * Measure a rendered scene. Pure DOM reads (getBoundingClientRect,
 * getComputedStyle for thumbnails) — run in the frame's read phase only.
 *
 * @param origin world position of the scene root's top-left corner
 * @param scale  screen px per world px of the context the scene is laid out in
 *               (the viewport zoom when live, 1 in the measuring host)
 */
export function measureScene(
  scene: Scene,
  origin: Point,
  scale: number,
  withThumb: boolean,
  assets?: AssetUrlCache,
  /** Screen rotation of the root (its own rotation when live; 0 when counter-rotated). */
  rootRotation = readRotation(scene.root.styles),
): MeasureResult {
  const rootEl = scene.rootEl
  const rootRect = rootEl.getBoundingClientRect()
  const inv = 1 / scale
  const items: IndexedNode[] = []
  const rects = new Map<string, Rect>()
  const frames = new Map<string, NodeFrame>()
  const thumbOps: ThumbOp[] | null = withThumb ? [] : null
  const waiting: Set<string> | null = withThumb ? new Set() : null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let range: Range | null = null

  interface Frame {
    node: SceneNode
    depth: number
    clip: Rect
    /** Accumulated rotation of the parent (screen space). */
    rot: number
  }
  const stack: Frame[] = [{ node: scene.root, depth: 0, clip: INFINITE, rot: 0 }]
  let order = 0
  for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
    const { node, depth, clip } = f
    if (node.hidden) continue
    const rot = node === scene.root ? rootRotation : f.rot + readRotation(node.styles)
    const r = node.el.getBoundingClientRect()
    const local: Rect = {
      x: (r.left - rootRect.left) * inv,
      y: (r.top - rootRect.top) * inv,
      width: r.width * inv,
      height: r.height * inv,
    }
    const world: Rect = {
      x: origin.x + local.x,
      y: origin.y + local.y,
      width: local.width,
      height: local.height,
    }
    rects.set(node.id, world)
    let frame: NodeFrame | undefined
    if (rot !== 0) {
      const size = layoutSize(node.el, node.styles, world, rot)
      const cx = world.x + world.width / 2
      const cy = world.y + world.height / 2
      frame = {
        x: cx - size.width / 2,
        y: cy - size.height / 2,
        width: size.width,
        height: size.height,
        rotation: rot,
      }
      frames.set(node.id, frame)
    }
    const visible = intersect(world, clip)
    if (visible) {
      const item: IndexedNode = {
        minX: visible.x,
        minY: visible.y,
        maxX: visible.x + visible.width,
        maxY: visible.y + visible.height,
        id: node.id,
        parentId: node.parentId,
        depth,
        order: order++,
        rect: world,
      }
      if (frame) item.frame = frame
      items.push(item)
      if (visible.x < minX) minX = visible.x
      if (visible.y < minY) minY = visible.y
      if (visible.x + visible.width > maxX) maxX = visible.x + visible.width
      if (visible.y + visible.height > maxY) maxY = visible.y + visible.height
      if (thumbOps) {
        range ??= document.createRange()
        collectThumbOp(
          node,
          local,
          intersect(local, translateRect(clip, -origin.x, -origin.y)) ?? local,
          frame ? { ...frame, x: frame.x - origin.x, y: frame.y - origin.y } : null,
          thumbOps,
          range,
          rootRect,
          inv,
          assets,
          waiting as Set<string>,
        )
      }
    }
    const childClip = clipsContent(node.styles)
      ? (intersect(world, clip) ?? { x: world.x, y: world.y, width: 0, height: 0 })
      : clip
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = scene.nodes.get(node.children[i] as string)
      if (child) stack.push({ node: child, depth: depth + 1, clip: childClip, rot })
    }
  }

  const size =
    rootRotation !== 0
      ? layoutSize(
          rootEl,
          scene.root.styles,
          { width: rootRect.width * inv, height: rootRect.height * inv },
          rootRotation,
        )
      : { width: rootRect.width * inv, height: rootRect.height * inv }
  const extent: Rect =
    minX === Infinity
      ? { x: origin.x, y: origin.y, width: size.width, height: size.height }
      : { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  return { size, items, rects, frames, extent, thumbOps, thumbWaiting: waiting }
}

function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }
}

type Drawable = CanvasImageSource & { naturalWidth: number; naturalHeight: number }

function placeholderBox(rect: Rect, radius: number, alpha: number): ThumbOp {
  return {
    kind: 'box',
    rect,
    fill: MISSING_FILL_COLOR,
    radius,
    stroke: null,
    strokeWidth: 0,
    alpha,
  }
}

/** A drawable for `assetId`: the decoded asset, or null (placeholder) while it loads. */
/** Paint properties an SVG image cannot resolve by itself (no document, no custom properties). */
const SVG_PAINTS = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color']

/**
 * A rendered SVG layer as standalone markup for an image of `box` size: its sanitised content
 * without the layer's own box styles (the thumbnail applies opacity and clipping), and with
 * `var(--token)` / `currentColor` paints replaced by what the canvas computed for them.
 */
export function svgThumbMarkup(el: Element, box: Rect): string {
  const clone = el.cloneNode(true) as Element
  for (const name of ['style', 'class', NODE_ID_ATTR]) clone.removeAttribute(name)
  clone.setAttribute('width', String(Math.max(1, Math.round(box.width))))
  clone.setAttribute('height', String(Math.max(1, Math.round(box.height))))
  if (/var\(|currentcolor/i.test(el.outerHTML)) {
    const from = [el, ...el.querySelectorAll('*')]
    const to = [clone, ...clone.querySelectorAll('*')]
    from.forEach((source, i) => {
      const target = to[i] as SVGElement | undefined
      if (!target?.style) return
      const cs = getComputedStyle(source)
      for (const prop of SVG_PAINTS) {
        const value = cs.getPropertyValue(prop)
        if (value) target.style.setProperty(prop, value)
      }
    })
  }
  return new XMLSerializer().serializeToString(clone)
}

function assetImage(
  assetId: string | undefined,
  assets: AssetUrlCache | undefined,
  waiting: Set<string>,
): Drawable | null {
  if (!assetId || !assets) return null
  if (assets.isMissing(assetId)) return null
  const img = assets.drawable(assetId)
  if (!img && !assets.isUndrawable(assetId)) waiting.add(assetId)
  return img
}

function collectThumbOp(
  node: SceneNode,
  local: Rect,
  clipped: Rect,
  /** Root-local frame for rotated nodes. */
  frame: NodeFrame | null,
  out: ThumbOp[],
  range: Range,
  rootRect: DOMRect,
  inv: number,
  assets: AssetUrlCache | undefined,
  waiting: Set<string>,
): void {
  const cs = getComputedStyle(node.el)
  const alpha = Number(cs.opacity) || 0
  if (alpha <= 0) return
  const radius = parseFloat(cs.borderTopLeftRadius) || 0
  if (node.type === 'image') {
    const el = node.el
    // The element itself only when drawing it cannot taint the thumbnail canvas.
    const image: Drawable | null =
      el instanceof HTMLImageElement &&
      el.complete &&
      el.naturalWidth > 0 &&
      isTaintFree(el.currentSrc || el.src)
        ? el
        : assetImage(node.assetId, assets, waiting)
    if (image)
      out.push({
        kind: 'image',
        rect: local,
        clip: clipped,
        radius,
        image,
        fit: cs.objectFit,
        position: cs.objectPosition,
        alpha,
      })
    else out.push(placeholderBox(clipped, radius, alpha))
    return
  }
  if (node.type === 'vector') {
    const path = node.el.firstElementChild
    const d = path?.getAttribute('d') ?? ''
    if (!d) return
    const pcs = path ? getComputedStyle(path) : cs
    const fill = pcs.fill && pcs.fill !== 'none' && !TRANSPARENT.has(pcs.fill) ? pcs.fill : null
    const stroke =
      pcs.stroke && pcs.stroke !== 'none' && !TRANSPARENT.has(pcs.stroke) ? pcs.stroke : null
    out.push({
      kind: 'path',
      rect: frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : local,
      rotation: frame?.rotation ?? 0,
      d,
      fillRule: path?.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero',
      fill,
      stroke,
      strokeWidth: parseFloat(pcs.strokeWidth) || 0,
      alpha,
    })
    return
  }
  if (node.type === 'svg') {
    // Drawn as an image of its own markup once decoded (the thumbnail waits for it); a
    // neutral box only when it cannot be drawn (rotated layers, undecodable markup).
    const svg = !frame && assets ? assets.svgDrawable(svgThumbMarkup(node.el, local)) : null
    if (svg?.image) {
      out.push({
        kind: 'image',
        rect: local,
        clip: clipped,
        radius,
        image: svg.image,
        fit: 'fill',
        position: '50% 50%',
        alpha,
      })
    } else if (svg && !svg.failed) {
      waiting.add(svg.key)
    } else {
      out.push({
        kind: 'box',
        rect: clipped,
        fill: 'rgba(128,128,128,0.35)',
        radius: 0,
        stroke: null,
        strokeWidth: 0,
        alpha,
      })
    }
    return
  }
  const bg = cs.backgroundColor
  const borderWidth = cs.borderTopStyle !== 'none' ? parseFloat(cs.borderTopWidth) || 0 : 0
  const fill = TRANSPARENT.has(bg) ? null : bg
  const stroke = borderWidth > 0 && !TRANSPARENT.has(cs.borderTopColor) ? cs.borderTopColor : null
  const rotated = frame
    ? {
        rect: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
        rotation: frame.rotation,
      }
    : null
  if (fill) {
    out.push(
      rotated
        ? { kind: 'box', ...rotated, fill, radius, stroke: null, strokeWidth: 0, alpha }
        : { kind: 'box', rect: clipped, fill, radius, stroke: null, strokeWidth: 0, alpha },
    )
  }
  // Image fill (one fill per layer: the first asset of the background image).
  const imageValue = node.styles['backgroundImage'] ?? node.styles['background']
  const fillAsset = typeof imageValue === 'string' ? assetRefsInValue(imageValue)[0] : undefined
  if (fillAsset !== undefined) {
    const image = assetImage(fillAsset, assets, waiting)
    if (image)
      out.push({
        kind: 'fill',
        rect: local,
        clip: clipped,
        radius,
        image,
        size: cs.backgroundSize,
        position: cs.backgroundPosition,
        repeat: cs.backgroundRepeat,
        alpha,
      })
    else out.push(placeholderBox(clipped, radius, alpha))
  }
  if (stroke) {
    out.push({
      kind: 'box',
      ...(rotated ?? { rect: clipped }),
      fill: null,
      radius,
      stroke,
      strokeWidth: borderWidth,
      alpha,
    })
  }
  if (node.type === 'text' && node.el.firstChild) {
    range.selectNodeContents(node.el)
    const lines: Rect[] = []
    for (const lr of Array.from(range.getClientRects())) {
      if (lr.width <= 0 || lr.height <= 0) continue
      const line: Rect = {
        x: (lr.left - rootRect.left) * inv,
        y: (lr.top - rootRect.top) * inv,
        width: lr.width * inv,
        height: lr.height * inv,
      }
      const c = intersect(line, clipped)
      if (c) lines.push(c)
    }
    if (lines.length > 0) out.push({ kind: 'text', lines, color: cs.color, alpha })
  }
}

function clipTo(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  r: Rect,
  radius: number,
): void {
  ctx.beginPath()
  const rr = Math.min(radius, r.width / 2, r.height / 2)
  if (rr > 0.5) ctx.roundRect(r.x, r.y, r.width, r.height, rr)
  else ctx.rect(r.x, r.y, r.width, r.height)
  ctx.clip()
}

/** Paint thumbnail ops into `canvas` (sized by the caller) at `scale` canvas px per world px. */
export function drawThumbnail(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  ops: readonly ThumbOp[],
  scale: number,
): void {
  const ctx = canvas.getContext('2d', { alpha: true }) as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.imageSmoothingQuality = 'medium'
  for (const op of ops) {
    ctx.globalAlpha = op.alpha
    if (op.kind === 'box') {
      const { x, y, width, height } = op.rect
      const r = Math.min(op.radius, width / 2, height / 2)
      if (op.rotation) {
        ctx.save()
        ctx.translate(x + width / 2, y + height / 2)
        ctx.rotate((op.rotation * Math.PI) / 180)
        ctx.translate(-x - width / 2, -y - height / 2)
      }
      ctx.beginPath()
      if (r > 0.5) ctx.roundRect(x, y, width, height, r)
      else ctx.rect(x, y, width, height)
      if (op.fill) {
        ctx.fillStyle = op.fill
        ctx.fill()
      }
      if (op.stroke) {
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = Math.max(op.strokeWidth, 1 / scale)
        ctx.stroke()
      }
      if (op.rotation) ctx.restore()
    } else if (op.kind === 'path') {
      const { x, y, width, height } = op.rect
      ctx.save()
      try {
        ctx.translate(x + width / 2, y + height / 2)
        if (op.rotation) ctx.rotate((op.rotation * Math.PI) / 180)
        ctx.translate(-width / 2, -height / 2)
        const path = new Path2D(op.d)
        if (op.fill) {
          ctx.fillStyle = op.fill
          ctx.fill(path, op.fillRule)
        }
        if (op.stroke && op.strokeWidth > 0) {
          ctx.strokeStyle = op.stroke
          ctx.lineWidth = Math.max(op.strokeWidth, 1 / scale)
          ctx.stroke(path)
        }
      } catch {
        // Invalid path data: skip.
      } finally {
        ctx.restore()
      }
    } else if (op.kind === 'text') {
      ctx.fillStyle = op.color
      ctx.globalAlpha = op.alpha * 0.8
      for (const l of op.lines) {
        const h = Math.max(l.height * 0.45, 1 / scale)
        ctx.fillRect(l.x, l.y + (l.height - h) / 2, l.width, h)
      }
    } else {
      const { naturalWidth: iw, naturalHeight: ih } = op.image
      if (!(iw > 0 && ih > 0)) continue
      ctx.save()
      try {
        clipTo(ctx, op.clip, op.radius)
        if (op.kind === 'image') {
          const d = fitImage(iw, ih, op.rect, op.fit, op.position)
          ctx.drawImage(op.image, d.x, d.y, d.width, d.height)
        } else {
          for (const t of backgroundTiles(iw, ih, op.rect, op.size, op.position, op.repeat, 400))
            ctx.drawImage(op.image, t.x, t.y, t.width, t.height)
        }
      } catch {
        // Undecodable image: skip.
      } finally {
        ctx.restore()
      }
    }
  }
  ctx.globalAlpha = 1
}
