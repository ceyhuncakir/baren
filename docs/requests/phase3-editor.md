# Phase 3 — editor workstream notes and requests

Built 2026-10-02: the editor side of the six Phase 3 features (`apps/desktop/src/renderer/editor`),
the clipboard bridge (`renderer/types/bridge.d.ts`, `preload/*`, `main/ipc/*`,
`main/clipboard/*`, `main/index.ts` wiring, `renderer/lib/mockBridge.ts`), the new command ids
(`renderer/lib/commands.ts`), `packages/ui` icons / layer kinds / component tokens, and the
editor tests (`tests/visual/editor.spec.ts` 29–33, `tests/visual/phase3-*.spec.ts`).

## Deviations from `docs/phase3/contract.md`

1. **Custom clipboard format blob type (§7.5).** Chromium refuses a `web …` custom format whose
   blob type is not the format's own MIME type (`NotAllowedError: Type web
application/x-baren-clipboard+json does not match the blob's type application/json`).
   Both the main process and the browser mock therefore write the payload as
   `new Blob([json], { type: 'application/x-baren-clipboard+json' })` instead of
   `application/json`. Electron's main-process `ClipboardItem` accepts either; the item's
   format name is unchanged, so every reader sees the same `web
application/x-baren-clipboard+json` type.
2. **Paste placement (§7.4, Ctrl+V).** "Same file and `bounds` intersects the viewport →
   (+24, +24)" is applied unless the target is a frame or group that the shifted copy would
   miss entirely (pasting a copy of a layer from artboard A into a selected frame B); then the
   copy is centred in B like a paste from another file. Pure and unit-tested in
   `editor/model/pastePlacement.ts`.
3. **Flow index for every target.** Pastes and picker inserts go right after the last selected
   sibling for absolute and page targets too (not only flex targets), so a paste lands above
   what was selected in paint order.
4. **Picker insert into a main of the same component.** When the selection would put an
   instance inside its own main (`containerForInsert` → cycle), the instance is inserted on the
   page instead of being refused (drag-and-drop targets still skip such frames through
   `dropTargetAt(…, { accept })`).
5. **Components panel order.** Rows are in document order (pages, then layer order), not
   `listComponents`' name order: artboards 31/32 list "Button / Primary, Button / Secondary,
   Badge / New, Card / Plan", which is their position on the page.
6. **Instance content rows.** Rows of nested instances inside an instance stay expandable (to
   reach deeper content from the layers panel); artboard 31 draws them without a chevron.
7. **Vector and group effects.** Vectors and groups show only Shadow and Filters (artboard 30);
   Outline, Border and Inner shadow are box effects that do not follow a path or a group's
   content.
8. **Detach on nested instances** (virtual) is disabled: it would restructure instance content
   (§2.7.3). Detach the outer instance first.
9. **Clipboard text for instances.** `clipboardText` yields `''` for an instance with an empty
   name (it shows its main's name); the editor then writes the resolved names instead.

## Requests

- **canvas (SHOULD, from docs/requests/phase3-design.md Request 2):** artboard labels of mains
  are truncated to the main's width ("Badg…" for the 58 px "Badge / New" main in 31–33);
  the reference design shows the whole name.
- **model (MAY):** `clipboardText` could fall back to the main's name for unnamed instances
  (deviation 9 above).
- **design:** artboard 33 omits the Component section the contract requires for a selected
  instance (and 31 shows Radius/Fill for an instance while 33 does not). The editor follows the
  contract; 33 measures 2.35 % (budget 3 %).
- **design (follow-up):** `design/tokens.dark.css` can now take the dark values of
  `--color-component`, `--color-component-faint` and `--color-component-subtle`, which are in
  `packages/ui/src/styles/tokens.css`.

## Notes for integration

- `UNDO_EXCLUDE` in `CanvasArea.tsx` includes `derived` (contract §8.1).
- The session owns one `ComponentResolver` (`session.resolver`, also `resolverOf(doc)` in
  `editor/model/resolver.ts`); `DocEvents` calls `affectedBy` + `apply` before the watchers
  run. Inspector reads and writes go through it (`getResolvedNode` / `setStylesAt` /
  `setTextAt` / `setPropsAt`), so instance content edits become overrides.
- The Electron clipboard check (`tests/visual/phase3-electron.spec.ts`) is opt-in
  (`BAREN_ELECTRON_E2E=1`) and needs a build (`BAREN_ELECTRON_OUT=<outDir>` when the
  build went elsewhere). It runs Chromium's headless Ozone platform: no window, and the OS
  clipboard is never touched.
