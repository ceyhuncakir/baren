# Phase 4 — runtime workstream notes and requests

The renderer runtime of the MCP server (contract `docs/phase4/contract.md` §11): the executors of
every host tool, the headless host (`#/agent-host/<fileId>`), the render window page
(`#/agent-render`), agent presence in the editor, and the hooks of §11.6. Code:
`apps/desktop/src/renderer/agent/**`; tests: `agent/*.test.ts` (vitest) and
`apps/desktop/tests/visual/phase4-runtime.spec.ts` (browser mode, mock bridge agent loop).

## Decisions within the contract (recorded as §0 asks)

1. **Geometry source (§5).** Layout-dependent values (flex children, `fit-content`/`auto`/`%`
   sizes) come from a measurement of the node's artboard laid out on its own: the resolved
   subtree rendered with the schema's HTML exporter (`renderSubtreeHtml`, ids included) into a
   hidden shadow root with the canvas's rules (border-box, text `pre-wrap`, block images, the
   body's inherited text styles, the file's tokens as custom properties), cached per artboard
   until the document changes. Exact declared values (top-level boxes, absolute and group
   children with px offsets and sizes) are read from the styles without layout. The canvas's
   `getNodeFrame` is not used: for artboards that are not mounted it silently falls back to
   declared styles (wrong for flow children), and the public API cannot tell the two apart.
   The result is independent of the user's viewport, zoom, virtualisation and LOD, like the
   screenshots, and a headless host never has to switch its canvas's page. Without a DOM
   (Node tests) layout-dependent values are `null`; the position of a node whose
   own position is exact (e.g. a `fit-content` artboard) is still reported.
2. **Batch tools that fail on every entry** (§4.9) answer `ok: true` with the body (the empty
   success list plus `errors`, or `results` of `{ result: 'error' }` for the token tools) and
   change nothing; main sets `isError` from the body (as `tools/host.ts` does).
3. **Locked layers.** Writes never change a locked layer or anything inside one: `write_html`
   targets, `update_styles`, `set_text_content`, `move_nodes` (source and destination parent),
   `delete_nodes` and a `duplicate_nodes` destination answer `invalid_target` ("… is locked. Ask
   the user to unlock it …"), per entry for batch tools. Renaming and duplicating a locked
   layer are allowed (non-destructive). Reads are unaffected.
4. **Groups.** Layers written into a group become `position: absolute` (group children always
   are) and every write that can change a group's content refits it (`fitGroups`) in the same
   transaction. `update_styles` on a group routes `width`/`height` through `resizeGroup`
   (children scale, like the canvas) and reports flex/padding keys as `ignoredStyles`.
5. **`open_file`'s host half** takes main's `firstOpen` flag: `pageId` switches the user's page
   only when this open created the window (without the flag: a session younger than 15 s).
   An unknown `pageId` is `page_not_found`; the body is get_basic_info's for that page.
6. **Whole-file reads** (get_basic_info's counts and fonts, find_nodes) use a plain-object
   mirror of the document (`agent/docIndex.ts`), loaded one artboard subtree per idle slice
   after an agent's first request and kept current from change batches. Before it is ready,
   get_basic_info scans the Loro tree directly; find_nodes completes the mirror on the spot.
7. **The executors load lazily.** `attachAgentHost` (run for every session) only registers
   listeners; the dispatcher, executors and `@baren/html` (with parse5) are a separate
   chunk (`host/runtime.ts`, ~300 kB) imported on the first request, so the editor chunk and
   cold start into a file are unchanged.
8. **`get_computed_styles` with `resolved: true`** also works when sent straight to a host (an
   isolated stage in the host window); main's render-window path (`artboards_of` →
   `render_job { purpose: 'styles' }` → `stage_styles`) is implemented too.
9. **Image sources.** The host stores `data:` rasters (`bridge.assets.put`), keeps `data:` and
   stored SVGs as markup, checks `baren-asset://<hash>` sources, reads natural sizes (DOM
   decode, 5 s cap) only for `<img>` without a size, and rewrites CSS `url()`s in
   `update_styles`/`create_artboard` styles to `url("baren-asset://<hash>")` before
   normalising; unresolvable ones are dropped with `image-unresolved`.
10. **Relayed agents (§10.3)** are cut to the server's limits in **bytes** (UTF-8; a name is cut
    on a character boundary), so a long or non-ASCII display name never gets the whole
    presence frame dropped.

## Requests

### To html — flex rows of phrasing elements collapse into one text layer

`parseHtml` turns `<div style="display:flex;gap:8px"><span>Docs</span><span>Pricing</span></div>`
into ONE text layer "DocsPricing" (with `rich-text-flattened` when a span is styled), because
§7.3's text rule (only text and phrasing content → `text`) is checked before the flex case. The
guide (§4) and the warning text itself tell agents to "put differently styled runs in separate
elements inside a flex row", and agent-written HTML uses `<span>`s in flex rows everywhere
(nav bars, price rows, status bars). Request: an element whose own `display` is `flex` or
`inline-flex` and that has at least one element child is never a text layer: each child
element becomes its own layer (text for phrasing children) and bare text runs follow the
"mixed content in a flex element" rule. The runtime's tests and browser spec use `<p>` children
until then.

### To server — `capturePage` of the off-screen render window fails under headless ozone

In the built app launched hidden (`--ozone-platform=headless`, with or without `--disable-gpu`,
scratch profile, ephemeral port), every `get_screenshot` and every png/jpg/webp `export` fails
with `Error [internal]: UnknownVizError` from `webContents.capturePage`, while the render page
answers `stage_prepare`, `stage_styles` (resolved computed styles were correct) and svg export
works. Off-screen windows deliver their frames through the `paint` event (`(event, dirty,
image: NativeImage)`); capturing the next `paint` image after `stage_prepare` (cropped to
`outWidth × outHeight`) instead of `capturePage` should work in every mode and keeps
transparency. Everything else in a 16-step hidden Electron session passed (headless host,
measured geometry, handoff on `open_file`, the agent avatar, Ctrl+Z undoing exactly the last
call, `finish_working_on_nodes`).

### To architect — §11.7 cold numbers

The budgets hold in steady state (browser mode, warm mirror, 2026-10-02, other workstreams'
tests running): get_basic_info on 20k nodes 16–23 ms (≤ 150), find_nodes over 50k nodes 83–89 ms
(≤ 500), a 15-line write_html 22–24 ms (≤ 50). The first whole-file read of a session is
slower: get_basic_info 20k ≈ 180–390 ms (Loro tree scan, plus loading the runtime chunk in
dev), find_nodes 50k ≈ 300–1200 ms when the mirror is not warm yet (one `toSnapshot`, ~0.7 s at
50k in Node, while the canvas is still mounting the scene). Proposal: state the budgets for
calls after the first one, or accept the first-call numbers above.

## Resolution (integration, 2026-10-02)

- Decisions 1–10 are recorded in `docs/phase4/contract.md` §17.2 (§5 geometry, §4.9
  all-failed batches, locked layers, groups, the document mirror, first-call numbers, lazy
  executors, relayed agents in bytes).
- html (flex rows of phrasing elements): done by the html workstream (§17.3 item 1);
  `<div style="display:flex"><span>Docs</span><span>Pricing</span></div>` is a frame with two
  text layers (checked again in the integration run).
- server (`capturePage` under headless Ozone): fixed by the server's retry and `paint` frame
  fallback; screenshots and PNG exports pass in every hidden e2e run.
- server (sign-in screen): `open_file` now fails fast with an actionable message (§17.1 item 12).
- ui's optional request: a headless host's canvas gets no agent presence (`useCollaboration`
  `pushPresence`), so the sweep never animates on a hidden canvas.
- Integration also changed `bodyTextStyles()` (`agent/measure.ts`): the stage uses
  `line-height: normal` like the canvas's document scope now does (§17.6 item 1).
