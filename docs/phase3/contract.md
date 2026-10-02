# Phase 3 contract — canvas tools

Written 2026-10-02 by the architect workstream, after reading the Phase 2 code. Binding for the
three build workstreams of this phase: **model** (document model, Rust mirror, exporters),
**canvas** (`packages/canvas`) and **editor** (the editor UI, the clipboard bridge). The short,
binding summary is the "Phase 3 contract — canvas tools" section at the end of
`ARCHITECTURE.md`; this file holds the full detail. Everything in `ARCHITECTURE.md` above that
section still holds.

The six features (user request; all end to end, including live collaboration):

1. **Reparent by dragging on the canvas.**
2. **Rotation.**
3. **Groups.**
4. **Pen tool and vector editing.**
5. **Reusable components** (main components, instances, overrides).
6. **Copy/paste between files** (and windows), with a versioned clipboard format.

Wording: **MUST** is binding, **SHOULD** is expected unless a workstream records why not in
`docs/requests/phase3-<workstream>.md`, **MAY** is optional. "Helper" means a function exported
by `@baren/schema`. "World" means canvas/page coordinates in px (zoom-independent).

Sequencing: **model first** (schema API + Rust mirror + exporters), then **canvas ∥ editor**.
The canvas lands its `types.ts` additions (section 5.1) with stub implementations as its first
change, so the editor can compile against them from the start.

## Model deviations

Recorded by the model workstream (2026-10-02). Every signature in section 4 exists as written
and is exported from `@baren/schema`; the items below are additions or clarifications the
canvas and editor can rely on. Usage notes are in `docs/requests/phase3-model.md`.

1. **Additive parameters.** `createNode(doc, input, options?: { random? })`,
   `createComponent(…, opts.random?)`, `createInstance(…, opts.random?)` (deterministic keys
   for fixtures), `findMainComponent(doc, key, hint?)` (`hint` = an instance's `mainId`, used
   by step 3 of 2.7.4), `docGeometry(doc, resolver?)`. `refExists` lives in `resolve.ts`, not
   `ids.ts` (same package export).
2. **Extra exports.** `clipboardPayloadVersion(json)` (lets the editor tell "copied from a
   newer version" apart from garbage, since `parseClipboardPayload` returns null for both),
   `clipAssetBytes`, `bytesToBase64`, `base64ToBytes`, `BENCH_MAIN_NODE_COUNT`,
   `MISSING_FILL_COLOR`, `isInstanceOwnKey`, `isOverridePath`, `isSubpathId`, `newSubpathId`,
   `compareTreeIds`, `parseAngle`, `rotateOnlyTransform`, `formatPathNumber`, `resolveVars`,
   `sanitizeSvgMarkup`, `formatCssNumber`, `cssPropertyName`, `cssDeclarationValue`,
   `positionContextOf`, `borderInsets`, `unionRects`, `wouldCreateCycleForKeys`.
3. **`readRotation`** returns `rotate` **plus** a rotate-only `transform` (CSS renders both); a
   `transform` with any other function contributes 0. `NodeFrame.rotation` from `docGeometry`
   is normalised to (−180, 180].
4. **`ResolvedNode` details** (identical in TS and Rust): `overridden` is omitted when nothing is
   overridden and its `styles` are sorted (Loro map order differs between the wasm and native
   builds); on an instance root it also lists the instance's own size keys. `mainDeleted` is
   present only when true. `source` is set on every expanded node including the instance root
   (absent on `unresolved` roots). An instance root keeps its own `nodeKey`/`mainId`; virtual
   copies of a main nested inside another main drop its `componentKey` (plain content, 2.7.1).
5. **Placeholder roots** (`cycle | depth | unresolved`) get width/height 100 only when missing
   and `#E3E3E3` only when they have no `backgroundColor`/`background` of their own.
6. **Depth:** the top-level instance and 15 nested levels resolve; the next level sees 16 keys
   on the stack and renders as `depth` (the 3.2 step 1 rule taken literally).
7. **`PasteResult.components.created/reused`** hold component **keys**.
   `ReparentRefusal 'instance-target'` also covers targets that cannot have children (leaves,
   missing or virtual ids).
8. **`resetOverrides` `keys`** also accepts the entry fields `text`, `hidden`, `assetId`,
   `assetName`; with `keys` on an instance root only `overrides['']` and the root's own
   non-placement keys are reset.
9. **`setPointMode(sp, i, 'corner')`** removes the anchor's handles (a sharp corner — the
   double-click toggle); `smooth`/`mirrored` create handles from the neighbours when missing.
10. **Sizes on context changes:** `groupNodes`, `wrapInFrame`, `reparentNodes` (into a group,
    or out of a flex parent into an absolute/page context), `pasteClipboard` and virtual
    duplicates freeze non-px `width`/`height` (`%`, `auto`, flex sizing) to the measured size;
    text keeps an absent width/height (auto size); instances keep following their main.
11. **`listComponents`** sorts by name, then key ("registry order" is Loro's hash order, which
    is not stable across builds). `removeNodes` skips pages. `duplicateNodes` places detached
    copies of virtual refs after their instance, at the same world position.
12. **`wrapInFrame`** keeps the editor's Phase 2 behaviour for flow items of a flex parent (a
    new flex frame with the parent's direction at the first item's index); everything else
    gets an absolute frame sized to the union.
13. **Exporters:** the JS fallback core now exports through `renderHtml`, so its HTML equals the
    Rust core's (headings by font size, `<section>` artboards, `baren-asset://` image URLs)
    except that it adds no intrinsic `<img>` size attributes. The Rust `export_html` resolves
    instances only for subtrees that contain one (or virtual roots); other subtrees take the
    Phase 2 path unchanged. Numeric `rotate` renders as `deg` in both.
14. **Parity fixture:** the Phase 2 parity document used a raw `type: 'group'` as its "unknown
    type decodes as frame" example; `group` is a real type now, so the generator writes
    `'widget'` instead and `parity.loro` was regenerated (otherwise the same document).

## QA changes

Recorded by the QA workstream (2026-10-02); details and tests in
`docs/requests/phase3-qa.md`.

1. `placementStyles` takes an optional `{ absolute }`: absolutely positioned children of flex
   frames stay absolute when rotated (`rotateNodes`), grouped, wrapped or ungrouped. A new
   group or wrapping frame in a flex parent is a flow item only when it holds a flow item of
   that parent.
2. `moveNode` into a main re-keys moved nodes whose `nodeKey` already exists in the enclosing
   main (nested mains keep their keys); `createComponent` reserves nested-main keys before
   de-duplicating; `detachInstance` refits the groups it materialises.
3. Paste and inserts never target a locked or hidden container (`containerForInsert`).
4. Section 9 propagation numbers must be measured with the bench rAF registered before the
   edit (Loro events are synchronous); the corrected measurements are in the QA notes.

The QA wording is folded into sections 2.4, 2.5, 2.7.2, 4.4 and 4.5 below.

## Integration changes

Recorded at the Phase 3 integration (2026-10-02). What was built is summarised in
`ARCHITECTURE.md` ("Phase 3 — canvas tools"); status and numbers are in `docs/STATUS.md`.

1. **Clipboard blob type (7.5).** The custom format's blob is typed
   `application/x-baren-clipboard+json` (not `application/json`): Chromium refuses a `web …`
   format whose blob type differs from the format's MIME type. Main and the mock bridge both do
   this (editor deviation 1); the format name readers see is unchanged.
2. **Main-component labels** on the canvas show the whole name (up to 320 screen px), not a name
   truncated to the main's width (design Request 2, editor request; artboards 31–33).
3. **`clipboardText`** falls back to the main's name for an unnamed instance without text
   (editor deviation 9 / model MAY request).
4. **Editor deviations accepted as built** (`docs/requests/phase3-editor.md`): paste offset rule
   (2), flow index after the selection for every target (3), picker insert of a component into
   its own main goes to the page (4), Components panel in document order (5), expandable nested
   instance rows (6), Shadow and Filters only for vectors and groups (7), Detach disabled on
   nested instances (8). Canvas deviations accepted as built: `docs/requests/phase3-canvas.md`
   items 1–11.
5. **Style-only propagation fast path (section 9).** The 16 ms budget for a main style edit
   with ~1,000 instances failed on the integration machine (medians 18–22 ms: every instance
   was re-expanded and diffed). New resolver methods (4.8) `stylePaths(batch)` — called before
   `apply`; for a batch that only restyles main content it returns, per affected component, the
   template paths whose resolved styles change (every template showing the node, nested ones
   included), else `null` (any other change kind, registry or instance changes, an affected
   component without a cached top-level template, a hint-cached template, or a restyled main
   root that other components nest) — and `resolveStyles(instanceId, path)` (template node
   styles + the instance's override at that path: exactly the full expansion's value). The
   canvas (`flushBatches` → `SceneManager.refreshInstances` → `Scene.patchStyles`) then
   restyles one virtual node per instance and path; everything else takes the full path as
   before. Layout keys still re-measure (`bump`), paint keys keep measurements. Result:
   6–14 ms (median ≈ 8 ms) at 1,023 instances; 8–11 ms instead of 43–57 ms for 2,000 × 50-node
   instances at 100 %.
6. **Stand-in thumbnails wait for the next frame after a document change** (`UpdateOptions`
   `deferThumbnails`): re-measuring a large stand-in artboard costs tens of ms and used to fill
   the frame that presents the edit. The thumbnails still regenerate (up to 2 per frame) right
   after.
7. **Tests added at integration:** `apps/desktop/tests/visual/phase3-integration-server.spec.ts`
   (all six features through real input, two browser peers, real server) and
   `phase3-electron-server.spec.ts` (B in the built Electron app: native core, real preload/IPC,
   main clipboard, copy/paste between two app windows), both opt-in like the other server
   specs; `packages/schema/tests/stylePaths.test.ts` (fast path equals full expansion, fallback
   cases); `packages/canvas/tests/e2e/integration-phase3.spec.ts` (no instance re-expansion on a
   style-only main edit, result identical to a fresh instance, overrides, layout keys, removed
   styles, the main root); `qa-fuzz.test.ts` got explicit 60 s timeouts (CPU-heavy, 5–7 s).
8. **Rust HTML export budget (section 9)** is read as written: ≤ 2 × the Phase 2 time (5.7 ms),
   i.e. ≤ 11.4 ms; measured 6.0–6.2 ms. The bench additionally prints the ratio to a plain
   500-node export in the same run (2.4–2.6× here; the 50 instances add 600 rendered nodes).

---

## 0. Key decisions (one paragraph each)

1. **Three new node types, one new marker.** `group`, `vector` and `instance` join
   `page | frame | text | rect | svg | image`. A **main component is a `frame` carrying a
   `componentKey`** (not a new type), so every frame feature works on mains for free.
2. **Rotation is the CSS individual transform property** `styles.rotate = "<deg>deg"`, rotating
   the unrotated layout box about its border-box centre — exactly what the inspector already
   writes and what exported HTML renders. `left/top/width/height` always describe the
   unrotated box.
3. **Groups are real boxes.** A group stores its own box (`width/height` + its position in the
   parent) and its children are always `position: absolute` inside it. The box is the union of
   the children and is refitted by whoever changes the geometry, in the same transaction. A
   group in a flex frame is therefore one flex item. Groups have their own rotation.
4. **Vectors store structured paths in node-local px** (`data.vector`: subpaths of anchor points
   with relative bezier handles, in mergeable Loro containers), rendered as one `<svg>` +
   `<path>`; stroke and fill are ordinary style keys (`stroke`, `strokeWidth`, `fill`, …).
5. **Instances are tree leaves resolved at render time.** An instance stores only
   `componentKey`, a `mainId` hint, its own placement/size styles and an `overrides` map. Its
   content is expanded from the main on every render (never copied into the document).
   Expanded nodes have **virtual ids** `"<instanceId>/<nodeKey>/…"`.
6. **Overrides are keyed by `nodeKey`, not by TreeID.** Every node inside a main component
   carries a random, component-scoped `nodeKey`. Override paths survive main edits, undo of
   deletes (which re-create nodes under new TreeIDs) and copy/paste of the main to another file.
7. **Deleted mains keep rendering.** Loro retains deleted subtrees (verified: data and children
   of a deleted tree node stay readable, also after a snapshot round trip). Instances of a
   deleted main render from that retained data, and "Restore main component" re-creates it.
8. **One geometry source of truth.** Group/ungroup, reparent, wrap, rotate-around-pivot and
   paste placement are schema helpers that take world frames from a `GeometrySource`
   (implemented by the canvas from measured DOM). The canvas drag, the layers panel and the
   clipboard all call the same helpers.
9. **Clipboard = one atomic clipboard item** with `text/plain`, `text/html` and the Chromium
   web custom format **`web application/x-baren-clipboard+json`** (payload v2). Written and
   read by the main process (Electron 44's `clipboard.write([new ClipboardItem(…)])`) through a
   new `bridge.clipboard`; the browser mock implements the same member with
   `navigator.clipboard` and the same format name, so both interoperate.
10. **No new presence/protocol kinds.** The server only accepts transient kinds `move` and
    `resize`; rotation previews are sent as `resize` with axis-aligned bounds. No server,
    proto or sync-client change in this phase.

---

## 1. Ownership (who edits what)

| Workstream    | Owns (may edit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **model**     | `packages/schema/**` (src, tests, scripts); `crates/core/**` (schema mirror, export, tests, fixtures, bench); `crates/napi/**` (only if an API change is needed — none is planned; rebuilding `baren-core.*.node` is allowed); `apps/desktop/src/main/core/**` (JS fallback core: export parity); `docs/requests/phase3-model.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **canvas**    | `packages/canvas/**` (src, bench, tests, Playwright config); `docs/requests/phase3-canvas.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **editor**    | `apps/desktop/src/renderer/editor/**`; `apps/desktop/src/renderer/lib/commands.ts` + `commands.test.ts` (new ids only); `apps/desktop/src/renderer/lib/mockBridge.ts` + its tests (the `clipboard` member only); `apps/desktop/src/renderer/types/bridge.d.ts` (the `clipboard` member only); `apps/desktop/src/preload/**` (`bridge.ts`, `channels.ts`, `bridge.test.ts`: clipboard); `apps/desktop/src/main/ipc/**` (handlers + validators for the clipboard channels); new `apps/desktop/src/main/clipboard/**`; `apps/desktop/src/main/index.ts` (only to pass the clipboard implementation into `IpcContext`); `packages/ui/src/icons/**`, `packages/ui/src/components/editor/**`, `packages/ui/src/index.ts` exports, `packages/ui/playground/**`, `packages/ui/src/styles/tokens.css` (additive derived tokens only); `apps/desktop/tests/visual/editor.spec.ts` and new `apps/desktop/tests/visual/phase3-*.spec.ts`; `docs/requests/phase3-editor.md` |
| **design**    | the reference designs (add 29–33, redraw 15 if needed), `design/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **architect** | `docs/phase3/**`, the appended section of `ARCHITECTURE.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Nobody edits `crates/server/**`, `crates/proto/**`, `packages/sync-client/**`,
`apps/desktop/src/renderer/{app,home,team,auth,state}/**`, `renderer/lib/assets.ts` (read-only
use is fine) or other existing sections of `ARCHITECTURE.md` in this phase. The canvas and the
editor never edit the same file: the editor reaches canvas behaviour only through
`CanvasController` (section 5.1) and the model only through `@baren/schema`. A needed change
in another workstream's file is requested in `docs/requests/phase3-<workstream>.md`.

---

## 2. Document model

### 2.1 Node types and containment

| `type`                         | May have children       | Element (canvas + export) | Notes                                           |
| ------------------------------ | ----------------------- | ------------------------- | ----------------------------------------------- |
| `page`                         | yes (any non-page type) | —                         | roots only (unchanged)                          |
| `frame`                        | yes (any non-page type) | `div`                     | a **main component** when `componentKey` is set |
| `group`                        | yes (any non-page type) | `div`                     | **new**; no paints of its own (see 2.5)         |
| `text`, `rect`, `svg`, `image` | no                      | as before                 | unchanged                                       |
| `vector`                       | no                      | `<svg>` + one `<path>`    | **new** (2.6)                                   |
| `instance`                     | **no** (tree leaf)      | `div` + resolved content  | **new** (2.7); content comes from the main      |

`NODE_TYPES = ['page','frame','text','rect','svg','image','group','vector','instance']`,
`CONTAINER_NODE_TYPES = {page, frame, group}`. A page's children may be of any non-page type
(top-level groups, instances, vectors are allowed). `DEFAULT_NODE_NAMES`: `group: 'Group'`,
`vector: 'Vector'`, `instance: ''` (an instance with an empty name displays the current name of
its main; a non-empty name is a rename). Unknown types keep decoding as `frame` (unchanged
rule), so pre-Phase-3 clients degrade instead of failing (2.10).

### 2.2 New data keys (`NODE_KEY` additions)

| Key            | On                               | Loro value              | Meaning                                                                                                                                                                                            |
| -------------- | -------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `componentKey` | `frame` (main), `instance`       | string `[0-9a-z]{16}`   | On a frame: this frame is a main component with this key. On an instance: the component it shows. Keys are random and globally unique; the same key in two files means the same component lineage. |
| `mainId`       | `instance`                       | string (TreeID)         | Hint: TreeID of the main when the instance was created/pasted. Used to find a deleted main (2.7.4). Never authoritative.                                                                           |
| `nodeKey`      | any node inside a main's subtree | string `[0-9a-z]{10}`   | Stable address of the node for overrides (2.7.2).                                                                                                                                                  |
| `overrides`    | `instance`                       | **mergeable** `LoroMap` | Per-instance overrides (2.7.3).                                                                                                                                                                    |
| `vector`       | `vector`                         | **mergeable** `LoroMap` | Path geometry (2.6).                                                                                                                                                                               |

All new child containers are created with `ensureMergeable*` (never `setContainer`), like
`styles` and `text`. Note the Loro rule (from the loro-crdt 1.16 docs, verified): **deleting a
map key that holds a mergeable child hides the child but keeps its state; ensuring the same
key again resurfaces the old state.** Therefore: code that "removes" an override entry or a
vector subpath MUST first delete every key inside it (recursively for `styles`) and SHOULD keep
the (now empty) entry key in place; random keys (subpath ids) are never reused.

New root container: **`doc.getMap("components")`** — the component registry: key =
`componentKey` → mergeable `LoroMap { mainId: string }` (TreeID of the main). Written whenever a
main is created, pasted or restored; never deleted (a deleted main's entry is how its
instances find the retained data). `CONTAINER.components = 'components'`.

`meta.schemaVersion` stays **1**: every change is additive and old documents need no migration.

### 2.3 Rotation

- Stored as `styles.rotate`, canonical value the string **`"<n>deg"`**, `n` normalised to
  (−180, 180] and rounded to 2 decimals; rotation 0 is the **absence** of the key. Writers MUST
  write this form (`rotationValue(deg)`); readers (`readRotation(styles)`) accept `"<n>deg"`,
  `"<n>turn"`, `"<n>rad"`, a bare number (degrees) and, as a legacy fallback, a `transform`
  containing `rotate(<n>deg)`.
- Renderers (canvas `cssValue`, Rust `css::declaration`, the TS HTML exporter) MUST render a
  numeric `rotate` as `"<n>deg"` (today it would get `px`).
- Rotation is about the **border-box centre** (the default `transform-origin`); writers never
  set `transformOrigin`. `left/top/width/height` describe the **unrotated** box in the parent
  (CSS semantics; the inspector's X/Y/W/H show these values). A rotated flex item keeps its
  unrotated flow slot (CSS behaviour; export identical).
- `setRotation` removes a `transform` whose only function is `rotate(…)` (migration of legacy
  values) and leaves any other `transform` untouched.
- **World frame**: `NodeFrame = { x, y, width, height, rotation }` — the unrotated box placed so
  that rotating it by `rotation` (degrees, accumulated over all ancestors) about its centre
  `(x + width/2, y + height/2)` gives the node's actual world shape. No scale or skew exists in
  the model (a user-set `transform` is rendered but ignored by geometry).

### 2.4 Positioning contexts

How a node's position is stored depends on its parent; `reparentNodes` and every placement
helper MUST produce exactly these forms (numbers are px numbers rounded to 2 decimals; existing
`"12px"` strings may be kept by `geometryValue`):

| Parent                                      | Child position styles                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| page                                        | `left`, `top` = world position of the unrotated box; no `position`                                                                                                                                                                                                              |
| `frame` with `display` `flex`/`inline-flex` | in flow: no `position/left/top/right/bottom/inset`; size via `width/height/flex*`. Absolutely positioned children (`position: absolute`) stay allowed and **stay absolute** when rotated, grouped, wrapped or ungrouped (`placementStyles(…, { absolute: true })`, QA change 1) |
| `frame`, any other display                  | `position: 'absolute'`, `left`, `top` relative to the frame's **padding box** (border-box origin + the frame's declared px border widths; unknown widths count as 0). Existing children in normal block flow stay valid                                                         |
| `group`                                     | always `position: 'absolute'`, `left`, `top` relative to the group box (groups have no border)                                                                                                                                                                                  |

Containing block: a non-top-level `frame` that receives absolutely positioned children through a
helper gets `position: 'relative'` in the same transaction when its `position` is unset or
`static`. Group elements always establish a containing block (render rule 3.1).

Converting between contexts (a child's world frame `F`, new parent world frame `P`): local
rotation = `F.rotation − P.rotation`; local centre = `R(−P.rotation)·(centre(F) − centre(P)) +
(P.width/2, P.height/2)` minus the padding-box offset; `left = cx − F.width/2`,
`top = cy − F.height/2`. Sizes are unchanged (there is no scale).

### 2.5 Groups

- A `group` stores its box like any layer: top level `{ left, top, width, height }`; absolute in
  a frame/group `{ position: 'absolute', left, top, width, height }`; in a flex frame
  `{ width, height, flexShrink: 0 }` when it holds a flow item of that frame, else absolute like
  its children were (a new group or wrapping frame in a flex parent is a flow item only when
  one of the grouped nodes was a flow item; QA change 1). It MAY carry `rotate`, `opacity`, `mixBlendMode`,
  `filter`, `zIndex` and flex-item keys; the editor offers no fill, radius, border or flex
  layout for groups (renderers still render any style present).
- Children are always `position: 'absolute'` with `left/top` in group-local coordinates.
- **Box invariant:** the group box equals the union of the axis-aligned bounds of **all** its
  children (hidden ones included, so hiding a child never moves the group) in group-local
  (unrotated) coordinates, normalised so the union starts at (0, 0). It is maintained by
  `fitGroups` (2.5.1).
- **Emptiness:** a local action that moves or deletes the last child of a group deletes the
  group in the same transaction (`reparentNodes`, `removeNodes`, `ungroupNodes` do this).
  Groups emptied by concurrent edits are left in place (no automatic deletion in response to
  imports, which could delete content another peer is adding); they render nothing, are not
  hit-tested on the canvas and stay visible and deletable in the layers panel.
- Groups are not drop targets for canvas drags (except the dragged nodes' own current group,
  5.2), draw/text/pen insertion or image drops (frames only). They are valid targets in the
  layers panel and for paste (when a child of the group is selected; `containerForInsert` then
  returns the group).

#### 2.5.1 Fitting

`fitGroups(doc, ids, geo)` refits every group that is an ancestor of (or is) one of `ids`,
deepest first. For each group: children's local frames come from their declared
`left/top/rotate` and their size (declared px `width/height`, else `geo.frameOf(child)`); the
union `U` of their rotated AABBs becomes the new box; children shift by `(−U.x, −U.y)`; the
group's own position moves so the children stay where they are in world space (for a rotated
group the centre shift is rotated by the group's rotation; for a flow group only `width/height`
change). No write happens when nothing changes by more than 0.01 px.

Who fits: **the actor that changes geometry, in the same transaction** — canvas move, resize,
rotate, nudge, reparent and duplicate; editor inspector geometry edits, layers-panel moves,
paste, delete. Size changes only known after layout (a text edit, a font or image load inside a
group) are refitted by the canvas after its next measurement **only for changes this peer
made** (batches with `by: 'local'`, its own undo/redo included), committed with origin
**`derived:group-fit`** (excluded from undo, see 8.1). Imported (remote) changes never trigger
a fit, which avoids ping-pong between peers whose fonts measure differently.

### 2.6 Vectors

```
data.vector                       mergeable LoroMap
  fillRule : 'nonzero' | 'evenodd' (absent = 'nonzero')
  subpaths : mergeable LoroMap  <subpathId [0-9a-z]{8}> →
      mergeable LoroMap {
        closed : boolean
        order  : number               (sort key; ties broken by subpathId)
        points : mergeable LoroMovableList<VectorPoint>   (plain values, not containers)
      }

VectorPoint = { x: number, y: number,
                in?: [dx, dy], out?: [dx, dy],         // handles, relative to the anchor
                mode?: 'corner' | 'smooth' | 'mirrored' } // absent = 'corner'
```

- **Coordinates are node-local px**: the origin is the top-left of the vector's unrotated
  border box. A vector's `width/height` MUST be px numbers (the editor disables Fill/Hug size
  modes for vectors); resizing a vector rewrites its points scaled by the size ratio in the same
  transaction (`scaleVector`).
- Segment `i` runs from point `i` to `i+1` (and from the last to the first point when
  `closed`). It is a cubic Bézier with control points `p_i + out_i` and `p_{i+1} + in_{i+1}`
  (a missing handle = the anchor itself), or a straight line when both handles are missing.
  `smooth` keeps the two handles collinear, `mirrored` also keeps equal lengths, `corner` makes
  them independent.
- **Path data** (`vectorToPathD`, identical output in TS and Rust): subpaths sorted by
  `(order, id)`, empty ones skipped; per subpath `M x0 y0`, then for each segment `L x y` (line)
  or `C x1 y1 x2 y2 x y`; when `closed` and n ≥ 2, the closing segment is emitted as a `C` only
  if it has a handle, then `Z`. Tokens are joined by single spaces; every number is
  `String(Math.round(n * 1000) / 1000)` with −0 printed as `0` (Rust: the same rounding, then
  `js_number`).
- **Box normalisation:** after an edit, the box is the tight Bézier bounds of all segments
  (curve extrema, not handle hulls), minimum 1 × 1 px. `normalizeVector` shifts the points by
  `(−minX, −minY)`, sets `width/height`, and moves the node so the path stays put in world space
  (rotation-aware; flow vectors only change size).
- Paint: `fill`, `fillOpacity`, `stroke`, `strokeWidth`, `strokeOpacity`, `strokeLinecap`,
  `strokeLinejoin` and `strokeDasharray` are ordinary style keys (camelCase; tokens allowed);
  the fill rule lives in `data.vector.fillRule` (rendered as the path's `fill-rule`). The pen
  tool creates `{ fill: 'none', stroke: '#000000', strokeWidth: 1 }`. Opacity, blend, rotation
  and shadows (`filter: drop-shadow`) work as on any node.
- `svg` layers (sanitised markup, e.g. pasted SVG) are unchanged and not editable as paths.

### 2.7 Components

#### 2.7.1 Mains and the registry

- A main component is a `frame` with `componentKey`. Mains may be top-level artboards or nested
  frames anywhere (also inside other mains). A main inside another main renders as plain
  content inside the outer component's instances.
- `createComponent` (section 4.6) converts a single selected `frame` in place, or wraps the
  selection in a new frame (same rules as wrap-in-frame) and converts that. It assigns
  `nodeKey`s and writes the registry entry. It never leaves an instance behind.
- Duplicating or pasting a main into a file that already has a **live** main with the same key
  gives the copy a **fresh** `componentKey` (a new component); pasting it into a file that does
  not gives it the **same** key (same lineage). The registry is written in both cases.

#### 2.7.2 `nodeKey`

- Every descendant of a main (any depth, also inside nested mains; instances are leaves so the
  walk never crosses them) has a `nodeKey` unique within the subtree of every main that contains
  it. A main root has one only when it is itself inside another main.
- Assignment (all inside schema helpers, so every caller is covered):
  `createNode`/`moveNode` into a main's subtree add a fresh key to nodes that have none;
  `createComponent` fills missing keys in the subtree; copies (duplicate, paste, detach)
  **keep** their keys only when the copy is placed outside every main, and get fresh keys for
  every copied node when placed inside a main's subtree. Moving keeps keys (so overrides stay
  valid when nodes move inside a main), except that `moveNode` into a main gives a fresh key to
  a moved node whose key already exists elsewhere in the outermost enclosing main (keys inside
  nested mains that move along are kept). `createComponent` reserves the keys used inside nested
  mains first, then re-keys every other duplicate, whatever the document order (QA change 2).
  Duplicates can therefore only remain between nested mains (copies of one main nested twice in
  a main, or a main nested in a copy of itself); lookups then use the first in document order.

#### 2.7.3 Instances and overrides

An instance node: `type: 'instance'`, `componentKey`, `mainId`, `name`, `locked`, `hidden`,
`styles`, `overrides`.

- **`styles` holds only the instance's own keys**: `PLACEMENT_KEYS` and `SIZE_KEYS` (listed
  below). A new instance has no size keys: it takes the main's size. Placement keys are never
  inherited from the main root.
  - `PLACEMENT_KEYS`: `left`, `top`, `right`, `bottom`, `inset`, `position`, `rotate`,
    `transform`, `margin`, `marginTop`, `marginRight`, `marginBottom`, `marginLeft`,
    `alignSelf`, `justifySelf`, `flex`, `flexGrow`, `flexShrink`, `flexBasis`, `order`,
    `zIndex`, `gridArea`, `gridColumn`, `gridColumnStart`, `gridColumnEnd`, `gridRow`,
    `gridRowStart`, `gridRowEnd`.
  - `SIZE_KEYS`: `width`, `height`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`,
    `aspectRatio`.
- **`overrides`**: mergeable map, key = **override path**, value = mergeable map entry:

  ```
  overrides[<path>] = { styles?: mergeable LoroMap<styleKey, StyleValue | null>,
                        text?: string, hidden?: boolean, assetId?: string, assetName?: string }
  ```

  Paths: `''` = the instance root (root style overrides other than own keys); `'k1'` = the main
  descendant with `nodeKey` k1; `'k1/k2'` = node k2 inside the nested instance whose node in the
  main has key k1 (any depth). A style value `null` means "property removed in this instance".
  Absent field = not overridden. `text` is a plain string (last writer wins), not LoroText.

- **Virtual ids**: expanded content has ids `"<instanceTreeId>/<path>"` (e.g. `"12@3/a8k2…"`,
  `"12@3/a8k2…/z0p9…"`); the instance root keeps its own TreeID. Grammar:
  `virtualId = treeId ("/" segment)+`, `segment = nodeKey | "~" treeId`, where the `~<TreeID>`
  form only appears for main nodes that lack a `nodeKey` (a broken invariant, 3.2) and cannot
  carry overrides. `/` and `~` never occur in TreeIDs or keys. Virtual ids are accepted by the
  canvas API, the editor selection, presence `selection` (plain strings) and the
  resolve/override helpers; `hasNode` stays false for them.
- **Writing through a ref** (`setStylesAt`, section 4.7): a real id writes the node; a virtual
  id writes its override entry; on an instance root, own keys go to `styles` and every other
  key to `overrides['']`. For overrides: a value equal to the effective base value **removes**
  the override key; `null` sets a `null` override when the base has the property and removes
  the override otherwise.
- **Reset**: `resetOverrides(doc, ref)` on an instance clears every entry's fields (entry keys
  stay, empty) and deletes the instance's non-placement keys from `styles` (it returns to the
  main's size); on a virtual id it clears that entry only (and, with `{ deep: true }`, entries
  below it).
- **Structural edits inside an instance are impossible**: virtual nodes cannot be reordered,
  reparented, grouped, deleted or given children. Delete on a virtual node sets
  `hidden: true` in its override. Moving an absolutely positioned virtual node writes
  `left/top` overrides; resizing writes `width/height` overrides; flow virtual nodes do not move.

#### 2.7.4 Resolving a component key

`findMainComponent(doc, key)` returns `{ mainId, deleted }` or null, deterministically:

1. Registry entry's `mainId` if that node is live and its `componentKey` equals `key`.
2. Else the live frame with that `componentKey` whose TreeID is smallest (compare peer as an
   unsigned integer, then counter). Found through a per-document index built lazily by one full
   tree scan and kept current from `created`/`props` events (this path only runs when the
   registry is stale, e.g. after undoing a main's deletion).
3. Else a **deleted** node (registry `mainId`, then the instance's `mainId` hint) whose data
   still has `componentKey === key` → `{ deleted: true }` (render from retained data).
4. Else null → the instance is **unresolved**.

#### 2.7.5 Cycles and nesting depth

- `componentDependencies(doc, key)`: the keys of all instances inside the main's subtree,
  transitively. Placing a subtree `S` under parent `P` creates a cycle when some main `M` that
  is `P` or an ancestor of `P` has `M.key` in `{instance keys in S} ∪ dependencies of those keys`.
  `createNode`, `moveNode`, `createInstance`, `reparentNodes`, `pasteClipboard`,
  `createComponent` reject such placements with `SchemaError('cycle')` (the paste and reparent
  helpers skip/refuse instead of throwing, see their signatures).
- Concurrent edits can still produce a cycle. Resolution therefore keeps a stack of keys; an
  instance whose key is already on the stack resolves as `status: 'cycle'`, and nesting deeper
  than `MAX_INSTANCE_DEPTH = 16` as `status: 'depth'`. Both render like unresolved instances.

### 2.8 Invariants (checked by `checkInvariants(doc)` in schema tests, never at runtime)

1. Only `page`, `frame`, `group` have children; only pages are roots.
2. Group children are `position: absolute`; a group box matches its children's union within
   0.5 px after any local helper (concurrent edits may leave it stale until the next local edit).
3. Instances have no tree children, have `componentKey`, and have only own keys in `styles`.
4. `componentKey` appears only on `frame` and `instance`; `overrides` only on instances; `vector`
   only on vectors; `nodeKey`s are unique per main subtree (modulo the documented copy case).
5. Every live main has a registry entry (its value may point at an older TreeID after undo).
6. No live main contains (transitively) an instance of itself — except as the result of
   concurrent edits, which render as `cycle`.

### 2.9 Merge behaviour of concurrent edits (two peers)

All cases MUST converge (identical `toSnapshot` on both peers); the table states the outcome.

| Concurrent edits                                                     | Outcome                                                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A groups {x, y}; B moves x                                           | x ends in the group (tree move); its `left/top` is last-writer-wins between A's group-local and B's parent-local value, so x may appear displaced inside the group. Accepted. |
| A and B group the same node into different groups                    | Loro tree move LWW: the node is in one group; the other group may end up empty (renders nothing, stays in layers).                                                            |
| A ungroups G; B adds/moves z into G                                  | G's deletion deletes z (Loro deletes children of a deleted parent). Accepted, documented.                                                                                     |
| A edits main node m; B overrides m in instance I                     | Both kept: I shows B's override for the overridden keys and A's edit for the rest.                                                                                            |
| A deletes main node m (or its subtree); B overrides m                | Override is orphaned (ignored, kept). If A undoes the delete, m returns with the same `nodeKey` and the override applies again.                                               |
| A deletes the main; B creates/edits instances                        | Instances render from the retained main (2.7.4 step 3); inspector offers Restore / Detach.                                                                                    |
| A detaches I; B overrides inside I                                   | B's override lands in the cleared, removed `overrides` map and is lost. Accepted.                                                                                             |
| A puts an instance of B in main A; B puts an instance of A in main B | A cycle exists after merge; resolution renders the inner repeat as `cycle`; the editor offers Detach.                                                                         |
| A and B edit different points of one vector                          | Both kept (movable list per-element ops). Same point: LWW per point. Insert/delete merge.                                                                                     |
| A resizes a vector (points rescaled); B moves a point                | Per-point LWW: B's point may end unscaled. Accepted.                                                                                                                          |
| A and B paste the same component into a file lacking it              | Two mains with one key; registry LWW picks one; resolution (2.7.4) is deterministic on both peers.                                                                            |
| A and B convert the same frame to a component                        | One `componentKey` wins (LWW) and per-node `nodeKey`s may mix; overrides made concurrently against the losing keys are orphaned. Accepted (rare).                             |
| A paste adds token `--x`; B edits `--x`                              | Token maps merge field-wise (existing behaviour).                                                                                                                             |
| A and B move the same node by canvas reparent                        | Tree move LWW + style LWW; may leave positions for the other parent context until the next edit. Accepted.                                                                    |
| Group fits computed by A and B for different child edits             | Last writer wins on the box; cosmetic until the next local edit refits.                                                                                                       |

### 2.10 Back-compat and migration

- No migration: documents without the new features decode, render and export exactly as before
  (parity fixtures for Phase 2 documents MUST stay byte-identical in `toSnapshot` JSON and HTML
  export).
- `DocSnapshot` gains `components?: Record<string, { mainId: string }>` (omitted when the
  registry is empty, so old snapshots are unchanged). `DesignNode` gains optional fields only.
- Pre-Phase-3 clients (until they auto-update) see new types as `frame`: groups render roughly
  right (absolute children in a box), instances and vectors render as empty boxes; their
  copy/duplicate drops the new keys. No crash, no data loss in documents they do not edit.
- Clipboard payload v1 (`{ kind: 'baren/nodes', version: 1 }` in `text/plain`) is still
  accepted by paste.

---

## 3. Rendering rules (canvas, editor raster, TS HTML, Rust HTML — all agree)

### 3.1 Common

1. `group` → `div`; renderers add `position: relative` unless the group's `position` is
   `absolute`/`fixed` (containing block for its children). The canvas also gives group elements
   `pointer-events: none` (children keep `auto`), so empty areas inside a group hit what lies
   below; exporters omit this.
2. `instance` → `div` styled with the resolved root styles, children = resolved content.
3. `vector` → `<svg width="W" height="H" viewBox="0 0 W H" overflow="visible">` (no
   `preserveAspectRatio` tricks, no `vector-effect`), node styles on the `<svg>` element (so
   `fill`, `stroke`, `strokeWidth`… inherit to the path), one
   `<path d="…" fill-rule="nonzero|evenodd"/>`. `overflow: visible` is the default unless the
   node sets `overflow`.
4. Numeric `rotate` renders as `deg` (2.3).
5. Hidden nodes (own flag or `hidden` override) are not rendered by exporters and are
   `.ic-hidden` on the canvas (unchanged).

### 3.2 Instance resolution (render-time, never copied)

For instance `I` with key `K` (stack of keys starts empty):

1. If `K` is on the stack → `status: 'cycle'`; if the stack depth is 16 → `'depth'`; else find
   the main (2.7.4). None → `'unresolved'`. Push `K`.
2. **Root** (id = `I`): styles = main root `styles` minus `PLACEMENT_KEYS`, then apply
   `I.overrides[''].styles` (value → set, `null` → delete), then apply `I.styles` (all keys).
   `hidden`, `locked`, `name` are `I`'s own (empty name → main's name). Type renders as a
   container (`div`).
3. **Descendants**: for each main node `n` below the root (document order), the virtual node
   `I/<path>` where `path` is `n.nodeKey` (nodes without a `nodeKey` are rendered with path
   `'~' + TreeID` and cannot be overridden — they only exist when invariant 4 is broken).
   Base = `n`'s data (styles, text, hidden, assetId/assetName, svg, vector). If `n` is a nested
   instance `N` (key `K2`), its base is the recursive resolution of `N` (steps 1–3 with `N`'s
   own `styles`/`overrides`, stack including `K`), and its content paths are prefixed with
   `n.nodeKey/`. Then apply `I.overrides[path]` (styles: value → set, `null` → delete; `text`,
   `hidden`, `assetId`, `assetName` replace).
   **Order: innermost definition first, outermost instance last** — main node → overrides
   stored on nested instance nodes inside the main → the outer instance's overrides.
4. Structure: children of a virtual node are the (virtual) children of its main node in main
   order. Pop `K`.
5. `status: 'cycle' | 'depth' | 'unresolved'`: render the root only, with `I.styles` (and the
   overrides[''] styles); when it has no own `width/height`, use 100 × 100 px and the neutral
   placeholder fill `#E3E3E3` (`MISSING_FILL_COLOR`, design content, like missing images).
6. A deleted main (`deleted: true`) renders normally from its retained data; the expansion is
   flagged `mainDeleted: true`.

Live propagation: any change to a node in a main's subtree, to the main itself or to the
registry entry invalidates that component and every component depending on it
(`ComponentResolver.affectedBy`, section 4.8); the canvas re-renders affected instances in the
same frame as the change.

### 3.3 Vectors

`vectorToPathD` (2.6) is the only path generator (canvas, raster, HTML in TS and Rust). Copy as
SVG of a vector produces a standalone document: `<svg xmlns="http://www.w3.org/2000/svg"
width="W" height="H" viewBox="0 0 W H">` with the path and **resolved** paint attributes
(`var(--token)` replaced by the token value, falling back to the var() fallback, else omitted).

### 3.4 Rotated geometry

- **Frames**: for rotated nodes (own or inherited rotation) the canvas takes the unrotated size
  from layout — `offsetWidth/offsetHeight`, which ignore transforms and are already world px
  (the zoom is a transform on the world layer); the declared px `width/height` for `<svg>`
  elements (vectors, svg layers) — and the world centre from the centre of
  `getBoundingClientRect()` converted with `screenToWorld` (the centre of any affine image of a
  rectangle is the image of its centre); world rotation = sum of `readRotation` along the
  ancestor chain. Unrotated nodes keep today's single `getBoundingClientRect` path (no extra
  reads).
- **Hit-testing**: the DOM path (`pathForElement`) is exact (the browser handles CSS rotation).
  The rbush indexes keep storing **axis-aligned bounds** (the rotated shape's AABB, which is what
  `getBoundingClientRect` returns); `IndexedNode` gains an optional frame, and `topmostAt`
  performs an exact point-in-rotated-rectangle test for entries with a non-zero world rotation.
  Clipping by a rotated `overflow: hidden` ancestor is approximated by its AABB (documented).
- **Selection**: one selected node → the outline and handles are drawn on its rotated box.
  Several nodes → one axis-aligned box around the union of their rotated corners; handles
  axis-aligned. Hover outlines follow the rotated box.
- **Snapping**: rotated nodes take part as their AABB (as moving selections do).
- **Bounds API**: `getNodeBounds` returns the world AABB (unchanged semantics for unrotated
  nodes); `getNodeFrame` returns the `NodeFrame`.

### 3.5 Export

- Rust `crates/core` HTML export and the TS exporter (`renderHtml`) render groups, vectors,
  resolved instances (with `data-node-id` = real or virtual id when ids are included) and
  rotation per 3.1–3.4. JSON export (`exportJson`) is the raw `DocSnapshot` (no expansion) with
  the new fields and `components`.
- Asset references inside overrides (`assetId`, `url(baren-asset://…)` in override styles)
  count as references: `nodeAssetRefs`, `docAssetRefs`, `referenced_assets` and the asset sync
  include them.

---

## 4. `@baren/schema` API additions (exact signatures)

Every compound helper below runs inside `transact(doc, fn, { origin })` itself (joining an outer
transaction when one is open): **one call = one commit = one undo step**. `origin` defaults are
given per helper; callers pass their own (section 8.1).

### 4.1 Types (`types.ts`)

```ts
export const NODE_TYPES = [
  'page',
  'frame',
  'text',
  'rect',
  'svg',
  'image',
  'group',
  'vector',
  'instance',
] as const
export const CONTAINER = {
  meta: 'meta',
  nodes: 'nodes',
  tokens: 'tokens',
  components: 'components',
} as const
export const NODE_KEY = {
  // …existing keys
  componentKey: 'componentKey',
  nodeKey: 'nodeKey',
  mainId: 'mainId',
  overrides: 'overrides',
  vector: 'vector',
} as const
export const CONTAINER_NODE_TYPES: ReadonlySet<NodeType> // page, frame, group
export const MAX_INSTANCE_DEPTH = 16
export const COMPONENTS_PAGE_NAME = 'Components'
export const PLACEMENT_KEYS: ReadonlySet<string> // 2.7.3
export const SIZE_KEYS: ReadonlySet<string> // 2.7.3

export type OverrideStyles = Record<string, StyleValue | null>
export interface OverrideEntry {
  styles?: OverrideStyles
  text?: string
  hidden?: boolean
  assetId?: string
  assetName?: string
}
export type VectorPointMode = 'corner' | 'smooth' | 'mirrored'
export interface VectorPoint {
  x: number
  y: number
  in?: [number, number]
  out?: [number, number]
  mode?: VectorPointMode
}
export interface VectorSubpath {
  id: string
  closed: boolean
  points: VectorPoint[]
}
export interface VectorData {
  fillRule: 'nonzero' | 'evenodd'
  subpaths: VectorSubpath[]
}

export interface DesignNode {
  // …existing fields, then in this order:
  componentKey?: string
  nodeKey?: string
  mainId?: string
  overrides?: Record<string, OverrideEntry> // instances; empty entries and empty maps omitted
  vector?: VectorData // vectors; subpaths sorted by (order, id)
}
export interface DocSnapshot {
  // …existing fields
  components?: Record<string, { mainId: string }>
}
export interface NodeProps {
  // …existing props
  componentKey?: string
  nodeKey?: string
  mainId?: string
}

export interface Point {
  x: number
  y: number
}
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
// 2.3
export interface NodeFrame extends Rect {
  rotation: number
}
export interface GeometrySource {
  frameOf(id: string): NodeFrame | null
}
```

`SchemaErrorCode` gains `'cycle' | 'invalid-ref' | 'invalid-payload'`. `CreateNodeInput` gains
`componentKey?`, `nodeKey?`, `mainId?`, `overrides?: Record<string, OverrideEntry>`,
`vector?: VectorData` (validated: `vector` only on vectors, `overrides` only on instances,
instances require `componentKey`, `componentKey` only on frames/instances).

Field order of `DesignNode` in JSON (Rust serde order MUST match): `id, type, name, parentId,
children, styles, text, svg, assetId, assetName, locked, hidden, background, componentKey,
nodeKey, mainId, overrides, vector`. `OverrideEntry`: `styles, text, hidden, assetId,
assetName`. `VectorData`: `fillRule, subpaths`; subpath: `id, closed, points`; point:
`x, y, in, out, mode`.

### 4.2 Events (`events.ts`)

```ts
export type NodeChange =
  /* existing */
  | { kind: 'overrides'; id: string; paths: string[] } // instance overrides changed ('' = root)
  | { kind: 'vector'; id: string } // vector geometry or fillRule changed
export interface NodeChangeBatch {
  // …existing fields
  components: string[] // registry keys changed
}
```

Path parsing: `['nodes', id, 'overrides', <path>, …]` → `overrides` with that path (a map diff
at `['nodes', id, 'overrides']` contributes its updated keys); `['nodes', id, 'vector', …]` →
`vector`; `componentKey`, `nodeKey`, `mainId` arrive as `props` keys. `subscribeNodes` also
fires when only `components` changed. Content events stay deduplicated per node and are omitted
for nodes created/deleted in the same batch (unchanged rule).

### 4.3 Ids and keys (`ids.ts`)

```ts
export function newComponentKey(random?: () => number): string // [0-9a-z]{16}
export function newNodeKey(random?: () => number): string // [0-9a-z]{10}
export function newSubpathId(random?: () => number): string // [0-9a-z]{8}
export function isComponentKey(v: unknown): v is string
export function isNodeKey(v: unknown): v is string
export function isVirtualId(id: string): boolean
export function parseVirtualId(id: string): { instanceId: string; path: string } | null // path 'k1/k2'
export function virtualId(instanceId: string, path: string): string
export function isNodeRef(v: unknown): v is string // TreeID or virtual id
export function refExists(doc: LoroDoc, ref: string, resolver?: ComponentResolver): boolean
```

Default `random` is `crypto.getRandomValues`-based.

### 4.4 Geometry and rotation (`geometry.ts`, `rotation.ts`)

```ts
export function frameCenter(f: NodeFrame): Point
export function frameCorners(f: NodeFrame): [Point, Point, Point, Point] // tl, tr, br, bl (world)
export function frameAabb(f: NodeFrame): Rect
export function pointInFrame(f: NodeFrame, p: Point): boolean
export function rotatePoint(p: Point, pivot: Point, deg: number): Point
export function worldToLocal(parent: NodeFrame, p: Point): Point // unrotated parent-local
export function localToWorld(parent: NodeFrame, p: Point): Point
/** Child world frame → its position styles under `parentId` (2.4), incl. relative `rotate`. */
export function placementStyles(
  doc: LoroDoc,
  parentId: string,
  world: NodeFrame,
  parentFrame: NodeFrame | null,
  opts?: { absolute?: boolean }, // QA: in a flex parent, place absolutely instead of in flow
): StylePatch
/** Declared-styles-only geometry (tests, headless use, fallback for unmeasured nodes). */
export function docGeometry(doc: LoroDoc): GeometrySource

export function normalizeDeg(deg: number): number // (-180, 180]
export function readRotation(styles: Styles): number // 2.3
export function rotationValue(deg: number): string | null // "15deg" | null for 0
/** Set each node's own rotation (about its own centre). Inspector field. */
export function setRotation(
  doc: LoroDoc,
  refs: readonly string[],
  deg: number,
  geo: GeometrySource,
  opts?: { origin?: string },
): void // default 'editor:inspector'
/** Rotate around a pivot (default: centre of the union AABB): absolute/top-level nodes move
 *  their centre and add `delta`; flow nodes and virtual nodes only add `delta`. Fits groups. */
export function rotateNodes(
  doc: LoroDoc,
  refs: readonly string[],
  delta: number,
  geo: GeometrySource,
  opts?: { pivot?: Point; origin?: string },
): void // default 'canvas:rotate'
```

### 4.5 Groups, reparenting, removal (`groups.ts`, `reparent.ts`)

```ts
/** Ctrl+G. Normalises to topmost refs (no virtual ids, no pages); the group goes into the
 *  parent of the top-most painted node, at that node's index; children keep their world
 *  frames. Returns the group id or null. */
export function groupNodes(
  doc: LoroDoc,
  ids: readonly string[],
  geo: GeometrySource,
  opts?: { name?: string; origin?: string },
): string | null // default 'editor:group'
/** Ctrl+Shift+G. Children go to the group's parent at the group's index, in order, keeping
 *  world frames (rotation baked: child rotation += group rotation); into a flex parent they
 *  become flow items when the group was a flow item, else they stay absolute (QA change 1).
 *  Deletes the groups. Returns the former children. */
export function ungroupNodes(
  doc: LoroDoc,
  groupIds: readonly string[],
  geo: GeometrySource,
  opts?: { origin?: string },
): string[] // default 'editor:ungroup'
export function fitGroups(doc: LoroDoc, ids: readonly string[], geo: GeometrySource): void // 2.5.1, no own commit
/** Resize a group's box and scale its descendants' px left/top/width/height (recursively
 *  through nested groups; frames keep their own layout inside). */
export function resizeGroup(
  doc: LoroDoc,
  groupId: string,
  box: { left?: number; top?: number; width: number; height: number },
  opts?: { origin?: string },
): void
/** Wrap in a new frame (rotation-aware successor of the editor's wrapInFrame). */
export function wrapInFrame(
  doc: LoroDoc,
  ids: readonly string[],
  geo: GeometrySource,
  opts?: { name?: string; origin?: string },
): string | null // default 'editor:menu'

export interface ReparentMove {
  id: string
  world?: NodeFrame /* desired; default geo.frameOf(id) */
}
export interface ReparentTarget {
  parentId: string
  index?: number /* final index of the first moved node */
}
export type ReparentRefusal = 'cycle' | 'instance-target' | 'virtual' | 'page-node' | 'into-self'
export function canReparent(
  doc: LoroDoc,
  ids: readonly string[],
  parentId: string,
): { ok: true } | { ok: false; reason: ReparentRefusal }
/** Canvas drag-reparent and layers-panel moves: tree move + context conversion (2.4) +
 *  containing-block fix + nodeKey assignment + group fits + deletion of emptied groups.
 *  Returns the ids actually moved ([] when refused). */
export function reparentNodes(
  doc: LoroDoc,
  moves: readonly ReparentMove[],
  target: ReparentTarget,
  geo: GeometrySource,
  opts?: { origin?: string },
): string[] // default 'editor:layers'
/** Delete real nodes (topmost only), hide virtual ones (override), delete emptied groups,
 *  refit groups. */
export function removeNodes(
  doc: LoroDoc,
  refs: readonly string[],
  geo: GeometrySource,
  opts?: { origin?: string },
): void // default 'editor:menu'
```

### 4.6 Components (`components.ts`)

```ts
export interface ComponentInfo {
  key: string
  mainId: string
  name: string
  pageId: string
}
export function listComponents(doc: LoroDoc): ComponentInfo[] // live mains, registry order then name
export function findMainComponent(
  doc: LoroDoc,
  key: string,
): { mainId: string; deleted: boolean } | null
export function isMainComponent(doc: LoroDoc, id: string): boolean
export function componentDependencies(doc: LoroDoc, key: string): Set<string>
export function wouldCreateCycle(
  doc: LoroDoc,
  subtreeIds: readonly string[],
  parentId: string,
): boolean
export function createComponent(
  doc: LoroDoc,
  ids: readonly string[],
  geo: GeometrySource,
  opts?: { name?: string; origin?: string },
): string | null // main id; default 'editor:component'
export function createInstance(
  doc: LoroDoc,
  input: {
    componentKey: string
    parentId: string
    index?: number
    styles?: Styles /* own keys only; others are dropped */
    name?: string
  },
  opts?: { origin?: string },
): string // default 'editor:insert'; throws 'cycle'
/** One level: the instance becomes a frame with real children (resolved, overrides baked in);
 *  nested instances stay instances with their overrides rebased. Same TreeID is kept. */
export function detachInstance(doc: LoroDoc, instanceId: string, opts?: { origin?: string }): string // default 'editor:detach'
/** Re-create a deleted main from retained data (same key, same nodeKeys) on the
 *  "Components" page (created at the end when missing); updates the registry. */
export function restoreMainComponent(
  doc: LoroDoc,
  key: string,
  opts?: { origin?: string },
): string | null // default 'editor:component'
```

### 4.7 Overrides (`overrides.ts`)

```ts
export function setStylesAt(
  doc: LoroDoc,
  ref: string,
  patch: StylePatch,
  opts?: { origin?: string; resolver?: ComponentResolver },
): void
export function setTextAt(
  doc: LoroDoc,
  ref: string,
  text: string,
  opts?: { origin?: string; resolver?: ComponentResolver },
): void
export function setPropsAt(
  doc: LoroDoc,
  ref: string,
  patch: Pick<NodePropsPatch, 'hidden' | 'locked' | 'name' | 'assetId' | 'assetName'>,
  opts?: { origin?: string; resolver?: ComponentResolver },
): void // virtual: hidden/assetId/assetName only
export function resetOverrides(
  doc: LoroDoc,
  ref: string,
  opts?: { deep?: boolean; keys?: readonly string[]; origin?: string },
): void // default 'editor:reset-overrides'
export function getOverrides(doc: LoroDoc, instanceId: string): Record<string, OverrideEntry>
export function hasOverrides(doc: LoroDoc, ref: string): boolean
```

Without an `origin` these behave like the primitive helpers (commit unless inside `transact`),
so the editor's existing `patchStyles`/`previewStyles` can route to `setStylesAt` unchanged.

### 4.8 Resolution (`resolve.ts`)

```ts
export type InstanceStatus = 'ok' | 'cycle' | 'depth' | 'unresolved'
export interface ResolvedNode extends DesignNode {
  // id = real or virtual id
  source?: { instanceId: string; path: string; mainNodeId: string; componentKey: string }
  overridden?: { styles: string[]; text: boolean; hidden: boolean; assetId: boolean } // outermost level
  status?: InstanceStatus // instance roots
  mainDeleted?: boolean // instance roots
}
export interface ExpandedInstance {
  rootId: string
  componentKey: string
  status: InstanceStatus
  mainDeleted: boolean
  nodes: Record<string, ResolvedNode>
  dependsOn: ReadonlySet<string>
}
export interface AffectedByBatch {
  components: ReadonlySet<string>
  instances: ReadonlySet<string>
}
export interface ComponentResolver {
  expandInstance(instanceId: string): ExpandedInstance | null
  resolveNode(ref: string): ResolvedNode | undefined
  /** Children refs of a node (virtual for instance content). */
  childrenOf(ref: string): readonly string[]
  /** Components whose rendered content changed, instances whose own data changed. */
  affectedBy(batch: NodeChangeBatch): AffectedByBatch
  /** Call once per batch (after affectedBy) to drop stale caches. */
  apply(batch: NodeChangeBatch): void
  /** Integration: the style-only fast path. Paths (per affected component key) a batch
   *  restyles, or null when it needs full re-expansion. Call BEFORE apply(batch). */
  stylePaths(batch: NodeChangeBatch): ReadonlyMap<string, ReadonlySet<string>> | null
  /** Integration: resolved styles of one node of a real instance, equal to the full
   *  expansion's, without expanding the instance. */
  resolveStyles(instanceId: string, path: string): Styles | undefined
  dispose(): void
}
export function createComponentResolver(doc: LoroDoc): ComponentResolver
/** toSubtreeSnapshot with every instance expanded (exporters, raster, clipboard HTML). */
export function toRenderSubtree(
  doc: LoroDoc,
  rootRef: string,
  resolver?: ComponentResolver,
): { rootId: string; nodes: Record<string, ResolvedNode> } | undefined
export function getResolvedNode(
  doc: LoroDoc,
  ref: string,
  resolver?: ComponentResolver,
): ResolvedNode | undefined
```

The resolver caches one resolved template per component key and clones it per instance (then
applies that instance's overrides); caches are invalidated through `apply(batch)`.

### 4.9 Vectors (`vector.ts`)

```ts
export function vectorToPathD(v: VectorData): string // 2.6 format
export function vectorBounds(v: VectorData): Rect | null // tight Bézier bounds
export function normalizeVector(
  v: VectorData,
  box: NodeFrame,
): { vector: VectorData; box: NodeFrame }
export function scaleVector(v: VectorData, sx: number, sy: number): VectorData
export function splitSegment(sp: VectorSubpath, segment: number, t: number): VectorSubpath
export function nearestOnPath(
  v: VectorData,
  p: Point /* local */,
  tolerance: number,
): { subpathId: string; segment: number; t: number; point: Point; distance: number } | null
export function setPointMode(sp: VectorSubpath, index: number, mode: VectorPointMode): VectorSubpath
export function vectorToSvgMarkup(
  node: Pick<DesignNode, 'styles' | 'vector'>,
  tokens: Record<string, Token>,
): string // 3.3
/** Replace geometry with a minimal diff (per-point `set`, inserts, deletes, subpath adds/removes). */
export function setVector(doc: LoroDoc, id: string, v: VectorData): void
export type VectorEdit =
  | { kind: 'set'; subpathId: string; index: number; point: VectorPoint }
  | { kind: 'insert'; subpathId: string; index: number; point: VectorPoint }
  | { kind: 'delete'; subpathId: string; index: number }
  | { kind: 'closed'; subpathId: string; closed: boolean }
  | { kind: 'fillRule'; fillRule: 'nonzero' | 'evenodd' }
export function editVector(doc: LoroDoc, id: string, edits: readonly VectorEdit[]): void
/** Points + box together (normalisation result) in one call. */
export function setVectorGeometry(
  doc: LoroDoc,
  id: string,
  v: VectorData,
  styles: StylePatch,
  opts?: { origin?: string },
): void // default 'canvas:vector'
```

Vectors are created with `createNode({ type: 'vector', vector, styles, … })`.

### 4.10 Clipboard (`clipboard.ts`) and HTML (`html.ts`)

```ts
export const CLIPBOARD_MIME = 'web application/x-baren-clipboard+json'
export const CLIPBOARD_KIND = 'baren/clipboard'
export const CLIPBOARD_VERSION = 2
export const MAX_CLIPBOARD_ASSET_BYTES = 24 * 1024 * 1024 // embedded raw bytes, total
export const MAX_CLIPBOARD_NODES = 50_000
export interface ClipboardPayload {
  /* section 7.2 */
}
export function serializeClipboard(
  doc: LoroDoc,
  refs: readonly string[],
  ctx: {
    geo: GeometrySource
    fileId: string | null
    pageId: string
    app?: string
    resolver?: ComponentResolver
  },
): ClipboardPayload | null
export function attachAssetBytes(
  payload: ClipboardPayload,
  read: (hash: string) => Promise<{ bytes: Uint8Array; mime: string } | null>,
  limit?: number,
): Promise<ClipboardPayload>
export function parseClipboardPayload(json: string): ClipboardPayload | null // strict; v1 upgraded
export function clipboardText(payload: ClipboardPayload): string // 7.3
export interface PasteOptions {
  parentId: string // page, frame or group
  index?: number // index of the first root among the new siblings
  translate?: { dx: number; dy: number } // world offset applied to root frames (default 0, 0)
  geo: GeometrySource
  assetRemap?: Record<string, string> // payload hash → stored hash (when they differ)
  origin?: string // default 'editor:clipboard'
  random?: () => number
}
export interface PasteResult {
  ids: string[]
  components: { created: string[]; reused: string[] }
  tokens: { added: string[]; kept: string[] }
  refused: 'cycle' | 'invalid-target' | null
}
export function pasteClipboard(
  doc: LoroDoc,
  payload: ClipboardPayload,
  opts: PasteOptions,
): PasteResult
/** Ctrl+D: the same deep-copy rules as paste, without the clipboard. Copies go right after
 *  each original; `placeRoot` may patch a copy root's styles (artboards to the right). */
export function duplicateNodes(
  doc: LoroDoc,
  refs: readonly string[],
  geo: GeometrySource,
  opts?: { placeRoot?: (node: DesignNode) => StylePatch | null; origin?: string },
): string[] // default 'canvas:duplicate'
export function tokensReferencedBy(
  nodes: Iterable<DesignNode | ResolvedNode>,
  tokens: Record<string, Token>,
): string[] // var(--x), transitive

export interface HtmlOptions {
  tokens?: Record<string, Token>
  includeIds?: boolean
  assetUrl?: (hash: string) => string | null /* null drops the image */
}
export function renderHtml(doc: LoroDoc, refs: readonly string[], opts?: HtmlOptions): string
export function renderSubtreeHtml(
  nodes: Record<string, ResolvedNode>,
  rootId: string,
  opts?: HtmlOptions,
): string
```

`renderHtml` replaces the JS fallback core's private exporter (its
`apps/desktop/src/main/core/js/htmlExport.ts` delegates to it) and produces the clipboard's
`text/html`.

`generateBenchDoc` gains `components?: { mains: number; everyNth: number }` and
`vectors?: { everyNth: number }` (both default off, so default output — and the Rust bench
mirror — are unchanged).

### 4.11 Rust mirror (`baren_core::schema`, `export`)

`NodeType::{Group, Vector, Instance}` (`is_container` adds `Group`); `node_key::{COMPONENT_KEY,
NODE_KEY, MAIN_ID, OVERRIDES, VECTOR}`; `container::COMPONENTS`; `DesignNode` gains
`component_key, node_key, main_id: Option<String>`, `overrides: Option<Overrides>`,
`vector: Option<VectorData>`; `DocSnapshot.components`. Functions: `to_render_subtree(doc,
root_id) -> Option<RenderSubtree>` (same algorithm as 3.2, including tombstones — if the `loro`
crate cannot read a deleted node's data, record it in `docs/requests/phase3-model.md` and render
such instances as `unresolved`), `find_main_component`, `vector_to_path_d`, `read_rotation`.
HTML export: section 3. Parity: `crates/core/tests/fixtures/make-parity.mjs` gains a document
with a group, a rotated group, a vector (lines + curves, closed + open), a main with a nested
instance, an instance with root/child/nested overrides (incl. `null`), a deleted main with a
live instance, and a registry; `toSnapshot`, `toRenderSubtree` and `vectorToPathD` JSON/strings
must be identical between TS and Rust.

---

## 5. Canvas (`packages/canvas`)

### 5.1 API additions (`types.ts`) — landed first, with stubs

```ts
export type Tool = 'select' | 'hand' | 'artboard' | 'rectangle' | 'text' | 'pen'
export const TOOLS: readonly Tool[] // + 'pen'
export type { NodeFrame, GeometrySource } from '@baren/schema'

export interface CanvasOptions {
  /* existing */
  /** Vector being edited in place (null when editing stops). */
  onVectorEditChange?: (id: string | null) => void
}
export interface DropTargetOptions {
  /** Deepest unlocked frame instead of the top-level artboard. */
  deep?: boolean
  /** Reject a candidate parent (e.g. component cycles); the next shallower one is tried. */
  accept?: (parentId: string) => boolean
}

export interface CanvasController {
  /* existing */
  /** World frame of a real or virtual node on this page (2.3); measures synchronously when
   *  needed (forced layout is acceptable: commands only, never per frame). */
  getNodeFrame(id: string): NodeFrame | null
  /** GeometrySource backed by getNodeFrame (fallback: docGeometry). */
  geometry(): GeometrySource
  /** Start/stop editing a vector's points in place (also stopped by stopEditing). */
  editVector(id: string): void
  getEditingVector(): string | null
  dropTargetAt(
    client: { clientX: number; clientY: number } | null,
    options?: DropTargetOptions,
  ): DropTarget | null
}
```

Accepting virtual ids: `select`, `setHover`, `getNodeBounds`, `getNodeFrame`, `editText`,
`getSelection` (returns them), `onSelectionChange`, `onHoverChange`, presence selections.
`ORIGIN` gains `reparent: 'canvas:reparent'`, `rotate: 'canvas:rotate'`, `pen: 'canvas:pen'`,
`vector: 'canvas:vector'`, `groupFit: 'derived:group-fit'`. The default
`undoExcludeOriginPrefixes` becomes `['remote', 'sync', 'bench', 'derived']`.
`deleteSelection` → `removeNodes`; `duplicateSelection` → schema `duplicateNodes` (top-level
artboards still go to the right with `DUPLICATE_GAP`); `nudge` fits groups.

### 5.2 Behaviour

**Reparent by drag (feature 1).**

- While a move gesture runs (selection normalised, unlocked), every pointer move computes the
  drop target: the deepest `frame` under the pointer that is not dragged, not inside a dragged
  node, not locked, not hidden, not inside an instance, and accepted by `canReparent`
  (no cycle). The dragged nodes' **current parent counts as a candidate even when it is a
  group** (so moving a child inside an entered group keeps it there while the pointer is over
  the group's box); other groups are never targets. None → the page. Top-level `frame`s
  (artboards) are never reparented by a canvas drag (they only move on the page); every other
  node, including nested frames, is. A Ctrl/⌘-click deep selection that turns into a drag keeps
  Ctrl's meaning below (no reparent) while the key is held.
- **Ctrl (⌘ on macOS) held = no reparenting** (and no snapping, as today): the move stays in the
  current parent (flow children reorder inside it as today).
- Target shown with the existing drop highlight (tint + 1.5 px selection-colour outline); a flex
  target also shows the insertion line from `flowDropIndex` (existing overlay). The original
  parent is highlighted only when it is the target and is not the page.
- The dragged layers stay visible over the whole canvas during the drag, not clipped by the old
  parent (e.g. a drag-layer clone in world space; the original hidden with `visibility`).
- Pointer up: target = current parent → today's commit (`canvas:move` / `canvas:reorder`);
  otherwise one `reparentNodes(…, { origin: 'canvas:reparent' })` with each node's world frame
  translated by the drag delta (flex target: index from the pointer). One undo step. Escape
  cancels. Presence: `transient.kind = 'move'` as today.

**Rotation (feature 2).**

- Rotation zones: outside each corner of the selection box (in its rotated frame), from the
  corner out to 16 screen px, excluding resize handles; cursor = a rotate cursor. Drag rotates
  about the selection centre (one node: its centre; several: the centre of the union AABB).
- Single node: new rotation = start + Δ, **Shift snaps the resulting angle to 15°**. Several:
  Δ itself snaps to 15° with Shift; positions move around the pivot (`rotateNodes` semantics).
- Live label (size-pill style) next to the pointer: `"<round(angle)>°"` — the node's resulting
  rotation (single) or Δ (several).
- Transform-only preview during the gesture; one commit at pointer up via `rotateNodes`
  (`canvas:rotate`, fits groups). Presence: `transient.kind = 'resize'` with each node's world
  AABB (the server accepts only `move`/`resize`).
- Resize of a single rotated node works in its local axes, keeping the opposite handle fixed in
  world space. Multi-selection resize maps each node's centre through the box transform and
  scales width/height by (sx, sy) when `|rotation mod 180| < 45`, else by (sy, sx).
- Top-level rotated nodes rotate with their wrapper/stand-in (LOD keeps the rotation); artboard
  labels stay axis-aligned above the AABB.

**Groups (feature 3).** Selection rule additions (`resolveClickTarget`): after the existing
rules choose a candidate, if a `group` or `instance` on the path above the candidate is not
"entered" (no current selection is that node or inside it), the **outermost** such node is
selected instead. A top-level non-frame node (group, instance, rect…) is selected as itself.
Double-click drills one level (existing), so double-click enters a group or an instance;
Escape/Shift+Enter go back up. Ctrl/⌘-click selects the deepest node (also inside
instances). Moving a group moves its box; resizing calls `resizeGroup`; rotating rotates the
group itself. Marquee treats a group as one item. Groups never receive the drag highlight.

**Pen tool (feature 4).** Tool `pen` (key **P**, cursor crosshair-pen). Click = corner point;
click-drag = smooth point (drag sets `out`, `in` mirrors; Alt while dragging breaks the mirror
→ `corner`); clicking the first point closes the path and finishes; **Enter or Escape
finishes** (fewer than 2 points = nothing created). The draft path, its anchors and the
rubber-band segment to the pointer are drawn by the overlay. On finish: one
`createNode({ type: 'vector', … })` into the insertion target of the first click (deepest
unlocked frame, groups skipped, as the rectangle tool), points converted to target-local, box
normalised, origin `canvas:pen`, tool back to `select`, new vector selected.

**Vector editing.** Double-click a vector (or Enter on a selected vector) enters edit mode
(`onVectorEditChange(id)`): anchors (6 px squares) and, for selected anchors and their
neighbours, handles (5 px circles with lines). Drag anchor/handle (Shift constrains to 45°);
click a segment = insert a point (`splitSegment`, shape unchanged); Delete/Backspace deletes
selected anchors (deleting all removes the vector); double-click an anchor toggles
`corner` ↔ `smooth`; Shift-click multi-selects anchors; Escape/Enter or clicking outside exits.
Every drag/insert/delete is one commit `canvas:vector` via `setVectorGeometry` (with
normalisation). Hit-testing of vectors MUST select on the visible stroke/fill (a 4 screen-px
tolerance SHOULD apply) and let clicks on empty areas of the box fall through.

**Instances (feature 5).** Scenes expand instances through the schema resolver into real DOM
with virtual ids in `data-nid`, measured and indexed like other nodes (thumbnails included).
On each batch, `affectedBy` decides: style/text/props changes of main nodes patch the
corresponding elements in every loaded instance (unless overridden there); structural changes
rebuild the affected instance subtrees. Text editing on a virtual text node writes
`setTextAt` (origin `canvas:text`); moves/resizes of absolute virtual nodes write overrides;
Delete hides (override). Draw/text/pen tools never insert into instances. Thumbnails draw
vectors with a `path` ThumbOp (Path2D from `vectorToPathD`, computed fill/stroke).

**Other.** Draw/text tools ignore groups when choosing the insertion target (frames only).
`selectAll` inside an instance selects the instance's direct virtual children. `Enter` on an
instance selects its virtual children; on a vector starts vector editing.

---

## 6. Editor (`apps/desktop/src/renderer/editor`)

- **Model routing.** Every write on selection refs goes through `setStylesAt` / `setTextAt` /
  `setPropsAt` (real or virtual); every read for the inspector through `getResolvedNode` (one
  `ComponentResolver` per session). `NodesWatcher` re-reads a virtual or instance ref when
  `resolver.affectedBy(batch)` names its instance or component.
- **Structure commands** (`commands/actions.ts`): Group (`groupNodes`, `editor:group`), Ungroup
  (`ungroupNodes`, `editor:ungroup`), Create component (`createComponent`, `editor:component`),
  Detach instance (`detachInstance`, `editor:detach`), Reset overrides (`resetOverrides`,
  `editor:reset-overrides`), Go to main component (switch page, select, zoom to selection;
  deleted main → toast with a **Restore** action → `restoreMainComponent`), wrap in frame →
  schema `wrapInFrame`. All take `canvas.geometry()`. Disabled for virtual selections except
  Copy, Reset overrides and Go to main.
- **Layers panel**: `LayerKind` gains `group`, `instance`, `vector` (the existing `component`
  kind is used for main components); new icons in `packages/ui` (group: dashed-corner square;
  instance: outlined diamond; main: filled four-diamond `ComponentIcon`; vector: `VectorIcon`).
  Groups are expandable containers and drop targets; instance rows expand into their resolved
  children (virtual rows: select, hover, eye toggle = hidden override; no rename, drag or
  lock). Drag and drop calls `reparentNodes` (`editor:layers`); refused moves show no drop
  indicator.
- **Components panel** (left panel, Design mode, collapsible section between Pages and Layers,
  per artboards 31/32): `listComponents` rows (component icon, name); click = go to main;
  drag a row onto the canvas = insert an instance at the drop point
  (`dropTargetAt(client, { deep: true, accept: !cycle })`, `createInstance`, `editor:insert`).
  The editor computes `place()` with the main's current size and drops `width/height` from the
  returned styles (keeping `left/top/position/flexShrink` and the flow `index`), so new
  instances follow the main's size.
- **Component tool (K)** opens the component picker (popover from the tool-rail button, search
  field + list, per artboard 32); click = insert at the viewport centre into
  `containerForInsert`; drag from the picker = as from the panel. The tool rail's "not
  available yet" toasts for pen and component go away; `pen` becomes a canvas tool.
- **Inspector**: groups → Layout (X/Y/W/H/rotation), Blending, Effects. Vectors → Layout, Fill
  (writes `fill`), **Stroke** (new section: colour/token, width, cap, join, dash), Blending,
  Effects; W/H Fill/Hug disabled. Instances and virtual nodes → a **Component** section at the
  top (component name, "Main component deleted" / "Component not found" / "Component cycle"
  states, Go to main, Reset overrides, Detach) followed by the resolved node's normal sections;
  overridden fields are marked as drawn in artboard 31. Main components → the Component section
  shows "Main component". The Layout rotation field sets each node's own rotation
  (`setRotation`); the existing "Rotate 90°" menu item uses it too.
- **Context menu** (canvas + layers, artboard 15): after "Wrap in frame" add "Group selection
  (Ctrl+G)" and "Create component (Ctrl+Alt+K)"; "Ungroup (Ctrl+Shift+G)" when a group is
  selected; "Go to main component", "Reset overrides", "Detach instance (Ctrl+Alt+B)" when an
  instance or virtual node is selected; "Paste in place (Ctrl+Shift+V)" after "Paste here".
  (Artboard 15 must be redrawn by design with these items, see 11.)
- **Clipboard**: section 7. Copy as SVG works for vectors (`vectorToSvgMarkup`) and `svg`
  layers; Copy as PNG/HTML/JSX/CSS use the resolved subtree.
- **Raster** (`session/raster.ts`, thumbnails and Copy as PNG): build from `toRenderSubtree`;
  render groups, rotation, vectors and instances per section 3.
- **Fixtures**: `?editorScene=` scenes for each new artboard (29–33), seeded with schema
  helpers (deterministic keys via the `random` parameters).

---

## 7. Clipboard

### 7.1 Formats

One clipboard item, written atomically, with:

| MIME (as written)                        | Content                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web application/x-baren-clipboard+json` | payload v2 (7.2), UTF-8 JSON, compact                                                                                                                                              |
| `text/html`                              | `renderHtml(doc, roots, { tokens, assetUrl })` — images as `data:` URIs for embedded assets up to 2 MiB each and 8 MiB in total, others dropped; whole HTML ≤ 16 MiB, else omitted |
| `text/plain`                             | `clipboardText(payload)` (7.3)                                                                                                                                                     |

Read priority on paste: (1) the custom format; (2) `text/plain` that parses as payload v2 or the
legacy v1 JSON; (3) raster images (`image/png|jpeg|webp|gif|avif`) → image layers (existing
`insertImageFiles`); (4) `image/svg+xml`, or `text/plain` that starts with `<svg` / `<?xml…<svg`
→ sanitised `svg` layer (existing `insertSvgMarkup`); (5) other `text/plain` → text layer
(existing `pasteText`). A payload with `version > 2` is refused with a toast ("Copied from a
newer version of Baren").

### 7.2 Payload v2

```ts
interface ClipboardPayload {
  kind: 'baren/clipboard'
  version: 2
  source: { fileId: string | null; pageId: string; app: string /* app version */ }
  bounds: Rect | null // world AABB of all roots at copy time
  nodes: ClipNode[] // copied roots, paint order (back to front)
  components: Record<string, ClipComponent> // closure of mains needed by instances in `nodes`
  // (transitively), minus mains that are inside `nodes`
  tokens: Record<string, Token> // tokensReferencedBy(nodes + components), transitive
  assets: Record<string, ClipAsset> // every referenced hash (image layers, fills, overrides)
}
interface ClipNode {
  type: NodeType
  name: string
  styles: Styles
  text?: string
  svg?: string
  assetId?: string
  assetName?: string
  locked?: true
  hidden?: true
  componentKey?: string
  nodeKey?: string
  mainId?: string // mainId dropped on paste across files
  overrides?: Record<string, OverrideEntry>
  vector?: VectorData
  children: ClipNode[]
  frame?: NodeFrame // roots only: world frame at copy time
  context?: 'page' | 'flow' | 'absolute' // roots only: source parent context
}
interface ClipComponent {
  key: string
  name: string
  root: ClipNode /* the main subtree */
}
interface ClipAsset {
  mime?: string
  name?: string
  size?: number
  data?: string /* base64 */
}
```

- **Virtual roots** are serialised as resolved, detached copies (effective styles/text; nested
  instances stay instances). An instance root is serialised as the instance (key, own styles,
  overrides) plus its component in `components`.
- **Asset bytes** (`attachAssetBytes`): embedded until `MAX_CLIPBOARD_ASSET_BYTES` (24 MiB raw)
  is reached, smallest first; others are listed without `data` (the target uses its local core
  copy, or shows the missing-image placeholder until the asset arrives through sync).
- **Validation** (`parseClipboardPayload`, untrusted input): exact `kind`/`version`; every field
  type-checked; numbers finite; strings ≤ 1 MiB except `svg` ≤ 4 MiB and `data` ≤ 28 MiB
  base64; ≤ `MAX_CLIPBOARD_NODES` nodes in total and depth ≤ 256; token names `isTokenName`;
  hashes `isAssetHash`; keys `isComponentKey`/`isNodeKey`; unknown node types become `frame`;
  invalid entries are dropped, a structurally invalid payload returns null. SVG markup is
  sanitised at render time (unchanged).

### 7.3 `text/plain`

The text of all text layers in the copied subtrees (paint order, joined by `\n`); if there is
none and the copy is a single vector or `svg` layer, its SVG markup; otherwise the layer names
joined by `\n`.

### 7.4 Paste (`pasteClipboard`), within and across files and windows

1. **Assets** (editor, before the paste commit): for every asset with `data`, `bridge.assets.put`
   (idempotent, content-addressed); a returned hash different from the payload's goes into
   `assetRemap`. The existing asset sync uploads referenced hashes when the file is shared.
2. **Tokens**: names missing in the target are added (with type, value, description, appended
   Theme-panel order); names that exist keep the target's value (`tokens.kept`).
3. **Components**: for each `components` entry: a live main with that key in the target → reused;
   else the main is created on the page named **"Components"** (created at the end of the pages
   when missing) as a top-level artboard, to the right of that page's content (gap 80 px, top
   aligned with the first artboard there, or at 0, 0), with the same key and `nodeKey`s, and
   registered. Mains inside `nodes` follow 2.7.1 (fresh key when the key is live in the target).
4. **Nodes**: new TreeIDs; `nodeKey` rule 2.7.2; instances keep key and overrides; `mainId` is
   re-pointed at the target's main; vectors keep their data. Roots are placed by `translate`
   applied to their `frame` and converted to the target parent's context (2.4); flex targets
   get flow items at `index`. A root that would create a cycle → the whole paste is refused
   (`refused: 'cycle'`, toast "Can't paste a component inside itself").
5. One commit (`editor:clipboard`); the editor selects `result.ids`.

**Placement (editor computes `parentId`, `index`, `translate`)**:

| Action                            | Target parent                                                                                                                                                                                                                                                     | translate                                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ctrl+V**                        | `containerForInsert` (selected frame → inside; other selection → its parent; none → page; never a locked or hidden container — beside its outermost locked/hidden ancestor instead, QA change 3). Flex target: index after the last selected sibling, else append | same file and `bounds` intersects the viewport → (+24, +24); else page target → centre `bounds` on the viewport centre; frame/group target → centre `bounds` in the target's box (top-left clamped to ≥ 0 local) |
| **Ctrl+Shift+V** (paste in place) | as Ctrl+V                                                                                                                                                                                                                                                         | (0, 0): the exact copied world position                                                                                                                                                                          |
| **Paste here** (context menu)     | deepest frame under the point (`dropTargetAt(…, { deep: true })`), else page                                                                                                                                                                                      | `bounds` top-left at the point                                                                                                                                                                                   |
| **Ctrl+D**                        | the original's parent, right after it (`duplicateNodes`)                                                                                                                                                                                                          | (0, 0); top-level artboards move right by width + 80 (unchanged)                                                                                                                                                 |
| **Ctrl+X**                        | copy as Ctrl+C, then `removeNodes` with origin `editor:clipboard` once the write succeeded                                                                                                                                                                        | —                                                                                                                                                                                                                |

Cross-window and cross-app-instance behaviour follows from the OS clipboard (the custom format
is a Chromium/Electron web custom format, readable by every window of every instance). Across
files in one window: copy in file A, open file B, paste.

### 7.5 Bridge addition (editor-owned; exact)

`renderer/types/bridge.d.ts`:

```ts
export interface ClipboardWrite {
  text?: string // text/plain, ≤ 16 MiB
  html?: string // text/html, ≤ 16 MiB
  baren?: string // CLIPBOARD_MIME payload JSON, ≤ 48 MiB
  png?: Uint8Array // image/png (Copy as PNG), ≤ 64 MiB
}
export interface ClipboardRead {
  text: string | null
  html: string | null
  baren: string | null
  svg: string | null // image/svg+xml
  images: { mime: string; bytes: Uint8Array }[] // raster images, one per item
}
export interface BarenBridge {
  /* existing */
  clipboard: {
    /** Replace the system clipboard with ONE item carrying the given representations (atomic). */
    write(content: ClipboardWrite): Promise<void>
    read(): Promise<ClipboardRead>
  }
}
```

- `preload/channels.ts`: `'clipboard:write': { args: [content: ClipboardWrite]; result: void }`,
  `'clipboard:read': { args: []; result: ClipboardRead }`; `preload/bridge.ts` maps them;
  `bridge.test.ts` key lists updated.
- Main (`src/main/clipboard/`, wired in `ipc/handlers.ts` with argument validation and the
  existing trusted-sender check). `write` uses Electron 44's main-process clipboard (all entries
  of one `write` are committed atomically; absent fields are left out):

  ```ts
  await clipboard.write([
    new ClipboardItem({
      'text/plain': text,
      'text/html': html,
      // The blob type must equal the custom format's own MIME type: Chromium refuses a
      // mismatched type (NotAllowedError) — corrected at integration (editor deviation 1).
      'web application/x-baren-clipboard+json': new Blob([baren], {
        type: 'application/x-baren-clipboard+json',
      }),
      'image/png': new Blob([png], { type: 'image/png' }),
    }),
  ])
  ```

  `read` → `await clipboard.read()`, reading `text/plain`, `text/html`, the custom format,
  `image/svg+xml` and raster types from the items (Blob → text / Uint8Array). Errors become
  plain `Error`s (bridge convention).

- Mock bridge (`lib/mockBridge.ts`): the same member over
  `navigator.clipboard.write([new ClipboardItem({ /* same keys */ })])` and
  `navigator.clipboard.read()`; when the Clipboard API rejects (no permission or focus), an
  in-memory clipboard shared between same-origin windows through
  `BroadcastChannel('baren-clipboard')`.
- The editor uses `bridge.clipboard` for all reads and writes (Copy, Cut, Paste, Paste in place,
  Copy as …). `commands/clipboard.ts` keeps `copyText` for plain strings (links, CSS).

---

## 8. Undo origins, shortcuts, command ids

### 8.1 Undo origins

| Origin                                                                                                               | Action                                                                 | Undoable |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `canvas:reparent`                                                                                                    | canvas drag into another parent                                        | yes      |
| `canvas:rotate`                                                                                                      | rotation handles                                                       | yes      |
| `canvas:pen`                                                                                                         | pen tool creates a vector                                              | yes      |
| `canvas:vector`                                                                                                      | vector edit (anchor/handle drag, add/delete point, mode toggle)        | yes      |
| `canvas:move`, `canvas:resize`, `canvas:nudge`, `canvas:reorder`, `canvas:duplicate`, `canvas:delete`, `canvas:text` | existing (now also fit groups / write overrides)                       | yes      |
| `editor:group` / `editor:ungroup`                                                                                    | Ctrl+G / Ctrl+Shift+G                                                  | yes      |
| `editor:component`                                                                                                   | create component, restore main                                         | yes      |
| `editor:detach`                                                                                                      | detach instance                                                        | yes      |
| `editor:reset-overrides`                                                                                             | reset overrides                                                        | yes      |
| `editor:insert`                                                                                                      | insert instance (picker, panel drag) — existing origin for inserts     | yes      |
| `editor:clipboard`                                                                                                   | paste, paste in place, cut's delete                                    | yes      |
| `editor:inspector`                                                                                                   | inspector edits incl. rotation field, stroke, overrides                | yes      |
| `editor:layers`                                                                                                      | layers-panel moves (`reparentNodes`), lock/hide incl. hidden overrides | yes      |
| `derived:group-fit`                                                                                                  | post-layout group refit after local text/font/image size changes       | **no**   |

`derived` is a new excluded prefix: the canvas default and the editor's `UNDO_EXCLUDE` (in
`CanvasArea.tsx`) become `['remote', 'sync', 'bench', 'fixture', 'preview', 'derived']`
(verified: an excluded commit after an undo keeps the redo stack). Undo of a delete still
re-creates nodes under new TreeIDs; `nodeKey` keeps overrides valid across it, and component
resolution survives it (2.7.4).

### 8.2 Keyboard shortcuts (`Mod` = Ctrl, ⌘ on macOS)

| Keys                                | Action                                                                     | Handled by                                  |
| ----------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Mod+G                               | Group selection                                                            | editor keymap                               |
| Mod+Shift+G                         | Ungroup                                                                    | editor keymap                               |
| Mod+Alt+K                           | Create component                                                           | editor keymap                               |
| Mod+Alt+B                           | Detach instance                                                            | editor keymap                               |
| Mod+C / Mod+X / Mod+V               | Copy / Cut / Paste                                                         | shell → `edit.*` (existing)                 |
| Mod+Shift+V                         | Paste in place                                                             | editor keymap                               |
| Mod+D                               | Duplicate                                                                  | canvas (focused) / editor keymap (existing) |
| P                                   | Pen tool                                                                   | canvas + editor keymap                      |
| K                                   | Component picker                                                           | editor keymap (existing key)                |
| Enter                               | Finish pen path; edit selected vector; select children of a group/instance | canvas                                      |
| Escape                              | Finish pen path; leave vector editing; select parent (existing)            | canvas                                      |
| Shift (rotating)                    | Snap to 15°                                                                | canvas                                      |
| Ctrl/⌘ (dragging)                   | Keep the parent (no reparent) and no snapping                              | canvas                                      |
| Alt (pen handle drag)               | Break handle symmetry (corner)                                             | canvas                                      |
| Delete / Backspace (vector editing) | Delete selected points                                                     | canvas                                      |

### 8.3 Command ids (`renderer/lib/commands.ts`)

New ids: `edit.pasteInPlace`, `edit.duplicate`, `object.group`, `object.ungroup`,
`object.createComponent`, `object.detachInstance`, `object.resetOverrides`,
`object.goToMainComponent`. The editor registers handlers for them (enabled state follows the
selection). The HTML menu bar (artboards 09–13, `renderer/app`) is **not** changed in this
phase; the ids exist so the native macOS menu and later menus can drive the commands.

---

## 9. Performance guardrails

- The Phase 2 budgets stay CI-enforced and unchanged: pan/zoom ≥ 120 fps at 20k nodes and
  ≥ 60 fps at 50k (`pnpm --filter @baren/canvas test:perf`). Documents without the new
  features MUST take the existing code paths: no resolver work, no extra layout reads for
  unrotated nodes, `decodeNode` cost within +5 %.
- New perf preset `?preset=20k-mixed`: the same 40 × 500 layout from
  `generateBenchDoc({ artboards: 40, nodesPerArtboard: 500, components: { mains: 10, everyNth: 10 }, vectors: { everyNth: 20 } })`,
  i.e. ~10 % of leaves are instances of 12-node mains and 5 % are 8-point vectors (rendered DOM
  ≈ 25k nodes). It MUST meet the 20k budget and is added to `tests/perf.spec.ts`.
- Propagation: editing a style of a main with 1,000 loaded instances re-renders in one frame
  with ≤ 16 ms of main-thread work; a structural main edit with 1,000 instances ≤ 50 ms; typing
  into an override has the same per-keystroke latency as plain text editing.
- Reparent drag: drop-target search ≤ 0.5 ms per pointer move at 20k nodes (rbush over frames,
  not DOM).
- Instances never copy main data into Loro (only overrides); `toSnapshot` and file size grow
  only with real content.
- Rust: HTML export of a 500-node artboard containing 50 instances ≤ 2 × the Phase 2 time
  (5.7 ms) in the release bench.

---

## 10. Test plan

Commands: `pnpm -r typecheck`, `pnpm -r test`, `cargo test --workspace` (with
`CARGO_TARGET_DIR=…/target/p3-<workstream>`), `cargo clippy --workspace --all-targets -- -D
warnings`, `pnpm --filter @baren/canvas test:e2e`, `… test:perf`,
`pnpm --filter @baren/desktop test:visual`, `pnpm --filter @baren/ui test:visual`,
`pnpm --filter @baren/core-native smoke`, Electron smoke (hidden window).

### 10.1 model (vitest in `packages/schema/tests`, cargo in `crates/core`)

- Decode/encode of every new key; events (`overrides` paths, `vector`, `components`, props);
  `checkInvariants` helper.
- Rotation: `readRotation` forms, `rotationValue` normalisation/rounding, `setRotation`
  transform migration, `rotateNodes` around a pivot (centres moved, flow nodes in place).
- Geometry: `placementStyles` for all four contexts incl. rotated parents and border offsets;
  `docGeometry`.
- Groups: group/ungroup round trip preserves world frames (rotated children, rotated group,
  flex parent, page parent); `fitGroups` (nested, rotated); `resizeGroup` scaling; emptied
  groups deleted by local helpers.
- Reparent: page ↔ absolute ↔ flex ↔ group, containing-block fix, nodeKey assignment, cycle
  refusal, emptied source group deletion.
- Components: create (in place, wrap), registry, `findMainComponent` steps 1–4 (incl. undo of a
  deleted main via `UndoManager`), dependencies and cycle detection, instance resolution
  (root/child/nested overrides, `null` removal, equal-to-base removal, hidden, text, assetId),
  cycle/depth/unresolved statuses, tombstone rendering, detach (nested rebasing),
  `resetOverrides` then re-override shows no resurfaced values, `restoreMainComponent`.
- Vectors: `vectorToPathD` golden strings, bounds with curve extrema, normalise (rotated),
  `scaleVector`, `splitSegment` shape preservation, `editVector` minimal ops.
- Clipboard: serialize → JSON → parse round trip; v1 upgrade; validation rejects (bad hash,
  token name, oversize, depth, unknown kind/version); paste into an empty second doc adds
  tokens, creates the "Components" page and mains once (second paste reuses), keeps nodeKeys so
  overrides work, refuses cycles, `assetRemap`; paste in place coordinates; `duplicateNodes`
  equals copy+paste semantics; `tokensReferencedBy` transitive; `renderHtml` snapshots.
- **Two-peer convergence** (`sync.test.ts` style, every row of the table in 2.9): after
  exchanging updates both peers have identical `toSnapshot`, `toRenderSubtree` for the
  instances involved, and the stated outcome.
- Rust: mirror decode, `to_render_subtree`, `vector_to_path_d`, HTML export of group/vector/
  instance/rotation; parity fixtures (4.11) identical to TS; existing Phase 2 fixtures and
  exports byte-identical; JS fallback core HTML via `renderHtml` (`jsCore.test.ts`).

### 10.2 canvas (vitest `tests/unit`, Playwright `tests/e2e`, `tests/perf.spec.ts`)

- Unit: point-in-rotated-frame hit test; selection rules with groups/instances (outermost,
  entered, deep, top-level group); rotation snapping; rotated-node resize anchor; multi-resize
  rule; drop-target choice (excluding dragged subtrees, locked, instances, cycles).
- E2E (bench `e2e.html` harness, extended): drag a rect from artboard A into B (absolute, world
  position kept, one undo step), into a flex frame (insertion line visible, index correct),
  out to the page, into a nested frame; Ctrl-drag keeps the parent; the dragged layer is not
  clipped by its old parent. Rotation handles (cursor, rotate, Shift 15°, label text),
  multi-selection rotates around the common centre, rotated node hit at its corner area but not
  in the AABB-only area, rotated resize. Groups: click selects group, double-click selects
  child, move/resize/rotate group moves children. Pen: click ×3 + Enter → vector with 3
  corners; click-drag → curve handles; click first point closes. Vector edit: drag anchor, add
  point on segment, delete point, toggle smooth. Instances: render main content; a main style
  edit propagates in the next frame; text override by in-place editing; hidden override;
  remote-peer harness (two docs synced in-page): peer B's main edit re-renders peer A's
  instances, B's override shows on A.
- Perf: existing 20k/50k unchanged; `20k-mixed` within the 20k budget; propagation bench
  (1,000 instances) within the section 9 budgets.

### 10.3 editor (vitest + Playwright in `apps/desktop/tests/visual`)

- Visual vs the new artboards **29–33** (names and PNGs from `design/screens.json` once
  design exports them; expected subjects: 29 rotation & groups, 30 pen / vector editing,
  31 components: main + instance inspector with overrides, 32 component picker + components
  panel, 33 reparent drop target / paste), each through an `?editorScene=` fixture, with the
  06/24 metric (channel difference > 24/255) and a 3 % budget. 15 against its redrawn
  reference.
- Behaviour: Ctrl+G / Ctrl+Shift+G (one undo step each; layers show the group icon and
  nesting); rotation field single + multi; create component (shortcut + context menu); insert
  instance via picker click and panel drag; override text/fill/visibility, reset overrides, go
  to main (other page), detach, nested instance override, cycle refused with a toast; delete a
  main → instances keep rendering, Restore works.
- Clipboard (browser mode with clipboard permissions): copy/paste within a file; across files
  (tokens added, "Components" page created, image renders from embedded bytes); paste in
  place; cut; Ctrl+D; plain text → text layer; SVG markup → svg layer; `text/html` and
  `text/plain` written (read back); v1 JSON still pastes; two pages of one browser context
  (cross-window).
- Electron (hidden windows, smoke-style harness): copy in window 1, paste in window 2 through
  `bridge.clipboard` (native core).
- Two peers: opt-in against a real server (`server.spec.ts` style): A creates a component and
  an instance, B edits the main → A sees it; concurrent override + main edit converge; B
  deletes the main → A's instance still renders.
- Unit: keymap (new shortcuts), command ids, clipboard placement math, mock clipboard
  fallback, IPC validation of the clipboard channels, preload bridge keys.

---

## 11. Dependencies and open items

- **Design**: artboards 29–33 (29 "Editor — Rotation & groups" already exists; the others are
  being drawn) and a redrawn **15 Editor — Context menu** with the new items (section 6). The
  final menu is the one in section 6. Interim rule, only while `design/reference/15-*.png` still
  shows the old menu: the conditional items (Ungroup, the instance items, which never apply to
  the 15 fixture selection) ship immediately; the always-visible items "Paste in place",
  "Group selection" and "Create component" are added together with the redrawn reference, so
  the 15 visual test is never weakened (their shortcuts work from the start). The orchestrator
  relays this to the design workstream.
- **Server/proto/sync-client**: unchanged by decision (presence kinds stay `move`/`resize`).
- Known accepted limitations: clipping by rotated ancestors uses AABBs; transient ghosts of
  rotations are axis-aligned; concurrent group/move and ungroup/insert outcomes as in 2.9;
  pre-Phase-3 clients render new types as plain boxes.
