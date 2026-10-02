# Status

Snapshot at the Phase 4 integration, 2026-10-02: the **built-in MCP server** (coding agents read
and edit files live through 30 tools; agent presence on the canvas, in the inspector and
for collaborators; the Connect your agent dialog). Phase 2 (email, password reset, dark theme,
auto-update, images) and Phase 3 (canvas tools) are unchanged and their suites were re-run. All
numbers were measured on one Linux machine (Fedora, i9-12900K, Intel UHD 770) unless noted, with
other desktop apps running (including the user's own `pnpm dev:all` session; load average about
5 while the MCP suites ran). Status per artboard uses **done** (built and tested),
**partial** (works, with listed gaps) and **missing**.

## Screens (artboards 01–36, D01, D06, D18, D34, D35)

"Pixel diff" is the share of pixels that differ from `design/reference/*.png` at 1440×900, as
asserted by `apps/desktop/tests/visual/*.spec.ts`. Screens and D01/D18 use a pixelmatch-style YIQ
threshold of 0.1; the editor and D06 use a threshold of more than 24/255 in any channel. Most of the
remainder is text rasterisation: some glyph runs in the reference PNGs sit 1px lower than Chromium
draws them.

| #   | Screen                         | Status      | Pixel diff | Notes                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------ | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01  | Home — Recents                 | **done**    | 0.92%      | Virtualized grid and list (2,008 files keep < 60 cards in the DOM), ordered by last opened, permanent Scratchpad, rename/archive/delete with undo, thumbnails written by the editor. Team files are pulled in automatically.                                                               |
| 02  | Team — Members                 | **done**    | 1.00%      | Sortable table, search, role changes, remove/leave, pending invites. Invite by email (mailed with SMTP; otherwise the link is copied). "Resend invite" mails a fresh link (the old one stops working).                                                                                     |
| 03  | Team — Settings                | **done**    | 0.94%      | Inline rename, file access (members / link), delete with typed confirmation, leave. Billing tab removed (product decision).                                                                                                                                                                |
| 04  | Editor — Empty file            | **done**    | 0.41%      | Empty page hint, Page section, and the MCP section with the server's live state (Not connected / Connected with agent rows / Off / Error) opening the Connect your agent dialog (34).                                                                                                      |
| 05  | Editor — Canvas overview       | **done**    | 2.22%      | Virtualized artboards, LOD thumbnails below 25% zoom (images included), layer hover highlights the canvas. The zoom chip shows the real zoom (14%), where the reference design says 12%.                                                                                                   |
| 06  | Editor — Selection & inspector | **partial** | 2.48%      | Every inspector section (layout, flex, radius, blending, fill, outline, border, shadows, filters, selection colours, typography); a scrub is one undo step. The rotation field now rotates (Phase 3). One fill per layer, not a stack.                                                     |
| 07  | Editor — Theme tokens          | **done**    | 1.32%      | Add, rename, delete and recolour tokens; usage ("Used in"); the canvas updates live.                                                                                                                                                                                                       |
| 08  | Editor — Share popover         | **partial** | 2.19%      | Invite (now emailed) and Copy link put the file in the team and start live sync. Role changes point to Team settings. "Copy link" produces `https://baren.dev/file/<id>`, which nothing serves yet.                                                                                        |
| 09  | Menu — File                    | **done**    | 3.37% †    | New Window, Quit.                                                                                                                                                                                                                                                                          |
| 10  | Menu — Edit                    | **done**    | 3.45% †    | Driven by the command registry; enabled state follows the editor.                                                                                                                                                                                                                          |
| 11  | Menu — View                    | **done**    | 4.42% †    | Reload, Force Reload, DevTools, Full Screen.                                                                                                                                                                                                                                               |
| 12  | Menu — Window                  | **done**    | 3.20% †    | Minimize, Zoom, Close.                                                                                                                                                                                                                                                                     |
| 13  | Menu — Help                    | **partial** | 3.86% †    | "Check for Updates…" works (shows the version; "Restart to Update (x.y.z)…" when ready). The `baren.dev/*` help pages do not exist yet.                                                                                                                                                    |
| 14  | Editor — Layers expanded       | **done**    | 2.00%      | Virtualized tree; rename, lock/hide, drag to reorder or reparent, keyboard navigation. Shows one more row than the reference design (each section's description column is a real layer).                                                                                                   |
| 15  | Editor — Context menu          | **partial** | 2.79%      | Redrawn in Phase 3: adds Paste in place, Group selection and Create component. All items work, including Copy as HTML/JSX/CSS/SVG/PNG. Copy as SVG works for vector and SVG layers only.                                                                                                   |
| 16  | Editor — Zoom menu             | **partial** | 0.70%      | Presets, fit, zoom to selection, zoom input. Pixel grid, snap to pixel grid, rulers and outline mode are toggles with no canvas effect yet.                                                                                                                                                |
| 17  | Home — Account menu            | **done**    | 0.96%      | Switch team, create team, log out, Light/Dark/System theme (persisted by main), Preferences (theme, change password, version).                                                                                                                                                             |
| 18  | Auth — Sign in                 | **done**    | 1.09%      | Email/password, forgot password, sign in with browser, continue offline. No Google/GitHub (product decision; the artboard was redrawn).                                                                                                                                                    |
| 19  | Auth — Create account          | **done**    | 1.12%      | Password strength, field errors. No social sign-in.                                                                                                                                                                                                                                        |
| 20  | Auth — Verify email            | **done**    | 1.17%      | 6-digit code (paste, auto-submit), resend countdown, email-aware copy. The tip differs from the artboard: the email has no link, so it suggests the spam folder instead.                                                                                                                   |
| 21  | Auth — Continue in browser     | **done**    | 1.11%      | Device-code flow with the server's `/device` page; `baren://auth/<code>` wakes the poller.                                                                                                                                                                                                 |
| 22  | Auth — Forgot password         | **done**    | 1.04%      | Carries the typed email from 18; always moves on (the server answers 204 for unknown addresses).                                                                                                                                                                                           |
| 23  | Auth — Reset password          | **done**    | 1.19%      | Code (auto-advance to the new password), strength meter, resend countdown; success signs in and signs out other devices.                                                                                                                                                                   |
| 24  | Editor — Image fill            | **done**    | 1.48%      | Fill/Fit/Crop/Tile, opacity, Replace/Remove; image layers have their own section. Crop has no on-canvas handles. The mock's Y (336) disagrees with its own canvas; the app shows 469.                                                                                                      |
| 25  | App — Update ready             | **done**    | 1.00%      | Card with Restart/Later, Help dot and menu item; checking/progress/up to date/error states use the same card (not drawn).                                                                                                                                                                  |
| 26  | Email — Verification code      | **done**    | 1.42% ‡    | HTML (email-safe tables, inline styles) + plain text.                                                                                                                                                                                                                                      |
| 27  | Email — Password reset         | **done**    | 1.67% ‡    |                                                                                                                                                                                                                                                                                            |
| 28  | Email — Team invite            | **done**    | 2.06% ‡    | Button plus plain-link fallback.                                                                                                                                                                                                                                                           |
| 29  | Editor — Rotation & groups     | **done**    | 1.61%      | Rotation zones outside the corners, Shift = 15°, live angle pill, rotated selection/handles/resize; groups with their own icon, click = outermost group, double-click enters.                                                                                                              |
| 30  | Editor — Pen tool              | **done**    | 0.81%      | Pen (P), vector edit mode (6 px anchors, 5 px handles), Fill and Stroke (colour, weight, dash, cap, join) in the inspector.                                                                                                                                                                |
| 31  | Editor — Components            | **done**    | 1.81%      | Violet main labels (full names) and component-coloured selection, Components section, inspector Component section with override count, Reset overrides, Go to main, Detach. Nested instance rows stay expandable (31 shows none).                                                          |
| 32  | Editor — Component picker      | **done**    | 2.34%      | K or the rail button; search, live previews, click or drag to insert.                                                                                                                                                                                                                      |
| 33  | Editor — Drop into frame       | **done**    | 2.32%      | Drop target outline + tint, insertion line in flex frames, the dragged copy in a world-space layer. The app also shows the Component section for the selected instance, which 33 omits (design follow-up).                                                                                 |
| 34  | Editor — Connect your agent    | **done**    | 2.09%      | App-level dialog: on/off Switch, Claude Code / Cursor / Codex / Other snippets with the real URL and a masked token, Reveal, Copy (full token), Regenerate token (confirmed inline), live status line. The artboard's snippet is the design's placeholder (port 29980, no `--scope user`). |
| 35  | Editor — Agent working         | **done**    | 1.80%      | Ring, glow, travelling sweep (static under reduced motion) and "Claude Code is working" badge on artboards in an agent's working set; agent avatar in the inspector; MCP section Connected with "Editing <artboard>".                                                                      |
| 36  | Home — Agents connected        | **done**    | 0.95%      | "Using agents" card lists recent agents (active with a presence dot, idle with "Last active …"); "Agent settings" opens the dialog.                                                                                                                                                        |
| D01 | Home — Recents (dark)          | **done**    | 0.88%      | Full frame (the fixture thumbnails are now transparent-ground RGBA, so they are no longer excluded).                                                                                                                                                                                       |
| D06 | Editor — Selection (dark)      | **done**    | 2.49%      | Canvas content is pixel-identical in both themes (0.000% on 7 LOD artboards and 1 artboard at 100%).                                                                                                                                                                                       |
| D18 | Auth — Sign in (dark)          | **done**    | 1.07%      | The artwork shell keeps its colours in both themes.                                                                                                                                                                                                                                        |
| D34 | Connect your agent (dark)      | **done**    | 1.61%      | Dark agent tokens (`#ec5a9c`, now mirrored in `design/tokens.dark.css`).                                                                                                                                                                                                                   |
| D35 | Agent working (dark)           | **done**    | 1.79%      | The 35/D35 tests freeze the sweep at the drawn frame (`__barenAgentSweepPhase = 0`).                                                                                                                                                                                                       |

† Title bar plus the open menu panel. The full frame is 0.43–0.62%, but that number undercounts,
because the menus sit over the editor.
‡ 600 px wide, rendered in headless Chromium with Inter/JetBrains Mono, YIQ 0.1, budget 3%
(`crates/server/scripts/email-preview.mjs`); sizes are identical (600×588, 600×612, 600×710).

Screens without a dark artboard (menus, dialogs, team screens, the other auth steps, the update
card) use the same tokens and were checked by eye only.

## Cross-cutting features

| Feature                                                                                       | Status              | Notes                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local files (Rust core, SQLite)                                                               | **done**            | Durable on every update, compaction, assets (blake3, stored mime), thumbnails, JSON + HTML export. A JS fallback core runs in a worker thread when the addon is missing.                                                                                                                      |
| Canvas: select, move, resize, marquee, snapping, artboard/rect/text tools, text editing, undo | **done**            | Transform-only drags, one Loro commit per gesture.                                                                                                                                                                                                                                            |
| Canvas: reparent by dragging on the canvas                                                    | **done**            | Deepest eligible frame under the pointer; flex targets get an insertion line and index, others an absolute position; Ctrl/⌘ keeps the parent; dragging out of a frame lands in the frame (or page) under the pointer. Same helper as the layers panel.                                        |
| Rotation                                                                                      | **done**            | Corner zones, Shift = 15°, live angle, multi-selection about the common centre, inspector field, rotated hit-testing/selection/resize/snapping (AABB snapping), HTML export. Peers see rotation previews as axis-aligned ghosts.                                                              |
| Groups                                                                                        | **done**            | Ctrl+G / Ctrl+Shift+G (one undo step each), own icon, outermost-group clicks, double-click enters, move/rotate/resize as one, a group in a flex frame is one item, absolute children of flex frames stay absolute.                                                                            |
| Pen tool and vector editing                                                                   | **done**            | P; click = corner, drag = curve, click the first point to close, Enter/Escape finish; double-click a vector to edit anchors/handles, add/delete points, toggle smooth/corner; fill and stroke; SVG/HTML export (TS and Rust identical).                                                       |
| Reusable components                                                                           | **done**            | Create (Ctrl+Alt+K, context menu), insert (picker, Components section, drag), live propagation, overrides (text, fills, visibility, any style) that survive main edits, reset, go to main, detach, nested instances, cycle refusal, deleted mains keep rendering + Restore. No instance swap. |
| Copy/paste between files and windows                                                          | **done**            | Ctrl+C/X/V, Ctrl+Shift+V, Paste here, Ctrl+D; one clipboard item (custom format + `text/html` + `text/plain`); images, tokens and the components instances need travel; plain text → text layer, SVG markup → svg layer; legacy JSON still pastes.                                            |
| MCP server: Streamable HTTP on 127.0.0.1, bearer token, DNS-rebinding checks                  | **done**            | Lazy start after the first screen (cold start unchanged), port 29170 (+1…+9, then ephemeral), one session per client (≤ 32), token reset, on/off switch, 429 after 30 wrong tokens a minute (requests without a token do not count).                                                          |
| MCP tools (30: reads, writes, screenshots/exports, files/pages)                               | **done**            | Strict zod schemas; `fileId` optional everywhere. No comment tools.                                                                                                                                                                                                                           |
| Agent edits: one Loro commit per call (`agent:<tool>`), one undo step, live sync              | **done**            | Files not open in a window are served by hidden host windows (≤ 4) and handed to a window when the user opens them.                                                                                                                                                                           |
| `write_html` / `get_jsx` (`@baren/html`)                                                      | **done**            | Flex, absolute, text, SVG, images (paths, `file://`/`baren-file://`, http(s), data URIs), clones (`<x-baren-clone>`), JSX in Tailwind and inline styles, write → JSX → write round trip. Rich text is flattened (warning).                                                                    |
| Screenshots and exports (PNG, JPEG, WebP, SVG, PDF)                                           | **done** (Linux)    | Off-screen render window, independent of the user's viewport. Verified under headless Ozone only.                                                                                                                                                                                             |
| Agent presence (badge, ring, inspector avatars, home card; relayed to collaborators)          | **done**            | Presence frames carry `agents` (proto, server relay, sync-client); working sets clear on `finish_working_on_nodes` or after 120 s.                                                                                                                                                            |
| stdio shim                                                                                    | **done**            | Packaged inside `app.asar`, copied to `<userData>/mcp/`; reconnects after an app restart, a token reset or a port change. Launched from the packaged `linux-unpacked` app; not from an AppImage.                                                                                              |
| Canvas: rulers, pixel grid, outline mode, on-canvas image crop                                | **missing**         | The zoom-menu toggles exist with no canvas effect.                                                                                                                                                                                                                                            |
| Images: layers and fills, insert (picker, drop, paste), `baren-asset://`, export              | **done**            | Native core serves the stored mime. HTML export inlines data URIs (no `assets/` folder yet). Fill opacity uses `-webkit-cross-fade` (Firefox ignores it in exported HTML).                                                                                                                    |
| Images between collaborators                                                                  | **done**            | Upload on insert, download on demand with retries; verified browser ↔ browser and browser → Electron (native core).                                                                                                                                                                           |
| Accounts, teams, invites, device sign-in                                                      | **done**            | argon2id, hashed tokens, sliding sessions, rate limits. Email + password only (no OAuth, by decision).                                                                                                                                                                                        |
| Email: verification, password reset, invites                                                  | **done**            | `MAIL_TRANSPORT=log \| file:<dir> \| smtp`, queued with retries. SMTP was tested against a local fake server, not a real provider.                                                                                                                                                            |
| Password reset and change                                                                     | **done**            | Reset signs out every session; change keeps the current one. Revoked sessions' sockets close with 4401.                                                                                                                                                                                       |
| Share a file to a team; team files appear for members                                         | **done**            |                                                                                                                                                                                                                                                                                               |
| Live co-editing, cursors, selections, gesture ghosts                                          | **done**            |                                                                                                                                                                                                                                                                                               |
| Dark theme                                                                                    | **done**            | Preference persisted by main, applied before first paint; design content never follows the app theme.                                                                                                                                                                                         |
| Auto-update (Linux)                                                                           | **done** (AppImage) | Verified end to end with packaged AppImages (check → download → ready; install on a scratch copy in the platform run). deb/rpm download to "ready" works the same way; their `pkexec` install was not run (system-wide).                                                                      |
| Release tooling (`pnpm release:linux`)                                                        | **done**            | AppImage/deb/rpm + `latest-linux.yml`, rsync to `UPDATES_DIR` (`latest-linux.yml` last).                                                                                                                                                                                                      |
| macOS / Windows                                                                               | **untested**        | Code paths exist (traffic lights, native macOS menu, NSIS/DMG targets, updater). macOS updates would need signing and a zip target.                                                                                                                                                           |

## Test results (this integration run)

Builds went to scratch directories (the user's `apps/desktop/out`, `crates/napi/*.node`, profile
and ports 8787/5173/29170 were in use by their own `pnpm dev:all` session and were not touched).
Real-server runs used a separate `baren-server` on 127.0.0.1:8899 with its own database,
`ASSETS_DIR` and `MAIL_TRANSPORT=file:<dir>`.

| Command                                                                                         | Result                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo build --workspace`                                                                       | pass                                                                                                                                                                                                                                                                                                                                    |
| `cargo test --workspace`                                                                        | pass: core 59 unit + 10 fixture-compat + 17 store; proto 12 (agents in presence); server 41 unit + 43 integration (assets 6, auth 5, device 1, invite_email 3, mail 2, password 8, sync 12 incl. the agents relay, teams 3, updates 3)                                                                                                  |
| `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`           | pass                                                                                                                                                                                                                                                                                                                                    |
| `node crates/core/tests/fixtures/make-parity.mjs` (regenerated in a scratch copy) + `cmp`       | pass: all eight `parity.*`/`parity3.*` files byte-identical (QA's `createNode` change preserves the Loro bytes)                                                                                                                                                                                                                         |
| `napi build --platform --release --output-dir <scratch>` + `smoke.mjs` against it               | pass (17 checks); `index.js`/`index.d.ts` identical, the addon byte-identical to `crates/napi`                                                                                                                                                                                                                                          |
| `pnpm -r typecheck`                                                                             | pass (schema, ui, canvas, html, sync-client, desktop node + web)                                                                                                                                                                                                                                                                        |
| `pnpm -r test`                                                                                  | pass: schema 194, ui 59, canvas 129, html 1,719, sync-client 64 (+3 "binary not found" placeholders skipped), desktop 607 (main-process MCP 103)                                                                                                                                                                                        |
| `electron-vite build`, `electron-builder --linux dir`                                           | pass; `out/main/mcp-stdio.js` (316 kB, Node built-ins only) is in `app.asar`, the addon in `app.asar.unpacked/native/`; main `index.js` 93 kB with no MCP code (the lazy controller chunk is 1.0 MB, its html chunk 274 kB without Loro)                                                                                                |
| `apps/desktop` Playwright, everything enabled (real server + Electron env set)                  | **128/128** pass: screens, editor, dark, Phase 3 and Phase 4 (runtime, ui 34–36/D34/D35) behaviour and pixel specs, and all opt-in specs (real-server screens/server, `phase3-server`, `qa-phase3-server`, `phase3-integration-server`, `phase3-electron-server`, `phase3-electron`). Every pixel diff is identical to the Phase 3 run. |
| `apps/desktop/tests/mcp` (`BAREN_MCP_E2E=1`, scratch build + server)                            | **35/35** pass: `mcp-e2e`, `mcp-collab`, QA's 32 (`qa-session`, `qa-security`, `qa-restart`, `qa-robustness`, `qa-perf`, `qa-collab`) and `integration-packaged` against the packaged app                                                                                                                                               |
| `packages/ui` Playwright gallery + interactions                                                 | 15/15 pass                                                                                                                                                                                                                                                                                                                              |
| `packages/canvas` Playwright e2e / perf                                                         | 86/86 / 8/8 pass                                                                                                                                                                                                                                                                                                                        |
| `BAREN_SMOKE=1` packaged app (`linux-unpacked`, hidden, fresh profile) ×5, with and without MCP | pass (10 runs each, over two packaged builds): cold start 167–182 ms without MCP, 165–218 ms with `BAREN_MCP=1` (server listening at 203–262 ms, authenticated `initialize` → 200); native core, no renderer errors                                                                                                                     |
| `npx prettier --check .`                                                                        | pass                                                                                                                                                                                                                                                                                                                                    |

### End-to-end checks

**Phase 4 (MCP).** All against the separate server on 127.0.0.1:8899, builds made for it, hidden
windows (`--ozone-platform=headless`), scratch profiles and ephemeral MCP ports.

- **The packaged app, two people and two agents**
  (`apps/desktop/tests/mcp/integration-packaged.spec.ts`, 4.2 s). Ada and Bora have accounts and
  a team file. **A** is the packaged app (`linux-unpacked`) signed in as Ada with its MCP
  server on; **B** is a second packaged instance signed in as Bora with the file open in its
  editor.
  1. An agent connected over Streamable HTTP as `claude-code` lists the file (not open
     anywhere), reads the guide, and builds a pricing page through a hidden host:
     `create_artboard`, three `write_html` calls (header with a flex nav of `<span>`s, hero,
     a plan card), two `duplicate_nodes` with `descendantIdMap`, `set_text_content`,
     `update_styles`. Over three runs each layer was in B's canvas DOM 15–49 ms after the call
     started (the styled button's new colour: 19–121 ms, polled).
  2. B's inspector shows "Claude Code (Ada Agent's agent)", and B's canvas overlay draws the
     working badge and ring.
  3. `open_file` hands the file from the hidden host to A's window (A's inspector shows
     "Claude Code (agent)"); a write served by A's visible editor reaches B in 25–27 ms; Ctrl+Z in
     A removes exactly that write on B, Ctrl+Shift+Z brings it back.
  4. A stdio agent (`cursor`) is launched exactly as A's setup snippet says
     (`ELECTRON_RUN_AS_NODE=1 <packaged executable> <userData>/mcp/baren-mcp-stdio.cjs`;
     the test checks the snippet's command is the packaged executable). It sees 30 tools, the
     file in A's focused window by default, the HTTP agent's screen in `get_tree_summary`,
     finds the subtitle with `find_nodes` and retexts it: B shows it 13–38 ms later and the HTTP
     agent reads it back. A's status lists both agents as connected, and B shows a second
     agent avatar.
  5. `get_screenshot` (JPEG) and `export` (PNG, 1440 px wide) of the artboard;
     `finish_working_on_nodes` clears the badge on B.
- **The MCP suite** (`apps/desktop/tests/mcp`, 34 specs, 1.6 min): a full design session with
  pixel checks and JSX round trip (`mcp-e2e`), one undo step per call over 19 writes
  (`qa-session`), security (token, Host/Origin, no CORS, body limit, loopback only, file
  modes, rotation, the 32-session cap), restarts over HTTP and stdio (incl. a token reset and a
  port change under a running shim), six files at once through four hidden hosts, crashed and
  hung hosts, hostile HTML, cancellation, export path traversal, HTTP image limits, and two
  collaboration runs (peer convergence, image upload, undo reaching the peer, a viewer's agent
  refused with `read_only`).

**Phase 3**, re-run with the full desktop suite (all pass):

- **All six features together, two people, real input**
  (`apps/desktop/tests/visual/phase3-integration-server.spec.ts`, browser mode; once in this
  run, 3/3 with `--repeat-each 3` at the Phase 3 integration). A creates and shares a file; B opens it from Recents; every
  step is done with the pointer, shortcuts, the inspector, the picker or the clipboard and checked
  on the other peer:
  1. A drags a layer into a frame (absolute, position kept) and another into a flex frame at the
     insertion line; B Ctrl+clicks a flex child and drags it out onto the artboard.
  2. B rotates a layer from its corner zone with Shift (lands on 60°, centre kept); A types 15
     into the rotation field, then undoes and redoes it; B sees each step.
  3. A Shift-selects two layers and presses Ctrl+G; B clicks the group (outermost), drags it
     100 px (children follow) and double-clicks into it.
  4. B draws a triangle with the pen (P, three clicks, click the first point); A double-clicks
     the vector and drags an anchor; B duplicates it with Ctrl+D. Path data is identical on both.
  5. A makes a frame a component (Ctrl+Alt+K), drags an instance in from the picker (K); B edits
     the main's child colour and A's instance follows live (resolver and DOM); A double-clicks the
     instance's child and overrides its fill; B restyles the main root: A's instance follows and
     the override stays.
  6. A builds a second, unshared file with a token-filled frame and a pasted PNG, copies it and
     pastes it into the shared file: B gets the frame, the token and the image (uploaded by A,
     downloaded by B, decoded at 32 × 24). A copies the instance into the unshared file (its main
     arrives on a "Components" page, override and B's main edits included) and pastes it back in
     place.
     Both peers end with identical snapshots and identical canvas DOM, with no page errors.
- **The real desktop app as one of the peers**
  (`apps/desktop/tests/visual/phase3-electron-server.spec.ts`; once in this run, 3/3 with
  `--repeat-each 3` at the Phase 3 integration): B runs
  the built Electron app (native Rust core, real preload and IPC, `app://` with the production
  CSP, the main-process clipboard) under `--ozone-platform=headless` (no window on screen, no OS
  clipboard), signs in through the app's sign-in screen and opens A's shared file. Instances
  with overrides, a rotated layer, a group, a vector and an image (`baren-asset://`, 32 × 24)
  render; A's main edit reaches B live; B rotates through the inspector, groups with Ctrl+G,
  draws with the pen and overrides instance content, and A sees each edit. B copies the instance
  in window 1 (one clipboard item: the custom format + `text/plain` + `text/html`), opens a
  second window with a new file and pastes: the instance renders and its main is on a
  "Components" page in the native core. A's snapshot equals B's native-core JSON export. No CSP
  violations or page errors.
- `phase3-server.spec.ts` (main edits live, override vs main edit, deleted main keeps rendering),
  `qa-phase3-server.spec.ts` (four concurrent scenarios with B's socket partitioned; identical
  snapshots and canvas DOM), `phase3-electron.spec.ts` (the clipboard bridge between two Electron
  windows) and `packages/sync-client/tests/e2e-phase3.test.ts` (eight concurrent scenarios
  through the real binary) all pass.
- **Phase 2 checks re-run:** the real-server screens/server specs (register → verify → forgot →
  reset, invites, device sign-in, shared images live) pass. The release/update-feed checks
  (packaged AppImage updating itself) were not re-run; nothing in that path changed.

### Performance

| Target                                                                          | Measured                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold start to the first screen < 1 s                                            | Packaged app (`linux-unpacked`, native core, `BAREN_SMOKE`, fresh profile = sign-in screen), 10 runs each: **167–182 ms** without MCP, **165–218 ms** with `BAREN_MCP=1` (the server listens at 203–262 ms, after the first screen). The MCP code is a lazy chunk; a plain smoke run never loads it. (Phase 3 run: 326–398 ms on a busier machine.)                                                                                                     |
| Pan/zoom ≥ 120 fps at 20k nodes                                                 | Headless Chromium (software GL): gesture work p95 3.1–3.8 ms, frame interval p95 3.7–5.2 ms, 0 long tasks.                                                                                                                                                                                                                                                                                                                                              |
| Pan/zoom ≥ 60 fps at 50k nodes                                                  | Headless: work p95 2.7–4.0 ms, interval p95 4.2–6.8 ms, 0 long tasks.                                                                                                                                                                                                                                                                                                                                                                                   |
| `20k-mixed` (10 % instances of 12-node mains, 5 % vectors) meets the 20k budget | work p95 3.2–4.2 ms, interval p95 3.8–6.0 ms, 0 long tasks.                                                                                                                                                                                                                                                                                                                                                                                             |
| Main style edit, 1,023 instances: ≤ 16 ms                                       | **7.0–12.9 ms** (5 edits); every instance updated in the timed frame.                                                                                                                                                                                                                                                                                                                                                                                   |
| Main structural edit, 1,023 instances: ≤ 50 ms                                  | 37.1–41.2 ms (3 edits).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Typing into an override ≈ plain text                                            | 5.6–14.1 ms vs 5.4–8.9 ms per keystroke (5 each).                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agent working edge: one overlay redraw ≤ 1 ms                                   | p50 0.1 ms, p95 0.2 ms with one agent artboard (240 frames); the redraw timer runs at ≤ 30 fps only while a sweep is on screen, never under reduced motion or on a hidden host.                                                                                                                                                                                                                                                                         |
| MCP tool latency, 20k-node file (QA spec, client round trip, p50 / p95)         | Open window: `get_basic_info` 2.6 / 7.7 ms, `get_tree_summary` 16.8 / 19.6, `find_nodes` whole file 3.7–7.2 / 5.9–8.5, `write_html` (15 lines) 8.5 / 10.7, `update_styles` 1.9 / 4.3, `set_text_content` 2.5 / 3.8, `duplicate_nodes` 6.8 / 15.3, `move_nodes` into a 666-row list 57 / 82, `get_screenshot` (480 px) 100 / 101. A hidden host is similar or faster. Budgets (contract §11.7): `get_basic_info` 150, `find_nodes` 500, `write_html` 50. |
| Agent edit visible to a collaborator < 100 ms                                   | Packaged app → server → second packaged app's canvas DOM: 13–49 ms per `write_html` / `duplicate_nodes` / `set_text_content` over three runs (measured from the start of the tool call).                                                                                                                                                                                                                                                                |
| Large writes                                                                    | `write_html` with 4,000 layers: 670 ms in the app (QA); parsing 2,001 layers 14–36 ms (Loro writes dominate, ~5 µs per map write).                                                                                                                                                                                                                                                                                                                      |
| 2,000 instances of a 50-node main (no budget; QA)                               | At 100 %: style edit 8–11 ms (was 43–57), text edit 47–60 ms, structural 61–69 ms; at 27 %: style 15–37 ms, text 88–104 ms, structural 104–111 ms. 400 instances live; each is updated in the next frame.                                                                                                                                                                                                                                               |
| Drop-target search ≤ 0.5 ms per pointer move                                    | p95 ≤ 0.1 ms, max 0.5 ms (400 deep searches over 4,509 live nodes).                                                                                                                                                                                                                                                                                                                                                                                     |
| Remote edit visible < 100 ms                                                    | Loopback server fan-out ~0.1 ms p50 (cargo test). Phase 1: Node → server → Electron layer panel 14 ms; browser click → peer layer panel 27 ms. Not re-measured (the sync path did not change).                                                                                                                                                                                                                                                          |
| Drag/resize/rotate same-frame, one Loro commit on release                       | Yes: transform-only previews; one commit per gesture (`canvas:move/resize/rotate/reparent`); peers see ghosts at 30 Hz (rotation as axis-aligned `resize`).                                                                                                                                                                                                                                                                                             |

Rust core, release build, 50,001-node document
(`cargo test -p baren-core --release --test bench -- --ignored --nocapture`; the core did not
change in Phase 4):

| Operation                                  | This run                 | Phase 3                  |
| ------------------------------------------ | ------------------------ | ------------------------ |
| Open a file, cold                          | 5.2 ms                   | 8.7 ms                   |
| First edit (loads and caches the document) | 150 ms                   | 137 ms                   |
| Steady-state edits                         | p50 0.04 ms, p99 0.09 ms | p50 0.04 ms, p99 0.09 ms |
| Slowest edit (includes a compaction)       | 62 ms                    | 54 ms                    |
| JSON export, whole document                | 613 ms                   | 565 ms                   |
| HTML export, one 500-node artboard         | 5.9 ms                   | 5.7 ms                   |
| HTML export, 500 nodes + 50 instances      | 6.3 ms (budget 11.4 ms)  | 6.0–6.2 ms               |
| Database file size                         | 8.6 MB                   | 8.6 MB                   |

The core code is unchanged since Phase 3, so the differences (in both directions, up to
about 15 % slower and 40 % faster) are run-to-run variation; this run shared the machine with the
user's own dev session.

## Known issues

1. **SMTP against a real provider is untested.** Delivery, retries and both TLS modes were checked
   against a local fake SMTP server and by building the connections; a real relay (and
   SPF/DKIM/DMARC) needs one live check on the deployed server.
2. **deb/rpm updates** install through `pkexec` (a password prompt). That path was not run, and
   packages are verified only by sha512 against `latest-linux.yml` (not GPG-signed).
3. **Team files are pulled, never pushed back as deletions.** Deleting a team file's local copy
   brings it back on the next pull. Archiving or deleting on the server is not reflected locally.
4. **Native vs JS core data are separate.** Files created while the JS fallback ran
   (`userData/core-js`) do not show up once the native core loads (`userData/core`).
5. **"Copy link"** points at `https://baren.dev/file/<id>`, and the Help/footer links point
   at `Baren` pages; none of them exist yet.
6. **Design follow-ups** (the reference designs change only in the design workstream): artboard
   20's tip still promises a link in the email; the Help menu's version label and update item states,
   dark menus/dialogs and the update card's other states are not drawn; artboard 33 omits the
   Component section the app shows for a selected instance; 31 draws nested instance rows
   without a chevron and names the Team card's rows differently; no dark artboards for 29–33.
7. **Dark theme details:** the inspector's Page section shows `EEEEEE` for the default page
   background while the canvas draws it in the app's canvas colour (`#141414` in dark); identity
   colours include `#1A1A1A` (avatars get a hairline ring in dark); a near-black collaborator
   colour has low contrast on the dark canvas.
8. **Images:** Crop has no on-canvas handles; exported HTML with a faded fill shows no fill in
   Firefox; HTML export does not write an `assets/` folder; the Rust `<img>` size ignores JPEG EXIF
   orientation (the TypeScript reader applies it); the TypeScript `renderHtml` (JS fallback core,
   clipboard `text/html`) adds no intrinsic `<img>` size.
9. **Undo or redo of a delete or a create gives the node a new id** (Loro behaviour). Anything
   that stores node ids must not rely on them surviving undo/redo (overrides use `nodeKey`s, so
   they survive).
10. **Pixel fidelity is close but not exact**: 0.4–2.8% per artboard (menus up to 4.4% of the menu
    region). Some text in the reference PNGs sits 1px off Chromium's rendering, and a few editor
    mock-ups contradict themselves (zoom labels, 06 vs 14 dimensions, 24's Y).
11. **Platforms:** only Linux x64 was run. The macOS layout and the Windows build are untested.
12. **Server:** rate limits are per process and per email/sender (no per-IP limit). Rooms keep the
    full Loro history. Switching `fileAccess` back to members-only does not disconnect viewers who
    are already connected. A user with the same file open in two windows shows up as two peers.
13. The browser mock bridge keeps the session token in `sessionStorage` (development
    convenience). Inside Electron it is stored with `safeStorage`; on Linux without a keyring it
    falls back to a 0600 file, with a warning.
14. **Components, performance:** text and structural main edits re-expand every affected
    instance: 36–50 ms for a structural edit at ~1,000 instances (budget 50 ms, little margin)
    and 47–111 ms for text/structural edits with 2,000 × 50-node instances. After a main edit,
    stand-in thumbnails of nearby artboards with instances regenerate in the following frames
    (up to 2 per frame, 25–30 ms each for 5,000-node artboards).
15. **Components, behaviour:** no instance swap; Detach is disabled on nested instances (detach
    the outer one first); inside an instance, a virtual group's box does not follow overrides
    that move its children (detach refits it); `nodeKey` duplicates can remain only between
    nested mains (lookups use the first in document order).
16. **Concurrent edits** converge but some outcomes are lossy by design (contract 2.9): group +
    move keeps the group's positions, ungroup + insert deletes the inserted node, detach +
    override loses the override, and two peers converting one frame at once can mix node keys.
    Pre-Phase-3 clients show groups, vectors and instances as plain boxes.
17. **Rotation:** clipping by a rotated `overflow: hidden` ancestor uses axis-aligned bounds;
    peers see rotation previews as axis-aligned ghosts; LOD thumbnails approximate text inside
    rotated nodes with axis-aligned line boxes; snapping uses axis-aligned bounds. The group
    resize preview scales strokes and text during the drag only (the commit scales boxes).
18. **Pen:** no double-click to finish (Enter, Escape or clicking the first point).
19. **Menus:** the HTML menu bar does not list the Phase 3 commands (group, component, paste in
    place, …); they are on shortcuts, the context menu and `runCommand`.
20. **Clipboard between app windows** was verified in the real app with Chromium's headless
    Ozone clipboard (no visible windows were allowed); the OS clipboard on X11/Wayland goes
    through the same Electron API but was not exercised, nor was pasting into other apps.
21. **MCP, platforms:** only Linux was run, with headless Ozone and `--disable-gpu` (no window
    may be shown here). Off-screen capture on a GPU desktop session, macOS and Windows is
    unproven; `capturePage` fails with `UnknownVizError` for a moment after each resize of the
    render window (retried; then the latest full `paint` frame is used). The stdio shim was
    launched from the packaged `linux-unpacked` executable and from Electron in development,
    not from an AppImage (`$APPIMAGE`).
22. **MCP, client configs:** the Cursor (`~/.cursor/mcp.json`) and Codex (`~/.codex/config.toml`,
    `url` + `http_headers`) formats and Claude Code's `--scope user` were checked against the
    clients' current documentation, not against the clients themselves. The tests use the MCP
    SDK client over HTTP and stdio.
23. **MCP, design follow-up:** artboards 34/D34 still show the design's placeholder snippet
    (port 29980, no `--scope user`); the app shows the real one (about 0.2 % of those
    artboards' pixels). Only the Claude Code tab and the Waiting state are drawn.
24. **MCP, first calls:** the first `get_screenshot` of a run takes ~650–750 ms while the render
    window starts (then ~100 ms); the first whole-file read of a session can exceed the budgets
    while the document mirror loads (browser mode: `get_basic_info` 20k 180–710 ms, `find_nodes`
    50k 300–1,200 ms; afterwards 2–9 ms).
25. **MCP, HTML import:** rich text is flattened into one text layer (with a warning), list
    markers are not drawn, multi-layer `background` values are opaque, `display: contents` and
    system font keywords are dropped. A 2,000-element `write_html` takes ~150 ms of Loro writes.
    Tailwind output orders classes by category (not in stored-key order) and maps 4 px
    multiples to the default spacing scale up to 384 px.
26. **MCP, undo:** an agent edit that lands while the user is typing in a text layer joins that
    typing undo step. An id does not survive the user undoing the creation of its layer (item 9);
    the guide tells agents to look layers up again.
27. **MCP, windows:** two windows on one local file are not synced (pre-existing); the server
    routes to the most recently focused one. On a signed-out profile `open_file` asks the agent
    to have the user sign in or continue offline; other tools work through hidden hosts.
28. **MCP, sessions:** a client that quits without `DELETE` (the SDK's `client.close()` sends
    none) stays "Connected" for about 60 s, and a client reconnecting with the same name in that
    minute gets a " 2" suffix. Display names are matched by prefix (`claude-code` → "Claude
    Code", any other `claude…` → "Claude"). A `Host`/`Origin` header in upper case passes our
    check but is refused by the SDK's own exact-match check (real clients send lower case).
29. **MCP, not built:** agent badges in the layers panel, toasts for agent errors,
    comment tools, one PDF of several artboards, avif/video export, agent cursors, an MCP undo tool.
30. **Team files created on the server without a snapshot** (only possible through the API; the
    app's Share always uploads one) get one first page per member when two members pull the
    file before it has content. Found while writing the Phase 4 integration test, which now
    creates the team file the way Share does.
31. **Hidden host crashes:** edits made in the last ~400 ms before a hidden host's renderer
    crashes are lost (the save debounce). `forcefullyCrashRenderer()` is noticed only after ~49 s
    under headless Ozone (a real SIGKILL is noticed at once).
32. **Text line height:** design content now uses `line-height: normal` where a layer sets none
    (it inherited the app's 16 px before, which made large text overlap its neighbours). Text
    the text tool creates always sets a line height, and every reference artboard's pixels are
    unchanged; a document that relied on the old 16 px default renders taller text boxes.

## Next steps

1. **Deploy check:** run the server with a real SMTP provider and DNS records; publish a release
   to `UPDATES_DIR` and update a friend's AppImage over the network.
2. **Components:** per-path patching for text and structural main edits (the style-only fast
   path shows the pattern), time-sliced stand-in thumbnails, instance swap, the Phase 3 commands
   in the HTML menu bar; design: 33's Component section and dark artboards for 29–33.
3. **Server-side file lifecycle in the app:** show which files are shared; leave or unlink a file;
   reflect server archive and delete; a "Team files" filter.
4. **Migrate `core-js` → `core`** on first native start.
5. **Canvas:** rulers and pixel grid, outline mode, on-canvas image crop.
6. **CI:** run `cargo test`, `pnpm -r test`, the Playwright suites (with a server and an Electron
   build for the opt-in blocks) and the perf budgets on every push; cross-build the napi addon
   for darwin, win32 and aarch64.
7. **macOS and Windows** runs: traffic-light spacing, native menu, NSIS/DMG packaging, code
   signing, their update paths, and the OS clipboard there.
8. **MCP follow-ups:** a run on a GPU desktop session, macOS and Windows (off-screen capture,
   the stdio launch from an AppImage and from installed packages); a live check of each client
   config (Claude Code, Cursor, Codex); design: redraw 34/D34's snippet and draw the Cursor,
   Codex and Other tabs and the Off/Connected/Error dialog states; agent badges in the layers
   panel and error toasts; comment tools.
