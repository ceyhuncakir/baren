/**
 * Upload the images a file uses to its server file, for files that are not open (Home's
 * background share, autoShare.ts). Loaded lazily: it pulls in Loro to read the snapshot.
 */
import { docAssetRefs, loadDoc } from '@baren/schema'
import { AssetSync, assetApiOf } from '../editor/collab/assetSync'
import { api } from '../lib/api'
import { getAssetBytes, putAsset, sniffImageMime } from '../lib/assets'

export async function uploadFileAssets(remoteId: string, snapshot: Uint8Array): Promise<void> {
  const assetApi = assetApiOf(api)
  if (!assetApi) return
  const refs = docAssetRefs(loadDoc(snapshot))
  if (refs.size === 0) return
  const sync = new AssetSync({
    local: { get: getAssetBytes, put: putAsset, mimeOf: sniffImageMime },
    onArrived: () => undefined,
    onError: (error) => console.warn('[assets]', error),
  })
  try {
    await sync.attach({ fileId: remoteId, api: assetApi }, refs)
  } finally {
    sync.dispose()
  }
}
