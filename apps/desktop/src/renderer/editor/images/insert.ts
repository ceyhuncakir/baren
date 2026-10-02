/**
 * Inserting images: the tool-rail image button (file picker), files dropped on the canvas
 * and images pasted from the clipboard all end here. Each file is read, validated and
 * measured without decoding on the main thread (header parse, else `createImageBitmap`),
 * stored with `bridge.assets.put`, then all files become layers in ONE commit (one undo
 * step): raster images → `image` layers, SVG files → sanitised `svg` layers.
 *
 * Placement: inside the artboard under the drop point (or the viewport centre), at the
 * natural size scaled down to fit that artboard; several files are laid out in rows.
 */
import { sanitizeSvgMarkup, type DropTarget } from '@baren/canvas'
import {
  ACCEPTED_IMAGE_MIMES,
  MAX_ASSET_BYTES,
  createNode,
  transact,
  type Styles,
} from '@baren/schema'
import { toast } from '@baren/ui'
import type { LoroDoc } from 'loro-crdt'
import { putAsset, sniffImageMime } from '../../lib/assets'
import { ORIGIN } from '../model/docOps'
import type { EditorSession } from '../session/context'
import { selectIds } from '../session/selection'
import { readImageSize, type Size } from './imageInfo'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Longest side of an image placed on the page itself (no artboard to fit into). */
export const PAGE_MAX_SIDE = 1200
/** Gap between several inserted images. */
export const INSERT_GAP = 20
/** Fallback size when an image's dimensions cannot be read. */
export const DEFAULT_IMAGE_SIZE: Size = { width: 400, height: 300 }

export const IMAGE_ACCEPT = [...ACCEPTED_IMAGE_MIMES, 'image/svg+xml'].join(',')

// ---------------------------------------------------------------------------
// Sizing math (pure)
// ---------------------------------------------------------------------------

/** `size` scaled down (never up) to fit inside `max`, keeping the aspect ratio. */
export function fitWithin(size: Size, max: Size): Size {
  const s = Math.min(1, max.width / size.width, max.height / size.height)
  if (!(s > 0) || !Number.isFinite(s)) return { ...size }
  return {
    width: Math.max(1, Math.round(size.width * s)),
    height: Math.max(1, Math.round(size.height * s)),
  }
}

/**
 * Rows of items (left to right, wrapping at `maxRowWidth`), as offsets from the group's
 * top-left corner, plus the group size.
 */
export function flowLayout(
  sizes: readonly Size[],
  maxRowWidth: number,
  gap: number,
): { offsets: { x: number; y: number }[]; size: Size } {
  const offsets: { x: number; y: number }[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  let width = 0
  for (const s of sizes) {
    if (x > 0 && x + s.width > maxRowWidth) {
      y += rowHeight + gap
      x = 0
      rowHeight = 0
    }
    offsets.push({ x, y })
    x += s.width + gap
    rowHeight = Math.max(rowHeight, s.height)
    width = Math.max(width, x - gap)
  }
  return { offsets, size: { width, height: y + rowHeight } }
}

/** Move `r` so it lies inside `bounds` where possible (top-left wins when it can't fit). */
export function clampInto(r: Rect, bounds: Rect): Rect {
  const x = Math.max(bounds.x, Math.min(r.x, bounds.x + bounds.width - r.width))
  const y = Math.max(bounds.y, Math.min(r.y, bounds.y + bounds.height - r.height))
  return { ...r, x, y }
}

/**
 * World rects for items with natural `sizes` dropped at `point`: each scaled to fit the
 * artboard (`bounds`, or PAGE_MAX_SIDE on the page), laid out in rows centred on the
 * point and kept inside the artboard.
 */
export function placeAt(
  point: { x: number; y: number },
  sizes: readonly Size[],
  bounds: Rect | null,
): Rect[] {
  const max = bounds
    ? { width: bounds.width, height: bounds.height }
    : { width: PAGE_MAX_SIDE, height: PAGE_MAX_SIDE }
  const fitted = sizes.map((s) => fitWithin(s, max))
  const layout = flowLayout(fitted, bounds ? bounds.width : PAGE_MAX_SIDE * 2, INSERT_GAP)
  let group: Rect = {
    x: Math.round(point.x - layout.size.width / 2),
    y: Math.round(point.y - layout.size.height / 2),
    ...layout.size,
  }
  if (bounds) group = clampInto(group, bounds)
  return fitted.map((s, i) => ({
    x: group.x + (layout.offsets[i]?.x ?? 0),
    y: group.y + (layout.offsets[i]?.y ?? 0),
    width: s.width,
    height: s.height,
  }))
}

// ---------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------

export type PreparedImage =
  | { kind: 'image'; name: string; assetId: string; size: Size; fileName?: string }
  | { kind: 'svg'; name: string; markup: string; size: Size }

export class InsertError extends Error {}

export function layerName(fileName: string | undefined, fallback = 'Image'): string {
  const base = (fileName ?? '').replace(/\.[^.]+$/, '').trim()
  return base || fallback
}

export function isAcceptedFile(file: { type: string; name?: string }): boolean {
  if (file.type === 'image/svg+xml' || ACCEPTED_IMAGE_MIMES.includes(file.type)) return true
  // Some platforms report no type for dragged files: decide by extension, sniff later.
  return !file.type && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.name ?? '')
}

/** Validate, measure and store one file (raster → asset, SVG → sanitised markup). */
export async function prepareImage(file: Blob, name?: string): Promise<PreparedImage> {
  const fileName = name ?? (file as Partial<File>).name
  if (file.size > MAX_ASSET_BYTES) {
    throw new InsertError(`${fileName ?? 'The image'} is larger than 20 MB.`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = sniffImageMime(bytes) ?? file.type
  if (mime === 'image/svg+xml') {
    const svg = sanitizeSvgMarkup(new TextDecoder().decode(bytes))
    if (!svg) throw new InsertError(`${fileName ?? 'The file'} is not a valid SVG.`)
    const width = svg.width ?? 100
    const height = svg.height ?? 100
    return {
      kind: 'svg',
      name: layerName(fileName, 'Vector'),
      markup: svg.markup,
      size: { width, height },
    }
  }
  if (!ACCEPTED_IMAGE_MIMES.includes(mime)) {
    throw new InsertError(
      `${fileName ?? 'This file'} is not a supported image (PNG, JPEG, WebP, GIF, AVIF or SVG).`,
    )
  }
  const [size, assetId] = await Promise.all([readImageSize(bytes, file), putAsset(bytes, mime)])
  return {
    kind: 'image',
    name: layerName(fileName),
    assetId,
    size: size ?? DEFAULT_IMAGE_SIZE,
    ...(fileName ? { fileName } : {}),
  }
}

// ---------------------------------------------------------------------------
// Creating layers
// ---------------------------------------------------------------------------

export interface PlacedImage {
  image: PreparedImage
  rect: Rect
}

/** Create the layers in one commit; returns their ids. */
export function insertPlaced(
  doc: LoroDoc,
  target: Pick<DropTarget, 'parentId' | 'place'>,
  items: readonly PlacedImage[],
  origin: string = ORIGIN.insert,
): string[] {
  const ids: string[] = []
  transact(
    doc,
    () => {
      let flowIndex: number | undefined
      for (const { image, rect } of items) {
        const geo = target.place(rect)
        const styles: Styles = { ...geo.styles }
        if (image.kind === 'image') styles['objectFit'] = 'cover'
        let index: number | undefined
        if (geo.index !== undefined) {
          flowIndex = flowIndex === undefined ? geo.index : flowIndex + 1
          index = flowIndex
        }
        ids.push(
          createNode(doc, {
            type: image.kind,
            parentId: target.parentId,
            ...(index !== undefined ? { index } : {}),
            name: image.name,
            styles,
            ...(image.kind === 'image'
              ? {
                  assetId: image.assetId,
                  ...(image.fileName ? { assetName: image.fileName } : {}),
                }
              : { svg: image.markup }),
          }),
        )
      }
    },
    { origin },
  )
  return ids
}

// ---------------------------------------------------------------------------
// Session flows
// ---------------------------------------------------------------------------

/** Client point of a world point on the canvas (for `dropTargetAt`). */
function clientOf(session: EditorSession, world: { x: number; y: number }) {
  const canvas = session.canvas.current
  const el = session.canvasEl.current
  if (!canvas || !el) return null
  const local = canvas.canvasToScreen(world)
  const r = el.getBoundingClientRect()
  return { clientX: r.left + local.x, clientY: r.top + local.y }
}

/**
 * Where inserts without a drop point go: the selected artboard (or the artboard holding
 * the selection), else the artboard under the viewport centre, else the page there.
 */
export function defaultInsertPoint(session: EditorSession): { x: number; y: number } | null {
  const canvas = session.canvas.current
  if (!canvas) return null
  const v = canvas.getViewport()
  const center = canvas.screenToCanvas({ x: v.width / 2, y: v.height / 2 })
  const first = session.store.getState().selection[0]
  if (first !== undefined) {
    const top = session.tree.topLevelOf(first)
    const bounds = top ? canvas.getNodeBounds(top) : null
    if (top && bounds && session.tree.meta(top)?.type === 'frame') {
      const inside =
        center.x >= bounds.x &&
        center.y >= bounds.y &&
        center.x <= bounds.x + bounds.width &&
        center.y <= bounds.y + bounds.height
      return inside ? center : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    }
  }
  return center
}

function reportError(error: unknown): void {
  toast(
    error instanceof InsertError
      ? error.message
      : error instanceof Error
        ? `Couldn't add the image: ${error.message}`
        : "Couldn't add the image.",
  )
}

/** Resolve where to insert at `world` (artboard under it, else the page). */
function targetAt(
  session: EditorSession,
  world: { x: number; y: number },
): Pick<DropTarget, 'parentId' | 'place'> & { bounds: Rect | null } {
  const canvas = session.canvas.current
  const client = canvas ? clientOf(session, world) : null
  const target = canvas && client ? canvas.dropTargetAt(client) : null
  canvas?.dropTargetAt(null)
  if (target) return target
  return {
    parentId: session.store.getState().pageId,
    bounds: null,
    place: (r) => ({
      styles: {
        left: Math.round(r.x),
        top: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    }),
  }
}

/** Place prepared images at `world` (or the default insert point) in one commit. */
export function insertPrepared(
  session: EditorSession,
  prepared: readonly PreparedImage[],
  world: { x: number; y: number } | null = null,
): string[] {
  if (prepared.length === 0) return []
  const at = world ?? defaultInsertPoint(session) ?? { x: 0, y: 0 }
  const target = targetAt(session, at)
  const rects = placeAt(
    at,
    prepared.map((p) => p.size),
    target.bounds,
  )
  // Shared files: start uploading the bytes now, together with the update that references them.
  session.assets.track(prepared.flatMap((p) => (p.kind === 'image' ? [p.assetId] : [])))
  const ids = insertPlaced(
    session.doc,
    target,
    prepared.map((image, i) => ({ image, rect: rects[i] as Rect })),
  )
  if (ids.length > 0) requestAnimationFrame(() => selectIds(session, ids))
  return ids
}

/** SVG markup (pasted text) → a sanitised vector layer. False when it is not an SVG. */
export function insertSvgMarkup(
  session: EditorSession,
  markup: string,
  world: { x: number; y: number } | null = null,
): boolean {
  if (session.canvas.current?.isReadOnly()) return false
  const svg = sanitizeSvgMarkup(markup)
  if (!svg) return false
  insertPrepared(
    session,
    [
      {
        kind: 'svg',
        name: 'Vector',
        markup: svg.markup,
        size: { width: svg.width ?? 100, height: svg.height ?? 100 },
      },
    ],
    world,
  )
  return true
}

/**
 * Insert files as layers at `world` (drop point) or the default insert point. Unsupported
 * or broken files are skipped with a toast; the rest are inserted together.
 */
export async function insertImageFiles(
  session: EditorSession,
  files: readonly Blob[],
  options: {
    world?: { x: number; y: number } | null
    names?: readonly (string | undefined)[]
  } = {},
): Promise<string[]> {
  if (session.canvas.current?.isReadOnly()) return []
  const prepared: PreparedImage[] = []
  const results = await Promise.allSettled(files.map((f, i) => prepareImage(f, options.names?.[i])))
  for (const r of results) {
    if (r.status === 'fulfilled') prepared.push(r.value)
    else reportError(r.reason)
  }
  return insertPrepared(session, prepared, options.world ?? null)
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}

/** Tool-rail image button / Insert → Image…: pick one or more files and insert them. */
export async function pickAndInsertImages(session: EditorSession): Promise<void> {
  const files = await pickFiles(IMAGE_ACCEPT, true)
  if (files.length === 0) return
  await insertImageFiles(session, files)
}

/** Pick one raster image and store it (image fills, replace). */
export async function pickImageAsset(): Promise<{
  assetId: string
  size: Size
  fileName: string | null
} | null> {
  const [file] = await pickFiles(ACCEPTED_IMAGE_MIMES.join(','), false)
  if (!file) return null
  try {
    const p = await prepareImage(file)
    if (p.kind !== 'image') throw new InsertError('Use a PNG, JPEG, WebP, GIF or AVIF image here.')
    return { assetId: p.assetId, size: p.size, fileName: p.fileName ?? null }
  } catch (error) {
    reportError(error)
    return null
  }
}

/** Files of a drag/drop or paste event that look like images. */
export function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  return Array.from(data.files).filter(isAcceptedFile)
}

/** True when a drag carries files (dragover cannot read them yet). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes('Files')
}
