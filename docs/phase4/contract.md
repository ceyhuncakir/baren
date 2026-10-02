# Phase 4 contract — MCP server

Written 2026-10-02 by the architect workstream, after reading the Phase 3 code (main process,
preload/bridge/mock, the editor's session lifecycle, `@baren/schema`, `@baren/canvas`,
the sync server's presence relay). Binding for the Phase 4
workstreams **server**, **runtime**, **html**, **ui** and **design**. The short, binding
summary is the "Phase 4 contract — MCP server" section at the end of `ARCHITECTURE.md`; this
file holds the full detail. Everything in `ARCHITECTURE.md` above that section still holds.

Goal (user request): a built-in MCP server so coding agents (Claude Code, Cursor, Codex, any
MCP client) can read and edit Baren files live. Every agent edit is a normal Loro
commit that appears on the canvas instantly, syncs to collaborators and undoes as one step; the
agent shows up like a collaborator.

Wording: **MUST** is binding, **SHOULD** is expected unless a workstream records why not in
`docs/requests/phase4-<workstream>.md`, **MAY** is optional. "Host" means the renderer that
has a file open (a visible editor window or a hidden headless host window). "Agent" means one
MCP session (one connected client). "World" means page coordinates in px.

Companion file: [`guide.md`](guide.md) (the text `get_guide` serves, and the `initialize`
instructions).

Sequencing:

1. **First changes (stubs, same day, before anything else lands):** server lands the bridge
   types, channels, preload and mock-bridge members (§4.14) with no-op implementations; html
   lands `packages/html/src/index.ts` with every signature of §12 (bodies may throw
   `not implemented`); ui lands the `RemotePresence` additions in `packages/canvas/src/types.ts`
   (§10.4). From then on everybody compiles against the final types.
2. **In parallel:** server (main process, transport, routing, render window, shim, wire
   presence), html (parser, normaliser, applier, exporters), runtime (executors, hosts, render
   root), ui (dialog, sections, badges, avatars, overlay). Design already delivered its
   artboards (34, 35, 36, D34, D35; §10.7) before this contract; it only updates 34's snippet
   text to the values fixed here.
3. **Integration** (whoever integrates): the end-to-end harness of §14.5, then docs/STATUS.

---

## 0. Key decisions (one paragraph each)

1. **The MCP server lives in the Electron main process** and starts lazily after the first
   screen is interactive (a dynamic import, like the core backend), so cold start does not
   change. It speaks **Streamable HTTP** through `@modelcontextprotocol/sdk` 1.31 on
   **`127.0.0.1` only**, default port **29170**, path `/mcp`, with **one SDK transport and one
   `McpServer` per client session**. Every request needs a per-install **bearer token**; Host
   and Origin headers are checked against loopback names (DNS-rebinding protection).
2. **A stdio shim for stdio-only clients** is a self-contained CommonJS file built from
   `src/main/mcp/stdio/shim.ts`, copied by the app into `<userData>/mcp/` at start, and run by
   the client with the app's own binary as Node (`ELECTRON_RUN_AS_NODE=1 <app> <shim>`) or
   with `node`. It pipes JSON-RPC between stdin/stdout and the HTTP endpoint (SDK
   `StdioServerTransport` ↔ `StreamableHTTPClientTransport`), reading the port and token from
   `<userData>/mcp/` at start, so its configuration never contains a secret and survives token
   resets.
3. **All document work happens in a renderer, never in main.** Main validates arguments (zod),
   resolves the target file, pre-resolves image sources (files, URLs) into core assets, and
   forwards a request over IPC to the **host** of that file: the visible editor window that
   has it open (most recently focused, if several), or a **headless host** — a hidden
   `BrowserWindow` that opens the file with the normal session code (`openSession(…, {
headless: true })`) and a real canvas, and joins live sync for shared files. Only one
   renderer ever hosts a file: when a visible window opens a file that a headless host holds,
   main makes the host flush and close first (handoff). Main owns no `LoroDoc`.
4. **One tool call = one Loro transaction** with origin **`agent:<tool>`** in the host's
   document: one event batch (the canvas, layers and inspector update through their normal
   paths), one sync update for collaborators, **one undo step** for the user (`agent:` is not
   in `UNDO_EXCLUDE`). Writes to one file are serialised by main; reads run in parallel.
5. **Pixel work goes through one shared render window**: a hidden off-screen-rendering
   (`webPreferences.offscreen`) window that renders a node's subtree as static DOM (the
   exporter's HTML plus the canvas's base rules, isolated in a shadow root) and is captured
   with `webContents.capturePage`. Screenshots and exports therefore never depend on the user's
   viewport, zoom, virtualisation or LOD stand-ins, and never flash anything on screen. The
   same window measures browser-computed styles (`get_computed_styles` with `resolved: true`),
   probes fonts and transcodes images.
6. **A small, stable tool surface.** Tool names, parameter names, enums and result shapes are
   fixed in §6; every file-scoped result uses the two-block format of §4.10 (`{ file,
contentHash }` header + JSON body). Deliberate choices and limits are listed in §15.
   `fileId` is optional everywhere (defaults to the file in the window the user last used).
7. **write_html maps HTML/CSS to the existing node types** without a new schema: elements →
   `frame`, text-only elements → `text`, `<img>` → `image` (or `svg` for SVG sources), `<svg>`
   → `svg`, clone elements → deep copies through the clipboard helpers. Styles are normalised
   to camelCase keys and a fixed shorthand policy so the inspector can edit what agents write;
   anything dropped or discouraged comes back as a `warning`. Parsing and applying are pure,
   DOM-free TypeScript in the new package **`@baren/html`** (parse5), unit-tested in Node.
8. **The agent is a collaborator.** Main keeps an agent registry (display name from MCP
   `clientInfo`, per-file activity and working sets, recently seen agents) and pushes it to
   hosts. Every agent uses the one **agent accent** `--color-agent` (design's magenta: the
   colour that means "an agent is doing this"), not per-agent colours. Hosts show agents in the
   inspector header (rounded-square sparkle avatars), draw a ring, glow, travelling sweep and an
   "<name> is working" badge on their working artboards (canvas overlay, `RemotePresence` of
   `kind: 'agent'`), and relay them to remote collaborators through a new optional **`agents`**
   field on the live-sync presence frame (additive proto change; old servers drop it, old
   clients ignore it). Badges clear on `finish_working_on_nodes`, after 120 s of inactivity, or
   when the session ends.
9. **Settings and secrets on disk, not in the renderer.** `<userData>/mcp/config.json`
   (enabled, port, token; mode 0600) and `<userData>/mcp/endpoint.json` (live URL and pid). The
   token reaches the renderer only through `bridge.mcp.setup()` when the user opens the Connect
   dialog. MCP is **on by default**; `BAREN_MCP=0|1` overrides; smoke runs leave it off
   unless `BAREN_MCP=1`.

---

## 1. Ownership (who edits what)

As built: §17.5 (two performance fixes outside this table).

No two workstreams edit the same file. A needed change in another workstream's file is
requested in `docs/requests/phase4-<workstream>.md` (the owner makes it). Reading and
importing any file is always allowed.

| Workstream    | Owns (may edit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **architect** | `docs/phase4/**` except `docs/phase4/design-tokens.md`; the appended "Phase 4 contract — MCP server" section of `ARCHITECTURE.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **server**    | new `apps/desktop/src/main/mcp/**` (incl. `stdio/shim.ts` and its tests); main hooks: `src/main/index.ts`, `src/main/ipc/handlers.ts`, `src/main/ipc/validate.ts`, `src/main/windows/windowManager.ts`, `src/main/startup/flags.ts`, `src/main/startup/smoke*.ts`, `src/main/env.d.ts`; `src/preload/channels.ts`, `src/preload/bridge.ts`, `src/preload/bridge.test.ts`; `src/renderer/types/bridge.d.ts` (the `mcp`, `agent` and `files.onChanged` members and their types); `src/renderer/lib/mockBridge.ts` + its tests (same members); `apps/desktop/electron.vite.config.ts` (shim entry); `apps/desktop/electron-builder.yml` (only if needed); **wire presence:** `crates/proto/src/presence.rs` (+ `lib.rs` exports), `crates/server/src/rooms/**` (relay `agents`) and server tests, `packages/sync-client/src/protocol.ts` (+ tests); the MCP end-to-end harness `apps/desktop/tests/mcp/**`; `docs/requests/phase4-server.md`                                                                                                                                               |
| **runtime**   | new `apps/desktop/src/renderer/agent/**` (dispatcher, executors, presence store, headless host root, render root, tests); hooks (exactly these files, exactly the changes of §11.6): `src/renderer/main.tsx`, `src/renderer/editor/session/openSession.ts`, `src/renderer/editor/session/context.tsx`, `src/renderer/editor/session/store.ts`, `src/renderer/editor/collab/presence.ts`, `src/renderer/editor/collab/useCollaboration.ts`; `apps/desktop/tests/visual/phase4-runtime.spec.ts`; `docs/requests/phase4-runtime.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **html**      | `packages/html/**` (src, tests, fixtures, package scripts); `docs/requests/phase4-html.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **ui**        | new `src/renderer/app/McpConnectDialog.tsx` (+ `.module.css`), new `src/renderer/state/mcp.ts`; `src/renderer/app/AppDialogs.tsx`, `src/renderer/state/ui.ts` (dialog kind), `src/renderer/app/PreferencesDialogs.tsx`, `src/renderer/state/files.ts` (reload on `files.onChanged`), `src/renderer/home/HomeSidebar.tsx` (+ its css module); `src/renderer/editor/inspector/sections/PageSections.tsx`, `src/renderer/editor/inspector/Inspector.tsx`, `src/renderer/editor/inspector/Inspector.module.css`, `src/renderer/editor/EditorLayout.tsx` (drop the old dialog), delete `src/renderer/editor/chrome/McpDialog.tsx`; `packages/canvas/src/types.ts` (`RemotePresence` and `OverlayTheme` additions), `packages/canvas/src/overlay/{model,overlay}.ts`, `packages/canvas/src/controller.ts` (only: keep the frame loop running while an animated agent edge is visible, §10.4) (+ canvas tests); `packages/ui/**` (agent tokens, `Switch`, Avatar `agent` variant, icons; design requests 1, 3, 4); `apps/desktop/tests/visual/phase4-ui.spec.ts`; `docs/requests/phase4-ui.md` |
| **design**    | the reference designs (artboards 34, 35, 36, D34, D35 — delivered; §10.7), `design/**` (reference PNGs, `screens.json`, `tokens.dark.css` once ui lands the agent tokens), `docs/phase4/design-tokens.md`, `docs/requests/phase4-design.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Nobody edits `packages/schema/**`, `crates/core/**`, `crates/napi/**`, the rest of
`packages/canvas/**`, the rest of the editor, or earlier sections of `ARCHITECTURE.md` in this
phase. Read-only use of editor modules from `renderer/agent/**` (e.g. `editor/model/tokenOps`,
`editor/collab/useCollaboration`, `lib/assets`) is expected.

How the runtime calls the html package: as an ordinary workspace dependency
(`import { parseHtml, applyHtml, toJsx, … } from '@baren/html'`, already wired into
`apps/desktop` and electron-vite's bundling list). The runtime owns the transaction, the
geometry source, the asset map and the placement callback; the html package never commits,
never touches the bridge and never uses the DOM (it is also imported by main, §4.8).

---

## 2. Architecture overview

```
 Claude Code / Cursor / any MCP client           stdio-only client (Codex, …)
        │ Streamable HTTP + Bearer token                │ stdin/stdout JSON-RPC
        │                                    ELECTRON_RUN_AS_NODE=1 <app> <userData>/mcp/baren-mcp-stdio.cjs
        ▼                                               │ Streamable HTTP + Bearer (token read from config.json)
 ┌────────────────────────── Electron main ─────────────▼──────────────────────────────┐
 │ mcp/httpServer  127.0.0.1:29170/mcp  (Host/Origin/token checks)                     │
 │ mcp/sessions    1 StreamableHTTPServerTransport + 1 McpServer per session            │
 │ mcp/tools       zod schemas, result formatting, per-file write mutex                │
 │ mcp/agents      registry: name, colour, working sets, timeouts → presence pushes    │
 │ mcp/hosts       which webContents hosts which file; headless host pool; handoff     │
 │ mcp/assets      image sources (paths, URLs) → core.putAsset                          │
 │ mcp/render      shared off-screen render window: stage → capturePage → encode       │
 │ core backend (Rust / JS)  ·  files, assets                                           │
 └───────┬──────────────────────────────┬──────────────────────────────┬───────────────┘
   agent:request / agent:response  (IPC, ids, deadlines, cancel)       │
         ▼                              ▼                              ▼
  visible editor window          headless host window           render window (OSR)
  (file open by the user)        #/agent-host/<fileId>          #/agent-render
  renderer/agent: executors      same executors + hidden canvas stage DOM in a shadow root
  → @baren/html, schema       + live sync for shared files    fonts probe, transcode
  → Loro transact('agent:<tool>')
         │ Loro updates (persistence → core; sync-client → server → collaborators)
         │ presence incl. `agents` → server → collaborators
```

---

## 3. Files, settings and runtime flags

### 3.1 On disk (`<userData>/mcp/`, created with mode 0700)

- **`config.json`** (mode 0600, written atomically with `writeFileAtomic`):
  `{ "version": 1, "enabled": boolean, "port": number, "token": string }`. Created on first
  start with `enabled: true`, `port: 29170`, a new token. Unknown or invalid content → recreate
  (new token; logged as a warning).
- **`endpoint.json`** (mode 0600): `{ "version": 1, "url": "http://127.0.0.1:<port>/mcp",
"port": number, "pid": number, "appVersion": string, "startedAt": number }`. Written when the
  server is listening, deleted when it stops (disable, quit). Contains no token.
- **`baren-mcp-stdio.cjs`**: the stdio shim (§4.12), copied from the app bundle when the
  bytes differ.
- **`agents.json`** (mode 0600): recently seen agents for the home card (§10.1):
  `{ "version": 1, "agents": [{ "name", "client", "lastActivityAt", "lastFileId",
"lastFileName" }] }`, keyed by display name, at most 10, entries older than 30 days dropped,
  written at most once a minute and on quit.

The token is stored in plain text (0600 file). It cannot use `safeStorage`, because the stdio
shim reads it without Electron. Tests and the e2e harness always set `BAREN_USER_DATA_DIR`
to a scratch directory; nothing ever touches the user's real profile.

### 3.2 Token

`brn_` + 43 characters of base64url (32 random bytes from `crypto.randomBytes`). Compared with
`crypto.timingSafeEqual` (after a length check). Rotation (`bridge.mcp.resetToken()`): new
token written to `config.json`, every open session closed (their transports `close()`d; the
agents disappear from presence), status re-broadcast. HTTP client configurations that embed
the old token must be updated (the dialog says so); stdio configurations keep working.

### 3.3 Port

Bind order: `config.port` (default 29170), then `config.port + 1 … + 9`, then an ephemeral
port (`0`). When the bound port differs from `config.port`, it is persisted to `config.json`
and the status carries `portChanged: true` for this run (the dialog explains that configured
agents need the new snippet). `BAREN_MCP_PORT=<n>` overrides for one run and is never
persisted (`0` = ephemeral; tests use `0`). Never 8787, 5173, 5199 (the app's own dev ports):
those are refused as configured values (fall through to the next candidate).

### 3.4 Runtime flags (`src/main/startup/flags.ts`, documented in its header)

| Variable                          | Meaning                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `BAREN_MCP=0\|1`                  | force the MCP server off/on for this run (default: `config.enabled`; smoke runs: off) |
| `BAREN_MCP_PORT=<n>`              | port for this run (`0` = ephemeral), not persisted                                    |
| `BAREN_MCP_ALLOWED_ORIGINS=<a,b>` | extra allowed `Origin` values (debugging with the MCP Inspector)                      |
| `BAREN_EXPORT_DIR=<dir>`          | where `export` writes (default `<Downloads>/Baren`)                                   |
| `BAREN_MCP_TOOL_TIMEOUT_MS=<n>`   | override every tool deadline (tests)                                                  |

### 3.5 Lifecycle

- **Start:** `src/main/index.ts` schedules `startMcp()` after the first window's `appReady`
  milestone (`baren:ready`) or 3 s after bootstrap, whichever comes first, via
  `setImmediate` → `import('./mcp/controller')`. Nothing from `@modelcontextprotocol/sdk`,
  `zod`, `parse5` or `@baren/html` may be imported on the cold path (the controller chunk is
  the only importer). Start reads/creates `config.json`, binds, writes `endpoint.json`, copies
  the shim, broadcasts `mcp:status`.
- **Enable/disable:** `bridge.mcp.setEnabled(false)` closes every session, stops listening,
  deletes `endpoint.json`, persists `enabled: false`; `true` starts again (same token and
  port). The Preferences dialog and the Connect dialog both drive it.
- **Quit:** `before-quit`: stop accepting requests (503 `shutting_down`), cancel in-flight
  requests, ask every headless host to flush (`release`, 3 s timeout), close the render
  window, delete `endpoint.json`. The existing core disposal follows.
- **Status states:** `off` (disabled), `starting`, `running`, `error` (bind failed on every
  candidate, or the controller threw; `error` holds a short message).

---

## 4. Main process (server workstream)

Module layout (MUST keep these names so other workstreams can find things; internal helpers
are free): `mcp/controller.ts` (lifecycle, status), `mcp/config.ts`, `mcp/httpServer.ts`,
`mcp/security.ts` (pure checks), `mcp/sessions.ts`, `mcp/tools/*.ts` (one module per tool
family; schemas in `mcp/tools/schemas.ts`), `mcp/agents.ts` (registry, presence),
`mcp/hosts.ts` (host registry, headless pool, handoff), `mcp/ipc.ts` (channels, correlation),
`mcp/assets.ts`, `mcp/render.ts`, `mcp/format.ts` (results, errors), `mcp/guide.ts`,
`mcp/setup.ts` (snippets), `mcp/stdio/shim.ts`.

### 4.1 HTTP endpoint

As built: §17.1 item 1 (only wrong tokens count towards the rate limit).

- `http.createServer` listening on **`127.0.0.1`** only (never `0.0.0.0`, never `::`).
- Routes: `POST /mcp` (JSON-RPC; `initialize` creates a session), `GET /mcp` (the session's
  SSE stream for server-initiated messages), `DELETE /mcp` (end the session). Everything else
  → 404. No CORS headers are ever sent; `OPTIONS` → 405.
- Checks, in this order, before the SDK sees the request (`mcp/security.ts`, pure and
  unit-tested):
  1. `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::ffff:127.0.0.1`} → else 403.
  2. `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`} (case-insensitive) → else 403
     `invalid_host` (DNS rebinding).
  3. `Origin` absent, or ∈ {`http://127.0.0.1:<port>`, `http://localhost:<port>`} ∪
     `BAREN_MCP_ALLOWED_ORIGINS` → else 403 `invalid_origin`.
  4. `Authorization: Bearer <token>` matches → else 401 with
     `WWW-Authenticate: Bearer realm="Baren"`. More than 30 failed attempts in 60 s
     → 429 for 60 s (all requests).
  5. While shutting down → 503.
     Error bodies are JSON-RPC errors: `{"jsonrpc":"2.0","error":{"code":-32001,"message":"…"},"id":null}`.
- Request bodies: at most 4 MiB (`maxRequestBodySize`, the SDK default).
- The SDK transports are created with `enableDnsRebindingProtection: true`, `allowedHosts`
  and `allowedOrigins` set to the same lists (defence in depth; our own checks run first).

### 4.2 Sessions

As built: §17.1 item 2 (60 s rule for dropped streams).

- Stateful Streamable HTTP: `new StreamableHTTPServerTransport({ sessionIdGenerator: () =>
randomUUID(), onsessioninitialized, onsessionclosed, enableJsonResponse: false })` and one
  `new McpServer({ name: 'baren', title: 'Baren', version: app.getVersion() },
{ instructions: <guide topic "server-instructions">, capabilities: { tools: {} } })` per
  session, `await server.connect(transport)`.
- A `POST` without `Mcp-Session-Id` must be an `initialize` request (else 400, SDK behaviour);
  a request with an unknown session id → 404 (the client re-initialises).
- On `server.server.oninitialized`: read `server.server.getClientVersion()` (`{ name,
version, title? }`) and register the agent (§4.4).
- Limits: at most **32** sessions (the 33rd `initialize` → 503 `too_many_sessions`). A session
  with no request for **30 min** and no open `GET` stream is closed.
- Tool handlers get `extra.signal` (the SDK aborts it on `notifications/cancelled` and on
  transport close) and forward cancellation (§4.6).

### 4.3 Tool registration

Every tool of §6 is registered with `registerTool(name, { title, description, inputSchema,
annotations }, handler)`, where `inputSchema` is a zod `z.object({…}).strict()` (so the JSON
schema has `additionalProperties: false`), descriptions are the texts of §6
(copied verbatim), and annotations are `{ readOnlyHint: true }` for read tools,
`{ destructiveHint: true }` for `delete_nodes` and `write_html` (replace), `{ openWorldHint:
false }` everywhere. No `outputSchema` (results are text).

### 4.4 Agents (`mcp/agents.ts`)

```ts
interface AgentSession {
  sessionId: string // MCP session id (never shown)
  presenceId: string // 12 random base36 chars: the id in presence data
  client: string // clientInfo.name as sent
  version: string | null // clientInfo.version
  name: string // display name (below)
  connectedAt: number
  lastActivityAt: number
  files: Map<
    string,
    { lastActivityAt: number; working: Map<string /*artboard id*/, number /*expires at*/> }
  >
}
```

- **Display name**: `clientInfo.title` if present, else a known-name map, else
  `clientInfo.name`, trimmed to 32 characters, empty → `"Agent"`. Map (case-insensitive,
  prefix match): `claude-code` → "Claude Code", `claude-ai`/`claude` → "Claude", `cursor` →
  "Cursor", `codex` → "Codex", `visual studio code`/`vscode` → "VS Code", `windsurf` →
  "Windsurf", `zed` → "Zed", `gemini-cli` → "Gemini CLI", `mcp-inspector`/`inspector-client` →
  "MCP Inspector". Two live sessions with the same display name get " 2", " 3"… suffixes.
- **Colour**: none per agent. Every agent is drawn with the agent accent tokens
  (`--color-agent`, `--color-agent-ring`, `--color-agent-glow`, `--color-overlay-agent`;
  `docs/phase4/design-tokens.md`), so presence data carries no colour.
- **Working sets** (the "working" indicator): every successful write tool adds the
  response's `touched` artboard ids (§4.6) to the session's working set for that file with an
  expiry of now + **120 s**; any later tool call whose `touched` includes the artboard
  (reads included) renews it. `finish_working_on_nodes` releases (§6.29). A 1 s timer drops
  expired entries. Closing a session drops everything.
- **Presence push**: whenever a session's name, file activity or working set changes, main
  sends `agent:presence` (§4.6) to the host of every affected file, throttled to 10 Hz per
  file, with the full list for that file: sessions with activity on the file in the last
  **10 min** or a non-empty working set there.
- **Status**: `McpStatus.agents` (§4.14) = every live session (`connected: true`) plus the
  recently seen agents of `agents.json` that have no live session (`connected: false`), most
  recent activity first. On every tool call main updates the session's `lastActivityAt`,
  `lastFileId`/`lastFileName` and the matching `agents.json` entry. Status broadcasts are
  throttled to 2 per second.

### 4.5 Hosts and routing (`mcp/hosts.ts`)

As built: §17.1 item 3 (leases, pings, deleted files).

- **Registry**: renderers announce `agent:host { fileId, state: 'opened' | 'closed',
headless }` (§4.6). Main keeps `fileId → { webContentsId, headless, openedAt }` plus, per
  visible `BrowserWindow`, the last time it was focused (`focus` events; creation counts).
  A webContents that is destroyed or navigates away unregisters its file.
- **Default file** (tool called without `fileId`): among visible windows that host a file, the
  one focused most recently (`BrowserWindow.getFocusedWindow()` first if it hosts a file).
  None → error `no_file_open`.
- **Resolving `fileId`**: accepts a bare id, `baren://file/<id>[/<pageId>]`,
  `#/file/<id>`, `/file/<id>` and `https://baren.dev/file/<id>`. Unknown id (not in
  `core.listFiles()`, archived included) → `file_not_found`.
- **Choosing the host for a request**: (1) a visible window hosting the file (most recently
  focused if several — two windows on one local file is the pre-existing "not synced between
  windows" limitation); (2) a headless host already holding it; (3) a visible `files:open` for
  that file in flight → wait for that window's `opened` (≤ 10 s); (4) otherwise start a
  headless host and wait for its `opened` (≤ 20 s, else `host_unavailable`).
- **Headless hosts**: `new BrowserWindow({ show: false, skipTaskbar: true, width: 1440,
height: 900, webPreferences: { …windowOptions() web preferences, backgroundThrottling:
false } })` loading `<rendererUrl>#/agent-host/<encodeURIComponent(fileId)>`, guarded with
  `guardWebContents`. They are not part of `WindowManager` (no broadcasts, never "current",
  never shown, not restored). At most **4** at once (the least recently used idle one is
  released first). A headless host is released after **120 s** without requests **and**
  without working sets on its file.
- **Release** (idle, LRU, quit, handoff): main sends request `release` (§4.6), the host
  flushes persistence, closes its session (thumbnail included) and answers; main then
  destroys the window. Timeout 5 s → destroy anyway (Loro updates already saved are safe; the
  debounce is at most 2 s).
- **Handoff to a visible window**: the `files:open` IPC handler (ipc/handlers.ts hook) first
  awaits `hosts.beforeVisibleOpen(fileId)`: if a headless host holds the file, release it;
  meanwhile requests for that file wait (case 3 above). Only then does it call
  `core.openFile`.
- **Quit when the last visible window closes**: because hidden hosts are windows too,
  `window-all-closed` no longer fires. Main MUST call `app.quit()` itself on Linux/Windows
  when the last `WindowManager` window closes (macOS keeps running as before, hosts included).

### 4.6 IPC protocol (`mcp/ipc.ts`, `preload/channels.ts`)

As built: §17.1 item 4 (headers of internal tools).

Channels (added to the typed channel maps; every message passes the existing trusted-sender
check and argument validation):

| Direction       | Channel                                                                     | Payload               |
| --------------- | --------------------------------------------------------------------------- | --------------------- |
| main → renderer | `agent:request`                                                             | `AgentRequest`        |
| renderer → main | `agent:response` (send)                                                     | `AgentResponse`       |
| main → renderer | `agent:cancel`                                                              | `id: string`          |
| renderer → main | `agent:host` (send)                                                         | `AgentHostState`      |
| main → renderer | `agent:presence`                                                            | `AgentPresenceUpdate` |
| main → renderer | `mcp:status`                                                                | `McpStatus`           |
| main → renderer | `files:changed`                                                             | (none)                |
| renderer → main | `mcp:status` / `mcp:set-enabled` / `mcp:setup` / `mcp:reset-token` (invoke) | §4.14                 |

```ts
type AgentToolName = McpToolName | InternalToolName
type InternalToolName =
  | 'release' // host: flush + close the session, then answer
  | 'flush' // host: persistence.flush()
  | 'artboards_of' // host: { nodeIds } → { artboards: Record<nodeId, artboardId | null> }
  | 'render_job' // host: { nodeId, scale, purpose: 'screenshot'|'export'|'styles', nodeIds? } → RenderJob
  | 'node_image' // host: { nodeId } → { assetId, mime?, name? } | { svg } (get_fill_image, svg export)
  | 'stage_prepare' // render window: { job: RenderJob, scale, maxSide, maxPixels, transparent } → { width, height, scale, outWidth, outHeight }
  | 'stage_styles' // render window: { job: RenderJob, nodeIds } → { styles: Record<id, CSSProperties> }
  | 'stage_clear' // render window
  | 'fonts_probe' // render window: { familyNames } → get_font_family_info body
  | 'image_transcode' // render window: { hash | png, to: 'jpeg'|'webp'|'png', maxSide?, quality? } → { bytes }

interface AgentRequest {
  id: string // 'r' + increasing integer, unique per main process
  fileId: string | null // null only for render-window tools
  tool: AgentToolName
  args: unknown // already validated by main (zod), plain JSON
  agent: { sessionId: string; presenceId: string; name: string } | null
  assets?: Record<string, ResolvedSource> // pre-resolved image sources (§4.8), write tools only
  deadline: number // epoch ms; the renderer gives up (error 'timeout') after it
}

type AgentResponse =
  | { id: string; ok: true; header: FileHeader | null; result: unknown; touched?: string[] }
  | { id: string; ok: false; error: AgentError }

interface FileHeader {
  file: { id: string; name: string }
  contentHash: { tokens: string }
}
interface AgentError {
  code: AgentErrorCode
  message: string
  data?: Record<string, unknown>
}

interface AgentHostState {
  fileId: string
  state: 'opened' | 'closed'
  headless: boolean
}
interface AgentPresenceUpdate {
  fileId: string
  agents: AgentPresence[]
}
interface AgentPresence {
  id: string // presenceId
  name: string
  working: string[] // artboard ids with an active working indicator in this file
  activeAt: number // last tool call on this file (epoch ms)
}
```

- **Correlation**: main keeps `id → { webContentsId, resolve, reject, timer }`; a response
  from another webContents than the one asked is ignored (logged). A host that is destroyed
  rejects its pending requests with `host_unavailable`.
- **Deadlines** (default; `BAREN_MCP_TOOL_TIMEOUT_MS` overrides): reads 30 s,
  `write_html` 60 s (asset pre-resolution has its own budget, §4.8), `render_job` and stage
  tools 30 s, `get_screenshot` 45 s end to end, `export` 120 s, host start 20 s, `release`
  5 s. On expiry main sends `agent:cancel` and returns `timeout`.
- **Cancellation**: on `extra.signal` abort main sends `agent:cancel` and returns
  `cancelled`. Executors check an `AbortSignal` between async steps; **a transaction that has
  started always completes** (Loro has no rollback) — a cancelled write is either not applied
  at all or applied completely.
- **Concurrency**: main runs write tools (§6, "write") through a `KeyedMutex` keyed by file id,
  so writes to one file never interleave; reads are not queued. The render window processes
  one stage job at a time (a FIFO in `mcp/render.ts`). Executors do all async preparation
  (data-URI asset puts, natural image sizes, waiting for collaboration role) **before** their
  single synchronous `transact`.
- **`touched`**: the top-level artboard ids (children of a page) that contain any node the
  call read or wrote (for writes: created, changed, moved — source and destination —
  and deleted nodes; a deleted artboard is not included). Main uses it for working sets.

### 4.7 Render window (`mcp/render.ts` + runtime `agent/render/**`)

As built: §17.1 item 13 (Electron 44 findings; PDF works).

- One shared window, created lazily, destroyed after **60 s** idle:
  `new BrowserWindow({ show: false, width: 64, height: 64, transparent: true,
backgroundColor: '#00000000', webPreferences: { …app web preferences, offscreen: true,
backgroundThrottling: false } })` loading `<rendererUrl>#/agent-render`; frame rate 30
  (`setFrameRate`). Guarded with `guardWebContents`.
- **Capture flow** (`get_screenshot`, `export` image formats):
  1. Main asks the file's host for `render_job { nodeId, scale, purpose }` → `RenderJob`
     (§11.4): the stage HTML/CSS from `@baren/html` `renderStage`, the node's measured size,
     inherited text styles, background.
  2. Main sends `stage_prepare { job, scale, maxSide, maxPixels, transparent }` to the render
     window (screenshots: `maxSide` 1568, `maxPixels` 1,150,000, `transparent: false`;
     exports: `maxSide` 8192, `maxPixels` ∞, `transparent: true`). The page builds the stage,
     waits for fonts and images (§11.5), measures the stage root's CSS size `(width, height)`,
     computes the effective scale `s = min(scale, maxSide / max(width, height), sqrt(maxPixels
/ (width × height)))`, applies `transform: scale(s)` (origin top-left) and answers
     `{ width, height, scale: s, outWidth: ceil(width × s), outHeight: ceil(height × s) }`.
  3. Main sets the window content size to `outWidth × outHeight`, waits for the next `paint`
     event (≤ 1 s), then `capturePage({ x: 0, y: 0, width: outWidth, height: outHeight },
{ stayHidden: true })`. (The stage is `position: fixed` with an explicit size, so the
     window size never changes its layout.)
  4. Encode with `nativeImage` (`toJPEG(90)` for screenshots, `toPNG()` for PNG exports,
     `toJPEG(92)` for JPG exports); WebP goes through `image_transcode` in the render page
     (`OffscreenCanvas.convertToBlob({ type: 'image/webp', quality: 0.92 })`). PDF uses
     `webContents.printToPDF({ printBackground: true, margins: { marginType: 'none' },
pageSize: { width: w µm, height: h µm } })` of the prepared stage (SHOULD; if it fails in
     off-screen mode, `export` reports `unsupported` for pdf).
  5. `stage_clear`.
- Exports keep transparency (PNG/WebP): the stage has no background unless the node has one.
  Screenshots are JPEG, composited on the job's `background` (§9.1).

### 4.8 Image sources (`mcp/assets.ts`)

Before forwarding `write_html`, `update_styles` or `create_artboard`, main collects candidate
sources with `@baren/html` `collectImageSources(html)` / `collectCssUrls(styles)` and
resolves each distinct one:

| Source                                                    | Resolution                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/abs/path`, `file:///abs/path`, `baren-file:///abs/path` | `fs.stat` (regular file, ≤ 20 MB) → read                                                                        |
| `http://…`, `https://…`                                   | `net.fetch` (Electron), 15 s timeout, ≤ 3 redirects, no cookies (`credentials: 'omit'`), ≤ 20 MB (abort beyond) |
| `data:…`                                                  | left to the renderer (decoded there, `bridge.assets.put`)                                                       |
| `baren-asset://<64 hex>`                                  | left to the renderer (existing asset)                                                                           |
| relative paths, other schemes                             | `{ error: 'unsupported_source' }`                                                                               |

Bytes are sniffed: PNG/JPEG/WebP/GIF/AVIF → `core.putAsset(bytes, mime)` → `{ kind: 'raster',
hash, mime, name }`; SVG (by content, `<svg` after optional XML prolog/comments, ≤ 1 MB) →
`{ kind: 'svg', markup, name }` (sanitised later by the applier); anything else →
`{ error: 'unsupported_type' }`. `name` = the file name without extension (URLs: last path
segment). Total budget per call: 45 s and 64 MB; sources beyond it get `{ error: 'budget' }`.
Results travel in `AgentRequest.assets` keyed by the exact source string:

```ts
type ResolvedSource =
  | { kind: 'raster'; hash: string; mime: string; name: string }
  | { kind: 'svg'; markup: string; name: string }
  | {
      error:
        | 'not_found'
        | 'too_large'
        | 'unsupported_type'
        | 'unsupported_source'
        | 'fetch_failed'
        | 'budget'
      message: string
    }
```

The renderer never reads local files or the network for agents.

### 4.9 Errors (`mcp/format.ts`)

As built: §17.1 item 5 and §17.2 item 2 (validation errors, all-failed batches).

Tool failures are MCP tool results with `isError: true` (never JSON-RPC errors, so the model
sees them), content `[header?, { type: 'text', text }]` where `text` is
`Error [<code>]: <message>` — one line, actionable (what is wrong, what to call instead).
Invalid arguments (zod) are the SDK's `InvalidParams` protocol errors (unchanged).

```ts
type AgentErrorCode =
  | 'no_file_open' // no fileId and no window has a file open
  | 'file_not_found'
  | 'page_not_found'
  | 'node_not_found'
  | 'invalid_target' // e.g. children into a text/rect, replace a page, page target where not allowed
  | 'instance_content' // structural edit inside an instance (virtual id)
  | 'cycle' // would put a component inside itself
  | 'read_only' // the user is a viewer of this shared file
  | 'token_exists'
  | 'token_not_found'
  | 'unsupported' // format/feature not available (video export, comments…)
  | 'too_large' // output or input over a limit
  | 'host_unavailable' // the host window did not answer / crashed / could not start
  | 'timeout'
  | 'cancelled'
  | 'invalid_argument' // semantic validation beyond the schema
  | 'internal' // unexpected exception (message = exception message, logged with stack)
```

Batch tools that report per-entry errors in-band (`set_tokens`,
`create_tokens`, `set_text_content`, `rename_nodes`, `update_styles`, `delete_nodes`,
`move_nodes`, `duplicate_nodes`, `rename_pages`) apply the valid entries in one transaction and
list the invalid ones in the body (`errors: [{ index, id?, code, message }]`); the call is
`isError: true` only when no entry succeeded.

### 4.10 Result format

Two text blocks, for every file-scoped tool:

```jsonc
content: [
  { "type": "text", "text": "{\n  \"file\": {\n    \"id\": \"<fileId>\",\n    \"name\": \"<name>\"\n  },\n  \"contentHash\": {\n    \"tokens\": \"<8 hex>\"\n  }\n}" },
  { "type": "text", "text": "<body as JSON.stringify(body, null, 2)>" }
  // get_screenshot / get_fill_image: + { "type": "image", "mimeType": "image/jpeg", "data": "<base64>" }
]
```

`contentHash.tokens` = `tokensHash(tokens)` from `@baren/html` (FNV-1a 32-bit, lowercase
hex, 8 chars, over the tokens sorted by name as `name\ttype\tvalue\tdescription\n`). Tools
without a file (`get_guide`, `list_files`, `create_file`, `get_font_family_info`) return only
the body (guide: plain markdown text, not JSON).

### 4.11 Logging

`log.child('mcp')`, stderr like the rest of main. `info`: listening / stopped / port changed /
session opened (display name, client, version) / session closed / headless host started or
released / token reset. `debug` (`BAREN_DEBUG=1`): each tool call with name, file id,
duration, outcome code and response size. Never logged: tokens, HTML, styles, text content,
file paths from arguments, image bytes.

### 4.12 stdio shim (`mcp/stdio/shim.ts` → `out/main/mcp-stdio.js`)

As built: §17.1 items 6–7 (Vite plugin build, more reconnect cases).

- Built by electron-vite as a second **main** input (`build.rollupOptions.input`), CommonJS,
  no `electron` import, everything bundled (SDK stdio server transport + Streamable HTTP
  client transport). The controller copies it to `<userData>/mcp/baren-mcp-stdio.cjs`
  (mode 0700) when the bytes differ.
- Launch (what the snippets configure): `command` = the app executable — `process.env.APPIMAGE`
  for AppImage builds, else `process.execPath` (dev: the Electron binary) — `args` =
  `[<userData>/mcp/baren-mcp-stdio.cjs]`, `env` = `{ ELECTRON_RUN_AS_NODE: "1" }`. Plain
  `node <path>` works too (Node ≥ 18). The `RunAsNode` Electron fuse MUST stay enabled
  (electron-builder default; do not flip it).
- Behaviour: read `config.json` (token) and `endpoint.json` (url) from the shim's own
  directory; if either is missing or the pid is not alive, answer the first request
  (`initialize`) with JSON-RPC error `-32002` "Baren is not running (or its MCP
  server is off). Open the app, then reconnect." and exit 1. Otherwise connect
  `StdioServerTransport` ↔ `StreamableHTTPClientTransport(url, { requestInit: { headers: {
Authorization: 'Bearer <token>' } } })`: every stdin message is `send()` to HTTP, every
  HTTP message is written to stdout. When the HTTP side fails with 404 (the app restarted),
  the shim SHOULD re-read the endpoint, replay the client's original `initialize` and
  `notifications/initialized`, swallow that `initialize` response, and resend the failed
  message; otherwise it exits 1. Logs go to stderr only.

### 4.13 Setup snippets (`mcp/setup.ts`, `bridge.mcp.setup()`)

With `URL` = the running endpoint, `TOKEN` = the token, `EXEC`/`SHIM` = the stdio launch
paths (JSON strings escaped with `JSON.stringify`). The Cursor and Codex formats follow the
design workstream's check of their current docs (`docs/phase4/design-tokens.md` §2); the Claude
Code command is split over three lines so it fits the dialog's code block (≤ 50 monospace
characters per line):

```text
claudeCode:   (label "Run this in your terminal")
claude mcp add --scope user --transport http \
  baren URL \
  --header "Authorization: Bearer TOKEN"

cursor:   (label "Add to ~/.cursor/mcp.json")
{
  "mcpServers": {
    "baren": {
      "url": "URL",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}

codex:    (label "Add to ~/.codex/config.toml")
[mcp_servers.baren]
url = "URL"
http_headers = { "Authorization" = "Bearer TOKEN" }

json:     (label "Add to your MCP client's config"; the "Other" segment)
{
  "mcpServers": {
    "baren": {
      "type": "http",
      "url": "URL",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}

stdioJson: (the "Other" segment's "Only supports stdio? Use the baren stdio shim instead." line)
{
  "mcpServers": {
    "baren": {
      "command": "EXEC",
      "args": ["SHIM"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### 4.14 Bridge additions (exact; `renderer/types/bridge.d.ts`, preload, mock)

```ts
export type McpState = 'off' | 'starting' | 'running' | 'error'

export interface McpAgentInfo {
  name: string // display name (§4.4)
  client: string // clientInfo.name
  version: string | null
  connected: boolean // a live session (false: a recently seen agent from agents.json)
  presenceId: string | null // live sessions only
  connectedAt: number | null // live sessions only
  lastActivityAt: number // last tool call (epoch ms)
  lastFileId: string | null
  lastFileName: string | null // for "Active now · <file>"
  files: { fileId: string; working: string[] }[] // live sessions: working artboard ids per file (names are resolved by the editor)
}

export interface McpStatus {
  state: McpState
  enabled: boolean
  url: string | null // 'http://127.0.0.1:29170/mcp' while running
  port: number | null
  portChanged: boolean
  error: string | null // state 'error' only
  agents: McpAgentInfo[] // live sessions first, then recent ones; "Connected" = some agent is connected
}

export interface McpSetup {
  url: string
  token: string
  snippets: { claudeCode: string; cursor: string; codex: string; json: string; stdioJson: string }
  stdio: { command: string; args: string[]; env: Record<string, string> }
}

interface BarenBridge {
  // …existing members…
  files: { /* …existing… */ onChanged(cb: () => void): () => void } // a tool created or imported a file
  mcp: {
    status(): Promise<McpStatus>
    onStatus(cb: (s: McpStatus) => void): () => void
    setEnabled(enabled: boolean): Promise<McpStatus>
    /** Rejects with "The MCP server is off" when not running. */
    setup(): Promise<McpSetup>
    resetToken(): Promise<McpSetup>
  }
  agent: {
    onRequest(cb: (req: AgentRequest) => void): () => void
    respond(res: AgentResponse): void
    onCancel(cb: (id: string) => void): () => void
    onPresence(cb: (update: AgentPresenceUpdate) => void): () => void
    host(state: AgentHostState): void
  }
}
```

`AgentRequest`, `AgentResponse`, `AgentHostState`, `AgentPresenceUpdate`, `AgentPresence`,
`FileHeader`, `AgentError(Code)`, `ResolvedSource`, `RenderJob` and the tool name unions are
exported from `renderer/types/bridge.d.ts` (one definition shared by main, preload, runtime and
mock). Validation in main: `agent:response` payloads ≤ 32 MiB, `agent:host` strings ≤ 256.

**Mock bridge** (browser mode): `mcp.status()` → a static status chosen by the query
parameter `?mcp=off|not-connected|connected|error` (default `not-connected`: running at
`http://127.0.0.1:29170/mcp`, no agents; `connected`: the agents of artboards 35/36 — "Claude
Code" connected, active now in the open file, and "Cursor" not connected, last active 2 hours
ago; `error`: "port 29170 is in use"); `setup()` → the §4.13 snippets with URL
`http://127.0.0.1:29170/mcp` and token `brn_mock_token_7f3a` (masked display ends in `7f3a`,
as in artboard 34); `setEnabled`/`resetToken` update the
static status and notify. `agent.*`: an in-page loop — the mock exposes
`window.__barenAgent = { dispatch(tool, args, opts?) → Promise<AgentResponse>, presence(update) }`
(browser mode only) that delivers a request to the registered `onRequest` listeners and
resolves with the `respond()` payload. This is how runtime executors are tested in Playwright
without Electron (§14.2). `files.onChanged` never fires in the mock.

### 4.15 Smoke

`BAREN_SMOKE=1 BAREN_MCP=1`: the smoke session additionally waits (≤ 5 s after
`appReady`) for the server to listen, POSTs an `initialize` with the token, expects 200 and a
session id, and reports `mcpReadyMs` in its JSON line. Plain `BAREN_SMOKE=1` is unchanged
(MCP off) and its cold-start numbers MUST stay < 1 s.

---

## 5. Ids, files, pages

As built: §17.2 item 1 (geometry from an isolated artboard measurement).

- **Node ids** are the document's ids, opaque to agents: Loro TreeIDs (`"<counter>@<peer>"`)
  and instance virtual ids (`"<instanceTreeId>/<nodeKey>[/<nodeKey>…]"`). Pages are nodes too
  (TreeIDs); a page's id doubles as `rootNodeId`. Accepted everywhere a `nodeId` is
  taken, with these rules: reads work on both; style/text/name/visibility writes on virtual ids
  become instance overrides (`setStylesAt`, `setTextAt`, `setPropsAt`); structural writes
  (`write_html` targets, `move_nodes`, `duplicate_nodes` parent, adding children) on virtual ids
  → `instance_content`; `delete_nodes` on a virtual id hides it (override), like the canvas.
  Ids do not survive undo/redo of a create or delete (Loro); the guide tells agents.
- **Component names** in results (`component` field, tree summary): page → `Page`, frame →
  `Frame` (a main component → `Component`), text → `Text`, rect → `Rectangle`, svg → `SVG`,
  image → `Image`, group → `Group`, vector → `Vector`, instance → `Instance`.
- **Artboard** = a `frame` (or `group`/`instance`) whose parent is a page. `artboardId` of a
  node = its top-level ancestor (itself for an artboard; null for a page).
- **Files**: `FileMeta.id`. `url` fields are `baren://file/<fileId>/<pageId>` (an identifier
  `open_file` accepts; not a registered deep link).
- **pageId default**: visible host → the page the user is viewing (`store.pageId`); headless
  host → the first page. Unknown `pageId` → `page_not_found`. `isActive` in page lists is true
  only for the page a user is viewing (all false in a headless host).
- **Geometry fields**: `worldX`, `worldY` (world position of the unrotated box's top-left),
  `x`, `y` (relative to the parent's border-box top-left; for artboards equal to world),
  `width`, `height`, rounded to 2 decimals. Source: the host canvas's `getNodeFrame(id)` when
  the node is on the canvas's current page (it flushes pending batches synchronously, so
  values are current right after a commit); otherwise `docGeometry` (declared styles), and
  **null** when the value depends on layout (flex child position, `auto`/`fit-content`/`%`
  sizes) and the node is not measured. A headless host switches its canvas to
  the page of the node being read before measuring (no user to disturb).

---

## 6. Tools

"Read" tools never change the document; "write" tools are serialised per file (§4.6) and each
is exactly one Loro commit with origin `agent:<tool name>` (or none when nothing changes).
All schemas are `.strict()`; `fileId` is optional everywhere (§4.5). Input types below are
TypeScript with constraints in comments; the server writes the equivalent zod. Bodies are the
JSON of the second content block. Descriptions are the exact strings to register.

### 6.1 `get_guide` (main) — read

Input `{ topic: string }`. Body: the topic's markdown from `guide.md`, as plain text.
Topics: `baren-mcp-instructions`, `mobile-status-bar`, `images`, `code-export`,
`image-generation`. Unknown → `invalid_argument`
listing the topics.

Description: "Read a detailed guide on a topic. Call with topic \"baren-mcp-instructions\"
before using other Baren tools. Other topics: \"mobile-status-bar\" (paste-ready
status bar markup for phone artboards), \"images\" (how to put images into a design),
\"code-export\" (turning designs into code), \"image-generation\"."

### 6.2 `get_basic_info` (host) — read

Input `{ fileId?: string; pageId?: string }`. Body:

```ts
{
  fileName: string; pageName: string; pageId: string; url: string
  rootNodeId: string                       // = pageId
  nodeCount: number                        // live real nodes in the file (all pages)
  artboardCount: number                    // on this page
  artboards: { id; name; component; childCount; width: number|null; height: number|null; worldX: number|null; worldY: number|null }[]   // page order
  pages: { id: string; name: string; isActive: boolean }[]
  fontFamilies: string[]                   // distinct families used in styles and fontFamily tokens; "system-ui…" → "System Sans-Serif"
  tokens: { items: { name: string; value: string | number }[] }   // theme-panel order, then name
  components: { key: string; name: string; mainId: string | null; instanceCount: number }[]
}
```

Description: "Get essential context about a design file: file name, the page, node count,
artboards with their sizes and positions, pages, font families in use, design tokens and
components. Call it first. Without fileId the file the user is looking at is used; without
pageId the page they are viewing. worldX/worldY/width/height are null when they depend on
layout and the node has not been measured. Pass pageId to work on another page without
disturbing the user."

### 6.3 `list_files` (main) — read

As built: §17.1 item 11 (URLs without a page id).

Input `{ limit?: integer /* 1–200, default 50 */ }`. Body `{ files: { id, name, createdAt:
ISO string, updatedAt: ISO string, isOpen: boolean, isShared: boolean, url }[], count }`:
files open in a window first (most recently focused first), then the rest by `updatedAt`
descending; archived files excluded. Team files not yet pulled to this computer are not
listed (they appear after the app syncs the team's files).

Description: "List Baren files on this computer: files open in the app first, then
the most recently updated. isShared marks files shared with a team."

### 6.4 `open_file` (main → host) — read (navigation)

As built: §17.1 item 12 (`firstOpen`, sign-in screen).

Input `{ fileId: string /* min 1; id or url */; pageId?: string }`. Already open in a visible
window → that window is focused only if the app is already focused (never steal focus from
the agent's terminal otherwise), page unchanged. Else: if the most recently focused visible
window shows a home screen, main navigates it (`webContents.executeJavaScript('location.hash
= …')` to `#/file/<id>`); otherwise main opens a new app window at that route
(`WindowManager.create({ route })`). `pageId` is applied only on first open (the runtime
switches the page once the session is ready). A headless host holding the file hands off
(§4.5). Body: the `get_basic_info` body for that page.

Description: "Open a file in the Baren app by its ID or URL, so the user sees it.
pageId is applied only when the file is not open yet (the user's current page is never
changed). Returns the same information as get_basic_info."

### 6.5 `create_file` (main) — write (file level)

As built: §17.1 item 11.

Input `{ name?: string /* ≤ 1024, default "Untitled" */; cloneFileId?: string }`. Without
clone: `core.createFile(name)`. With clone: the source's host (if any) flushes, then
`core.importFile(core.openFile(cloneFileId), name ?? "<source name> copy")`. Broadcast
`files:changed`. Body `{ fileId, name, url }`. The file is local (not shared); it is not
opened.

Description: "Create a new local Baren file and return its ID. Optionally clone an
existing file. The file is not opened: pass the ID as fileId to other tools (works without
opening it), or call open_file to show it to the user."

### 6.6 `create_page` (host) — write

Input `{ fileId?; name?: string /* default "Page N" (nextPageName) */ }`. Creates a page
(background `#EEEEEE`) at the end. Body `{ pageId, name }`. Does not switch the user's page.

Description: "Create a new page in the file and return its ID. Use the pageId in later calls to
work on it; the user's current page does not change."

### 6.7 `rename_pages` (host) — write

Input `{ fileId?; updates: { pageId: string; name: string /* 1–1024 */ }[] /* min 1 */ }`.
Body `{ renamed: string[], errors? }`.

Description: "Rename one or more pages. Does not change which page the user is viewing."

### 6.8 `get_selection` (host) — read

Input `{ fileId? }`. Body `{ selectedNodes: { id, name, component, width, height,
artboardId, artboardName }[], count }` from the host's canvas selection (always empty in a
headless host).

Description: "Get the layers the user has selected in the file they are looking at: IDs,
names, component types, sizes and the artboard each belongs to."

### 6.9 `get_tree_summary` (host) — read

Input `{ fileId?; nodeId: string; depth?: number /* integer 1–10, default 3 */ }`. Body
`{ summary: string, nodeId, depth }`. Format (deterministic, one line per node, two spaces of
indent per level, resolved tree — instance content included with virtual ids):

```
<Component> "<name>" (<id>) <W>×<H>[ "<text, first 60 chars, newlines as ⏎>"][ (N children)][ [hidden]][ → Component "<main name>"]
```

- `W`/`H`: integers, `?` per axis when unmeasured (§5).
- Text nodes add the quoted text. `(N children)` appears on nodes at the depth limit that have
  children. `[hidden]` for hidden nodes. Instances add `→ Component "<main name>"`.
- More than 2,000 lines → stop and append `… truncated (N more nodes)`.
- A page as `nodeId` summarises its artboards.

Description: "Get a compact text outline of a node's subtree: component type, name, ID and size
of each layer, and text content. Sizes show '?' when they depend on layout and have not been
measured. Much cheaper than get_jsx — use it to understand structure first. depth defaults
to 3 (max 10)."

### 6.10 `get_children` (host) — read

Input `{ fileId?; nodeId: string }`. Body `{ children: { id, name, component, childCount,
worldX, worldY, x, y, width, height }[], count }`.

Description: "Get the direct children of a node with their IDs, names, component types, child
counts, world position (worldX/worldY) and position relative to the parent (x/y). Positions
are null when they depend on layout and have not been measured."

### 6.11 `get_node_info` (host) — read

Input `{ fileId?; nodeId: string }`. Body:

```ts
{
  id; name; component; width; height; worldX; worldY; x; y      // §5
  rotation: number                     // degrees, 0 when none
  isVisible: boolean; isLocked: boolean
  parentId: string | null; childIds: string[]; childCount: number
  artboardId: string | null; pageId: string
  textContent: string | null
  image: { assetId: string; name: string | null } | null           // image layer or fill
  mainComponent: { key: string; mainId: string | null; name: string } | null   // instances and their content
  isMainComponent: boolean
  overrides: string[] | null                                        // overridden style keys/fields on an instance node
}
```

Description: "Get detailed information about a node: size, position, visibility, lock state,
parent, children, the artboard it belongs to, text content, image and component information.
x/y/worldX/worldY/width/height are null when they depend on layout and the node has not been
measured."

### 6.12 `find_nodes` (host) — read

Input `{ fileId?; filters?: { styleName?: string; styleValue?: string }[] /* min 1
*/; textValue?: string; nodeId?: string; pageId?: string }` — at least one of `filters` /
`textValue` (else `invalid_argument`). Scope: `nodeId` subtree › `pageId` › every page.
Semantics:

- Each filter matches a node whose **canonical declared styles** (§8.2; resolved for instance
  content) contain an entry satisfying both fields; fields are wildcards (`*`), names match
  camelCase or kebab-case, values match the literal text, a token (`--color-x` ≡
  `var(--color-x)`), or — for colours — by equivalence (`#ccc` ≡ `rgb(204, 204, 204)`, alpha
  included). A literal colour also matches `var(--token)` usages whose token resolves to that
  colour (reported as the `var(…)` reference). Colours inside composite values (gradients,
  borders, shadows) match as fragments; the reported `styleValue` is the matched fragment.
- `textValue` matches text content of text nodes, case-insensitive, `*` wildcard anchored to
  the whole value.
- Filters and `textValue` combine with AND. Results in document order, at most 500
  (`truncated: true` beyond).

Body `{ nodes: { id, name, component, matched: ({ styleName, styleValue } | { textValue })[] }[],
count, truncated?: true }`.

Description: "Find nodes by style and/or text content — for example everything that uses a
token, a literal colour or a piece of copy before a bulk update. Searches every page by
default; pass pageId to search one page, or nodeId to search a node and its descendants
(nodeId wins). filters are { styleName, styleValue } matchers combined with AND; both accept
\"\*\" wildcards; styleValue may be a literal (\"#ff0000\", \"16px\") or a token
(\"--color-primary\"). Colours match by equivalence, and a literal colour also finds
token-bound usages (reported as the var(--token) reference). textValue matches text layer
content, case-insensitive, with \"\*\" wildcards anchored to the whole value (\"Submit\", \"Get
\*\", \"\*started\*\"). Each result has its ID, name, component and the matched entries; for a
colour inside a gradient, border or shadow, styleValue is the matched fragment." (The registered
text is the same with plain `*`; the backslashes only stop Markdown from reading them as
emphasis.)

### 6.13 `get_jsx` (host) — read

Input `{ fileId?; nodeId: string; format?: 'tailwind' | 'inline-styles' /* default tailwind */;
includeIds?: boolean /* default false: adds data-node-id */ }`. Body: the JSX string
(not JSON-wrapped: the code is the body text). Not allowed on a page
(`invalid_target`). Output over 300 KB → `too_large` ("ask for a child node"). Rules in §8.1.

Description: "Get the JSX code of a node and its descendants. format \"tailwind\" (default)
uses Tailwind classes mapped to the file's design tokens with inline fallbacks;
\"inline-styles\" uses React style objects. The output is deterministic."

### 6.14 `get_computed_styles` (host; render window when `resolved`) — read

Input `{ fileId?; nodeIds: string[] /* 1–200 */; resolved?: boolean }`. Body
`{ styles: Record<nodeId, CSSProperties> }` (unknown ids → `errors` in-band).

- Default: each node's **canonical declared styles** (§8.2) — resolved
  for instance content, token references kept as `var(--…)`.
- `resolved: true`: values the browser computes in the render stage (§4.7, `stage_styles`):
  for every CSS property whose computed value differs from its value on an empty reference
  `div` in the same stage, camelCase keys, colours as `rgb()/rgba()`, lengths in px, tokens
  resolved; plus `width`/`height` of the laid-out box. Nodes are grouped by artboard; one
  stage per artboard.

Description: "Get the CSS styles of one or more nodes as a map of nodeId to CSS properties
(camelCase). Values are the styles as designed, with design tokens kept as var(--…). Pass
resolved: true to get the values the browser computes instead (tokens resolved, sizes in px).
Supports batches."

### 6.15 `get_screenshot` (host + render window) — read

Input `{ fileId?; nodeId: string; scale?: number /* 0.1–4, default 1 */ }`. Content:
header + one `image/jpeg` block (+ a text block `"Downscaled to fit size limits (effective
scale 0.62)."` when capped). Rules in §9.1.

Description: "Capture a screenshot of a node by ID (JPEG). 1x scale (default) is enough to
check layout, spacing and colour; use scale 2 only to read small text. Large images are
downscaled to fit size limits — screenshot a child node for more detail. The node is rendered
on its own, independent of what the user's canvas shows."

### 6.16 `get_fill_image` (host + main/render window) — read

Input `{ fileId?; nodeId: string }`. The image of an image layer or the first image fill
(`backgroundImage` url) of the node: header + text block `{ nodeId, assetId, mime, name,
width, height }` + `image/jpeg` block (fitted into 1568 px, quality 85, via
`image_transcode`). SVG layers/vectors → message "This is a vector layer; use get_jsx".
No image → `invalid_target`.

Description: "Get the image of a node that has an image (an image layer or an image fill) as
JPEG, resized to fit size limits, with its asset ID, type and natural size. Returns an error
if the node has no image; for SVG and vector layers use get_jsx."

### 6.17 `get_font_family_info` (render window) — read

Input `{ familyNames: string[] /* 1–20 */ }`. Body:

```ts
{ families: {
    familyName: string
    available: boolean
    source: 'bundled' | 'local' | null     // bundled = identical for every collaborator
    weights: number[] | null               // bundled: exact; local: null (unknown)
    styles: ('normal' | 'italic')[] | null
    isVariable: boolean
    note?: string                          // e.g. "Installed on this computer only; collaborators without it see a fallback."
} [] }
```

Bundled: `Inter` (variable 100–900, normal; italic synthesised → styles `['normal']`),
`JetBrains Mono` (400, 500, 600; normal), `system-ui`/`sans-serif`/`serif`/`monospace`
(generic, `source: 'local'`, available). Local fonts are detected in the render page by
comparing canvas text metrics against three generic fallbacks. Web fonts are never fetched:
unknown families → `available: false` with note "Not installed. Baren does not
download web fonts."

Description: "Check whether font families are available and which weights and styles they
have. Call before your first typographic styling. Inter and JetBrains Mono are bundled and
render the same for every collaborator; other installed fonts work on this computer only."

### 6.18 `get_tokens` (host) — read

Input `{ fileId?; format?: 'json' | 'css' | 'tailwind'; namePattern?: string;
types?: TokenType[] }` with `TokenType` = `TOKEN_TYPES` in `mcp/tools/schemas.ts`
(`breakpoint`, `color`, `container`, `fontFamily`, `fontSize`, `fontWeight`, `letterSpacing`,
`lineHeight`, `opacity`, `radius`, `spacing`). Order = theme-panel order (`order` key), then
name. Body: `json` → `{ tokens: { name, type, value, description? }[] }`; `css` →
the text `:root {\n  --name: value;\n}\n`; `tailwind` → `@theme {\n  --name: value;\n}\n`
(Tailwind v4 namespaces are already the token names; values verbatim). `namePattern`:
case-insensitive glob on the full name.

Description: "List the file's design tokens (colours, spacing, typography, radius…). format
\"json\" (default) returns structured tokens, \"css\" a :root { … } stylesheet, \"tailwind\" a
Tailwind v4 @theme { … } block. Filter with namePattern (a glob on the full variable name, e.g.
\"--color-*\") and types."

### 6.19 `create_tokens` (host) — write

Input `{ fileId?; tokens: { type: TokenType; name: string /* ^--[a-zA-Z0-9_-]+$ */;
value: string | number; description?: string /* ≤ 1024 */ }[] /* min 1 */ }`. Each new token
is appended in the given order (`upsertTokens` orders). An existing name → entry error
`token_exists` (the token map is keyed by name, so duplicate names cannot exist).
Body `{ results: ({ name, result: 'created' } | { name, result: 'error', message })[] }`.

Description: "Create one or more design tokens. Each entry needs type, name (a CSS custom
property such as \"--color-primary\") and value; use var(--other-token) as the value to alias
another token. Returns one result per entry ({ name, result: \"created\" } or an error, e.g.
when the name already exists — change existing tokens with set_tokens). Order matters: define
colour tokens semantic first (neutrals, then primary, secondary, accents); define other types
from the smallest value to the largest. Reuse existing tokens before creating new ones."

### 6.20 `set_tokens` (host) — write

Input `{ fileId?; tokens: { name; newName?; value?; description?; delete?: boolean
}[] /* min 1, applied in order */ }`. Rename keeps value, description and order, and
**rewrites `var(--old)` references** in every node style, override style and token value of
the file in the same commit (`rewriteTokenRefs`). `description: ""` clears it. Delete removes
the token (references stay and render their fallback). Unknown name → entry error
`token_not_found`; rename onto an existing name → `token_exists`. Body `{ results: ({ name,
result: 'updated' | 'renamed' | 'deleted', newName? } | { name, result: 'error', message })[] }`.

Description: "Update, rename or delete existing design tokens by their full CSS variable name.
Each entry needs name; newName renames the token (references to it across the file are
updated), value changes its value (var(--other-token) makes an alias), description changes its
description (\"\" clears it), delete: true removes it. Entries are applied in order; errors are
reported per entry."

### 6.21 `create_artboard` (host) — write

Input `{ fileId?; name: string; pageId?: string; styles: { width: string; height:
string; [k: string]: string | number } }`. Creates a `frame` under the page with styles =
`{ display: 'flex', flexDirection: 'column', backgroundColor: '#FFFFFF' }` (each default only
when the caller sets no value for that key — for the background, no `background`,
`backgroundColor` or `backgroundImage`) merged with `normalizeStyles(styles)` and `left`/`top`
from the placement rule (§6.21.1) unless given. `width`/`height` must be px or `fit-content`
(else `invalid_argument`). Image `url()`s resolved like write_html (§4.8). Body `{ id, name,
pageId, worldX, worldY, width, height, warnings }`. The artboard joins the working set.

#### 6.21.1 Artboard placement (also used by write_html on a page and duplicate_nodes)

Inputs: the new artboard's size `(w, h)` (`h` of `fit-content` counts as 900 until measured),
the page's top-level nodes' bounds (measured via the canvas when the page is on the host
canvas, else declared; unknown heights count as 900), and an **anchor**: the last artboard
this agent session created or duplicated on that page, else for duplicates the source
artboard, else the top-most then left-most artboard of the page.

1. Empty page → `(0, 0)`.
2. Candidate `left = max(right edge of every top-level node whose vertical extent overlaps
the anchor's row band [anchor.top, anchor.top + max(anchor.height, h)]) + 80`,
   `top = anchor.top`.
3. While the candidate rect inflated by 80 px intersects any top-level node, move it right to
   that node's right edge + 80. (Terminates: finite nodes.)
4. Round to integers.

Deterministic for a given document and session history; unit-tested as a pure function
`placeArtboard(existing: Rect[], anchor: Rect | null, size)` in `renderer/agent/geometry.ts`.

Description: "Create a new artboard (top-level frame) on a page and return
its ID; then add content with write_html (mode \"insert-children\"). Set the size with styles
(width and height in whole px are required). Artboards default to display: flex,
flexDirection: column and a white background. Without left/top it is placed in a free spot
next to the other artboards. Omit pageId to use the page the user is viewing. Default sizes:
desktop 1440×900, tablet 768×1024, phone 390×844 (with a status bar: get_guide topic
\"mobile-status-bar\"). The height is a starting point: when content clips, set height
\"fit-content\" with update_styles instead of guessing."

### 6.22 `write_html` (main assets + host) — write

Input `{ fileId?; html: string /* 1 byte – 1 MB */; mode: 'insert-children' |
'replace'; targetNodeId: string }`. Full rules in §7. Body:

```ts
{
  createdNodes: {
    id: string; name: string; component: string; parentId: string
    worldX: number | null; worldY: number | null; width: number | null; height: number | null
  }[]                               // the new top-level nodes, in order
  summary: string                   // get_tree_summary text (depth 3) of every created root, joined by "\n"
  replacedNodeId?: string           // replace mode
  warnings: { code: string; message: string; path?: string; property?: string }[]
}
```

Description (newlines as written):

```text
Write HTML into the design as new layers. mode "insert-children" adds the HTML as the last children of targetNodeId (a page, frame or group); mode "replace" removes targetNodeId and puts the new layers in its place.
IMPORTANT: Write incrementally. The user watches you write on the canvas in real time; show visual progress every few seconds. Each call should create one visual item: a header, one list row, a button bar or a paragraph block. Even a simple card is several calls: the shell, then the header, then each row, then the footer.
IMPORTANT: Prefer cloning existing layers over rewriting them: <x-baren-clone node-id="…" style="…" /> copies a layer and applies your inline styles to the copy. For repeated items, create the container first, then add each item in its own call, or duplicate the first one with duplicate_nodes.

HTML and CSS rules:
- Inline styles only (style="…"); class and <style> are ignored. Use the file's design tokens as CSS variables.
- Name layers with the layer-name attribute, e.g. <div layer-name="Hero">.
- Flexbox is the layout system: display flex, gap and padding. Do NOT use margin, display: inline, display: grid or HTML tables.
- position: absolute is fully supported; use it for decorative elements, never to cover a whole artboard (it blocks clicks underneath).
- Everything is border-box. display: block is fine for simple leaves (text, shapes), not for layout containers.
- An element that contains only text becomes one text layer. Rich text is not supported: put differently styled runs in separate elements. Use <pre> or white-space: pre for code and indented text.
- Any CSS colour format works: hex, rgb(a), hsl(a), oklch, oklab, color-mix().
- Icons: inline <svg>; fill and stroke may use var(--token) and currentColor. Never use emoji as icons.
- Images: <img src> with an absolute local path, an https URL, a data URI or baren-asset://<hash> (get_guide topic "images"). AI image generation is not available.
- Fonts: Inter and JetBrains Mono are bundled; other installed fonts work on this computer only (get_font_family_info).
The result lists the created layers and warnings for anything that was dropped or changed.
```

### 6.23 `update_styles` (main assets + host) — write

Input `{ fileId?; updates: { nodeIds: string[] /* min 1 */; styles: Record<string,
string | number | null> }[] /* min 1 */ }` (`null` or `""` removes a property).
Per node: `normalizeStyles(styles)` (§7.6) → `partitionStyles` (inert keys, §7.7) → apply:
pages → `background` prop from `backgroundColor`/`background` (others ignored); real nodes →
`setStyles` (+ shorthand-family clearing); instances and virtual ids → `setStylesAt` (own keys
on the instance, the rest as overrides). Artboard `left`/`top` move it. Body `{ updated:
string[], ignoredStyles?: Record<nodeId, string[]>, warnings, errors? }`.

Description: "Update styles on one or more nodes in one call. styles is a JSON object with
camelCase CSS property names, like React.CSSProperties ({ \"backgroundColor\":
\"var(--color-surface)\", \"padding\": \"20px\" }); pass null or an empty string to remove a
property. Design tokens work as CSS variables. Setting left/top on an artboard moves it on the
canvas. Styles that are inert in a node's context (e.g. gap on an image) are dropped rather
than applied and returned under ignoredStyles; anything else dropped or changed is listed in
warnings. Layers inside a component instance get the change as an override."

### 6.24 `set_text_content` (host) — write

Input `{ fileId?; updates: { nodeId: string; textContent: string /* ≤ 100,000 */ }[]
/* min 1 */ }`. Text nodes only (real → `setText`, virtual → `setTextAt` override); others →
entry error `invalid_target`. Body `{ updated: string[], errors? }`.

Description: "Set the text of one or more text layers (component \"Text\") in one call. Use
this instead of write_html replace when only the text changes. Text inside a component
instance becomes an override."

### 6.25 `rename_nodes` (host) — write

Input `{ fileId?; updates: { nodeId: string; name: string }[] /* min 1 */ }`. Names
are trimmed and truncated to 50 characters. Virtual ids → `entry error
instance_content` (instance content names come from the main). Pages → use rename_pages
(entry error `invalid_target`). Body `{ renamed: string[], errors? }`.

Description: "Rename one or more layers (the names shown in the layers panel). Names longer
than 50 characters are truncated. Supports batches. Use rename_pages for pages."

### 6.26 `duplicate_nodes` (host) — write

Input `{ fileId?; nodes: { id: string; parentId?: string }[] /* min 1 */ }`.

- Without `parentId`: like Ctrl+D (`duplicateNodes`): the copy goes right after its source with
  identical styles; **a duplicated artboard is placed with §6.21.1** (anchor = the source).
- With `parentId`: serialise + paste (`serializeClipboard` → `pasteClipboard`, same document)
  appended to that parent; the copy keeps its world position in absolute/page contexts and is
  appended in flow for flex parents.
- Virtual sources become detached copies (Phase 3 rule); instances stay instances.

Body: `{ duplicates: { sourceId, newId, parentId }[], descendantIdMap:
Record<sourceDescendantId, newId>, errors? }`. The map covers every descendant of every
source (not the roots), built by walking source and copy subtrees in parallel (same child
order; resolved children for virtual sources).

Description: "Duplicate one or more nodes with all their descendants. Without parentId the
copy goes right after its source in the same parent; with parentId it is added at the end of
that parent. Duplicated artboards are placed in a free spot next to their source. Returns the
source and new IDs plus descendantIdMap, which maps every descendant ID of a source to its
copy — use it to edit the copies right away (e.g. set_text_content) without looking them up."

### 6.27 `move_nodes` (host) — write

Input `{ fileId?; moves: ({ nodeId; before: string } | { nodeId; after: string } |
{ nodeId; parentId: string /* id or 'root' */; index?: integer ≥ 0 })[] /* min 1 */ }`. Applied
sequentially inside one transaction (later moves see earlier ones). `'root'` = the page the
node is on. Implementation: `reparentNodes` (it keeps world positions for absolute/page
contexts and converts placement, Phase 3 §2.4) with the final index (clamped). Refusals map
to entry errors: `cycle`, `instance_content` (virtual node or target inside an instance),
`invalid_target` (leaf target, page moved, into itself). Moves between pages are allowed.
Body: `{ moves: { nodeId, parentId, index }[], affectedParents: Record<parentId,
string[] /* child ids after the batch */>, errors? }`.

Description: "Move existing nodes — reorder or reparent — keeping their IDs, so references you
hold stay valid. Prefer this over duplicate + delete or rewriting HTML. Each move is either
sibling-relative ({ nodeId, before } or { nodeId, after }: the parent comes from the sibling)
or parent-absolute ({ nodeId, parentId, index? }: index is the final position among the new
siblings, clamped, appended when omitted; parentId \"root\" means the page the node is on).
Moves apply in order and see the earlier ones. In flex parents this changes the visual order;
in other parents it changes stacking and keeps the node's position on the canvas.
Baren adjusts position styles (absolute/flow) so the node keeps its place, and may
fix its size when it leaves a flex parent. Nodes can move between pages. A node cannot move
into itself, into a layer that cannot have children, or into a component instance. Returns the
resolved parentId and index of each move and affectedParents: the final child list of every
parent whose children changed."

### 6.28 `delete_nodes` (host) — write

Input `{ fileId?; nodeIds: string[] /* min 1 */ }`. `removeNodes` (topmost only;
emptied groups go too; virtual ids are hidden). Pages → entry error `invalid_target`. Body
`{ deleted: string[], hidden: string[], errors? }`.

Description: "Delete one or more nodes and all their descendants. Layers inside a component
instance are hidden instead (an override). IMPORTANT: before deleting nodes you think have the
wrong parent, check them with get_node_info."

### 6.29 `finish_working_on_nodes` (main) — write (presence only, no document change)

Input `{ fileId?: string; nodeIds?: string[] }`. Without `nodeIds`: release every
working indicator of this session in `fileId` — or, when `fileId` is also omitted, in every
file. With `nodeIds`: each id maps to its artboard (`artboards_of` on the host when not
already an artboard in the set) and that artboard is released. Body `{ released: string[],
remaining: string[] }`. Never an error for ids that were not marked.

Description: "MUST be called when you are done working. Removes your \"working\" indicator from
the artboards you were editing. Call with no nodeIds to release all of them at once, or pass
the IDs of the artboards you finished (preferred when several agents work in the file)."

### 6.30 `export` (host + render window + main) — write (files on disk)

Input `{ fileId?; pageId?; type?: 'image' | 'video'; nodes: 'nodes-with-exports-only'
| Record<nodeId, { format: Format; scale: string /* ^\d+(\.\d+)?(x|w|h|p)$ */;
durationSeconds?; pdfQuality?; pdfResampling? }[]> }`.

- Supported now: `png`, `jpg`, `webp` (any node), `svg` (svg and vector nodes only; markup
  from the node — `vectorToSvgMarkup` with tokens resolved / sanitised `svg`), `pdf` (SHOULD,
  §4.7). `avif`, `mp4`, `webm`, `type: 'video'` → entry error `unsupported`;
  `'nodes-with-exports-only'` → `unsupported` ("Baren has no export settings; pass
  node IDs"). An empty settings array means `[{ format: 'png', scale: '1x' }]`.
- Scale: `Nx` multiplier; `Nw`/`Nh` target width/height; `Np` shortest side. Output long side ≤
  8192 px (else entry error `too_large` with the largest allowed scale).
- Files go to `BAREN_EXPORT_DIR` or `<Downloads>/baren.dev/<file name>/`, named
  `<node name>@<scale>.<ext>` (`/\:*?"<>|` and control characters replaced by `-`; ` (2)`,
  ` (3)`… when taken).
- Body `{ files: { nodeId, format, scale, path, width, height, bytes }[], errors? }`.

Description: "Export nodes as image files (png, jpg, webp; svg for vector and SVG layers; pdf)
to the user's Downloads folder and return their paths. Unless the user specifies, use the
defaults (png at 1x)."

### 6.31 Not implemented

There are no comment tools (Baren has no comments yet) and no tool that exports several nodes
into one PDF. See §15.

---

## 7. write_html (html workstream: `parseHtml` + `applyHtml`; runtime: orchestration)

### 7.1 Pipeline

1. **Main**: zod validation; `collectImageSources(html)`; resolve sources (§4.8); forward
   `write_html` with `assets`.
2. **Runtime** (host): `parseHtml(html)` → IR + warnings; decode `data:` sources and
   `bridge.assets.put` them; check `baren-asset://<hash>` sources with `bridge.assets.get`
   (missing → unresolved); for rasters without explicit size, read the natural size (decode
   `baren-asset://` / blob URL with `Image.decode()`, 5 s timeout); wait for the
   collaboration role on shared files (≤ 3 s; viewer → `read_only`); then
   `transact(doc, () => applyHtml(doc, ir, target, ctx), { origin: 'agent:write_html' })`.
3. **Runtime**: measure created roots (canvas `getNodeFrame`), build `createdNodes`, `summary`,
   `touched`.

### 7.2 Targets

- `insert-children`: the target must be a page, frame or group (real id). Text, rect, image,
  svg, vector, instance → `invalid_target` ("… cannot contain children; use mode
  \"replace\""). Virtual id → `instance_content`. New nodes are appended in order.
- `replace`: the target (real, not a page) is deleted and the new roots are inserted at its
  index in its parent, in order. If the target was an artboard, the first root takes its
  `left`/`top` unless it has its own. Virtual id → `instance_content`.
- **Page target** (insert-children into a page): each root becomes an artboard: `left`/`top`
  from §6.21.1 unless given (each placed after the previous); missing `width` → `1440px`,
  missing `height` → `fit-content` (warning `artboard-size-defaulted`).
- Cycle (a clone of a main into its own instance tree) → whole call refused with `cycle`.

### 7.3 Element mapping

As built: §17.3 items 1, 3–5 (flex containers, `/>`, containing blocks, replace).

parse5 `parseFragment` (template-context `body`); comments, `<!DOCTYPE>`, `<html>`, `<head>`,
`<body>` wrappers are dropped; whitespace-only text between elements is ignored.

| HTML                                                                                                                                                                                                       | Node                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `<x-baren-clone node-id="ID">`                                                                                                                                                                             | deep copy of `ID` (§7.5)                                                                                               |
| `<svg>` (anywhere)                                                                                                                                                                                         | `svg`: `sanitizeSvgMarkup(outerHTML)`; `width`/`height` attributes → styles when the style sets none                   |
| `<img>`                                                                                                                                                                                                    | `image` (raster source) or `svg` (SVG source) (§7.8); `alt` → name fallback                                            |
| an element whose content is only text and phrasing elements (`span b strong i em u s del ins mark small sub sup code kbd samp a abbr cite q time label br wbr`) that themselves contain only text/phrasing | `text` (§7.4) — any tag (`div`, `p`, `h1`, `button`, `li`, `a`…)                                                       |
| any other element (including empty ones)                                                                                                                                                                   | `frame`                                                                                                                |
| `<hr>`                                                                                                                                                                                                     | `frame` with `height: 1px` and `backgroundColor` from its `border-color`/`color` (default `#E5E5E5`) unless styled     |
| `<input>`, `<textarea>`                                                                                                                                                                                    | `frame` (its styles) containing a `text` with `value` or `placeholder` (placeholder: `opacity: 0.5` unless styled)     |
| `<select>`                                                                                                                                                                                                 | like `<input>` with the selected (else first) `<option>` text                                                          |
| `<table>`, `<thead>`, `<tbody>`, `<tr>`                                                                                                                                                                    | `frame` flex column (`table`, sections) / row (`tr`); `<td>`/`<th>` as ordinary elements; warning `table-as-flex` once |
| `<script> <style> <link> <meta> <template> <iframe> <object> <embed> <video> <audio> <canvas> <noscript> <slot> <dialog>`                                                                                  | dropped, warning `unsupported-element` (`<style>`: `stylesheet-ignored`)                                               |
| `<ul>`, `<ol>`                                                                                                                                                                                             | `frame`; warning `list-markers-dropped` once (no bullets)                                                              |

- **Mixed content** (text and non-phrasing elements, or phrasing elements with element
  children) in an element whose `display` is `flex`/`inline-flex`: every bare text run (after
  whitespace normalisation, empty runs skipped) becomes its own `text` child named after its
  content, between the element children, in order. In any other element: the same split, plus
  warning `block-flow` when the element ends up with ≥ 2 in-flow children.
- **Rich text**: a text element containing phrasing elements with their own `style`, or
  `b/strong/i/em/u/s/del/ins/mark/sub/sup/code` that would change the look → one text node,
  warning `rich-text-flattened` (the inner formatting is lost).
- **Attributes**: `style` (§7.6), `layer-name` (also `data-layer-name`) → name, `hidden` →
  `hidden: true`, `src`/`alt`/`width`/`height` (img, svg), `node-id` (clones), `value`/
  `placeholder` (form controls). `class`, `id`, `href`, event handlers, `title`, `role`,
  `aria-*`, `data-*` → ignored (warning `class-ignored` once when `class` is present).
- **Names**: `layer-name` › text: its text (first line, trimmed, ≤ 50 chars) › image: `alt`, else
  the source name, else "Image" › svg: "SVG" › frame: "Frame". Names are truncated to 50.
- **Limits**: ≤ 5,000 created nodes per call (`too_large`); nesting depth ≤ 64 (deeper
  elements dropped, warning).

### 7.4 Text

- Content = the concatenated text of the element and its phrasing descendants, with `<br>` →
  `\n`. Whitespace: unless the element's (or an ancestor's within the call) `white-space` is
  `pre`, `pre-wrap`, `break-spaces` or `pre-line`, or the tag is `<pre>`/`<textarea>`, runs of
  space/tab/newline collapse to one space and the result is trimmed (newlines from `<br>`
  stay). `pre-line` collapses spaces but keeps newlines. `<pre>`: one leading newline is
  removed (HTML rule) and `whiteSpace: 'pre'` is added unless set. HTML entities are decoded by
  parse5.
- **UA defaults** applied when the property is not set inline (nothing else from the user-agent
  stylesheet: no margins, no heading sizes, no link colours, no bullets): `h1`–`h6`, `th`,
  `b`, `strong` (when it is the text element itself) → `fontWeight: 700`; `i`, `em` →
  `fontStyle: 'italic'`; `u`, `ins` → `textDecoration: 'underline'`; `s`, `del` →
  `textDecoration: 'line-through'`; `pre`, `code`, `kbd`, `samp` → `fontFamily: 'JetBrains
Mono'`.
- Text nodes never get `display: block` stored (it is the default); `display: flex` on a text
  element is kept (text layers use it for alignment).

### 7.5 Clones

`<x-baren-clone node-id="ID" style="…" layer-name="…">`: `ID` real
or virtual, in this file (`clone-not-found` warning and nothing created otherwise). Copy =
`serializeClipboard(doc, [ID], { geo, fileId, pageId })` → `pasteClipboard(doc, payload, {
parentId: <insertion parent>, index, geo })` inside the call's transaction (instances stay
instances, virtual content becomes a detached copy, Phase 3 rules). Then the clone element's
normalised styles are applied to the copy root (`setStyles`), and `layer-name` renames it.
Children of the clone element are ignored (warning `clone-children-ignored`). In a flex parent
the copy is in flow (its old `position`/`left`/`top` removed unless the clone element sets
them).

### 7.6 Style normalisation (`normalizeStyles`, also used by update_styles and create_artboard)

As built: §17.3 item 2 (canonical shorthands).

Input: a CSS declaration string (`style` attribute) or a record (tool JSON). Output: a
`StylePatch` (null = remove) + warnings. Rules, in order:

1. **Parse**: declarations split on top-level `;` (respecting strings, parentheses, `url()`);
   `!important` stripped. Record input: kebab-case keys accepted.
2. **Keys**: kebab → camelCase; `-webkit-x` → `WebkitX`, `-moz-x` → `MozX`; custom properties
   (`--x`) kept verbatim (allowed on any node; they define local variables).
3. **Values**: strings trimmed; `""`/`null` → remove; JSON numbers are kept as numbers (px for
   non-unitless properties, React semantics; the unitless list is the schema exporter's —
   `packages/schema/src/html.ts` `UNITLESS`, not exported: the html package keeps a copy and a
   test checks it against `cssDeclarationValue(key, 1)` for every key); `rem` lengths → px
   (×16, rounded to 2 decimals) wherever they appear in a value; numeric strings for
   `fontWeight` (`"600"`) → number; unsafe values (the schema's `isSafeCssValue` rules in
   `svgSanitize.ts`, not exported: the html package keeps an equivalent copy with the same test
   cases; e.g. `expression(`, `javascript:`, external `url()` after asset resolution) →
   dropped, `unsafe-value`.
4. **Shorthand policy** (expansions; each expansion also sets the _other_ members of its family
   to `null` in an update, so stored styles never disagree):

   | Input                                          | Stored as                                                                                                                                                                                                                         |
   | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `padding` / `margin`: 1 value                  | `padding` / `margin`                                                                                                                                                                                                              |
   | 2 values                                       | `paddingBlock` + `paddingInline` (margin alike)                                                                                                                                                                                   |
   | 3 values                                       | `paddingTop`, `paddingInline`, `paddingBottom`                                                                                                                                                                                    |
   | 4 values                                       | the four longhands                                                                                                                                                                                                                |
   | `inset` (1–4)                                  | `top` `right` `bottom` `left`                                                                                                                                                                                                     |
   | `gap`: 1 / 2 values                            | `gap` / `rowGap` + `columnGap`                                                                                                                                                                                                    |
   | `border`, `border-top\|right\|bottom\|left`    | `borderWidth/Style/Color` or `border<Side>Width/Style/Color` (any order of width/style/colour; `none` or `0` → `borderStyle: 'none'`, width and colour removed)                                                                   |
   | `border-width/style/color` with 2–4 values     | per-side longhands                                                                                                                                                                                                                |
   | `outline`                                      | `outlineWidth/Style/Color`                                                                                                                                                                                                        |
   | `border-radius`: 1 value                       | `borderRadius`; 2–4 values → four corner longhands; with `/` → kept as is                                                                                                                                                         |
   | `background` (single layer)                    | colour part → `backgroundColor`; `url()`/gradient → `backgroundImage`; `<position> / <size>` → `backgroundPosition` + `backgroundSize`; repeat keyword → `backgroundRepeat`; `none`/`transparent` → both colour and image removed |
   | `background` (several comma-separated layers)  | kept as `background`                                                                                                                                                                                                              |
   | `flex`                                         | `flexGrow` `flexShrink` `flexBasis` (`N` → N 1 0%; `N M` → N M 0%; `N M B`; `B` → 1 1 B; `auto` → 1 1 auto; `none` → 0 0 auto; `initial` → 0 1 auto)                                                                              |
   | `flex-flow`                                    | `flexDirection` + `flexWrap`                                                                                                                                                                                                      |
   | `place-items` / `place-content` / `place-self` | `alignItems`+`justifyItems` / `alignContent`+`justifyContent` / `alignSelf`+`justifySelf`                                                                                                                                         |
   | `font`                                         | `fontStyle` `fontWeight` `fontSize` `lineHeight` `fontFamily` (system font keywords → `unsupported-property`)                                                                                                                     |
   | `overflow` with 2 values                       | `overflowX` + `overflowY`                                                                                                                                                                                                         |

   Families for clearing: padding (`padding`, `paddingBlock`, `paddingInline`,
   `padding{Top,Right,Bottom,Left}`, `padding{Block,Inline}{Start,End}`), margin (alike),
   inset (`inset` clears `top/right/bottom/left`; a single side never clears the others), gap
   (`gap`, `rowGap`, `columnGap`), border (`border` + every border width/style/colour key),
   radius (`borderRadius` + corners), background (`background` + `backgroundColor/Image/
Position/Size/Repeat`), flex (`flex`, `flexGrow`, `flexShrink`, `flexBasis`), outline. Rule:
   setting a shorthand clears its longhands; setting a longhand clears the shorthands that
   contain it.

5. **Policy per property**:
   - **Dropped silently**: `boxSizing` (always border-box).
   - **Dropped with `unsupported-property`**: `transition*`, `animation*`, `cursor`,
     `pointerEvents`, `userSelect`, `content`, `willChange`, `resize`, `caretColor`,
     `appearance`, `scroll*`, `counter*`, `listStyle*` (with `list-markers-dropped`).
   - **Converted with `position-converted`**: `position: fixed | sticky` → `absolute`.
   - **Converted with `table-as-flex`**: `display: table | table-row | table-cell |
inline-table` → `flex` (row for `table-row`).
   - **Dropped with warning**: `display: contents` (`unsupported-property`).
   - **Kept with `discouraged-property`** (renders, but the inspector cannot edit it): `margin*`,
     `display: grid | inline-grid` and `grid*`, `display: inline | inline-block`, `float`,
     `clear`.
   - **Unknown names** (not in `KNOWN_CSS_PROPERTIES`, a static list in the html package that
     includes SVG paint properties): dropped, `unknown-property`.
   - Everything else is kept verbatim (colours, `color-mix()`, gradients, shadows, filters,
     transforms, `rotate` — normalised with the schema's `normalizeDeg` to `"<deg>deg"`).
6. **Tokens**: `var(--x)` (and `var(--x, fallback)`) kept verbatim; a name that is neither a
   file token nor a custom property declared in the same call → warning `unknown-token` (still
   kept).
7. **Images in values**: `url(…)` in `background`/`backgroundImage`/`maskImage`/
   `borderImageSource`/`listStyleImage` → replaced with `url("baren-asset://<hash>")` from
   the asset map (raster only); unresolved or SVG sources → the property is dropped, warning
   `image-unresolved`.

### 7.7 Inert styles (`partitionStyles`, update_styles only)

A key is ignored (reported in `ignoredStyles`, not written) when:

- the node is a page and the key is not `backgroundColor`/`background`;
- the node is `rect`, `image`, `svg`, `vector` or `instance` and the key is a flex-container
  property (`flexDirection`, `flexWrap`, `justifyContent`, `alignItems`, `alignContent`,
  `gap`, `rowGap`, `columnGap`), or the node is `text` and its `display` (after the patch) is
  not `flex`/`inline-flex`;
- the key is `left`/`top`/`right`/`bottom`/`inset`, the node is not top-level, and its
  `position` (after the patch) is static (absent or `static`);
- the key is `objectFit`/`objectPosition` and the node is not an image;
- the key is a typography property (`fontFamily`, `fontSize`, `fontWeight`, `fontStyle`,
  `lineHeight`, `letterSpacing`, `textAlign`, `textTransform`, `textDecoration*`,
  `whiteSpace`) and the node is `rect`, `image` or `vector`.

### 7.8 Images

- `<img src>`: asset map entry `raster` → `image` node with `assetId`, `assetName` = source
  name; styles from the element, plus `width`/`height` attributes; when neither style nor
  attribute gives a size, the natural size in px (computed by the runtime); `objectFit` is not
  added (CSS default `fill`).
- `svg` entry → `svg` node with the sanitised markup; size from style/attributes, else the
  SVG's `width`/`height` attributes, else its `viewBox`, else 24×24.
- `data:image/svg+xml,…` → `svg` node; other `data:` images → raster after `assets.put`.
- `baren-asset://<hash>` present in the core → raster image.
- Unresolved → an `image` node without `assetId` (the canvas draws the grey placeholder), size
  from styles or 100×100, warning `image-unresolved` with the reason.

### 7.9 Result details

`createdNodes` = the new top-level nodes (children of the target, or of the target's parent in
replace mode), in order, with §5 geometry measured after the commit. `summary` = for each
created root, its `get_tree_summary` (depth 3), joined by newlines. `warnings` deduplicated by
`(code, property, path)`; `path` is an element path like `div[2] > p[1]` (1-based among element
siblings of the fragment).

---

## 8. Readers and exporters (html workstream)

### 8.1 `toJsx`

As built: §17.3 item 6 (Tailwind scale and order).

- Root wrapper: `(\n    <root …>\n      …\n    </root>\n  )` with 4 spaces before
  the root and 2 more per level; text content on its own line, indented one level deeper.
- Elements: frame/group/instance/rect → `div`; text → `div` with its text (escaped for JSX:
  `{`, `}`, `<`, `>` via `{'…'}`; `\n` → `<br />`); image → `<img src="baren-asset://<hash>"
alt="<name>" />`; svg → the sanitised markup converted to JSX (attributes camelCased,
  `class` → `className`, `style` strings → objects); vector → `<svg width height viewBox
overflow="visible"><path d fillRule /></svg>` with paints resolved (`vectorToSvgMarkup`).
  Hidden nodes are omitted. Instances are expanded (resolved subtree). Pages are not allowed.
- **Root inherited styles**: the root element additionally carries the inherited text
  properties (`INHERITED_TEXT_PROPERTIES`: `color`, `fontFamily`, `fontSize`, `fontWeight`,
  `fontStyle`, `lineHeight`, `letterSpacing`, `textAlign`, `textTransform`, `whiteSpace`,
  `wordBreak`, `overflowWrap`) it inherits from its ancestors and does not set itself, so the
  snippet renders standalone. The runtime computes them (nearest ancestor's declared value).
- **inline-styles**: `style={{ … }}` with canonical styles (§8.2), plus `boxSizing:
'border-box'` on every element, keys sorted alphabetically, strings in single
  quotes, numbers bare. A top-level root drops `left`/`top`/`position`.
- **tailwind**: classes in this fixed category order — display; flex direction/wrap;
  align/justify; position + offsets; size (`w`, `h`, `min-*`, `max-*`); padding; margin;
  radius; gap; overflow; border (width, style, colour); background; typography (font size [+
  line height as `text-x/y`], line height, tracking, family, weight, style, transform,
  decoration, align, whitespace); colour; opacity; shadow; filters; transform/rotate; anything
  else as arbitrary properties. Within a category, longhand order as listed in the Tailwind v4
  docs. Values map to utilities through the file's tokens as a Tailwind v4 theme (namespaces
  `--color-*` → `bg-`, `text-`, `border-`, `fill-`, `stroke-`, `outline-`, `ring-`;
  `--spacing-*` → padding/margin/gap/size/inset utilities; `--radius-*` → `rounded-`;
  `--text-*` → font size (`text-sm`, with `/sm` when `lineHeight` equals `--leading-sm`);
  `--font-*` → family; `--font-weight-*` → weight; `--tracking-*`; `--leading-*`;
  `--shadow-*`; `--opacity-*`; `--container-*` → `w-`/`max-w-`): a `var(--token)` value maps to
  that token's utility; a literal equal to a token's value maps to the token's utility
  (e.g. `#F3F3F3` → `bg-input`); spacing values that are multiples of 4 px without a
  matching token map to Tailwind's default scale (`gap-2` = 8 px); everything else becomes an
  arbitrary value (`pb-[14px]`, `text-[#8A8A8A]`, `font-['JetBrains_Mono',system-ui,sans-serif]`)
  or an arbitrary property (`[background-color:var(--color-x)]` when a utility would be
  ambiguous). Keywords: `flex`, `flex-col`, `items-center`, `justify-between`, `shrink-0`,
  `grow`, `relative`, `absolute`, `overflow-hidden`, `rounded-full` (≥ 9999 px), etc.
- **Determinism**: output depends only on the resolved subtree, the tokens and the options;
  style key insertion order and Loro map order never matter (tests shuffle them).

### 8.2 Canonical declared styles (`canonicalStyles`, get_computed_styles default, find_nodes)

From the node's resolved styles: drop `--hidden-*`; numeric values of non-unitless properties
→ `"<n>px"`; numeric-string `fontWeight` → number; text nodes get `whiteSpace: 'pre-wrap'`
when absent; keys sorted alphabetically. Nothing else is rewritten (shorthands stay as stored,
tokens stay `var()`).

### 8.3 Tokens formats

`tokensToCss(tokens, order, 'css' | 'tailwind')`: `:root {` / `@theme {`, one `  name: value;`
line per token in order, `}`, trailing newline. Values verbatim
(numbers printed with `formatCssNumber`).

---

## 9. Screenshots and export

### 9.1 `get_screenshot`

1. The host builds a `RenderJob` (§11.4) for `nodeId`; pages → `invalid_target`.
2. Output scale `s = min(scale, 1568 / max(w, h), sqrt(1_150_000 / (w × h)))` (the Claude
   image limits; `w`,`h` = the node's CSS size; computed by the render page, §4.7); `s < scale`
   adds the "Downscaled…" text block. Minimum output 1×1.
3. Background (JPEG has no alpha): the node's own opaque background if any, else the nearest
   ancestor's background colour (resolved through tokens), else the page background, else
   `#FFFFFF`.
4. The node is rendered **on its own and upright** (its own `rotate` removed; descendants keep
   theirs), at its measured size (so flex-sized nodes keep their layout), with inherited text
   styles applied to the stage wrapper. Off-screen, virtualised or LOD-replaced nodes render the
   same as visible ones. Hidden nodes render (the agent asked for them); hidden descendants do
   not.
5. JPEG quality 90.

### 9.2 `export` image formats

Same render path with `purpose: 'export'` (transparent stage, no background substitution),
output size from the scale string (§6.30), PNG/JPG/WebP/PDF encoding (§4.7).

---

## 10. Agent presence and UI (runtime + ui + server wire + design)

### 10.1 What the user sees (artboards 34, 35, 36 and dark D34, D35)

The design workstream delivered these screens before this contract; their exact measurements
are in `docs/phase4/design-tokens.md` §2 and its requests in `docs/requests/phase4-design.md`.
This section fixes behaviour and data; the look follows the artboards.

- **Inspector header** (`Collaborators`, 35): after the user and the remote people, one agent
  avatar per agent in `EditorState.agents` (local and remote, deduplicated by id): the Avatar
  `agent` variant — a 22 px rounded square (`--radius-md`) in `--color-agent` with a white
  12 px sparkle — with the existing overlap rule (−4 px, 2 px `--color-surface` ring). Tooltip
  "Claude Code (agent)"; remote: "Claude Code (ana's agent)". At most 4 people and 3 agents,
  then `+N`.
- **Canvas** (35): for every artboard in a working set, the label row grows from 14 to 18 px
  (the name stays bottom-aligned, the artboard does not move) and gets a badge right-aligned to
  the artboard's right edge: an 18 px pill, radius `--radius-sm`, `--color-overlay-agent`, a
  10 px sparkle and "<name> is working" (11/500, `--color-on-accent`). Several agents on one
  artboard share one badge: "Claude Code and Cursor are working" ("A, B and C are working").
  Around the artboard: a 2 px `--color-agent-ring` ring just outside it, a `--color-agent-glow`
  glow (`0 0 18px 2px`) and a **sweep** — a 2 px `--color-overlay-agent` stroke fading along the
  perimeter, travelling clockwise one lap every 2.4 s (linear). With
  `prefers-reduced-motion: reduce` there is no sweep and the ring is 1.5 px in full
  `--color-overlay-agent`. Drawn by the canvas overlay from `RemotePresence` entries of `kind:
'agent'` (§10.4); no cursor. Agent writes outside a working set draw nothing.
- **MCP section** (inspector, nothing selected):
  - not connected (34): `Status` "Not connected" (`--color-dot`) and the full-width button
    "Connect your agent";
  - connected (35): "Connected" (`--color-success`); one 32 px row per **connected** agent
    (`McpStatus.agents` with `connected: true`, joined with this file's `EditorState.agents` by
    `presenceId`): agent avatar 22, name 12/500, activity 11 muted — "Editing <artboard name>"
    while it holds a working set in this file (the first one; the name comes from the
    document), otherwise "Idle · <relative time of lastActivityAt>"; then the full-width
    secondary button "Agent settings";
  - off: "Off" (`--color-dot`) and "Connect your agent"; error: "Error"
    (`--color-destructive`, tooltip = the message) and "Connect your agent" (not drawn; the 34
    layout with another status).
    Both buttons open the Connect dialog.
- **Connect dialog** (34; app level, `openDialog({ kind: 'mcp' })` from the MCP section, the
  home card and Preferences; it replaces `editor/chrome/McpDialog.tsx`). Width 480, five
  blocks as drawn:
  1. header: "Connect your agent", close button, description "Let coding agents like Claude
     Code, Cursor and Codex read and edit your files live, through the MCP server built into
     baren.";
  2. server row: "MCP server" with the **Switch** (`setEnabled`); sub line "On · Only apps on
     this computer can connect" / "Off · Agents can't connect" (off: blocks 3 and 4 at 50 %
     opacity and inert);
  3. setup: Segmented **Claude Code | Cursor | Codex | Other** (last choice remembered per
     install in `localStorage`), the segment's label and snippet (§4.13) in a code block with
     **Reveal** (the token shows as `••••••••` + its last 4 characters until revealed) and
     **Copy** (always copies the unmasked snippet; shows a check for 1.5 s); "Other" adds the
     line "Only supports stdio? Use the baren stdio shim instead." with the copyable
     `stdioJson`; below: "Includes your access token. Keep it private." and **Regenerate
     token** (inline confirm "Regenerate? Connected agents will need the new token." →
     `resetToken()`; the snippet updates in place);
  4. "What agents can do": the three capability rows as drawn;
  5. footer: status line — waiting "Waiting for an agent to connect…", connected "Connected ·
     Claude Code[, Cursor]", off "MCP server is off", error "Couldn't start the MCP server" +
     the reason (e.g. "port 29170 is in use"); with `portChanged` the line adds "· new address";
     then "Learn more" (`LINKS.agents`) and "Done".
     The token is fetched with `setup()` when the dialog opens (and after a regenerate), kept only
     in the dialog's component state and dropped when it closes.
- **Home sidebar "Using agents" card** (36): when `McpStatus.agents` is not empty, up to three
  agent rows (most recent first): agent avatar 22 — the `agent` variant with an 8 px
  `--color-success` presence dot when the agent is connected and active in the last 5 min,
  else the `idle` variant — name 12/500 and 11 muted "Active now · <lastFileName>" or "Last
  active <relative time>"; "+N more" beyond three; the secondary button "Agent settings" (no
  chevron) opens the dialog. Otherwise (no agent seen yet, server on or off) the current "Get
  started" content stays, and its button opens the dialog instead of the docs link. Dismissal
  unchanged.
- **Preferences dialog**: a row "MCP server" with the Switch and an "Agent settings…" link
  (opens the dialog).

### 10.2 Runtime state (runtime)

- `AgentPresenceStore` per session (`renderer/agent/presence.ts`): `local: AgentPresence[]`
  (from `agent:presence` for this file) and `remote` (from peers' presence `agents`, each
  tagged with the peer's `clientId`, `userId`, `name`), merged into `EditorState.agents:
readonly EditorAgent[]`. API: `setLocal(agents: readonly AgentPresence[])`,
  `setRemote(peers: readonly PeerPresence[])`, `get(): readonly EditorAgent[]`,
  `subscribe(cb): () => void`, `dispose()`.

```ts
interface EditorAgent {
  id: string // local: presenceId; remote: `${clientId}:${id}`
  name: string
  working: string[] // artboard ids
  activeAt: number | null // local agents only
  origin: 'local' | 'remote'
  via: string | null // remote: the relaying user's display name
}
```

- The canvas receives `[...toRemotePresence(peers), ...agentPresences(agents)]` whenever
  either list changes (`useCollaboration` / the store subscription), where each agent becomes
  `{ userId: id, name, color: '', pageId: null, cursor: null, selection: working, kind:
'agent', badge: name }` (`color` is ignored for agents).
- Local agents are relayed to the server through `PresenceRelay.setAgents(local)` (the
  `agents` field, §10.3) while the file is shared; throttled with the existing 30 Hz presence
  throttle.

### 10.3 Wire presence (server workstream; additive, backwards compatible)

- `ClientPresence` and `Presence` gain `agents: Vec<AgentPresence>` (serde default empty;
  `skip_serializing_if = "Vec::is_empty"` on `Presence`), with
  `AgentPresence { id: String /* ≤ 64 */, name: String /* ≤ 64 */, working: Vec<String> /* ≤
200 ids, each ≤ 256 */ }` and at most 8 agents per client. `validate()` rejects frames over
  the limits (the frame is dropped, as today).
- The room actor copies `agents` from the client's presence into the fan-out `Presence`.
  Nothing is persisted.
- `packages/sync-client/src/protocol.ts`: `ClientPresence.agents?: AgentWirePresence[]`,
  `PeerPresence.agents?: AgentWirePresence[]` (`{ id, name, working }`). Old servers drop the
  field (remote agents are then invisible; everything else works); old clients ignore it.

### 10.4 Canvas overlay (ui workstream, `packages/canvas`)

- `RemotePresence` gains `kind?: 'user' | 'agent'` (default `user`) and `badge?: string` (the
  agent's display name). `OverlayTheme` gains `agent` (`--color-overlay-agent`), `agentRing`
  (`--color-agent-ring`) and `agentGlow` (`--color-agent-glow`), read from the container like
  the other overlay tokens (and re-read on theme changes).
- For agent entries the overlay ignores `color` and `cursor`, keeps only the **top-level**
  artboard ids of `selection` that are on the current page, groups the entries by artboard and
  draws per artboard the ring, glow, sweep and one badge of §10.1 (names joined "A and B" /
  "A, B and C"). Badge, ring and glow are screen-space sizes (not scaled with zoom). User
  entries are unchanged.
- Animation: while at least one agent artboard is visible and reduced motion is off, the
  controller keeps requesting frames (overlay redraw only, no scene work) capped at 30 fps;
  sweep phase = `(performance.now() / 2400) % 1`. It stops as soon as no agent artboard is
  visible. The pan/zoom budgets (measured without agents) must still pass; with one agent
  artboard visible the overlay redraw stays ≤ 1 ms per frame (canvas perf test).

### 10.5 Badge lifecycle

Set: on the first write tool call touching an artboard (§4.4). Renewed: by any later call
touching it. Cleared: `finish_working_on_nodes`, 120 s without a touching call, the session
closing (client disconnect, token reset, MCP turned off, app quit), the artboard being
deleted. Remote collaborators see the same set within ~100 ms (presence relay).

### 10.6 Undo and agent edits

The user's Ctrl+Z / ⌘Z in the host window undoes the last undo step whoever made it (one agent
tool call = one step; `agent:` origins are recorded by the canvas `UndoManager`). A headless
host also has an undo stack, but nobody can reach it; when the user opens the file, the
history starts empty (pre-existing behaviour on reopen). Known limitation: an agent commit that
lands while the user is typing in a text layer joins that typing step (the canvas groups text
editing).

### 10.7 Design deliverables (design workstream; delivered)

PNGs in `design/reference/`, entries in `design/screens.json`:

| #   | Artboard                               | Base screen                                      |
| --- | -------------------------------------- | ------------------------------------------------ |
| 34  | 34 Editor — Connect your agent         | 05 (canvas overview, nothing selected) + dialog  |
| 35  | 35 Editor — Agent working              | 32 (pricing file at 100 %), nothing selected     |
| 36  | 36 Home — Agents connected             | 01 Recents                                       |
| D34 | D34 Editor — Connect your agent (dark) | D06's dark chrome; canvas content equal to light |
| D35 | D35 Editor — Agent working (dark)      | D06's dark chrome; canvas content equal to light |

Tokens (`--color-agent`, `--color-agent-ring`, `--color-agent-glow`, `--color-overlay-agent`),
the Switch and the Avatar `agent`/`idle` variants are design requests 1, 3 and 4, made by ui in
`packages/ui`; the overlay (request 2) is made by ui in `packages/canvas` as §10.4 (data from
§10.2). `design/tokens.dark.css` gets the dark agent values after ui lands the tokens
(design). **Design follow-up:** artboard 34's code block shows a placeholder URL
(`http://127.0.0.1:29980/mcp`) and an older Claude Code line; update it to the §4.13 snippet
(port 29170, `claude mcp add --scope user --transport http \` / `  baren <url> \` /
`  --header "Authorization: Bearer ••••••••7f3a"`) and re-export 34 and D34.

### 10.8 ui visual budget

34, 35, 36, D34 and D35 vs the references at the Phase 3 budget (3 % of pixels, threshold

> 24/255), in browser mode with `?fixture=design&mcp=<state>` (`not-connected` for 34/D34,
> `connected` for 35/D35/36). The editor fixtures are not owned by anyone this phase, so the spec
> builds the scenes from the existing fixture scenes (05 overview for 34; the components scene of
> 32 for 35, picker closed and nothing selected; 01 for 36) and injects agents itself: local
> agent presence through `window.__barenAgent.presence({ fileId, agents })` (mock bridge,
> §4.14), remote agents through `window.__barenEditor.session.agents.setRemote(peers)` (the
> session's `AgentPresenceStore`, §10.2) with `PeerPresence` objects that carry `agents`, and
> reduced motion emulated (`page.emulateMedia({ reducedMotion: 'reduce' })`) so the sweep does
> not make the comparison flaky — the reference shows the sweep frozen at the top-right corner,
> which the ui spec reproduces by setting the overlay's sweep phase through a test-only option
> or by masking the ring's top-right 260 × 180 px region (ui's choice, documented in its request
> file).

---

## 11. Renderer runtime (runtime workstream, `apps/desktop/src/renderer/agent/**`)

### 11.1 Layout

| Module                  | Role                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `boot.tsx`              | entry for `#/agent-host/<fileId>` and `#/agent-render` (called from `main.tsx`)                                              |
| `host/attach.ts`        | `attachAgentHost(session): { dispose(): void }` — announces the host, routes requests for `session.fileId`, applies presence |
| `host/HeadlessHost.tsx` | headless root: `openSession(fileId, noop, { headless: true })`, a hidden canvas, `useCollaboration(session)`                 |
| `host/dispatch.ts`      | request → executor, `AbortController` per id, deadline, error mapping, header (`FileHeader`), `touched`                      |
| `tools/read.ts`         | get_basic_info, get_selection, get_tree_summary, get_children, get_node_info, find_nodes                                     |
| `tools/code.ts`         | get_jsx, get_computed_styles (declared), get_tokens                                                                          |
| `tools/write.ts`        | write_html, create_artboard, create_page, rename_pages, update_styles                                                        |
| `tools/nodes.ts`        | set_text_content, rename_nodes, duplicate_nodes, move_nodes, delete_nodes                                                    |
| `tools/tokens.ts`       | create_tokens, set_tokens                                                                                                    |
| `tools/internal.ts`     | release, flush, artboards_of, render_job, node_image                                                                         |
| `geometry.ts`           | geometry fields (§5), `placeArtboard` (§6.21.1), page switching for headless measuring                                       |
| `presence.ts`           | `AgentPresenceStore`, `agentPresences()`                                                                                     |
| `render/RenderRoot.tsx` | render window page: stage_prepare, stage_styles, stage_clear, fonts_probe, image_transcode                                   |
| `errors.ts`             | `AgentToolError(code, message, data?)`                                                                                       |

### 11.2 Host attach

`attachAgentHost` (called by `openSession` for every session, visible or headless):
`bridge.agent.host({ fileId, state: 'opened', headless })`; subscribe `onRequest` (ignore
requests for other files), `onCancel`, `onPresence` (this file); on dispose `state: 'closed'`
and unsubscribe. Requests that arrive before the canvas mounts wait for
`session.canvas.current` (≤ 2 s, then proceed with `docGeometry`). Every executor reads
through `session.resolver` and writes with `transact(session.doc, fn, { origin:
'agent:<tool>' })` using the schema/editor helpers named in §6 (never raw Loro writes).
Read-only check before writes: `store.self?.role === 'viewer'` → `read_only` (on shared files
wait ≤ 3 s for `store.self`).

### 11.3 Headless host

`#/agent-host/<fileId>` → `boot` → `HeadlessHost`: `openSession(fileId, () => undefined,
{ headless: true })` (no file prefs read or written, no fixtures, `exit` is a no-op; the
thumbnail is still captured on close when changed), mount a canvas with `createCanvas({
container: <1440×900 div at 0,0>, doc, pageId: first page, resolveAsset: resolveCanvasAsset,
keyboard: 'none', undo: true, undoExcludeOriginPrefixes: ['remote', 'sync', 'bench',
'fixture', 'preview', 'derived'] })` and set `session.canvas.current`, run `useCollaboration`
(shared files join the room, so agent edits and presence reach collaborators; assets sync),
`ensureDesignFonts()`. No app shell, no title bar, no `rememberLocation`, no update checks,
no `baren:ready`. The `release` request closes the session (flush + thumbnail) and answers.

### 11.4 `render_job` (host) → `RenderJob`

```ts
interface RenderJob {
  nodeId: string
  stage: { html: string; css: string; assetUrls: string[] } // @baren/html renderStage
  width: number | null
  height: number | null // measured size of the node (null → layout in the stage)
  background: string | null // screenshot compositing colour (§9.1); null for export
  inherited: Record<string, string | number> // INHERITED_TEXT_PROPERTIES from ancestors
  ids: string[] // node ids present in the stage (data-node-id)
}
```

Built from `toRenderSubtree(doc, nodeId, resolver)` and `renderStage(nodes, nodeId, { tokens,
inherited, size, background, assetUrl: (h) => 'baren-asset://' + h })`.

### 11.5 Render root (`#/agent-render`)

- The page sets `<html>` and `<body>` backgrounds to transparent, calls `ensureDesignFonts()`,
  and keeps one stage host element at `position: fixed; left: 0; top: 0` with `all: initial`
  and an open **shadow root** (the app's global CSS cannot reach the stage).
- `stage_prepare`: shadow root ← `<style>` (`job.stage.css`: canvas base rules — every
  `[data-node-id]` `box-sizing: border-box`, text `white-space: pre-wrap`, `img { display:
block }`, groups `position: relative` — the token `:root`→`:host` variables, the inherited
  text styles on the wrapper, the background unless `transparent`) + `job.stage.html`; then
  wait for `document.fonts.ready`, every `<img>` `decode()` and every `assetUrls` entry
  preloaded (5 s cap); measure the root element's border box, compute and apply the effective
  scale (§4.7 step 2), wait two animation frames, answer `{ width, height, scale, outWidth,
outHeight }`.
- `stage_styles`: build the stage (no scaling), read `getComputedStyle` for the requested
  `data-node-id` elements against a reference empty `div` (§6.14), answer, clear.
- `fonts_probe` and `image_transcode` as in §6.17 / §4.7.

### 11.6 Hooks into existing files (exact)

1. `renderer/main.tsx`: before `installTestHooks()`, if `location.hash` starts with
   `#/agent-host/` or equals `#/agent-render`, `import('./agent/boot').then((m) =>
m.boot(root))` and skip the App, the last-route restore and `installUpdates()`.
2. `editor/session/openSession.ts`: `openSession(fileId, exit, options: { headless?: boolean }
= {})`; headless skips `readFilePrefs`/`persistFilePrefs` and fixture seeding; the session
   gets `headless` and `agents` (new `AgentPresenceStore`); after the session object exists:
   `const agentHost = attachAgentHost(session)`; `close()` calls `agentHost.dispose()` first.
3. `editor/session/context.tsx`: `EditorSession` gains `readonly headless: boolean` and
   `readonly agents: AgentPresenceStore`.
4. `editor/session/store.ts`: `EditorState` gains `agents: readonly EditorAgent[]` (initial
   `[]`). It loses `mcpOpen` (the dialog moved to the app level) only after ui has switched
   `McpSection` to `openDialog({ kind: 'mcp' })` and deleted `McpDialog.tsx`; until then the
   field stays.
5. `editor/collab/presence.ts`: `PresenceRelay.setAgents(agents: AgentWirePresence[])`
   (remembered like page/selection and re-sent on `attach`); `toRemotePresence(peers)` keeps
   its signature; new `agentPresences(agents: readonly EditorAgent[]): RemotePresence[]`.
6. `editor/collab/useCollaboration.ts`: on peers or agents change, `canvas.setRemotePresence([
...toRemotePresence(peers), ...agentPresences(agents)])`; feed peers' `agents` into
   `session.agents.setRemote(peers)`; relay local agents with `session.presence.setAgents`.

### 11.7 Performance

As built: §17.2 items 5–7 (document mirror, first-call numbers, lazy executors).

- Nothing agent-related runs in a renderer until a request or presence update arrives
  (`attachAgentHost` only registers listeners). Presence updates are applied at most 10 per
  second.
- Reads use `session.resolver`, `toSubtreeSnapshot`/`toRenderSubtree` of the requested subtree,
  and the session's `LayerTree`/watchers; `toSnapshot` of the whole document is never called
  on a request path. `get_basic_info` on a 20k-node file ≤ 150 ms; `find_nodes` over 50k
  nodes ≤ 500 ms; a 15-line `write_html` ≤ 50 ms renderer time (excluding image decode).

---

## 12. `@baren/html` API (exact; DOM-free; imported by main and renderer)

As built: §17.3 item 7 (additions).

```ts
import type { LoroDoc } from 'loro-crdt'
import type {
  ComponentResolver,
  DesignNode,
  GeometrySource,
  NodeType,
  ResolvedNode,
  StylePatch,
  StyleValue,
  Styles,
  Token,
} from '@baren/schema'

// ---- warnings
export type HtmlWarningCode =
  | 'unsupported-element'
  | 'stylesheet-ignored'
  | 'class-ignored'
  | 'attribute-ignored'
  | 'unknown-property'
  | 'unsupported-property'
  | 'unsafe-value'
  | 'discouraged-property'
  | 'position-converted'
  | 'table-as-flex'
  | 'list-markers-dropped'
  | 'rich-text-flattened'
  | 'block-flow'
  | 'image-unresolved'
  | 'image-generation-unsupported'
  | 'unknown-token'
  | 'clone-not-found'
  | 'clone-children-ignored'
  | 'artboard-size-defaulted'
  | 'depth-limit'
export interface HtmlWarning {
  code: HtmlWarningCode
  message: string
  path?: string
  property?: string
}

// ---- parse (no Loro)
export interface IrBase {
  name: string | null
  styles: StylePatch
  hidden: boolean
  path: string
}
export type IrNode =
  | (IrBase & { kind: 'frame'; children: IrNode[] })
  | (IrBase & { kind: 'text'; text: string })
  | (IrBase & {
      kind: 'image'
      src: string
      alt: string | null
      attrWidth: number | null
      attrHeight: number | null
    })
  | (IrBase & { kind: 'svg'; markup: string }) // sanitised
  | (IrBase & { kind: 'clone'; nodeId: string })
export interface ParsedHtml {
  roots: IrNode[]
  warnings: HtmlWarning[]
  nodeCount: number
}
export function parseHtml(
  html: string,
  opts?: { tokens?: Record<string, Token>; maxNodes?: number /* 5000 */ },
): ParsedHtml
export function collectImageSources(html: string): string[] // <img src> + url() in style attributes, deduped, in order
export function collectCssUrls(styles: Record<string, StyleValue | null>): string[]

// ---- styles
export interface NormalizeResult {
  styles: StylePatch
  warnings: HtmlWarning[]
}
export function normalizeStyles(
  input: string | Record<string, StyleValue | null>,
  ctx?: { tokens?: Record<string, Token>; localVars?: ReadonlySet<string>; path?: string },
): NormalizeResult
export function clearedFamilyKeys(patch: StylePatch, existing: Styles): StylePatch // §7.6 rule 4 clearing for updates
export function partitionStyles(
  patch: StylePatch,
  ctx: { type: NodeType; styles: Styles; isTopLevel: boolean },
): { apply: StylePatch; ignored: string[] }
export function canonicalStyles(node: Pick<DesignNode, 'type' | 'styles'>): Styles // §8.2
export const INHERITED_TEXT_PROPERTIES: readonly string[]
export const KNOWN_CSS_PROPERTIES: ReadonlySet<string>
export function rewriteTokenRefs(value: StyleValue, from: string, to: string): StyleValue
export function tokensHash(tokens: Record<string, Token>): string
export function parseCssColor(value: string): { r: number; g: number; b: number; a: number } | null
export function colorsEqual(a: string, b: string): boolean
export function wildcardMatch(
  pattern: string,
  value: string,
  opts?: { caseInsensitive?: boolean },
): boolean

// ---- apply (Loro; never commits — call inside transact)
export type ResolvedImage =
  | {
      kind: 'raster'
      hash: string
      mime: string
      name: string
      width: number | null
      height: number | null
    }
  | { kind: 'svg'; markup: string; name: string }
export interface ApplyContext {
  fileId: string
  geometry: GeometrySource
  resolver: ComponentResolver
  tokens: Record<string, Token>
  image(src: string): ResolvedImage | { error: string } | null // null = not a known source
  placeArtboard(
    pageId: string,
    size: { width: number; height: number },
  ): { left: number; top: number }
  random?: () => number
}
export interface ApplyTarget {
  mode: 'insert-children' | 'replace'
  targetId: string
}
export interface ApplyResult {
  created: string[]
  parentId: string
  replacedId: string | null
  warnings: HtmlWarning[]
}
export class HtmlApplyError extends Error {
  readonly code: 'node_not_found' | 'invalid_target' | 'instance_content' | 'cycle' | 'too_large'
}
export function applyHtml(
  doc: LoroDoc,
  parsed: ParsedHtml,
  target: ApplyTarget,
  ctx: ApplyContext,
): ApplyResult

// ---- export
export interface JsxOptions {
  format: 'tailwind' | 'inline-styles'
  tokens: Record<string, Token>
  inherited?: Styles
  includeIds?: boolean
  assetUrl?: (hash: string) => string // default baren-asset://<hash>
}
export function toJsx(nodes: Record<string, ResolvedNode>, rootId: string, opts: JsxOptions): string
export function tokensToCss(
  tokens: Record<string, Token>,
  order: readonly string[],
  format: 'css' | 'tailwind',
): string
export interface StageOptions {
  tokens: Record<string, Token>
  inherited?: Styles
  size?: { width: number; height: number } | null
  background?: string | null
  assetUrl?: (hash: string) => string
}
export interface RenderStage {
  html: string
  css: string
  assetUrls: string[]
}
export function renderStage(
  nodes: Record<string, ResolvedNode>,
  rootId: string,
  opts: StageOptions,
): RenderStage
```

Rules: no `document`, `window`, `Element`, `CSSStyleDeclaration` or other DOM globals anywhere
in the package (it is bundled into main, whose TS lib has no DOM); parse5 is the only HTML
parser; the exported schema helpers (`createNode`, `setStyles`, `setStylesAt`, `deleteNode`,
`moveNode`, `serializeClipboard`, `pasteClipboard`, `sanitizeSvgMarkup`, `renderSubtreeHtml`,
`cssPropertyName`, `cssDeclarationValue`, `formatCssNumber`, `normalizeDeg`,
`vectorToSvgMarkup`, `toRenderSubtree`, `getNode`, `getChildIds`, `nodesTree`) are used
instead of re-implementing them. Only the two non-exported rules named in §7.6 rule 3
(`UNITLESS`, `isSafeCssValue`) are copied, with parity tests; `@baren/schema` is not edited
this phase.
`renderStage` builds on `renderSubtreeHtml(nodes, rootId, { tokens, includeIds: true,
assetUrl })` and adds the base CSS, the wrapper with inherited styles and background, the
explicit size, and the root's upright rule.

---

## 13. Safety and performance guardrails

- Cold start: no MCP code before `appReady` (§3.5); smoke numbers stay < 1 s (§4.15).
- Loopback only; token on every request; Host/Origin checks; no CORS; 4 MiB bodies; 1 MB
  HTML; image sources ≤ 20 MB each, 64 MB and 45 s per call; ≤ 5,000 created nodes per call;
  ≤ 32 sessions; ≤ 4 headless hosts; render window single-flight.
- The renderer never gets file-system or network access for agents (main pre-resolves); the
  token reaches the renderer only via `setup()` while the dialog is open.
- Agent-created SVG is always sanitised (`sanitizeSvgMarkup`); CSS values pass the
  `isSafeCssValue` rules (§7.6); `url()`s in stored styles only ever point at
  `baren-asset://`.
- A crashing or hung renderer costs one request (`host_unavailable`/`timeout`), never the
  server: hosts are re-created on the next request.

---

## 14. Test plan

### 14.1 html (vitest, node; `packages/html/tests`)

- **Parser**: one test per mapping row of §7.3 and per text rule of §7.4 (whitespace, `<br>`,
  `<pre>`, UA defaults, rich-text flattening, mixed content in flex vs block), attributes,
  names, limits, and the HTML in `guide.md` (`mobile-status-bar` must parse with zero
  warnings).
- **Normaliser**: a table test per row of §7.6 rule 4 (input → stored keys, plus clearing in
  updates), every policy bucket of rule 5, rem conversion, numbers, unsafe values, unknown
  tokens, url rewriting; `partitionStyles` per rule of §7.7; `canonicalStyles`.
- **Applier** (`createEmptyDoc` + `docGeometry` + a fake asset map): insert-children,
  replace (artboard keeps its position), page target (artboards placed, size defaults),
  clones (real, instance, virtual; styles applied; flex parent in flow), images (raster with
  and without size, svg file, data URIs via the map, unresolved placeholder), invalid targets,
  `instance_content`, cycle, `too_large`; invariants (`checkInvariants` from the schema test
  helpers or an equivalent) after each.
- **HTML corpus** `tests/fixtures/html/*.html` + `*.tree.json` (expected tree: types, names,
  canonical styles, text): at least 12 fixtures written the way `guide.md` tells agents to
  write (card shell then rows, header with nav and SVG icons, a button bar, a list row with
  fixed-width slots, absolute decorative shapes, token `var()`s and `color-mix()`, `<pre>`
  code block, `<x-baren-clone>`, a local file image, phone status bar, a `<p>` with inline
  `<b>`, an artboard-sized page write).
- **Exporters**: `toJsx` golden files for both formats (incl. a code block: given styles + the
  file's tokens → token utility classes in the fixed order, no renderer-only classes), determinism
  (shuffled style keys and token order → identical output), inherited root styles;
  `tokensToCss`; `renderStage` (ids, base CSS, size, background, upright root).
- **Round trip**: `parseHtml(H)` → `applyHtml` → `toJsx(inline-styles)` → test helper
  JSX→HTML → `parseHtml` → `applyHtml` into a second parent → both subtrees have identical
  canonical styles, types, names and text.

### 14.2 runtime

- **vitest (node)** in `renderer/agent/*.test.ts`: tree-summary formatting, geometry fields
  (measured vs declared vs null), `placeArtboard` (empty page, rows, gaps, overlaps,
  determinism), find_nodes matching (wildcards, colour equivalence, token-bound literals,
  composite fragments, text), error mapping, `touched` computation, presence store merging,
  dispatch (deadline, cancel before/after commit).
- **Playwright, browser mode** `tests/visual/phase4-runtime.spec.ts` (mock bridge,
  `window.__barenAgent.dispatch`): every tool of §6 that runs in a host, on a real canvas:
  create_artboard → write_html (several calls) → get_children positions measured → update_styles
  (ignoredStyles) → set_text_content → duplicate_nodes (descendantIdMap valid) → move_nodes
  (affectedParents) → delete_nodes → get_jsx/get_computed_styles/get_tokens/find_nodes; **one
  undo step per call** (`runCommand('edit.undo')` after each write restores the previous
  snapshot exactly); virtual ids become overrides; viewer role → `read_only`; presence update →
  inspector agent avatar and canvas overlay entry.

### 14.3 server

- **vitest (node)** next to the sources: `security.ts` (remote address, Host, Origin incl. DNS
  rebinding `Host: attacker.example`, token, rate limit), config create/repair/rotate, port
  fallback and persistence, display names (map, title, suffixes), recent agents
  (`agents.json` limits and expiry), working-set expiry (fake
  timers), default-file selection, host choice incl. pending opens and handoff ordering,
  correlation/timeout/cancel, KeyedMutex write serialisation (two writes to one file never
  overlap; writes to two files do), asset resolution (temp files, sizes, sniffing, SVG,
  unsupported schemes, budget), snippet generation (JSON/TOML escaping incl. Windows paths),
  result/error formatting, guide splitting (`guide.md` topics present; `server-instructions`
  non-empty).
- **SDK integration (node, no Electron)**: start the HTTP server with a fake router; connect
  `Client` + `StreamableHTTPClientTransport`; `listTools` returns exactly §6's tools; call each
  with fake host answers; 401 without/with a wrong token, 403 for bad Host/Origin, 404 for a
  stale session, 503 when shutting down; two concurrent sessions; DELETE ends a session.
- **stdio shim**: spawn the built shim with `node` against
  the in-process server (scratch userData with `config.json`/`endpoint.json`):
  `initialize`, `tools/list`, one tool call through stdio; app-not-running error path.
- **Rust**: `crates/proto` serde/validation tests for `agents`; a `crates/server` integration
  test: client A sends presence with agents → client B receives them; a client without
  `agents` is unaffected; oversized `agents` frames are dropped.

### 14.4 ui

- `tests/visual/phase4-ui.spec.ts` (browser mode): artboards 34, 35, 36, D34 and D35 vs the
  references (§10.8); behaviour: the segments show the right label and snippet, the token is
  masked until Reveal, Copy writes the unmasked snippet, the Switch calls `setEnabled` and dims
  the setup blocks when off, Regenerate token asks for confirmation then shows the new token,
  the last segment is remembered, the MCP section and the home card follow the `?mcp=` states
  and live `onStatus` changes, agent avatars and badges appear for injected presence and
  disappear when it is cleared, "Agent settings" / "Connect your agent" / the home card button
  open the same dialog.
- `packages/canvas` unit tests for the overlay model with agent entries (grouping per
  artboard, joined names, top-level only, other pages ignored, no cursor, reduced motion → no
  animation frames requested) and an e2e screenshot of an agent badge at two zoom levels; the
  perf preset measures the overlay redraw with one agent artboard visible (≤ 1 ms).

### 14.5 End-to-end (server owns; opt-in `BAREN_MCP_E2E=1`, after `pnpm --filter @baren/desktop build`)

`apps/desktop/tests/mcp/mcp-e2e.spec.ts` (Playwright test runner, `_electron.launch` of the
built app with `--ozone-platform=headless --disable-gpu`, env `BAREN_USER_DATA_DIR=<scratch>`,
`BAREN_MCP=1`, `BAREN_MCP_PORT=0`, `BAREN_EXPORT_DIR=<scratch>`; the harness reads
`<scratch>/mcp/endpoint.json` + `config.json` and connects an SDK `Client`). Nothing is shown,
the user's profile and ports 8787/5173 are never used. One full session:

1. `listTools` = §6; `get_guide` returns the guide; `list_files` (only the Scratchpad/empty).
2. `create_file` → `open_file` (a window opens on the file; `get_basic_info` matches).
3. `create_artboard` (desktop) → 4 × `write_html` (header, hero, a card shell, two rows into the
   card) → `update_styles` (artboard `height: fit-content`, ignoredStyles reported for an inert
   key) → `set_text_content` → `duplicate_nodes` of a row (map used to retitle the copy).
4. `get_screenshot` → a JPEG that decodes, has the artboard's aspect ratio, and a known pixel
   (header background) within 2/255 of its colour.
5. `get_jsx` (inline-styles) → convert to HTML (test helper) → `write_html` into a new
   artboard → `get_tree_summary`/`get_computed_styles` of both equal modulo ids (round trip).
6. The inspector header shows the agent (name from the harness's `clientInfo`, e.g.
   "baren-e2e"); the canvas overlay has a badge entry; `finish_working_on_nodes` clears it.
7. **Undo**: press Ctrl+Z in the window (Playwright keyboard) → the last write disappears
   (`get_children` count) and only that one; Ctrl+Shift+Z brings it back.
8. **Headless path**: `create_file` a second file and `write_html` into it without opening it →
   a hidden host serves it; `get_screenshot` works; then `open_file` it → handoff; the content
   is there in the visible window and in the core (`files:open` snapshot).
9. `export` png@2x and svg of an icon → files exist in `BAREN_EXPORT_DIR` with the reported
   sizes.
10. Token reset via `bridge.mcp.resetToken()` (page evaluate) → the client's next call fails
    with 401; a new client with the new token works.

`apps/desktop/tests/mcp/mcp-collab.spec.ts` (opt-in, also needs `VITE_SERVER_URL` and
`BAREN_E2E_MAIL_DIR` with a scratch `baren-server` on a free port, e.g. 8897): user A
signs into the Electron app (sign-in screen), shares a file to the team (REST + the app's
team pull, or the share popover); peer B is a Node `connectFile` client as user B on the same
file; the agent (connected to A's app) runs `write_html` → B's doc has the nodes within 2 s and
B's presence shows A's peer with `agents: [{ name: 'baren-e2e', working: [<artboard>] }]`;
`finish_working_on_nodes` → B sees the working set empty; B edits the agent's text → the agent's
`get_node_info` returns B's text.

### 14.6 Regression and performance

`pnpm -r typecheck`, `pnpm -r test`, `cargo test --workspace`, clippy/fmt, the existing
Playwright suites, `pnpm --filter @baren/desktop build` + smoke (cold start < 1 s, with and
without `BAREN_MCP=1`; report numbers), and the §11.7 budgets measured once in the e2e run
(log the numbers into STATUS).

---

## 15. Deliberate choices and limits

| Area                                                      | Behaviour                                                                                                                                | Why                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `fileId`                                                  | optional everywhere (defaults to the file in the last-used window)                                                                       | user request                                   |
| Clones                                                    | `<x-baren-clone node-id>` copies a layer and applies the element's styles                                                                | reuse instead of rewriting                     |
| Image sources                                             | absolute paths, `file://`, `baren-file://`, http(s), data URIs, `baren-asset://<hash>`; anything else → placeholder + `image-unresolved` | local-first assets                             |
| AI image generation                                       | not supported (the `image-generation` guide topic explains)                                                                              | no generation service                          |
| Fonts                                                     | bundled Inter/JetBrains Mono + installed fonts; no web fonts                                                                             | offline, identical rendering for collaborators |
| `create_tokens` with an existing name                     | `token_exists` error                                                                                                                     | tokens are keyed by name                       |
| `set_tokens` rename                                       | also rewrites `var()` references                                                                                                         | keeps designs intact                           |
| comment tools, one PDF of several nodes                   | not registered                                                                                                                           | no comments yet                                |
| export: avif, mp4, webm, video, `nodes-with-exports-only` | `unsupported`                                                                                                                            | no encoder / no export settings                |
| export destination                                        | `<Downloads>/baren.dev/<file>/` (paths returned)                                                                                         | —                                              |
| `get_basic_info`                                          | `rootNodeId` = the page id                                                                                                               | no separate root node                          |
| `get_computed_styles`                                     | declared styles by default; `resolved: true` adds browser-computed values                                                                | code export precision                          |
| `get_jsx`                                                 | `includeIds` option (`data-node-id`); no renderer-only root classes                                                                      | the canvas does not set them                   |
| `write_html` result                                       | `summary` and `warnings` next to `createdNodes`                                                                                          | ids of descendants without a second call       |
| `update_styles`                                           | `null`/`""` remove a style                                                                                                               | —                                              |
| Tool errors                                               | `Error [code]: message` text                                                                                                             | stable codes for agents and tests              |

---

## 16. Dependencies and open items

As built: §17.7 (open items after Phase 4).

- No new dependencies: `@modelcontextprotocol/sdk` 1.31 and `zod` 4 (apps/desktop, bundled
  into main), `parse5` (packages/html) are installed. Electron's `net.fetch`, `nativeImage`,
  `capturePage`, off-screen rendering and `printToPDF` cover the rest.
- Open: whether off-screen `printToPDF` works in Electron 44 (PDF export is a SHOULD); whether
  `capturePage` of an off-screen window returns alpha on every platform (else exports get a
  white background on that platform, documented in STATUS); macOS/Windows paths of the stdio
  launch (only Linux is run in this phase).
- Later: comment tools; export settings per node; one PDF of several nodes; agent cursors
  (pointing at what they read); an MCP `undo` tool; multi-window live sync of local files
  (would let two windows host one file).

---

## 17. As built (amendments recorded at integration)

Recorded 2026-10-02 by the integration workstream from `docs/requests/phase4-*.md`. Where an
item below and an earlier section disagree, **this section wins**: it describes the code. Each
item names the section it amends; those sections carry a one-line pointer here.

### 17.1 Main process (server, QA)

1. **§4.1 rate limit.** Only requests that send an `Authorization` header with a **wrong**
   token count towards "30 failures in 60 s → 429". A request without the header still gets
   401 but is not counted: a web page can reach the port without an `Origin` header
   (`<img src="http://127.0.0.1:29170/mcp">`) and would otherwise lock the user's agent out
   for a minute. Tests: `security.test.ts`, `qa-security.spec.ts`.
2. **§4.2 session lifetime.** Besides the 30-minute idle rule, a session whose client held the
   GET stream and then dropped it without reconnecting or sending anything for **60 s** is
   closed (`STREAM_GONE_MS`). A client that quits without `DELETE` (the SDK's
   `client.close()` sends none) would otherwise stay "Connected", with its working badges, for
   up to 30 minutes. Open responses (the GET stream, a long tool call's SSE answer) keep a
   session alive. The agent's display name is taken as soon as `initialize` is answered, once
   per session.
3. **§4.5 hosts.**
   - Requests take a **lease** on a headless host. Pool eviction (LRU), idle release and
     handoff never release a host that is serving a request; a handoff lets reads already on
     their way finish first (at most 10 s).
   - A request to a headless host that misses its deadline makes main **ping** the host
     (`flush`, 2 s). If the ping times out too, the host is destroyed and the next request
     opens the file in a new one (§13: a hung renderer costs one request).
   - `resolveFile` trusts only a **visible** window that has the file open as proof that the
     file exists. A file deleted from Home while a headless host holds it fails writes with
     `file_not_found`, and the host is released.
4. **§4.6 internal tools.** `artboards_of` and `render_job` answer with the file header (so
   `get_screenshot` and `get_computed_styles` with `resolved: true` carry the header
   block); `release` and `flush` do not.
5. **§4.9 invalid arguments.** SDK 1.31's `McpServer` turns schema validation failures into
   tool results (`isError: true`, "Input validation error: …"), not JSON-RPC `InvalidParams`
   errors. Kept as the SDK does it.
6. **§4.12 shim build.** The shim is built by a Vite plugin in `electron.vite.config.ts`
   (`closeBundle` → `src/main/mcp/stdio/build.ts`, esbuild), not as a second
   `rollupOptions.input`: with two inputs Rollup moves the SDK modules that the controller
   chunk also uses into shared chunks, and the copied shim would no longer stand alone. The
   output is still `out/main/mcp-stdio.js`: one CommonJS file, Node built-ins only, no
   `electron`.
7. **§4.12 shim reconnects.** Besides 404 (the app restarted), the shim re-establishes its
   session on a **401** when `config.json` holds a different token (the token was regenerated)
   and on a **network error** when `endpoint.json` names a different URL (the app came back
   on another port). Tests: `shim.test.ts`, `qa-restart.spec.ts`.
8. **§4.8 / §12 html in main.** Main imports `@baren/html/sources` (parse5 only), not the
   package index, which would pull `@baren/schema` and Loro's web glue into the lazy MCP
   chunk.
9. **§3.4 / §6.30 export directory.** `BAREN_EXPORT_DIR` replaces the base
   `<Downloads>/Baren`; files always go into a `<file name>/` subfolder of it.
10. **§3.4 tool timeouts.** `BAREN_MCP_TOOL_TIMEOUT_MS` replaces every deadline except
    `release`, which stays ≤ 5 s.
11. **§6.3 / §6.5 file URLs.** `list_files` and `create_file` return `baren://file/<id>`
    without a page id (main holds no document). Host tools return
    `baren://file/<id>/<pageId>`. Both forms are accepted everywhere; a page in the URL
    becomes the default `pageId` of `get_basic_info`, `create_artboard` and `open_file`.
12. **§6.4 `open_file`.** Main sends `{ pageId?, firstOpen }` to the host's executor
    (`firstOpen` = this call opened the window; `pageId` switches the user's page only then).
    When the window that `open_file` navigated or opened shows the **sign-in screen** (a
    signed-out profile without "Continue offline"), the call fails within ~200 ms with
    `host_unavailable` and a message telling the agent to ask the user to sign in or continue
    offline (before: a 20 s wait). Every other tool still works on the file through a headless
    host, which needs no session. Tests: `server.integration.test.ts`, `helpers.test.ts`.
13. **§4.7 render window (Electron 44, Linux).** `capturePage` of the off-screen window fails
    with `UnknownVizError` for a moment after a resize; main retries briefly and otherwise uses
    the most completely painted `paint` frame of the new size. `webContents.invalidate()` is
    only called once a frame of the new size arrived (repeated invalidations keep the view at
    its old size). A same-size render requests a fresh frame instead of waiting out the paint
    timeout. Alpha is kept (transparent PNG exports are RGBA) and off-screen `printToPDF`
    works, so PDF export is supported (page size = the node's CSS size). Image URLs that
    redirect are followed with `net.request` (at most 3 hops).

### 17.2 Renderer runtime

1. **§5 geometry source.** Layout-dependent values come from a measurement of the node's
   artboard laid out **on its own**: the resolved subtree rendered with the schema's HTML
   exporter into a hidden shadow root with the canvas's rules and the file's tokens, cached
   per artboard until the document changes. Exact declared values (top-level boxes, absolute
   and group children with px offsets and sizes) are read from the styles without layout. The
   canvas's `getNodeFrame` is **not** used: for artboards that are not mounted it silently
   falls back to declared styles, which is wrong for flex children, and the API cannot tell
   the two cases apart. Results are independent of the user's viewport, zoom, virtualisation
   and LOD, and a headless host never switches its canvas's page. Without a DOM (Node tests),
   layout-dependent values are `null`. Known edge cases: an image without a
   size whose bytes are not loaded yet measures 0 × 0; a rotated artboard's children take
   their size from computed styles.
2. **§4.9 all-failed batches.** A batch tool whose every entry fails answers `ok: true` with
   the per-entry errors and changes nothing; main sets `isError` from the body.
3. **Locked layers.** Writes never change a locked layer or anything inside one
   (`invalid_target`, "… is locked. Ask the user to unlock it …"; per entry for batch tools).
   Renaming and duplicating a locked layer are allowed. Reads are unaffected.
4. **Groups.** Layers written into a group become `position: absolute` and every write that
   can change a group's content refits it in the same transaction. `update_styles` on a group
   routes `width`/`height` through `resizeGroup` and reports flex/padding keys as
   `ignoredStyles`.
5. **§11.7 whole-file reads.** `get_basic_info` and `find_nodes` use a plain-object mirror of
   the document (`agent/docIndex.ts`), loaded one artboard per idle slice after an agent's
   first request and kept current from change batches (one re-read per node per batch). Node
   lookups (`resolveRef`) are cached while the document's op count is unchanged.
6. **§11.7 budgets** hold for every call after the first one of a session (QA, 20k-node file,
   client round trip: `get_basic_info` 2.4 / 4.9 ms p50/p95, `write_html` 15 lines 8.2 / 10.9
   ms). The first whole-file read can take longer while the mirror loads (runtime, browser
   mode: `get_basic_info` 20k 180–710 ms, `find_nodes` 50k 300–1,200 ms).
7. **§11.2 lazy executors.** `attachAgentHost` only registers listeners; the dispatcher,
   executors and `@baren/html` (with parse5) are a separate ~300 kB chunk loaded on the
   first request.
8. **§10.2 canvas presence.** A headless host's (never visible) canvas gets no agent entries,
   so the working-edge sweep never animates there.
9. **§10.3 relayed agents** are cut to the server's limits in UTF-8 bytes (names on a
   character boundary), so a long name never gets the whole presence frame dropped.

### 17.3 `@baren/html`

1. **§7.3 flex and grid containers** whose children are elements are frames, even when every
   child is a phrasing element (`<div style="display:flex"><span>Docs</span><span>Pricing</span></div>`
   → a frame with two text layers). Text-only elements without element children (a
   `display: flex` button label) are still text layers.
2. **§7.6 shorthand families** are stored in one canonical form derived from the side values
   (`padding: 8px 8px` → `padding: 8px`; `padding: 1px 2px 1px 2px` → `paddingBlock` +
   `paddingInline`). `clearedFamilyKeys` returns the full patch and keeps the other sides:
   setting `paddingTop` on `padding: 10px` writes `paddingTop`, `paddingInline` and
   `paddingBottom` and removes `padding`.
3. **`/>` on non-void elements** is self-closing (`<x-baren-clone … />` and `<div … />` no
   longer swallow the following siblings).
4. **Containing blocks.** A created frame with absolutely positioned children gets
   `position: relative` (unless it sets a position), and so does an unpositioned, non-top-level
   target frame receiving absolute roots.
5. **Replacing an artboard**: the first root takes the replaced artboard's `left`/`top` and,
   when it sets none, its `width`/`height` (warning `artboard-size-defaulted`). `replace` with
   HTML that creates no layers is refused with `invalid_target`.
6. **§8.1 Tailwind.** Multiples of 4 px map to the default spacing scale up to step 96
   (384 px), arbitrary values beyond. Line heights map only through `--leading-*` /
   `--spacing-*` tokens. Text layers print `whitespace-pre-wrap` only when it is stored. Class
   order is a fixed category order, not the stored-key order.
7. **§12 additions** (backwards compatible): the `@baren/html/sources` subpath,
   `NormalizeContext.image?`, `resolveStyleImages`, `IMAGE_PROPERTIES`, `JsxOptions.topLevel?`,
   `textLayerName`, `MAX_CREATED_NODES`. `ApplyResult.warnings` already includes the parse
   warnings.
8. **Performance.** Parsing and normalising 2,001 layers takes 14–36 ms; writing them into
   Loro is bounded by Loro itself (~5 µs per map write, 140–160 ms for 2,000 nodes in Node),
   so a 2,000-element `write_html` does not fit in 50 ms end to end.

### 17.4 ui and design

1. **§10.8** the visual tests freeze the sweep with a test-only global
   (`globalThis.__barenAgentSweepPhase`; 0 = the head on the artboard's top-right corner).
2. "Agent settings" in the MCP section is an outline button (as drawn in 35).
3. With no running server the dialog shows the snippets with a dotted placeholder token
   (`buildSetup` from `main/mcp/setup.ts`); Copy, Reveal and Regenerate stay disabled.
   `mcp:status` answers from the first frame (`off` / `starting` before the controller loads).
4. The inspector header shows at most 4 people, then at most 3 agents, then one "+N".
5. `design/tokens.dark.css` mirrors the dark agent tokens (integration). Artboards 34/D34
   still show the design's placeholder snippet (port 29980, no `--scope user`); the app shows
   §4.13's (open design follow-up; it costs about 0.2 % of pixels in those comparisons).

### 17.5 Ownership (§1)

Two performance fixes landed outside the Phase 4 ownership table, kept minimal and
behaviour-preserving (QA): `packages/schema` `createNode` appends without counting the
parent's children (creating N children of one parent was O(N²)), and `packages/canvas`
`collectFits` looks up each ancestor's type once per batch. With §17.2 item 5, a 3,600-layer
`write_html` went from 7.8 s to 0.6–0.7 s. The integration workstream also removed the deleted
`McpDialog`'s CSS rules from `editor/Editor.module.css` and re-exported `AgentWirePresence`
from the `@baren/sync-client` root.

### 17.6 Integration fixes

1. **Line height of design content.** Canvas content used to inherit the app chrome's
   `line-height: 16px` (packages/ui `global.css`), so text without its own line height sat in
   a 16 px line box whatever its size: an agent's `<h1 style="font-size: 56px">` overlapped the
   next layer. The document scope (`.ic-root, [data-design-content]` in packages/ui
   `tokens.css` §4) now sets `line-height: normal`, as a browser, the exported HTML and `get_jsx`
   do, and as the inspector's "Auto" already said. The render stage (`@baren/html`
   `renderStage`) and the runtime's measurement (`agent/measure.ts`) use the same default, so
   screenshots and geometry match the canvas. Text with a line height (everything the text tool
   creates, every fixture) is unchanged.
2. **`open_file` on the sign-in screen** fails fast (§17.1 item 12).
3. **Headless canvases** get no agent presence (§17.2 item 8).
4. Main's lazy MCP chunk imports `@baren/html/sources` (§17.1 item 8): 274 kB instead of
   774 kB, no Loro in main's MCP code.

### 17.7 Open items after Phase 4

- Only Linux (headless Ozone, `--disable-gpu`) was run end to end. Off-screen capture on a GPU
  desktop session, macOS and Windows is unproven; the stdio launch through `$APPIMAGE` was
  exercised from the packaged `linux-unpacked` build (see `docs/STATUS.md`), not from an
  AppImage.
- The Cursor and Codex snippet formats and Claude Code's `--scope user` were checked against
  current documentation, not against live clients.
- Not built: agent badges in the layers panel, toasts for agent errors, comment tools,
  one PDF of several nodes, agent cursors, an MCP `undo` tool.
