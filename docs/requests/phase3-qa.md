# Phase 3 — QA workstream: contract changes and requests

Recorded 2026-10-02 by the QA workstream. These are the behaviour changes the QA fixes made to
`docs/phase3/contract.md` (so every workstream reads the same rules), and the open items that
need another workstream. The tests behind each item are named in brackets.

## Contract changes (made by QA fixes)

1. **Absolutely positioned children of flex frames stay absolute** (§2.4, §2.5, §4.4).
   - `placementStyles(doc, parentId, world, parentFrame, opts?: { absolute?: boolean })` gains
     an optional fifth parameter. With `absolute`, a flex parent positions the node like any
     other frame (`position: absolute`, `left/top` from the padding box).
   - `rotateNodes` passes it for absolutely positioned nodes. Before, rotating an absolute
     child of a flex frame (canvas rotation handles, `rotateNodes`) deleted its `left/top`.
   - `groupNodes`, `wrapInFrame` (and `createComponent`, which wraps) make the new container a
     flow item only when one of the selected nodes is a flow item of that flex parent.
     Otherwise the container is absolute, and nothing moves.
   - `ungroupNodes` hands the children of an absolutely positioned group in a flex frame
     absolute positions. "Into a flex parent they become flow items" applies only to flow
     groups.
   - Seen in artboard 29's own scene: the rotated "Launch sticker" group is absolute inside the
     flex "Hero" frame. Ctrl+Shift+G used to drop both children into the Hero's column flow.
   - Tests: `packages/schema/tests/qa-phase3.test.ts` (QA rotation, QA groups),
     `apps/desktop/tests/visual/qa-phase3-editor.spec.ts` (sticker),
     `packages/canvas/tests/e2e/qa-phase3.spec.ts` (Floating).
2. **Node keys never repeat after a move into a main** (§2.7.2).
   - `moveNode` into a main's subtree gives a fresh `nodeKey` to moved nodes whose key already
     exists elsewhere in the outermost enclosing main. Keys inside mains that are part of the
     moved subtree, including the moved node itself when it is a main, are kept.
   - Without this, a node moved from a duplicated main (a duplicate keeps its node keys) into the
     original took over the instances' overrides of the original node.
   - The documented exception now covers only nested mains: copies of one main nested twice in
     a main, or a main nested in a copy of itself.
   - Tests: `qa-phase3.test.ts` (QA duplicate / paste …), `qa-fuzz.test.ts`.
3. **`createComponent` de-duplicates node keys order-independently.** Keys used inside nested
   mains are reserved first. Other nodes that repeat one of them, or each other, are re-keyed
   whatever their document order. Before, a plain node placed before a nested main kept the
   nested main's key. Test: `qa-phase3.test.ts` (createComponent re-keys …).
4. **`detachInstance` refits the groups it materialises.** Overrides can move, resize or rotate
   content inside a virtual group, and a virtual group box cannot follow them. Once the group is
   real it is refitted in the same commit, which keeps invariant 2. Test: `qa-phase3.test.ts`
   (detaching an instance whose group content is overridden …).
5. **Paste and inserts skip locked and hidden containers** (§7.4, editor).
   `containerForInsert` (Ctrl+V, Ctrl+Shift+V, pasted text, picker inserts) never returns a
   locked or hidden frame, or one inside a locked or hidden ancestor. The content goes beside
   the outermost such ancestor. This matches the canvas drop targets (§5.2). Tests:
   `apps/desktop/src/renderer/editor/model/docOps.test.ts`, `qa-phase3-editor.spec.ts`.

## Performance (contract §9): measurement fix and canvas changes

1. **The propagation bench measured the wrong frame part.**
   - Loro delivers change events synchronously on commit, so the canvas requests its frame
     inside the edit call. `frameWorkAfter` registered its own rAF after the edit, so it ran
     after the canvas's callback and timed only the tail of the frame.
   - The canvas workstream's numbers (style edit 1.9–3.5 ms, structural 7.7–9.8 ms at 1,023
     instances) were therefore too low. Measured correctly, the code at hand-over took 43–55 ms
     and 116–144 ms, missing the 16 ms and 50 ms budgets.
   - `frameWorkAfter` now registers before the edit. `docs/requests/phase3-canvas.md` and the
     integration's STATUS numbers should use the corrected figures below.
2. **Canvas and resolver changes** (`packages/canvas/src/render/*`, `controller.ts`,
   `packages/schema/src/resolve.ts`):
   - The resolver caches decoded instance data across component invalidations. A main edit no
     longer re-reads every instance from Loro.
   - Instance syncs that change only paint (colours, opacity, shadows, fill/stroke) keep the
     current measurement instead of re-measuring whole artboards.
   - Structural main edits reconcile instance children by key (one new element per instance)
     instead of rebuilding every instance's content.
   - The scene manager's mount and thumbnail budget counts the frame's write phase, so stand-in
     thumbnails wait for a lighter frame.
3. **Results** (headless Chromium, this machine; contract budgets in brackets):
   - 1,023 instances of a 12-node main: style edit 14–24 ms [16], structural edit 37–48 ms [50].
   - 2,000 instances of a 50-node main (new `?preset=propagation-2k`; at most about 400 are
     live because of `MAX_LIVE_NODES`): style edit 43–57 ms, structural edit 65–80 ms of frame
     work at 100 % zoom.
   - Every live instance shows each edit in the frame right after it.
4. **Open (canvas):**
   - The style-edit budget is met only at the median and is noise-sensitive. Most of the rest
     is per-instance expansion (one ResolvedNode per virtual node) and the browser's style and
     paint work.
   - Reaching one frame at 2,000 × 50 would need per-path patching of the affected virtual
     nodes instead of re-expanding each instance. That is a redesign and out of QA scope.
   - After a main edit, stand-in thumbnails of nearby artboards that contain instances are
     regenerated (up to 2 per frame). With 5,000-node artboards each costs about 25–30 ms.

## Requests

- **canvas:** consider per-path instance patching (above), and spreading thumbnail regeneration
  of large artboards over several frames.
- **model:** contract §2.7.2 and §4.4 wording should follow changes 1–3 above. The Rust mirror
  is unaffected: these are TS-only mutation helpers, and the parity fixtures regenerate
  byte-identically.
- **integration:** the opt-in real-server suites are
  `packages/sync-client/tests/e2e-phase3.test.ts`, which runs whenever an `baren-server`
  binary is found (e.g. `target/p3-qa/debug`), and
  `apps/desktop/tests/visual/qa-phase3-server.spec.ts`, which needs `BAREN_E2E_MAIL_DIR` and
  `VITE_SERVER_URL` like the other server specs.

## Integration follow-up (2026-10-02)

- **Per-path patching** is in for style-only main edits (contract "Integration changes" 5):
  `resolver.stylePaths` / `resolveStyles` + `Scene.patchStyles`. Style edit at 1,023 instances
  6–14 ms (median ≈ 8 ms, budget 16 ms, now met with margin); 2,000 × 50-node instances 8–11 ms
  at 100 %. Text and structural main edits still re-expand each affected instance.
- **Stand-in thumbnails** no longer start in the frame that applies a document change
  (contract "Integration changes" 6); they still cost 25–30 ms each for 5,000-node artboards in
  the following frames (time-slicing them remains open).
- The opt-in suites named above ran against the integration's own server and passed; the
  QA fuzz tests got explicit 60 s timeouts (they hit vitest's 5 s default on a loaded machine).
