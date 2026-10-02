# Phase 2 — images workstream: contract notes and requests

Status of the "Images" part of the Phase 2 contract as built by the images workstream, plus
the requests it makes to other workstreams. Nothing here edits ARCHITECTURE.md.

## Additions to the document model (proposed for the contract)

1. **`assetName` node prop (optional string).** The original file name of the node's image
   (an image layer's source or a frame/rect image fill), shown by the inspector
   ("dolomites-dawn.jpg" in artboard 24). Additive: `NODE_KEY.assetName`,
   `DesignNode.assetName?`, `NodeProps.assetName?` in `@baren/schema`; mirrored in
   `baren_core` (`node_key::ASSET_NAME`, `DesignNode.asset_name`, `NodeInit.asset_name`,
   serialised as `assetName` after `assetId`). Old readers ignore it.
2. **Image fill opacity** is encoded in the fill value itself, no new key:
   `backgroundImage: -webkit-cross-fade(url("baren-asset://<hash>"), url("<1×1 transparent GIF>"), <100 − opacity>%)`.
   Chromium (canvas, Electron) and Safari render it as the image at that opacity; the
   `url(baren-asset://…)` token stays where sync and exporters find it. Firefox ignores
   the declaration in exported HTML (no fill there). 100 % is the plain `url("…")`.
3. **Fill modes** (contract wording kept): Fill = `cover`, Fit = `contain`, Crop =
   `"<w>px <h>px"` + `no-repeat` (the cover size at the time of switching), Tile =
   `"<natural w>px <natural h>px"` + `repeat` + `left top`.
4. A `rect` whose `backgroundImage` references an asset shows the image icon in the layers
   panel (as drawn in 24).
5. HTML export drops hidden paints (`--hidden-*` keys) — the contract already allows it.

## Requests

### platform (`src/main/**`, preload, mock bridge theme/updates)

- **Serving `baren-asset://<hash>`:** the napi addon now has
  `getAssetFile(hash): Promise<{ bytes: Buffer; mime: string } | null>` (bytes + stored mime
  in one call) and `getAssetInfo(hash): Promise<{ mime, size, width, height } | null>`.
  `putAsset` replaces a non-image mime (e.g. `application/octet-stream` from a drop) by the
  type sniffed from the bytes, so the stored mime is right for `Content-Type`.
- **CORS on the scheme:** already in place (`corsEnabled` + `Access-Control-Allow-Origin: *`,
  checked by the smoke run). The canvas relies on it: it draws assets into OffscreenCanvases
  for LOD thumbnails, and from the `app://renderer` origin an `baren-asset://` image is
  cross-origin, so its thumbnail copies are loaded with `crossOrigin = 'anonymous'`. Please
  keep the header; without it LOD thumbnails show a neutral placeholder where images are
  (rendering itself is unaffected). PNG export and file thumbnails use blob URLs and do not
  depend on it.
- The JS fallback core (`core-js`) has no `getAssetFile`/`getAssetInfo`; `getAsset` plus
  sniffing the mime from the bytes works there.
- `exportJson(fileId, { embedAssets: true })` adds `assets: { <hash>: data URI }` (opt-in;
  the bridge's `export.json(fileId)` is unchanged).

### shell-ui (`renderer/lib/mockBridge.ts` assets, `renderer/lib/mockApi.ts`)

- **Mock bridge hashing:** `assets.put` hashes with SHA-256. The server verifies **blake3**
  on `PUT /api/files/:id/assets/:hash`, so browser-mode clients against a real server cannot
  upload images. `@noble/hashes/blake3` is already a dependency of `apps/desktop`;
  `bytesToHex(blake3(bytes))` would make browser mode match the native core.
- `mockApi.ts` does not implement the new `ApiClient` members yet (typecheck error); the
  editor only calls the asset endpoints outside fixture mode, through a defensive adapter
  (`editor/collab/assetSync.ts → assetApiOf`).

### dark-theme

- New editor styles in `editor/inspector/Inspector.module.css` (`.image*`) use tokens except
  the preview's inset ring `#0000000f` (same literal as the reference design).
- Placeholders for missing assets are document content, not chrome: `#E3E3E3` in
  `packages/canvas` (`MISSING_FILL_CSS`, `.ic-img-missing`) and `lib/assets.ts`. They should
  not follow the app theme.
