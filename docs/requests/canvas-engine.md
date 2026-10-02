# Contract notes from canvas-engine

`@baren/canvas` is built and tested (77 unit tests, 32 Chromium e2e tests and 3 perf tests). These
notes cover what other workstreams need to know, plus changes the canvas needs from them. Please
fold them into ARCHITECTURE.md, or reject them, at integration.

## 1. API surface (for the editor)

- `createCanvas(options)` from `@baren/canvas` returns a `CanvasController`.
  `<DesignCanvas … />` from `@baren/canvas/react` mounts and unmounts it. The controller is created
  once per `doc`. `pageId`, `tool` and `readOnly` props are forwarded imperatively, and callbacks
  always read the latest props, so React re-renders never touch the canvas.
- **Options:** `container`, `doc`, `pageId`, `readOnly`, `tool`, `viewport` (`'fit'` by default),
  `resolveAsset(assetId)` (returns a URL or a Promise of one, used for image nodes), `keyboard`,
  `undo`, `undoExcludeOriginPrefixes`, `theme` and `viewportChangeThrottleMs`.
- **Callbacks:** `onSelectionChange`, `onHoverChange`, `onViewportChange`, `onToolChange`,
  `onTransientChange`, `onCursorMove`, `onContextMenu`, `onHistoryChange` and `onTextEditChange`.
  - `onViewportChange` is throttled to 100 ms during gestures and always delivers the final value,
    so the zoom indicator does not cause a re-render on every frame.
  - `onTransientChange` and `onCursorMove` are throttled to 30 Hz.
- **Controller:**
  - Tools and pages: `setTool`/`getTool`, `setPage`/`getPageId`.
  - Selection: `select`, `getSelection`, `selectAll`.
  - Viewport: `zoomTo(scale, anchor?)`, `zoomIn`, `zoomOut`, `zoomToFit`, `zoomToSelection`,
    `getViewport`, `setViewport`, `screenToCanvas`, `canvasToScreen`.
  - History: `undo`, `redo`, `canUndo`, `canRedo`.
  - Editing: `deleteSelection`, `duplicateSelection`, `nudge`, `editText`, `stopEditing`,
    `setReadOnly`.
  - Geometry and presence: `getNodeBounds`, `getSelectionBounds`, `setRemotePresence`.
  - Other: `focus`, `getStats`, `destroy`.
- **Wiring the command registry** (`lib/commands.ts`):

  | Command                                 | Controller call                          |
  | --------------------------------------- | ---------------------------------------- |
  | `edit.undo` / `edit.redo`               | `undo()` / `redo()`                      |
  | `edit.delete`                           | `deleteSelection()`                      |
  | `edit.selectAll`                        | `selectAll()`                            |
  | `view.zoomIn` / `zoomOut` / `zoomToFit` | `zoomIn()` / `zoomOut()` / `zoomToFit()` |
  | `view.zoom100`                          | `zoomTo(1)`                              |

  If the HTML menu bar also handles accelerators, pass `keyboard: 'canvas'`. The canvas then still
  handles tools, nudging, delete, duplicate, Escape, Enter and Space-to-pan, and leaves
  undo/redo/zoom/select-all to the registry, so no shortcut fires twice.

- **Zoom menu (artboard 16):** `formatZoom(viewport.zoom)` produces "12%", and `ZOOM_STEPS`
  contains the 50 %, 100 % and 200 % presets. "Zoom to selection" is `zoomToSelection()`.
- **Context menu (artboard 15):** `onContextMenu({ clientX, clientY, world, targetId })` fires after
  the target has been selected. Use client coordinates to place the menu.
- **Selection model:**
  - A click selects the artboard's direct child. Ctrl/Meta-click selects the deepest node.
  - Double-click drills one level deeper; on a text node it starts editing. Enter selects the
    children (or edits a text node), and Shift+Enter or Escape selects the parent.
  - Clicking an artboard label selects the artboard, and dragging the label moves it.
- **New-node defaults:**
  - The artboard tool on empty canvas creates a frame named "Artboard N" with
    `backgroundColor: '#FFFFFF'` and `overflow: 'hidden'` ("Clip content" on). A click without a
    drag gives 1440×900. Inside a frame it creates a nested frame named "Frame".
  - The rectangle tool fills with `#D9D9D9`; a click gives 100×100.
  - The text tool uses `Inter` 16px/20px in `#000000`.
  - Inside flex parents, new nodes join the flow; elsewhere they are `position: absolute`.

## 2. Requests to other workstreams

1. **ui-kit, fonts:** register the bundled Inter variable font under the family name `Inter` as
   well. Design documents (the fixtures and the bench documents) use `fontFamily: 'Inter'`, but
   `@fontsource-variable/inter` registers only `'Inter Variable'`, so canvas text silently falls
   back to a system font. Add a second `@font-face { font-family: 'Inter'; … }` with the same woff2
   `src` and `font-weight: 100 900` to `tokens.css`. (`bench/fonts.ts` does this with `FontFace` for
   the bench.)
2. **rust-core, HTML export parity:** the canvas renders with these conventions, and export must
   match them or exported HTML will lay out differently:
   - Every node has `box-sizing: border-box`.
   - Text nodes have `white-space: pre-wrap`.
   - Numeric style values become `px`, except unitless properties (React's list: `opacity`,
     `flexGrow`, `flexShrink`, `fontWeight`, `lineHeight`, `zIndex`, `order`, …).
   - A top-level node is placed at `styles.left/top` in page space, and its own element is
     `position: relative`, so absolute children are relative to the artboard.
   - Image nodes are `display: block`.
   - SVG markup is sanitized with an allowlist. Scripts, event handlers, `<style>`,
     `<foreignObject>`, `<a>` and external `href`/`url()` are removed. Export should do the same.
3. **sync-server and sync-client, presence:** the canvas accepts and produces an optional field on
   the presence JSON, `transient: { kind: 'move' | 'resize', nodes: { id, rect }[] } | null`.
   It describes another peer's gesture in progress (world coordinates, 30 Hz, never persisted).
   Please relay unknown presence fields unchanged. `cursor` is in world (canvas) coordinates, which
   is exactly what `onCursorMove` emits.
4. **desktop-shell, CSP:**
   - LOD thumbnails are `blob:` image URLs, so `img-src` needs `blob:` (and `data:` for
     sanitized inline SVG images).
   - The canvas sets styles only through the CSSOM and a constructed stylesheet
     (`adoptedStyleSheets`), so it needs no `'unsafe-inline'` for `style-src`. The one exception
     is `style` attributes inside stored SVG markup: they are kept, sanitized of `url()`
     references.
5. **editor and anyone holding node ids:** Loro's `UndoManager` re-creates a deleted tree node
   under a **new TreeID** when the delete is undone (checked with loro-crdt 1.16.4). Selection,
   layer-panel expansion state, comments and similar must not assume ids survive an undo or redo of
   a delete. The canvas re-selects the recreated roots after undo/redo.
6. **foundation, undo origins:** the canvas commits with origins `canvas:move`, `canvas:resize`,
   `canvas:reorder`, `canvas:create`, `canvas:text`, `canvas:delete`, `canvas:duplicate` and
   `canvas:nudge` (exported as `ORIGIN`). One gesture or command is one commit and one undo step,
   and a text-editing session (including creating the text node) is a single undo group. By
   default the `UndoManager` ignores origins starting with `remote`, `sync` or `bench`. Inspector
   edits made by the editor with `transact(doc, fn, { origin: 'inspector' })` are undoable through
   the same controller.

## 3. Dependencies

- `@baren/canvas/react` imports `react`. It currently resolves through the hoisted
  `node_modules`. Please add `"peerDependencies": { "react": "^19.3.0" }` and
  `"devDependencies": { "@types/react": "^19.3.0", "react-dom": "^19.3.0" }` to
  `packages/canvas/package.json` at the next install. `react-dom` is used only by the bench
  harness.
- `pnpm --filter @baren/canvas bench:electron` runs the bench in hidden Electron windows (real
  GPU). It uses the hoisted `electron` from `apps/desktop`.
