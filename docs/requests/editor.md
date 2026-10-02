# Contract notes from the editor workstream

The editor (`apps/desktop/src/renderer/editor/**`) is built against the contract and the other
workstreams' notes. Everything below is implemented; items marked **request** need another
workstream or a contract change at integration.

## 1. How the editor integrates

- `EditorScreen({ fileId, onExit })` is the only entry point. It talks to the app through
  `lib/bridge.ts` and `lib/commands.ts` only (no screens state modules).
- Opening: `bridge.files.open` → `loadDoc`; edits (local commits **and** imported remote edits)
  are saved by exporting everything since the last saved version vector as one update →
  `bridge.files.applyUpdate` (400 ms debounce, 2 s max wait, flushed on exit, `pagehide`,
  `beforeunload` and when the window is hidden). Failed saves keep the old base and retry.
- On exit, when the file changed, the first artboard of the first page is rendered off-screen
  (static DOM with the canvas conventions + a 2D painter) to a ≤640px-wide, 4:3-cropped PNG →
  `bridge.files.setThumbnail`.
- Opens/closes of the same file are serialized (React StrictMode double-mounts in dev).
- Commands registered while the editor is mounted: `edit.undo` (when undo is possible),
  `edit.redo` (when redo is possible), `edit.cut/copy/delete` (with a selection),
  `edit.paste`, `edit.selectAll`, `view.zoomIn/zoomOut/zoomToFit/zoom100`. The canvas runs
  with `keyboard: 'canvas'`; the shell's Ctrl+Z/C/V/X/A/Delete reach the editor through the
  registry. Editor-only shortcuts (zoom, Shift+A, Ctrl+Alt+G, Ctrl+]/[, F2, Ctrl+Shift+L/H,
  Alt+C, tools) are handled at window level, skipping text fields and open menus.
- Browser design fixture: `?fixture=design` (mock bridge) seeds `f-acme` with the component
  library and leaves `f-baren` empty. Extra query `editorScene=theme` seeds the 07
  "Theme preview" + tokens into `f-baren`; `editorScene=perf20k|perf50k` seeds a
  generated 20k/50k-node document into any file (profiling). In fixture mode only, the editor
  exposes `window.__barenEditor` (`session`, `canvas`, `snapshot()`, `tokens()`) for the
  visual tests.

## 2. Requests

1. **canvas-engine — `setHover(id | null)` on `CanvasController`.** The layers panel highlights
   the hovered layer on the canvas (artboard 05). The controller implementation already has a
   public `setHover`; the editor calls it behind a feature check. Please add it to the
   interface.
2. **canvas-engine — undo origins.** The editor passes
   `undoExcludeOriginPrefixes: ['remote', 'sync', 'bench', 'fixture', 'preview']`. Inspector
   scrubs and color-picker drags commit live previews with `preview:*` origins (so the canvas
   and collaborators see them), then revert and commit the final value with `editor:*`, so a
   whole scrub is one undo step. Editor commits use `editor:inspector | layers | pages | theme
| clipboard | menu`.
3. **foundation / rust-core — token order (contract change).** Loro map iteration order is
   not insertion order, so the Theme panel would reshuffle tokens between peers. The editor
   stores a numeric `order` key inside each token's (mergeable) map next to
   `type/value/description`; `setTokens` leaves it untouched. Proposal: add
   `order?: number` to `Token`, have `getTokens` return it, and have the Rust core keep it.
4. **all exporters — hidden paints.** Hiding a fill (eye in Fill) moves the value to a CSS
   custom property `--hidden-<property>` (e.g. `--hidden-backgroundColor: #FFFFFF`). It is valid
   CSS and ignored by renderers; HTML/JSON exporters may drop `--hidden-*` keys.
5. **desktop-shell — `baren-asset://<hash>` scheme.** Image fills are written as
   `background-image: url("baren-asset://<hash>")` (the same convention rust-core's HTML
   export uses for non-embedded images). Please serve that scheme from the asset store
   (and allow it in `img-src`) so image fills render in the canvas. Image _layers_ already
   render through `resolveAsset`.
6. **desktop-shell / screens — remote files.** Collaboration starts when the opened file's
   `FileMeta.remoteId` is set and a token exists (`@baren/sync-client` `connectFile`;
   verified end to end against the real server with two browser peers). Nothing in the bridge
   can set `remoteId` yet: please add `files.setRemote(id, { remoteId, teamId })` (rust-core
   already has `setFileRemote`) and a "share to team" / "open team file" flow that imports the
   server snapshot.
7. **sync-server — relay unknown presence fields.** The editor forwards the canvas'
   `transient` (in-progress move/resize ghosts) in presence, as canvas-engine requested; the
   server currently drops unknown fields.
8. **ui-kit.**
   - `LayerRow` always reserves its 36px lock/eye slot, so names truncate earlier than in
     the reference design ("Section / Checkbo…" in 14). Collapse the slot unless the row is hovered,
     focused or has a pinned (locked/hidden) state.
   - `InspectorSection` has no 16px-title variant; Page/MCP (04) need it. The editor applies
     `.compactHeader > :first-child { height: 16px }` locally.
   - `InspectorRow`, `FieldIconButton`, `SelectionColorRow` and `NumberField`'s root don't
     take `ref` (React 19 ref-as-prop works at runtime, but the prop types omit it). The
     editor wraps them to anchor popovers.
   - The editor registers the bundled Inter (latin + latin-ext, `opsz` files) under the family
     name `Inter` with `FontFace`, because design documents use `fontFamily: 'Inter'`.
     If ui-kit adds the alias in `global.css`, `editor/lib/fonts.ts` can go.
9. **screens.** `EditorRoute` redirects when the file is missing from the files store; a file
   created through the bridge after the store loaded is treated as missing until a reload.
   The window title follows `FileMeta.name`; a rename in the editor calls
   `bridge.files.rename` and sets the document name, and the title updates when the files
   store reloads (it does on exit).

## 3. Design notes (mock-up inconsistencies)

The editor artboards are mock-ups and not internally consistent, so a faithful editor
cannot reach 0% pixel difference:

- 05/06/08/15 say "12%"/"18%" but draw 1440px artboards 112px wide (7.8%), while 14 says "75%"
  but draws the 03 Forms text at 1:1. The fixture keeps 14's real content at 1:1 (artboards
  are 800px wide) and the overview at 14% (112px per artboard), so the zoom chip reads 14% and
  100% there.
- 06's inspector shows 03 Forms as W 1440, gap 72, padding 96/80/96/96, but 14 renders it 800px
  wide with 48/40 padding and 36px gaps. The fixture follows 14 (the canvas), so 06's inspector
  shows 800 / 36 / 48·40.
- 14's layer list has no row for the sections' left-hand description column; the fixture needs
  one node for it ("Description", last child of each section), adding one row.
- The reference PNGs show some text 1px lower than Chromium renders the same font (ui-kit noted
  the same); this is most of the remaining difference.

Per-artboard mismatch (share of pixels differing by more than 24/255 in any channel) is printed
by `apps/desktop/tests/visual/editor.spec.ts`.
