# Phase 3 — canvas workstream notes and requests

Built 2026-10-02 in `packages/canvas` for contract §5 (all six features' canvas parts). The
`types.ts` additions (§5.1) landed first with stubs; the implementation followed. Nothing outside
`packages/canvas/**` was edited.

## For the editor (usage notes)

- **Undo exclusions.** The canvas default is now `['remote', 'sync', 'bench', 'derived']`.
  `CanvasArea.tsx` passes its own `UNDO_EXCLUDE`; per contract §8.1 it must add `'derived'`
  (post-layout group refits commit with `derived:group-fit` and must not become undo steps).
- **`onVectorEditChange`** is forwarded by `DesignCanvas` (`@baren/canvas/react`) like
  `onTextEditChange`.
- **`geometry()` vs `getNodeFrame(id)`.** Both return world `NodeFrame`s (unrotated box +
  accumulated rotation) for real and virtual ids. `getNodeFrame` first applies committed but not
  yet rendered changes (forced layout; commands only). `geometry()` never flushes, so it is safe
  to pass into schema helpers that call `frameOf` inside their own transaction. Pass
  `canvas.geometry()` to `groupNodes`, `ungroupNodes`, `wrapInFrame`, `createComponent`,
  `reparentNodes`, `setRotation`, `pasteClipboard`, `duplicateNodes`, `removeNodes`.
- **`dropTargetAt(client, { deep, accept })`.** Without `deep`: the top-level artboard (Phase 2
  behaviour, used by image drops). With `deep`: the top-most eligible frame (not locked/hidden,
  not a group, not inside an instance); `accept(parentId) === false` falls back to shallower
  frames (use it for `wouldCreateCycle`). `place(rect)` returns rounded styles relative to the
  frame's containing block (absolute), flow size + `index` (flex), or page `left/top`. For
  instances drop `width/height` from the result (contract §6).
- **Keyboard (when the canvas has focus).** The canvas handles `P` (pen), Enter/Escape (finish
  the pen path; leave vector editing), Delete/Backspace in vector edit mode (delete points) and
  Enter on a selected vector (edit it) or instance (select its content). It stops propagation
  for keys it handles, so the editor keymap does not see them.
- **Virtual ids** (`"<instanceId>/<path>"`) are accepted by `select`, `setHover`,
  `getNodeBounds`, `getNodeFrame`, `editText` and presence selections, and reported through
  `onSelectionChange` / `onHoverChange` / `onTextEditChange`.
- **Theme.** The overlay reads `--color-overlay-component` from the canvas container (design
  Request 2; fallback `#7B4DFF`) for main-component labels (four-diamond mark + name) and for the
  selection outline/handles/pill of mains, instances and instance content. `OverlayTheme` gained
  `component`.
- **`deleteSelection`** → schema `removeNodes` (`canvas:delete`; instance content is hidden by
  override, emptied groups are deleted); **`duplicateSelection`** → schema `duplicateNodes`
  (`canvas:duplicate`; top-level nodes go right by width + 80 as before); **`nudge`** moves
  in the parent's axes, writes overrides for absolute instance content and refits groups.

## Behaviour details and deviations (recorded per contract wording)

1. **Drop highlight while moving inside the current parent.** The target frame is highlighted
   also when it is the dragged nodes' own parent (contract: "highlighted only when it is the
   target and is not the page"); groups are never highlighted.
2. **Flex siblings are targets.** Dragging a flow child over a sibling _frame_ now moves it into
   that frame (deepest frame under the pointer). The Phase 2 e2e test "dragging a flex child
   reorders it" pointed into the sibling frame `Section`; its end point moved 13 px up into the
   artboard's padding (still a reorder there).
3. **Mixed selections.** Nodes already in the target keep moving by the drag delta (same commit,
   `canvas:reparent`); selections containing a top-level artboard or instance content never
   reparent; flow content of instances does not move (contract 2.7.3).
4. **Rotation zones** are squares of 16 screen px beyond each corner of the (rotated) selection
   box, in the quadrants facing away from the box; resize handles and artboard labels take
   precedence. The cursor is a curved double arrow rotated with the corner and the box.
5. **Group resize preview** scales the group element with CSS `scale` (strokes and text scale
   during the preview only); the commit is `resizeGroup` (boxes scaled, content restyled by
   layout). Vectors rescale their points with their box in the same commit.
6. **Pen placement** follows the draw tool: positions relative to the target's containing
   block; in a rotated container the vector is aligned to the container and its points
   converted, so the drawn shape stays where it was drawn. Vectors get `{ fill: 'none',
stroke: '#000000', strokeWidth: 1 }`.
7. **Vector hit-testing:** the path element receives pointer events on its painted area
   (`visiblePainted`; the `<svg>` box is pass-through); a further 4 screen px plus half the
   stroke width is found with `nearestOnPath` over the spatial index.
8. **Rotated top-level nodes at LOD:** thumbnails are drawn unrotated (the measuring host's
   wrapper cancels the root's rotation) and the stand-in rotates them. Their child index is only
   taken from live measurements (world positions are unknown in the measuring host).
9. **`commitReorder`** moves the dragged items to the end before placing them, so multi-item
   reorders land at the intended indices (Phase 2 could misplace the second item).
10. **Post-layout group fits** run after the next measurement for every local batch that
    touched a group descendant (text, styles, props, creations); refits that change nothing
    write nothing. Imported batches never trigger a fit.
11. Clipping by rotated `overflow: hidden` ancestors uses axis-aligned bounds, and peers see
    rotation previews as axis-aligned `resize` ghosts (both accepted in contract §11).

## Visual details matched to the reference artboards

- 29: no size pill while rotating (the live angle pill replaces it, 12 px right/below the pointer).
- 30: in vector edit mode the path is outlined in the selection colour, no bounding box or size
  pill; the pen tool (and a segment hover in edit mode) shows a pen-nib cursor (`+` = add point,
  `o` = close path).
- 31: main labels with the four-diamond mark; selecting an instance (or its content) draws the
  selection, handles and pill in the component colour plus a 1 px outline 2 px outside the
  instance's main when that main is on the page (design Request 2, items 1–3).
- 33: while dragging, the selection, pill and drop target stay in the selection colour.

## Benches

The `20k-mixed` preset, the propagation bench (`?preset=propagation`, ~1,000 loaded instances)
and the drop-target timer are in `bench/main.ts` and asserted in `tests/perf.spec.ts`.

**Correction (QA, recorded at integration).** The propagation numbers this workstream reported
(style edit 1.9–3.5 ms, structural 7.7–9.8 ms at 1,023 instances) timed only the tail of the
frame: Loro delivers events synchronously, so the canvas's rAF was registered before the
bench's. With the bench fixed (`frameWorkAfter` registers first) the hand-over code took
43–55 ms / 116–144 ms. QA's canvas changes (cached instance data, paint-only syncs keep
measurements, keyed reconciliation, frame-budgeted thumbnails) brought it to 14–24 ms (style,
budget 16 ms, met at the median only) and 37–48 ms (structural, budget 50 ms). Current numbers:
`docs/STATUS.md`; details: `docs/requests/phase3-qa.md`. The integration then added per-path
patching for style-only main edits (contract "Integration changes" 5–6): 6–14 ms at 1,023
instances, 8–11 ms at 2,000 × 50-node instances. Text and structural main edits still re-expand
every affected instance (open).
