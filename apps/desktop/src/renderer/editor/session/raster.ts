/**
 * Renders a node subtree to PNG without touching the live canvas: the subtree is built as
 * static DOM (same conventions as @baren/canvas) in an off-screen host, measured, and
 * painted onto a 2D canvas (boxes, borders, radii, images, SVG, real text). Used for the
 * file thumbnail on exit and "Copy as PNG".
 *
 * Image layers honour object-fit/object-position; image fills (`url(baren-asset://…)`)
 * honour background-size/-position/-repeat and the fill opacity.
 *
 * Phase 3: the subtree is the resolved one (`toRenderSubtree`: instances expanded from their
 * mains), groups and instances are containers, vectors are drawn from the single path
 * generator with resolved paints (`vectorToSvgMarkup`), and rotated layers (own or inherited
 * `rotate`) are painted in their rotated frame.
 *
 * Not a full CSS painter: gradients, shadows and filters are skipped.
 */
import { backgroundTiles, fitImage, sanitizeSvg } from '@baren/canvas'
import {
  assetRefsInValue,
  getTokens,
  rewriteAssetUrls,
  toRenderSubtree,
  vectorToSvgMarkup,
  type DesignNode,
  type Token,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { cssEntries } from '../model/css'
import { imageOpacityOf } from '../model/imageFill'
import { resolverOf } from '../model/resolver'

type AssetUrl = (assetId: string) => Promise<string | null>

/** Decoded image fills of the built elements (drawn by `paint`). */
interface FillImage {
  image: HTMLImageElement
  opacity: number
}

async function decoded(url: string): Promise<HTMLImageElement | null> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
    return img
  } catch {
    return null
  }
}

function buildNode(
  nodes: Record<string, DesignNode>,
  id: string,
  assetUrl: AssetUrl,
  pending: Promise<unknown>[],
  root: boolean,
  fills: Map<HTMLElement, FillImage>,
  tokens: Record<string, Token>,
): HTMLElement | null {
  const node = nodes[id]
  if (!node || node.hidden) return null
  let el: HTMLElement
  switch (node.type) {
    case 'text':
      el = document.createElement('div')
      el.textContent = node.text ?? ''
      el.style.whiteSpace = 'pre-wrap'
      break
    case 'image': {
      const img = document.createElement('img')
      img.style.display = 'block'
      img.alt = ''
      if (node.assetId) {
        pending.push(
          assetUrl(node.assetId).then((url) => {
            if (!url) return
            img.src = url
            return img.decode().catch(() => undefined)
          }),
        )
      }
      el = img
      break
    }
    case 'svg':
      el = document.createElement('div')
      {
        const svg = sanitizeSvg(node.svg ?? '')
        if (svg) el.appendChild(svg)
      }
      break
    case 'vector':
      // Standalone markup with resolved paints (tokens substituted), like Copy as SVG.
      el = document.createElement('div')
      if (node.vector) {
        const svg = sanitizeSvg(vectorToSvgMarkup(node, tokens))
        if (svg) {
          svg.style.display = 'block'
          svg.style.overflow = 'visible'
          el.appendChild(svg)
        }
      }
      break
    default:
      el = document.createElement('div')
  }
  el.style.boxSizing = 'border-box'
  for (const [prop, value] of cssEntries(node.styles)) el.style.setProperty(prop, value)
  // Image fill: resolve the asset (the scheme may not exist here) and keep the decoded
  // image for painting; the element itself only keeps its size/position styles.
  const fillValue = node.styles['backgroundImage'] ?? node.styles['background']
  const fillAsset = typeof fillValue === 'string' ? assetRefsInValue(fillValue)[0] : undefined
  if (fillAsset !== undefined && typeof fillValue === 'string') {
    const target = el
    pending.push(
      assetUrl(fillAsset).then(async (url) => {
        const value = rewriteAssetUrls(fillValue, () => (url ? `url("${url}")` : 'none'))
        target.style.setProperty(
          node.styles['backgroundImage'] !== undefined ? 'background-image' : 'background',
          value,
        )
        const image = url ? await decoded(url) : null
        if (image) fills.set(target, { image, opacity: imageOpacityOf(fillValue) })
      }),
    )
  }
  // Groups are containing blocks for their absolutely positioned children (render rule 3.1).
  if (node.type === 'group' && node.styles['position'] !== 'absolute') {
    el.style.position = 'relative'
  }
  if (root) {
    el.style.position = 'relative'
    el.style.left = '0px'
    el.style.top = '0px'
    // The image shows the layer itself, upright.
    el.style.rotate = 'none'
  }
  el.dataset['nid'] = id
  if (
    node.type === 'frame' ||
    node.type === 'page' ||
    node.type === 'group' ||
    node.type === 'instance'
  ) {
    for (const c of node.children) {
      const child = buildNode(nodes, c, assetUrl, pending, false, fills, tokens)
      if (child) el.appendChild(child)
    }
  }
  return el
}

/** Own rotation of an element in degrees (`rotate`, or a rotation in `transform`). */
function rotationOf(cs: CSSStyleDeclaration): number {
  let deg = 0
  const r = cs.rotate
  if (r && r !== 'none') {
    const m = /(-?\d*\.?\d+(?:e-?\d+)?)(deg|rad|turn)?\s*$/.exec(r)
    if (m) {
      const n = Number(m[1])
      deg += m[2] === 'rad' ? (n * 180) / Math.PI : m[2] === 'turn' ? n * 360 : n
    }
  }
  const t = cs.transform
  if (t && t !== 'none') {
    const m = /matrix\(([^,]+),\s*([^,]+)/.exec(t)
    if (m) deg += (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI
  }
  return deg
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function parseRadius(cs: CSSStyleDeclaration): [number, number, number, number] {
  const f = (v: string) => Number.parseFloat(v) || 0
  return [
    f(cs.borderTopLeftRadius),
    f(cs.borderTopRightRadius),
    f(cs.borderBottomRightRadius),
    f(cs.borderBottomLeftRadius),
  ]
}

function transparent(color: string): boolean {
  return color === 'transparent' || color === 'rgba(0, 0, 0, 0)'
}

function textLines(el: HTMLElement, origin: DOMRect): { text: string; box: Box }[] {
  const out: { text: string; box: Box }[] = []
  const range = document.createRange()
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType !== Node.TEXT_NODE) continue
    const text = child.textContent ?? ''
    const limit = Math.min(text.length, 4000)
    let lineStart = 0
    let lineTop: number | null = null
    let lineBox: Box | null = null
    const flush = (end: number) => {
      if (lineBox && end > lineStart) out.push({ text: text.slice(lineStart, end), box: lineBox })
    }
    for (let i = 0; i < limit; i++) {
      range.setStart(child, i)
      range.setEnd(child, i + 1)
      const r = range.getClientRects()[0]
      if (!r) continue
      const top = Math.round(r.top)
      if (lineTop === null || Math.abs(top - lineTop) > 2) {
        flush(i)
        lineStart = i
        lineTop = top
        lineBox = { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
      } else if (lineBox) {
        lineBox.w = r.right - origin.left - lineBox.x
      }
    }
    flush(limit)
  }
  return out
}

async function svgImage(el: HTMLElement): Promise<HTMLImageElement | null> {
  const svg = el.querySelector('svg')
  if (!svg) return null
  const markup = new XMLSerializer().serializeToString(svg)
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
  const img = new Image()
  img.src = url
  try {
    await img.decode()
    return img
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function paint(
  root: HTMLElement,
  scale: number,
  maxHeight: number | null,
  fills: ReadonlyMap<HTMLElement, FillImage>,
): Promise<Blob | null> {
  const origin = root.getBoundingClientRect()
  const width = Math.max(1, Math.round(origin.width * scale))
  const height = Math.max(1, Math.round(Math.min(origin.height, maxHeight ?? Infinity) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)

  const svgs = new Map<HTMLElement, HTMLImageElement | null>()
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('div'))) {
    if (el.firstElementChild?.tagName.toLowerCase() === 'svg') svgs.set(el, await svgImage(el))
  }

  const base = ctx.getTransform()
  const draw = (el: HTMLElement, alpha: number, parentAngle: number) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    const opacity = alpha * (Number.parseFloat(cs.opacity) || 0)
    if (opacity <= 0) return
    const r = el.getBoundingClientRect()
    const angle = parentAngle + rotationOf(cs)
    const rotated = Math.abs(angle) > 0.001
    // Rotated: draw in the element's own (unrotated) frame around its centre; the centre of
    // the axis-aligned bounds is the image of the box centre under any rotation.
    const cx = r.left - origin.left + r.width / 2
    const cy = r.top - origin.top + r.height / 2
    const box: Box = rotated
      ? { x: -el.offsetWidth / 2, y: -el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight }
      : { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
    const radius = parseRadius(cs)
    ctx.save()
    ctx.setTransform(base)
    if (rotated) {
      ctx.translate(cx, cy)
      ctx.rotate((angle * Math.PI) / 180)
    }
    ctx.globalAlpha = opacity
    const path = () => {
      ctx.beginPath()
      if (radius.some((v) => v > 0)) ctx.roundRect(box.x, box.y, box.w, box.h, radius)
      else ctx.rect(box.x, box.y, box.w, box.h)
    }
    if (!transparent(cs.backgroundColor)) {
      path()
      ctx.fillStyle = cs.backgroundColor
      ctx.fill()
    }
    const fill = fills.get(el)
    if (fill) {
      ctx.save()
      path()
      ctx.clip()
      ctx.globalAlpha = opacity * fill.opacity
      const area = { x: box.x, y: box.y, width: box.w, height: box.h }
      const { naturalWidth: iw, naturalHeight: ih } = fill.image
      for (const t of backgroundTiles(
        iw,
        ih,
        area,
        cs.backgroundSize,
        cs.backgroundPosition,
        cs.backgroundRepeat,
        2000,
      ))
        ctx.drawImage(fill.image, t.x, t.y, t.width, t.height)
      ctx.restore()
    }
    // Borders: uniform → stroke the (rounded) box; otherwise fill each side.
    const widths = [
      cs.borderTopWidth,
      cs.borderRightWidth,
      cs.borderBottomWidth,
      cs.borderLeftWidth,
    ].map((v) => Number.parseFloat(v) || 0)
    const styles = [
      cs.borderTopStyle,
      cs.borderRightStyle,
      cs.borderBottomStyle,
      cs.borderLeftStyle,
    ]
    const colors = [
      cs.borderTopColor,
      cs.borderRightColor,
      cs.borderBottomColor,
      cs.borderLeftColor,
    ]
    const uniform =
      widths.every((w) => w === widths[0]) &&
      colors.every((c) => c === colors[0]) &&
      styles.every((s) => s === styles[0])
    if (uniform && (widths[0] ?? 0) > 0 && styles[0] !== 'none') {
      const w = widths[0] ?? 0
      ctx.beginPath()
      const inset = w / 2
      if (radius.some((v) => v > 0))
        ctx.roundRect(
          box.x + inset,
          box.y + inset,
          box.w - w,
          box.h - w,
          radius.map((v) => Math.max(0, v - inset)),
        )
      else ctx.rect(box.x + inset, box.y + inset, box.w - w, box.h - w)
      ctx.lineWidth = w
      ctx.strokeStyle = colors[0] ?? '#000'
      ctx.stroke()
    } else {
      const sides: Box[] = [
        { x: box.x, y: box.y, w: box.w, h: widths[0] ?? 0 },
        { x: box.x + box.w - (widths[1] ?? 0), y: box.y, w: widths[1] ?? 0, h: box.h },
        { x: box.x, y: box.y + box.h - (widths[2] ?? 0), w: box.w, h: widths[2] ?? 0 },
        { x: box.x, y: box.y, w: widths[3] ?? 0, h: box.h },
      ]
      sides.forEach((s, i) => {
        if (s.w <= 0 || s.h <= 0 || styles[i] === 'none') return
        ctx.fillStyle = colors[i] ?? '#000'
        ctx.fillRect(s.x, s.y, s.w, s.h)
      })
    }
    if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) {
      const d = fitImage(
        el.naturalWidth,
        el.naturalHeight,
        { x: box.x, y: box.y, width: box.w, height: box.h },
        cs.objectFit,
        cs.objectPosition,
      )
      ctx.save()
      path()
      ctx.clip()
      ctx.drawImage(el, d.x, d.y, d.width, d.height)
      ctx.restore()
    }
    const svg = svgs.get(el)
    if (svg) {
      const svgEl = el.querySelector('svg')
      if (rotated && svgEl) {
        const w = Number(svgEl.getAttribute('width')) || box.w
        const h = Number(svgEl.getAttribute('height')) || box.h
        ctx.drawImage(svg, box.x, box.y, w, h)
      } else {
        const s = svgEl?.getBoundingClientRect()
        if (s) ctx.drawImage(svg, s.left - origin.left, s.top - origin.top, s.width, s.height)
      }
    }
    if (
      el.childNodes.length > 0 &&
      Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE)
    ) {
      ctx.fillStyle = cs.color
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      ctx.textBaseline = 'middle'
      const ls = Number.parseFloat(cs.letterSpacing)
      ctx.letterSpacing = Number.isFinite(ls) ? `${ls}px` : '0px'
      const transform = cs.textTransform
      const rad = (-angle * Math.PI) / 180
      for (const line of textLines(el, origin)) {
        let t = line.text.replace(/\n$/, '')
        if (transform === 'uppercase') t = t.toUpperCase()
        else if (transform === 'lowercase') t = t.toLowerCase()
        if (!rotated) {
          ctx.fillText(t, line.box.x, line.box.y + line.box.h / 2)
          continue
        }
        // Map the (axis-aligned) glyph run's centre into the rotated frame; draw centred.
        const dx = line.box.x + line.box.w / 2 - cx
        const dy = line.box.y + line.box.h / 2 - cy
        const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
        const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
        ctx.save()
        ctx.textAlign = 'center'
        ctx.fillText(t, lx, ly)
        ctx.restore()
      }
    }
    const clip = cs.overflow === 'hidden' || cs.overflow === 'clip'
    if (clip) {
      path()
      ctx.clip()
    }
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement && child.tagName.toLowerCase() !== 'svg')
        draw(child, opacity, angle)
    }
    ctx.restore()
  }
  draw(root, 1, 0)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export interface RasterOptions {
  /** Scale down so the output is at most this wide (thumbnails). */
  maxWidth?: number
  /** Device pixels per CSS px (PNG 1× / 2×). Default 1. */
  scale?: number
  /** Crop to at most height = width × maxAspect (keeps the top of tall artboards). */
  maxAspect?: number
  assetUrl: AssetUrl
}

/** PNG of `nodeId`'s subtree, or null when it cannot be rendered. */
export async function renderNodePng(
  doc: LoroDoc,
  nodeId: string,
  options: RasterOptions,
): Promise<Blob | null> {
  const sub = toRenderSubtree(doc, nodeId, resolverOf(doc))
  if (!sub) return null
  const tokens = getTokens(doc)
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  // Design content: light app tokens and text colour whatever the app theme (tokens.css §4).
  host.setAttribute('data-design-content', '')
  host.style.cssText =
    'position:fixed;left:-30000px;top:0;width:max-content;pointer-events:none;contain:layout style;'
  for (const [name, token] of Object.entries(tokens))
    host.style.setProperty(name, String(token.value))
  const pending: Promise<unknown>[] = []
  const fills = new Map<HTMLElement, FillImage>()
  const root = buildNode(sub.nodes, nodeId, options.assetUrl, pending, true, fills, tokens)
  if (!root) return null
  host.appendChild(root)
  document.body.appendChild(host)
  try {
    await Promise.all(pending)
    await document.fonts.ready
    const rect = root.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    let scale = options.scale ?? 1
    if (options.maxWidth !== undefined) scale = Math.min(scale, options.maxWidth / rect.width)
    const maxHeight = options.maxAspect !== undefined ? rect.width * options.maxAspect : null
    return await paint(root, scale, maxHeight, fills)
  } finally {
    host.remove()
  }
}
