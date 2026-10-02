# Phase 4 — server workstream: notes, deviations and requests

Server workstream, 2026-10-02. Everything in `docs/phase4/contract.md` that names the server is
implemented; this file records where the implementation had to choose, where it deviates from the
letter of the contract (and why), and what other workstreams may want to know or change.

## Implemented (where to find it)

- Main process: `apps/desktop/src/main/mcp/**` — `controller.ts` (Electron adapter: windows, OSR
  render window, headless hosts, `nativeImage`, `net` in an isolated partition), `service.ts`
  (everything else, Electron-free so the whole server runs in Node tests), `config.ts`,
  `security.ts`, `httpServer.ts`, `sessions.ts`, `agents.ts`, `hosts.ts`, `ipc.ts`,
  `assets.ts`, `render.ts`, `format.ts`, `guide.ts`, `setup.ts`, `tools/*.ts`
  (`schemas.ts`, `context.ts`, `host.ts`, `main.ts`, `pixels.ts`, `index.ts`), `stdio/shim.ts`,
  `stdio/build.ts`, `testing.ts` (test fakes).
- Hooks: `index.ts` (lazy start after `baren:ready` or 3 s, quit handling, smoke probe),
  `ipc/handlers.ts` + `ipc/validate.ts` (`mcp:*`, `agent:*`, `files:open` handoff),
  `windows/windowManager.ts` (focus order, `create({ route, inactive })`, last-window quit),
  `startup/flags.ts`, `startup/smokeSession.ts`, `env.d.ts` (`*?raw`), preload channels and
  bridge, `renderer/types/bridge.d.ts`, `renderer/lib/mockBridge.ts`,
  `electron.vite.config.ts` (shim plugin).
- Wire presence: `crates/proto/src/presence.rs` (`AgentPresence`, limits, validation),
  `crates/server/src/rooms/actor.rs` (relay), `packages/sync-client/src/protocol.ts`
  (`AgentWirePresence`, tolerant parsing).
- Tests: unit tests next to the sources (security, config, port fallback, agents/names/recent
  agents/working sets, hosts/routing/handoff, IPC correlation/timeout/cancel, assets, snippets,
  format, guide, sessions, validators, tool helpers), `server.integration.test.ts` (real service +
  SDK client over HTTP with fake renderers), `stdio/shim.test.ts` (built shim spawned with
  Node), Rust proto + server relay tests, and the opt-in end-to-end specs
  `apps/desktop/tests/mcp/mcp-e2e.spec.ts` and `mcp-collab.spec.ts` (own Playwright config:
  `tests/mcp/playwright.config.ts`).

## Deviations from the letter of the contract

1. **Shim build (§4.12).** The shim is built by a Vite plugin in `electron.vite.config.ts`
   (`closeBundle` → `src/main/mcp/stdio/build.ts`) instead of a second `rollupOptions.input`:
   with two inputs Rollup moves the SDK modules the controller chunk also uses into shared
   chunks, and the copied shim would no longer be self-contained. The output is the contract's
   `out/main/mcp-stdio.js` (one CommonJS file, Node built-ins only, no `electron`).
2. **Invalid arguments (§4.9).** SDK 1.31's `McpServer` turns schema validation failures into
   tool results (`isError: true`, "Input validation error: …"), not JSON-RPC `InvalidParams`
   errors. Kept as the SDK does it ("unchanged").
3. **File URLs from main.** `list_files` and `create_file` return `baren://file/<fileId>`
   without a page id: main owns no `LoroDoc` and cannot know the first page. Host tools return the
   full `baren://file/<id>/<pageId>`. Both forms are accepted everywhere; a page in the URL
   becomes the default `pageId` of `get_basic_info`, `create_artboard` and `open_file`.
4. **open_file host args.** Main sends `{ pageId?, firstOpen }` to the host's `open_file`
   executor (`firstOpen` = this call opened the window). The runtime already implements it.
5. **Session lifetime (§4.2, §10.5).** Besides the 30-minute idle rule, a session whose client
   held the GET stream and then dropped it without reconnecting or sending anything for 60 s is
   closed (`STREAM_GONE_MS`): a client that quits without `DELETE` otherwise stays "Connected"
   with its working badges for up to 30 minutes. Open responses (the GET stream, a long tool
   call's SSE answer) keep a session alive.
6. **Agent naming.** The agent is identified as soon as `initialize` was answered (clientInfo is
   known then), not only at `notifications/initialized`; once per session.
7. **Export directory (§3.4, §6.30).** `BAREN_EXPORT_DIR` replaces the base
   `<Downloads>/Baren`; files always go into a `<file name>/` subfolder of it.
8. **`find_nodes` description.** The contract text shows `"_" wildcards` and `"_started_"`;
   that is Prettier rewriting `*…*` emphasis to `_…_` in the markdown. The registered description
   uses `"*"` (the semantics the contract describes). Architect: please fix the contract text
   (escape the asterisks).
9. **Tool timeouts.** `BAREN_MCP_TOOL_TIMEOUT_MS` replaces every deadline except `release`,
   which stays ≤ 5 s.

## Render window findings (Electron 44, Linux, `--ozone-platform=headless --disable-gpu`)

- `capturePage` of the off-screen window works, **but fails with `UnknownVizError` for a moment
  after a resize** (always on the first real capture of a new window). Main therefore retries it
  briefly and otherwise uses the most completely painted `paint` frame (the first frames after a
  resize can be partly painted).
- **Never call `webContents.invalidate()` while a resize is pending**: repeated invalidations keep
  the OSR view at its old size (frames stay 1×1 / the previous size). Main only invalidates once a
  frame of the new size arrived.
- Alpha is kept: PNG exports of transparent stages are RGBA (colour type 6).
- `printToPDF` works off-screen: PDF export is supported (page size = the node's CSS size).
- The display under headless Ozone is 1×1; window sizes still apply (`enableLargerThanScreen`).

## Requests

- **sync-client `index.ts` (no owner this phase; integration):** re-export
  `type AgentWirePresence` from the package root. Until then it is reachable as
  `NonNullable<ClientPresence['agents']>[number]`.
- **runtime (FYI, no change needed):** main uses an idempotent `stage_clear` as the readiness
  probe of the render page (retried every 400 ms until answered), then one warm-up capture.
  `get_fill_image` re-encodes opaque JPEG/PNG in main (`nativeImage`); other formats and
  transparent PNGs go to `image_transcode { hash, to: 'jpeg', maxSide: 1568, quality: 0.85 }`.
- **ui (FYI):** `McpStatus.agents[].files` carries the live working sets per file; `setup()`
  rejects with "The MCP server is off" whenever the state is not `running` (also `error`), so the
  dimmed setup block in the off state has no snippet to show. If the dialog should show the
  snippet while off, ask for a `setup()` that builds it from the persisted port instead.
- **architect:** the Codex (`url` + `http_headers`) and Cursor snippet formats and Claude Code's
  `--scope user` were not checked against live clients in this phase (unchanged from the
  contract's own open item).

## Resolution (integration, 2026-10-02)

- Deviations 1–9 are recorded in `docs/phase4/contract.md` §17.1 (items 2, 5, 6, 9–12) and §17.1
  item 13 (render window findings); the `find_nodes` description in the contract now shows `*`.
- `type AgentWirePresence` is re-exported from the `@baren/sync-client` root.
- `controller.ts` now imports `@baren/html/sources` (html request): main's lazy html chunk is
  274 kB without Loro (was 774 kB).
- Runtime's sign-in request: `open_file` fails within ~200 ms with an actionable
  `host_unavailable` when its window shows the sign-in screen (`signInShown()` on the platform,
  `isAuthUrl` in `hosts.ts`; tests in `server.integration.test.ts` and `helpers.test.ts`).
- Runtime's `capturePage` request: already handled by the retry + `paint` frame fallback; every
  screenshot and raster export passes in the hidden e2e runs, including the packaged app.
- ui's `mcp:status` request: answered from the first frame (`provisionalMcpStatus()` in
  `index.ts`: `off` / `starting`). Snippets while the server is off use `buildSetup` in the
  dialog (ui decision 7), so no new `setup()` variant was needed.
- Snippet formats: still checked against documentation only (STATUS known issue 22).
