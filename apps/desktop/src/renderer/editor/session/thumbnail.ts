/**
 * File thumbnails: the previews on Home's file cards. The first artboard of the first page is
 * rendered off-screen (raster.ts), cropped to 4:3, and stored with the file; Home's cards that
 * show it reload (`thumbnailChanged`). An open file's thumbnail is kept current by its
 * session (thumbnailWriter.ts); a team file pulled onto this machine gets one from the snapshot
 * just downloaded — Home never opens a file for this, because opening one takes it over from
 * an agent's hidden window.
 */
import { getChildIds, loadDoc } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { thumbnailChanged } from '../../home/thumbnailCache'
import { drawableAssetUrls } from '../../lib/assets'
import { bridge } from '../../lib/bridge'
import { renderNodePng } from './raster'

const THUMB_WIDTH = 640

/** PNG of the first artboard of the first page (cropped to 4:3); null when there is none. */
export async function renderThumbnail(doc: LoroDoc): Promise<Uint8Array | null> {
  const firstPage = getChildIds(doc, null)[0]
  const firstBoard = firstPage === undefined ? undefined : getChildIds(doc, firstPage)[0]
  if (firstBoard === undefined) return null
  const urls = drawableAssetUrls()
  const png = await renderNodePng(doc, firstBoard, {
    maxWidth: THUMB_WIDTH,
    maxAspect: 0.75,
    assetUrl: urls.assetUrl,
  }).finally(() => urls.release())
  return png ? new Uint8Array(await png.arrayBuffer()) : null
}

/** Render and store `doc`'s thumbnail. False when the file has nothing to show. */
export async function saveThumbnail(fileId: string, doc: LoroDoc): Promise<boolean> {
  const png = await renderThumbnail(doc)
  if (!png) return false
  await bridge.files.setThumbnail(fileId, png)
  thumbnailChanged(fileId)
  return true
}

let queue: Promise<unknown> = Promise.resolve()

/** A pulled team file's thumbnail, from its snapshot (one at a time; failures are skipped). */
export function saveSnapshotThumbnail(fileId: string, snapshot: Uint8Array): Promise<void> {
  const next = queue
    .then(() => saveThumbnail(fileId, loadDoc(snapshot)))
    .then(
      () => undefined,
      (error: unknown) => console.warn('[thumbnail]', error),
    )
  queue = next
  return next
}
