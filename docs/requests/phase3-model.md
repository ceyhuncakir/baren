# Phase 3 — model workstream notes

Built 2026-10-02: `packages/schema` (document model and helpers for all six features),
`crates/core` (Rust mirror, exporters, parity fixtures, bench), `crates/napi` (rebuilt addon,
smoke check), `apps/desktop/src/main/core` (JS fallback core exports through `renderHtml`).
Deviations from `docs/phase3/contract.md` are listed at the top of that file under
"Model deviations". This file holds usage notes for the canvas and editor workstreams and the
findings the contract asked to record.

## Findings the contract asked for

- **The Rust `loro` crate reads deleted tree nodes.** `LoroTree::get_meta(id)` and
  `LoroTree::children(id)` return the retained data and children of a deleted node, before and
  after a snapshot round trip (probe with `loro` 1.16.2, same result as `loro-crdt` 1.16.4).
  So the Rust export renders instances of a deleted main from its retained data exactly like
  JS; no `unresolved` fallback was needed. The parity fixture `parity3.loro` contains such an
  instance and both sides print the same render subtree and HTML.

## Notes for the canvas and the editor

- **One resolver per session.** `createComponentResolver(doc)`; on every `subscribeNodes`
  batch call `resolver.affectedBy(batch)` (components whose content changed — dependents
  included — and instances whose own data changed), re-render, then `resolver.apply(batch)`.
  For documents without components (empty registry, nothing expanded yet) the call returns
  after one registry-size read, so Phase 2 documents do no resolver work. Reads right after a local commit that was not applied
  yet are still correct (the resolver drops its caches when `doc.opCount()` moved), so the
  editor can read through the shared resolver at any time.
- **Virtual ids** are `"<instanceId>/<path>"`; `parseVirtualId`, `virtualId`, `isNodeRef`.
  `getNode` and `hasNode` stay real-only; use `resolver.resolveNode(ref)` /
  `getResolvedNode(doc, ref, resolver)` for both kinds. Write through `setStylesAt`,
  `setTextAt`, `setPropsAt` (pass the session resolver in `opts.resolver` for scrubs).
- **Frames:** `docGeometry(doc)` is the declared-styles fallback (`placementStyles` uses it
  when `parentFrame` is null). Flow children are placed at the parent's content origin and
  nodes without px sizes measure 0 — always pass the canvas `geometry()` to helpers.
- **Undo:** helpers commit with the origins in contract 8.1; post-layout refits use
  `transact(doc, () => fitGroups(doc, ids, geo), { origin: 'derived:group-fit' })`.
- **Clipboard:** `serializeClipboard` → `attachAssetBytes(payload, read)` →
  `JSON.stringify` for `CLIPBOARD_MIME`; `renderHtml(doc, roots, { tokens, assetUrl })` for
  `text/html`; `clipboardText(payload)` for `text/plain`. On paste:
  `clipboardPayloadVersion(json) > 2` → the "newer version" toast; otherwise
  `parseClipboardPayload` (v1 is upgraded), `clipAssetBytes(asset)` + `bridge.assets.put` for
  each embedded asset (build `assetRemap` when the stored hash differs), then
  `pasteClipboard(doc, payload, { parentId, index, translate, geo, assetRemap })`.
  `result.refused === 'cycle'` → "Can't paste a component inside itself".
- **Instance placement:** `createInstance` keeps own keys only (placement + size); drop
  `width/height` from the canvas `place()` result so instances follow the main's size.
- **Main lookup and restore:** `findMainComponent(doc, key, instance.mainId)` (pass the hint);
  `restoreMainComponent(doc, key)` also searches instance hints.
- **Bench preset `20k-mixed`:**
  `generateBenchDoc({ artboards: 40, nodesPerArtboard: 500, components: { mains: 10, everyNth: 10 }, vectors: { everyNth: 20 } })`.
  The mains (12 nodes each, `BENCH_MAIN_NODE_COUNT`) are on a second page, "Components";
  every other instance overrides its title text; vectors are 8-point closed stars.
- **JS fallback core:** `exportHtml(fileId, nodeId)` accepts virtual ids now (as does the Rust
  core); the IPC validator (`is.id`, ≤ 256 chars) already admits them.

## Not done here (other workstreams or later)

- `docs/STATUS.md` is not updated (integration step).
- `design/fixtures/sample.*` (design-owned) were not regenerated; they contain no Phase 3
  data and still pass on both sides.
- The Electron app smoke (`pnpm --filter @baren/desktop build && … smoke`) was not run:
  the user's `pnpm dev:all` was running, and `electron-vite build` writes the same `out/`
  directory as the running `electron-vite dev`. The addon itself was smoke-tested in Node and
  in Electron's runtime (`ELECTRON_RUN_AS_NODE=1`).
