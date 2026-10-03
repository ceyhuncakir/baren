# Baren — architecture & build contract

A local-first, multiplayer design tool for desktop.
This file is the **contract** every part of the code builds against. It was written before the
parallel build and updated at each integration (Phases 1–4, 2026-10-02) to describe what was
actually built. The per-workstream notes it was reconciled from are kept in `docs/requests/*.md`
(Phase 2: `docs/requests/phase2-*.md`, Phase 3: `docs/requests/phase3-*.md` and the full Phase 3
contract `docs/phase3/contract.md`, Phase 4: `docs/requests/phase4-*.md` and the full Phase 4
contract `docs/phase4/contract.md`); feature status and measured numbers are in
`docs/STATUS.md`.

## Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron 44** + **electron-vite 5** (build) + **electron-builder 26** (packaging) | Chromium on every OS → identical rendering for both collaborators, best DOM/GPU perf. |
| UI | **React 19 + TypeScript 7 (strict)**, **CSS Modules** + `tokens.css` (CSS custom properties), `lucide-react` icons | Designs are DOM/CSS; tokens map 1:1 to CSS variables. |
| Fonts | `@fontsource-variable/inter` (wght + opsz axes), `@fontsource/jetbrains-mono` bundled | Never depend on system fonts — rendering must match on every machine. |
| UI state | `zustand` (UI-only state). Document state lives in Loro, never in React state. | |
| Document / sync | **Loro CRDT** — `loro-crdt` 1.16.4 (WASM) in the renderer, `loro` 1.16.2 crate in Rust. Same release line both sides (checked by fixture tests). | Offline-first, conflict-free merges, movable tree for layers, undo. |
| Canvas | Custom imperative DOM renderer (`packages/canvas`), Canvas 2D overlay for selection/handles/cursors, `rbush` spatial index | No React/VDOM in the canvas hot path. |
| Local backend | **Rust** `crates/core` (Loro + `rusqlite` 0.39 bundled + blake3) exposed to Electron main via **napi-rs 3** (`crates/napi`); a JS fallback core in a worker thread when the addon is missing | Persistence, export, assets, later MCP. |
| Server | **Rust** `crates/server`: `axum` 0.8 + `tokio` + WebSockets + `sqlx` 0.9 (SQLite) + `argon2` + `tracing` | Accounts, teams ("party"), invite links, live rooms. |
| Tests | `vitest`, `cargo test`, `@playwright/test` (visual diff vs the reference PNGs in `design/reference/`) | |
| Package mgmt | **pnpm 10 workspaces** (`node-linker=hoisted`) + **cargo workspace** | |

Version pins with reasons are in `docs/versions.md`. Two deliberate deviations from "latest":
**Vite 7.3.6** (electron-vite 5 does not support Vite 8 yet) and **rusqlite 0.39** (it must share
`libsqlite3-sys` with sqlx 0.9).

## Repository layout

```
apps/desktop/                  Electron app (electron-vite)
  src/main/**                  main process: windows, IPC, core backends, deep links, CSP, smoke mode
  src/main/mcp/**              built-in MCP server (Streamable HTTP, tools, hosts, render window, stdio shim)
  src/preload/**               window.baren (contextBridge), typed IPC channels
  src/renderer/                shell: router, title/menu bar, home/team/auth screens, mock bridge
  src/renderer/editor/**       the editor (layers, inspector, theme, share, collaboration)
  src/renderer/agent/**        MCP tool executors, headless host and render page (agents' renderer side)
  tests/visual/                Playwright: pixel diffs vs design/reference + behaviour tests
  tests/mcp/                   Playwright + MCP SDK: the built app driven by agents (opt-in)
packages/schema/               document model (types + Loro helpers; shared contract)
packages/html/                 write_html importer, style normaliser, get_jsx/screenshot exporters (DOM-free)
packages/ui/                   tokens.css, fonts, components, playground
packages/canvas/               canvas engine (+ bench, e2e and perf tests)
packages/sync-client/          TS client for the server REST API + WebSocket live sync
crates/core/, crates/napi/     Rust core (SQLite store, export, schema mirror) and its napi binding
crates/server/, crates/proto/  sync server and its wire types
design/                        reference PNGs, screens.json, tokens, fixtures, brand
docs/                          versions, STATUS, contract requests
```

The parallel build used per-directory ownership (desktop-shell, screens, editor, foundation,
ui-kit, canvas-engine, sync-server, rust-core). That split still describes who wrote what and is
the natural review boundary, but the repo now builds and tests as one.

## Design source of truth

The reference designs are the PNGs in `design/reference/`, listed in `design/screens.json`
(number, artboard name, size and PNG path for each). Tokens are in `design/tokens.css` (light) and
`design/tokens.dark.css` (dark). The PNGs are renders of the app in its design-fixture mode (26–28:
renders of the server's email templates). **Change them only for an intentional design change:**
`UPDATE_REFERENCES=1 pnpm test:visual` rewrites every reference a visual test uses, and
`node crates/server/scripts/email-preview.mjs <dir>` renders the emails (copy `<dir>/<kind>.png`
over 26–28). Review the new PNGs before committing them.

Brand: the seal in `design/brand/` (app icon, in-app mark, emails). `--color-brand*` (vermilion)
colours primary buttons and brand moments and `--color-link` text links; `--color-selection` (blue)
stays the colour of selection and focus, and `--color-destructive` is a crimson kept apart from the
brand red. Artboards (1440×900 unless noted):

| # | Artboard name | Code |
|---|---|---|
| 01 | 01 Home — Recents | `renderer/home` |
| 02 | 02 Team — Members | `renderer/team` |
| 03 | 03 Team — Settings | `renderer/team` |
| 04 | 04 Editor — Empty file | `renderer/editor` |
| 05 | 05 Editor — Canvas overview | `renderer/editor` |
| 06 | 06 Editor — Selection & inspector | `renderer/editor` |
| 07 | 07 Editor — Theme tokens | `renderer/editor` |
| 08 | 08 Editor — Share popover | `renderer/editor` |
| 09–13 | 09 Menu — File … 13 Menu — Help | `renderer/app` (HTML menu bar, shared by all windows) |
| 14 | 14 Editor — Layers expanded | `renderer/editor` |
| 15 | 15 Editor — Context menu | `renderer/editor` |
| 16 | 16 Editor — Zoom menu | `renderer/editor` |
| 17 | 17 Home — Account menu | `renderer/home` |
| 18–20 | 18 Auth — Sign in, 19 Create account, 20 Verify email | `renderer/auth` |
| 22–23 | 22 Auth — Forgot password, 23 Auth — Reset password | `renderer/auth` |
| 24 | 24 Editor — Image fill | `renderer/editor` |
| 25 | 25 App — Update ready | `renderer/app` (`UpdateToast`) |
| 26–28 | 26 Email — Verification code, 27 Password reset, 28 Team invite (600 wide) | `crates/server/templates` |
| D01, D06, D18 | dark versions of 01, 06 and 18 | `packages/ui` tokens (`tests/visual/dark.spec.ts`) |
| 29–33 | 29 Rotation & groups, 30 Pen tool, 31 Components, 32 Component picker, 33 Drop into frame | `renderer/editor` + `packages/canvas` (see "Phase 3") |

15 was redrawn in Phase 3 (Paste in place, Group selection, Create component).

Product decisions that override the designs: **no billing** — no "Billing" tab and no "Pro" badges;
**no OAuth / social sign-in** — accounts are email + password only (18 and 19 were redrawn without
the Google/GitHub buttons). The user's display name in fixtures is "ceyhun cakir".

Tokens: `packages/ui/src/styles/tokens.css` holds the design tokens (`design/tokens.css`)
unchanged, plus a second section of **derived tokens** (owned by `packages/ui`) for values that
appear literally in the artboards but have no design token: selection tints,
destructive/success/warning colours, control borders, menu/popover/focus shadows, radius 5/10,
the 28 px auth heading, and (Phase 2) the segment/thumb/scrim/handle/checker colours that dark
mode needs. The dark values are in
`:root[data-theme="dark"]`, taken from `design/tokens.dark.css` (see "Dark theme" below).

## Document model (Loro) — `packages/schema`

One `LoroDoc` per design file.

- `doc.getMap("meta")`: `{ name: string, schemaVersion: 1 }`
- `doc.getTree("nodes")`: the layer tree, fractional index enabled (jitter 0). **Only pages are
  roots**; a page's children are artboards (type `frame` with absolute `left/top/width/height` in
  `styles`); deeper nodes are layers. **Only `page` and `frame` nodes have children**; `text`,
  `rect`, `svg`, `image` are leaves. Sibling order = tree child order. Node id = Loro `TreeID` string.
- Each tree node's `data` (LoroMap):
  - `type`: `"page" | "frame" | "text" | "rect" | "svg" | "image"`
  - `name`: string
  - `styles`: **mergeable** LoroMap — camelCase CSS properties → string | number (e.g. `display: "flex"`,
    `gap: "12px"`, `backgroundColor: "var(--color-surface)"`). Every node gets one at creation.
  - `text`: **mergeable** LoroText (type `text` only)
  - `svg`: string markup (type `svg`), `assetId`: blake3 hex (type `image`)
  - `assetName` (optional string): the original file name of the node's image — an image layer's
    source or a frame/rect image fill — shown by the inspector (artboard 24). Old readers ignore it.
  - `locked`, `hidden`: boolean; `background`: string (type `page`)
- Phase 3 adds the node types `group`, `vector` and `instance` (containers: `page`, `frame`,
  `group`), the data keys `componentKey`, `mainId`, `nodeKey`, `overrides`, `vector`, rotation
  as `styles.rotate`, and the root map `components`; see "Phase 3 — canvas tools" below.
- `doc.getMap("tokens")`: key = CSS var name (`"--color-primary"`) → **mergeable** LoroMap
  `{ type, value, description?, order? }`. `order` is the Theme panel position written by the
  editor (Loro map iteration order is not insertion order); snapshots do not expose it.

"Mergeable" means `ensureMergeableMap` / `ensureMergeableText` (Rust: `ensure_mergeable_map` /
`ensure_mergeable_text`), never `setContainer`: two peers that lazily create the same child get the
same container, so their edits merge instead of one fork being lost.

`createEmptyDoc(name)` creates one page, "Page 1", with `background: "#EEEEEE"` (artboard 04).

Snapshot types used by renderers:

```ts
type NodeType = 'page' | 'frame' | 'text' | 'rect' | 'svg' | 'image'
interface DesignNode { id: string; type: NodeType; name: string; parentId: string | null;
  children: string[]; styles: Record<string, string | number>; text?: string; svg?: string;
  assetId?: string; assetName?: string; locked?: boolean; hidden?: boolean; background?: string }
interface Token { type: string; value: string | number; description?: string }
interface DocSnapshot { name: string; pageIds: string[]; nodes: Record<string, DesignNode>;
  tokens: Record<string, Token> }
```

Helpers: `createEmptyDoc`, `loadDoc(bytes | bytes[])`, `exportSnapshot`, `toSnapshot`,
`toSubtreeSnapshot(doc, rootId)` (hydrate one artboard: ~9 ms per 500 nodes, vs ~270 ms for a
whole 20k-node `toSnapshot`), `getNode`, `getChildIds`, `getParentId`, `hasNode`, `createNode`,
`moveNode(doc, id, parentId, index)` (index = **final** position among the new siblings, clamped;
cycles rejected), `deleteNode`, `setStyle`, `setStyles`, `setText`, `setNodeProps`, `setTokens`,
`getTokens`, `setDocName`, `transact`, `subscribeNodes`, `generateBenchDoc`, `SchemaError`, and
the asset helpers (`assetUrlOf`, `assetCssUrl`, `isAssetHash`, `assetRefsInValue`,
`rewriteAssetUrls`, `nodeAssetRefs`, `collectAssetRefs`, `docAssetRefs`, `ACCEPTED_IMAGE_MIMES`,
`MAX_ASSET_BYTES`).
The Rust core mirrors this in `baren_core::schema` (same decoding rules; parity fixtures in
`crates/core/tests/fixtures`).

### Commit semantics, events and undo

- Every mutating helper commits immediately unless it runs inside `transact(doc, fn, { origin })`.
  A transaction is one commit = one event batch = one undo step = one sync update. Nested
  `transact` calls join the outermost one. Writing an unchanged value writes no op.
- `subscribeNodes` delivers `{ by: 'local'|'import'|'checkout', origin, changes, tokens, meta }`:
  `created`/`moved`/`deleted` first, in order; then `styles`/`text`/`props` deduplicated per node.
  Deleting a node emits one `deleted` for that node only.
- Undo is Loro's `UndoManager`. Origins: the canvas commits `canvas:*` (`move`, `resize`, `reorder`,
  `create`, `text`, `delete`, `duplicate`, `nudge`, and in Phase 3 `reparent`, `rotate`, `pen`,
  `vector`); the editor commits `editor:*` (`inspector`, `layers`, `pages`, `theme`, `clipboard`,
  `menu`, `insert`, and in Phase 3 `group`, `ungroup`, `component`, `detach`, `reset-overrides`).
  Excluded from undo: origins starting with `remote`, `sync`, `bench`, `fixture`, `preview`,
  `derived` (post-layout group refits, Phase 3). Inspector scrubs and colour drags commit live
  `preview:*` changes, then one undoable `editor:*` commit.
- **Undoing a delete re-creates the node under a new TreeID** (Loro behaviour). Nothing may assume
  ids survive undo/redo of a delete.
- Hidden paints are stored as `--hidden-<property>` style keys (e.g. `--hidden-backgroundColor`);
  exporters may drop `--hidden-*` keys.

### Rendering conventions (canvas and HTML export agree)

Every node `box-sizing: border-box`; text nodes `white-space: pre-wrap`; numeric style values are
`px` except React's unitless list (`opacity`, `lineHeight`, `fontWeight`, `zIndex`, `flex*`, …);
top-level nodes are placed at `styles.left/top` in page space and are `position: relative` for
their children; images `display: block`; SVG markup is allowlist-sanitised (no scripts, `on*`,
`<style>`, `<foreignObject>`, `<a>`, external `href`/`url()`). Documents say `fontFamily: 'Inter'`;
the editor registers the bundled Inter files under that family name (`editor/lib/fonts.ts`).

## Desktop bridge — `window.baren` (preload, contextBridge)

```ts
interface FileMeta { id: string; name: string; createdAt: number; updatedAt: number;
  archived: boolean; teamId: string | null; remoteId: string | null }
interface BarenBridge {
  window: { minimize(): void; toggleMaximize(): void; close(): void;
            isMaximized(): Promise<boolean>; onMaximizedChange(cb: (v: boolean) => void): () => void }
  files: { list(): Promise<FileMeta[]>; create(name: string): Promise<FileMeta>;
           rename(id: string, name: string): Promise<void>; archive(id: string, archived: boolean): Promise<void>;
           remove(id: string): Promise<void>; open(id: string): Promise<Uint8Array /* Loro snapshot */>;
           applyUpdate(id: string, update: Uint8Array): Promise<void>;
           setThumbnail(id: string, png: Uint8Array): Promise<void>; getThumbnail(id: string): Promise<Uint8Array | null>;
           import(snapshot: Uint8Array, name: string | null): Promise<FileMeta>;      // team file → local copy
           setRemote(id: string, teamId: string | null, remoteId: string | null): Promise<void> }
  assets: { put(bytes: Uint8Array, mime: string): Promise<string>; get(hash: string): Promise<Uint8Array | null> }
  export: { html(fileId: string, nodeId: string): Promise<string>; json(fileId: string): Promise<string> }
  auth:   { getToken(): Promise<string | null>; setToken(token: string | null): Promise<void> }  // safeStorage
  shell:  { openExternal(url: string): Promise<void> }   // http(s) only
  onDeepLink(cb: (url: string) => void): () => void   // baren://invite/<token>
  app: { newWindow(): void; quit(): void; reload(): void; forceReload(): void; toggleDevTools(): void;
         toggleFullScreen(): void; checkForUpdates(): Promise<void>; version(): Promise<string> }
  theme: { initial: ResolvedTheme; preference(): Promise<ThemePreference>;
           setPreference(p: ThemePreference): Promise<void>; onChange(cb: (t: ResolvedTheme) => void): () => void }
  updates: { status(): Promise<UpdateStatus>; check(): Promise<UpdateStatus>; install(): void;
             onStatus(cb: (s: UpdateStatus) => void): () => void }
  clipboard: { write(c: { text?: string; html?: string; baren?: string; png?: Uint8Array }): Promise<void>
               read(): Promise<{ text: string | null; html: string | null; baren: string | null;
                                 svg: string | null; images: { mime: string; bytes: Uint8Array }[] }> }  // Phase 3
  platform: 'linux' | 'darwin' | 'win32'
}
type ThemePreference = 'light' | 'dark' | 'system'; type ResolvedTheme = 'light' | 'dark'
interface UpdateStatus { state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready'
  | 'none' | 'error'; version?: string; progress?: number /* integer percent */; error?: string }
```

Theme and updates are described in "Phase 2" below.

- `window.baren` is declared optional: it is absent in a plain browser, where
  `renderer/lib/mockBridge.ts` (in-memory, complete) is used. The preload exposes the complete
  bridge or nothing. Bridge errors are plain `Error`s with the main-process message.
- Two DOM events connect preload and renderer without widening the bridge:
  `baren:ready` (renderer → main: first screen interactive; the cold-start metric) and
  `baren:command` (`CustomEvent<string>`, macOS native menu → `runCommand`; also
  `app.checkForUpdates`, so a check started from the native menu shows the same feedback card).
- Main process: the renderer is served from the privileged **`app://renderer/`** scheme (needed for
  `loro-crdt/bundler`'s async wasm fetch) with a production CSP: `script-src 'self'
  'wasm-unsafe-eval'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob: baren-asset: <server>`,
  `media-src 'self' data: blob: baren-asset:`, `connect-src 'self' baren-asset: <server http + ws
  origins from VITE_SERVER_URL at build time>`. A second privileged scheme, **`baren-asset://<hash>`**,
  serves image bytes from the local core (see "Images").
  Sandbox + context isolation; only the app's own top frame may call IPC; every IPC argument is
  validated. On Linux/Windows the main process owns the app shortcuts (Ctrl+Shift+N, Ctrl+Q,
  Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I, F11, Ctrl+M, Ctrl+W); macOS uses a native menu.
- **Core backends** (`src/main/core`): the Rust addon `crates/napi/baren-core.<platform>-<arch>.node`
  exports `CoreHandle(dataDir)` with `listFiles, createFile, renameFile, archiveFile, removeFile,
  openFile, applyUpdate, setThumbnail, getThumbnail, putAsset, getAsset, exportHtml, exportJson,
  importFile, setFileRemote, close` plus (Phase 2) `getAssetFile(hash) → { bytes, mime } | null`
  (what `baren-asset://` serves), `getAssetInfo(hash) → { mime, size, width, height } | null`,
  `exportHtml(fileId, nodeId, options?)` and `exportJson(fileId, { embedAssets? })` (async on the
  libuv pool; errors start with a stable `[code]`; one owner per database via an exclusive lock;
  `putAsset` stores the type sniffed from the bytes when given a generic mime). When the addon is
  missing or incomplete, a JS core with the same operations runs in a worker thread
  (`userData/core-js`, no migration to the native `userData/core`; it keeps each asset's mime in a
  `.json` sidecar). `BAREN_CORE=native|js` forces one; `BAREN_SMOKE=1` runs the headless
  startup check (hidden window, throwaway profile; it also round-trips an `baren-asset://`
  image). All runtime switches are listed in `src/main/startup/flags.ts`.

### Renderer-wide shared modules

- `renderer/lib/bridge.ts` — `bridge` (real or mock) and `isMockBridge`.
- `renderer/lib/commands.ts` — command registry so the HTML menu bar can drive the editor:
  `registerCommand(id, handler): () => void` (stacked: latest wins), `runCommand(id): boolean`,
  `useCommandEnabled(id)`, `isCommandId`. Ids: `edit.undo edit.redo edit.cut edit.copy edit.paste
  edit.delete edit.selectAll` (Phase 3: `edit.pasteInPlace edit.duplicate object.group
  object.ungroup object.createComponent object.detachInstance object.resetOverrides
  object.goToMainComponent`), `view.zoomIn view.zoomOut view.zoomToFit view.zoom100`,
  `help.documentation help.videoTutorials help.releaseNotes help.discord help.slack help.reddit
  help.twitter`. The shell binds Ctrl+Z/Shift+Z/Y/X/C/V/A, Delete and Backspace once and runs the
  registered command; the editor registers handlers instead of binding those keys.
- `renderer/editor/index.tsx` — `EditorScreen({ fileId, onExit })`, rendered below the shared 36 px
  title bar (it draws no title or menu bar of its own).
- Server URL: `import.meta.env.VITE_SERVER_URL ?? 'http://127.0.0.1:8787'`; `@baren/sync-client/api`
  (no Loro) for REST at startup, `@baren/sync-client` for `connectFile`.
- Routes are hash routes (`#/recents`, `#/files`, `#/archive`, `#/team/members`, `#/team/settings`,
  `#/auth/sign-in|register|verify|forgot|reset`, `#/invite/<token>`, `#/file/<id>`) because
  `app://` has no SPA fallback. `#/auth/reset` without a pending reset redirects to `#/auth/forgot`.
  `?fixture=design` (browser only) swaps in fixture data and an in-memory fake server so every
  screen renders without a server — this is how the visual tests run. It also takes
  `&theme=light|dark|system` (default `light` in fixture mode), `&updates=<UpdateState>` (static
  update status, e.g. `ready` for 25) and `&editorScene=theme|image|rotation|pen|components|picker|drop`
  (editor fixtures for 07, 24 and 29–33). `?editorTestHook=1` (browser only, no fixture data)
  exposes `window.__barenEditor` for the two-client tests against a real server.
- Styles: `import '@baren/ui/styles.css'` once at the root (tokens + fonts + base reset).

### Team files and collaboration

A file is local until it is shared. **Share** (the editor's share popover: Invite or Copy link)
uploads the full snapshot with `POST /api/teams/:id/files` and links the local file with
`files.setRemote`. Team members' Recents/Files pull team files they do not have yet
(`GET /api/teams/:id/files` → `GET /api/files/:id/snapshot` → `files.import` → `files.setRemote`).
Both copies share the Loro history, so live sync only exchanges new ops. While a linked file is open
the editor runs `connectFile` (remote edits arrive as Loro imports; local commits are sent as
updates; presence drives cursors, selections, gesture ghosts and avatars).

## Server API (`crates/server`, default `http://127.0.0.1:8787`)

REST, JSON, `Authorization: Bearer <token>`. Errors are always `{ error: { code, message } }` with
stable codes (`invalid_credentials`, `email_not_verified`, `email_taken`, `invalid_code`,
`code_expired`, `too_many_attempts`, `rate_limited`, `last_admin`, `weak_password`,
`current_password_required`, `invite_has_no_email`, `hash_mismatch`, `asset_too_large`,
`unsupported_media_type`, …). Phase 2 endpoints (password reset, providers, assets, invite
re-send, update feed) are listed in "Server additions" below.

- `POST /api/auth/register {name,email,password}` → `{ userId, needsVerification: true }` (the code is
  emailed; with `MAIL_TRANSPORT=log` it is printed in the server log)
- `POST /api/auth/verify {email, code}` → `{ token, user }` · `POST /api/auth/login {email,password}` → `{ token, user }`
- `POST /api/auth/resend {email}` (30 s cooldown) · `POST /api/auth/logout`
- `GET /api/me` → `{ user, teams }` · `GET/POST /api/teams` · `PATCH /api/teams/:id {name?, fileAccess?}` · `DELETE /api/teams/:id` (admin)
- `Team = { id, name, role, fileAccess: 'members'|'link', memberCount, createdAt }`; registration creates "<first name>'s Team"
- `GET /api/teams/:id/members` → `Member = { userId, name, email, role, joinedAt, lastSeenAt, online }` ·
  `PATCH/DELETE /api/teams/:id/members/:userId` (roles `admin | editor | viewer`)
- `POST /api/teams/:id/invites {role, email?, maxUses?, expiresInDays? (default 14)}` → `{ id, token, url }` ·
  `GET /api/teams/:id/invites` · `GET /api/invites/:token` (preview; 404/410 when invalid) ·
  `POST /api/invites/:token/accept` (idempotent) · `DELETE /api/invites/:id`
- `GET /api/teams/:id/files` · `POST /api/teams/:id/files {name, snapshot? (base64 Loro)}` ·
  `PATCH /api/files/:id {name?, archived?}` · `DELETE /api/files/:id` · `GET /api/files/:id/snapshot` (binary).
  The server mirrors the live document's `meta.name` into the file list.
- `GET /i/:token` → small HTML page with an "Open in Baren" button → `baren://invite/<token>`

Live sync: `GET /ws/files/:id?token=…` (WebSocket). Binary frames, first byte = message type:

- `0x01` Loro update (both ways; the server imports, fans out to other clients, appends to SQLite).
- `0x02` sync request, payload = encoded version vector — **both ways**. The client sends it when the
  socket opens and every 25 s (heartbeat + anti-entropy); the server answers `0x03`. On join the
  server sends its own `0x02`; the client answers `0x01` with what the server lacks (offline edits).
- `0x03` updates since that version (server → client; empty = already in sync).

Text frames are presence JSON, never persisted. Client → server: `{ pageId, cursor: {x,y} | null,
selection: string[], transient?: { kind: 'move'|'resize', nodes: {id, rect:{x,y,width,height}}[] } | null }`
(world coordinates, ≤ 30 Hz). Server → client messages carry `type`: `welcome {clientId, userId,
name, color, role}`, `presence` (the client fields + `clientId, userId, name, color`, identity filled
in by the server), `leave {clientId, userId}`, `error {code, message}` (e.g. `read_only` for viewers).
Close codes: `4401`/`4403`/`4404` terminal (bad token / no access / no file); `4400`, `4408`, `4429`,
`4500`, `1012` retryable. The server keeps one `LoroDoc` per open room in its own task,
group-commits updates to SQLite and compacts snapshots periodically.

## Performance targets (CI-enforced where possible)

- Pan/zoom ≥ 120 fps on a 20k-node doc; ≥ 60 fps on 50k nodes (virtualize off-screen artboards, bitmap
  stand-ins at low zoom, transform-only updates during gestures).
- Drag/resize: visual update within the same frame; commit to Loro on gesture end (throttle remote to 30 Hz).
- Cold start to Recents < 1 s. Remote edit visible to collaborator < 100 ms (same region).
- Layer tree and file grid virtualized (`@tanstack/react-virtual`).

Measured results are recorded in `docs/STATUS.md`.

---

## Phase 2 — email, password reset, dark theme, auto-update, images

Contract added 2026-10-02, built by six parallel workstreams and integrated the same day; this
section describes what was built. Everything above still holds.

### Design additions

Only the **design** workstream changed the reference designs: it added the artboards below and
made one edit to existing ones — **18 Auth — Sign in** and **19 Auth — Create account** lost the
Google/GitHub buttons and the "or with email" divider (**no OAuth — email + password only**).
Nothing else in 01–21 changed. All are exported to `design/reference/` and listed in
`design/screens.json` (31 entries):

| # | Artboard | Built in |
|---|---|---|
| 22 | 22 Auth — Forgot password | `renderer/auth/ForgotScreen.tsx` |
| 23 | 23 Auth — Reset password | `renderer/auth/ResetScreen.tsx` |
| 24 | 24 Editor — Image fill | `renderer/editor/inspector/sections/ImageSections.tsx` |
| 25 | 25 App — Update ready | `renderer/app/UpdateToast.tsx` |
| 26 | 26 Email — Verification code (600 × 588) | `crates/server/templates/verification_code.*` |
| 27 | 27 Email — Password reset (600 × 612) | `crates/server/templates/password_reset.*` |
| 28 | 28 Email — Team invite (600 × 710) | `crates/server/templates/team_invite.*` |
| D01 | D01 Home — Recents (dark) | `packages/ui` dark tokens |
| D06 | D06 Editor — Selection & inspector (dark) | `packages/ui` dark tokens |
| D18 | D18 Auth — Sign in (dark) | `packages/ui` dark tokens |

The dark artboards use literal hex values; `design/tokens.dark.css` maps them to token names.

### Dark theme

- `<html data-theme="light|dark">`. `packages/ui` tokens: light values on `:root`, dark overrides on
  `:root[data-theme="dark"]` (with `color-scheme: dark`). The same dark block also applies under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`, so the first frame is already
  dark before the renderer sets `data-theme` (main keeps `nativeTheme.themeSource` equal to the
  preference). Every colour in app chrome comes from a token; `tokens.test.ts` fails on literal
  colours in any stylesheet outside tokens.css, except design content (colour-picker spectra).
  The auth screens' artwork (`auth/assets/shell-background.webp`) keeps its colours in both themes.
- Core dark values: background `#1A1A1A`, surface `#202020`, canvas `#141414`, muted `#2A2A2A`,
  input `#262626`, border `#2E2E2E`, foreground `#EDEDED`, foreground-muted `#A0A0A0`,
  foreground-subtle `#6B6B6B`, primary `#F2F2F2`, primary-foreground `#111111`, selection `#3B8CFF`,
  avatar `#F04E1E`. Derived dark values are in `design/tokens.dark.css`. Every derived token added
  for dark mode has a light value equal to what light mode rendered before, e.g.
  `--color-segment-active`, `--color-thumb`, `--color-on-accent`, `--color-glyph-muted`,
  `--color-scrim(-subtle)`, `--color-checker(-alt)`, `--color-handle`, `--color-scrollbar(-hover)`,
  `--shadow-toast`, `--shadow-swatch(-base)`, `--shadow-identity`.
- Preference `'light' | 'dark' | 'system'`, persisted by main in `<userData>/theme.json` and applied
  with `nativeTheme.themeSource`. `theme.initial` reaches the preload through
  `webPreferences.additionalArguments` (`--baren-theme=dark`; no IPC on the cold-start path; a
  reload asks main synchronously). The window `backgroundColor` follows the resolved theme
  (`#F7F7F7` / `#202020`, equal to `--color-surface`). `theme.onChange` fires in every window on a
  real light ↔ dark switch. The renderer's `installTheme()` (first thing in `main.tsx`) sets
  `data-theme` before React renders; the Account menu and Preferences drive `setPreference`.
- **Design content never changes with the app theme.** The light token set is re-declared on
  `.ic-root` (the canvas content root) and `[data-design-content]` (any other element that renders
  design content, e.g. the off-screen thumbnail/PNG renderer), with `color-scheme: light` and
  `color: #1A1A1A`; the canvas sets a document's own tokens inline on `.ic-root`, so they win.
- **Canvas chrome tokens** live on `:root` only: `--color-canvas-ground` (the default page
  background `#EEEEEE` is drawn with the app's canvas colour; any other page background is document
  data) and `--color-overlay-selection|-label|-label-active|-handle|-snap|-marquee`, which the Canvas
  2D overlay reads from its container and re-reads when `<html>`'s `data-theme` changes.

### Images

- Asset bytes live in the core (`assets.put/get`, blake3). Main serves **`baren-asset://<hash>`**
  (64 lowercase hex; query strings ignored): the stored mime (`image/*`, `video/*`, `audio/*`,
  `font/*`, else `application/octet-stream`), `Cache-Control: public, max-age=31536000, immutable`,
  `ETag`, byte ranges, HEAD, `Access-Control-Allow-Origin: *` (LOD thumbnails draw images into
  canvases with `crossOrigin`); unknown hash → 404 (`no-store`), core unavailable → 503.
  `renderer/lib/assets.ts` gives `baren-asset://` URLs in Electron and cached blob URLs in browser
  mode (`assetUrl`, `loadAssetUrl`, `resolveCanvasAsset`, `putAsset`, `getAssetBytes`,
  `drawableAssetUrls`, `sniffImageMime`, …). The canvas engine stays bridge-agnostic: it takes an
  asset resolver, draws a neutral placeholder (`#E3E3E3`, document content) while an asset is
  missing, and re-renders on `CanvasController.reloadAssets(ids)`.
- Document representation:
  - Image layer: `type: 'image'`, `assetId`, optional `assetName`, styles `width/height` +
    `objectFit` (`cover | contain | fill | none`) + optional `objectPosition`.
  - Image fill on a `frame`/`rect`: `backgroundImage: 'url("baren-asset://<hash>")'` with
    Fill = `backgroundSize: cover`, Fit = `contain`, Crop = `"<w>px <h>px"` + `no-repeat` (the cover
    size when switching), Tile = `"<natural w>px <natural h>px"` + `repeat` + `left top`.
    **Fill opacity** is encoded in the value itself:
    `-webkit-cross-fade(url("baren-asset://<hash>"), url("<1×1 transparent GIF>"), <100 − opacity>%)`
    (Chromium/Safari render it; Firefox ignores it in exported HTML). 100 % is the plain `url(…)`.
- HTML export (Rust core) inlines image layers and fills as data URIs (or links them with a given
  URL prefix), drops `--hidden-*` paints and adds intrinsic `width`/`height` to `<img>` without a
  set size; it does not write an `assets/` folder yet. `exportJson(fileId, { embedAssets: true })`
  adds `assets: { <hash>: data URI }`.
- Insert: tool-rail image button (file picker, several files), drag-and-drop onto the canvas (into
  the artboard under the pointer — flex flow or absolute — else the page), paste (every clipboard
  image, and SVG markup). Accepted: png, jpeg, webp, gif, avif (≤ 20 MB); SVG files become
  sanitised `svg` layers. One insert = one undo step (`editor:insert`).
- Collaboration (`editor/collab/assetSync.ts`): an image referenced locally is uploaded
  (`api.uploadAsset`, after `hasAsset`) as soon as the reference is made — the Loro update streams
  at the same time; a reference arriving from a peer whose bytes are missing is downloaded
  (`api.downloadAsset`, retried with backoff while the uploader is still sending), `assets.put`
  locally, and the canvas reloads it. Sharing a file or opening a team file reconciles every
  reference. Browser mode hashes with blake3 too, so it can upload to a real server.

### Server additions

- **No OAuth / social sign-in.** Accounts are email + password only.
- `GET /api/auth/providers` → `{ email: boolean }`: true only with `MAIL_TRANSPORT=smtp`. The app
  uses it for copy ("check your email" vs "ask the server admin for your code").
- **Password reset:** `POST /api/auth/password/forgot {email}` → 204 always (6-digit code, stored
  hashed, 10 min, 5 attempts; 30 s cooldown; 5 requests per address per 10 min → 429) ·
  `POST /api/auth/password/reset {email, code, password}` → `{ token, user }` (single use; signs out
  **every** session of the account, marks the email verified) ·
  `POST /api/auth/password/change {currentPassword, newPassword}` (authenticated; `currentPassword`
  is required in practice → `400 current_password_required`, a wrong one is
  `400 invalid_credentials`, not 401; keeps the calling session, signs out the others). Revoked
  sessions' live WebSockets are closed with **4401**, also on logout.
- **Email:** `MAIL_TRANSPORT = log | file:<dir> | smtp` (default `smtp` when `SMTP_URL` is set, else
  `log`); `SMTP_URL` (`smtps://user:pass@host:465` implicit TLS, or `smtp://user:pass@host:587?tls=required`
  STARTTLS; any provider), `MAIL_FROM` (required with SMTP), `MAIL_MAX_ATTEMPTS` (5),
  `MAIL_RETRY_BASE_MS` (2000). Delivery is queued off the request path with retries (exponential
  backoff + jitter; a 5xx is final) and flushed on shutdown; logs mask recipients and never contain
  codes or links. `file:<dir>` writes `<ms>-<seq>-<kind>.eml` plus a `.json` sidecar (`{ kind, to,
  subject, code, url, text, html, … }`, written last) — the e2e tests read codes from it. Emails:
  verification code, password-reset code, team invite (when an invite has `email`; 30 per sender per
  hour). HTML (email-safe tables, inline styles, light only) + plain text, templates in
  `crates/server/templates/` (prettier-ignored).
- **Invites:** `POST /api/invites/:id/resend` (admins or the invite's creator; one per minute) →
  `{ id, token, url }`. It **rotates the link** (only token hashes are stored): the old link stops
  working. `invite_has_no_email` (400), `invite_revoked|invite_expired|invite_used_up` (410).
- **Assets:** `PUT /api/files/:id/assets/:hash` (≤ 20 MB → 413, blake3 must match → 400
  `hash_mismatch`, png/jpeg/webp/gif/avif sniffed from the bytes → else 415; editors and admins) ·
  `GET`/`HEAD` same path (any member, including link viewers; `Cache-Control: public,
  max-age=31536000, immutable`, `ETag: "<hash>"`). Bytes are stored once on disk in `ASSETS_DIR`
  (default `<db file stem>-assets` next to the database), content-addressed; SQLite records
  `assets(hash, mime, size)` and `file_assets(file_id, hash)`; knowing a hash never grants access;
  unreferenced bytes are swept after 24 h.
- `@baren/sync-client/api` gained **top-level** `ApiClient` methods: `providers()`,
  `forgotPassword(email)`, `resetPassword(email, code, password) → AuthResponse`,
  `changePassword({ currentPassword?, newPassword })`, `resendInvite(inviteId) → CreateInviteResponse`,
  `uploadAsset(fileId, hash, bytes, mime) → { hash, mime, size }`,
  `downloadAsset(fileId, hash) → { bytes, mime } | null` (null on 404), `hasAsset(fileId, hash)`.
- **Update feed:** `GET`/`HEAD /updates/*` served from `UPDATES_DIR` (404 when unset): single and
  multiple byte ranges (`multipart/byteranges`, as electron-updater's differential download uses),
  `If-Range`, `ETag`/`Last-Modified`, `latest-linux.yml` with `Cache-Control: no-cache`; no
  traversal, hidden files or symlink escapes.

### Auto-update

- `electron-updater` (generic provider), loaded lazily on the first check (no cold-start cost).
  Feed: `BAREN_UPDATE_URL` (run time) › `VITE_UPDATE_URL` › `<VITE_SERVER_URL>/updates/` ›
  `http://127.0.0.1:8787/updates/` (build time), always a directory URL. Checks 10 s after start
  and every 4 h; downloads in the background. `UpdateStatus.progress` is an integer percent (only
  while `downloading`); `version` is kept on `error` when known. `check()` resolves when the check
  itself ends; concurrent calls share one check. `app.checkForUpdates()` = `updates.check()`.
- Runs only in packaged builds installed as **AppImage** (`$APPIMAGE`; replaces its own file, also
  installs on a normal quit) or **deb/rpm** (electron-builder's `resources/package-type`; the system
  package manager runs through `pkexec`, so the user sees a password prompt, and only after
  clicking "Restart to update" — never on a plain quit). Everywhere else the state is `disabled`:
  dev builds, smoke runs, `linux-unpacked`, browser mode — unless `BAREN_FORCE_UPDATES=1`.
  `install()` flushes window state, closes the core database and releases the single-instance
  lock first, and takes them back if the install does not happen.
- Renderer: the artboard-25 card shows whenever an update is `ready` (Restart → `install()`,
  Later → hidden until the next launch); Help gets a dot and "Restart to Update (<version>)…".
  Help → "Check for Updates…" reports checking / progress / up to date / error / disabled; background
  checks are never announced except `ready`. The mock bridge simulates states (`?updates=ready`).
- `pnpm release:linux [<version>|major|minor|patch] [--no-save] [--targets AppImage,deb,rpm]
  [--skip-native] [--out <dir>] [--feed <url>] [--dry-run]` (`scripts/release.mjs`, the root
  `package.json` script) builds the native core, bundles with the feed URL baked in, and runs
  electron-builder (`--publish never`; AppImage first) into `apps/desktop/release/<version>/` with
  `latest-linux.yml`. With `RELEASE_TARGET=user@host:/path/` it rsyncs the packages, then
  `latest-linux.yml` last, to the server's `UPDATES_DIR`.

### Phase 2 tests

- `apps/desktop/tests/visual/screens.spec.ts`: 22, 23, 25 and the redrawn 18/19 vs the references,
  plus behaviour (forgot → reset, updates card/menu, theme switch, change password, invites).
- `apps/desktop/tests/visual/editor.spec.ts`: 24 vs its reference plus image insert/fill behaviour.
- `apps/desktop/tests/visual/dark.spec.ts`: D01 (full frame; the fixture thumbnails are RGBA on a
  transparent ground), D06, D18 vs the references; design-content isolation; runtime theme switch.
- Opt-in against a real server (skipped unless `BAREN_E2E_MAIL_DIR` and `VITE_SERVER_URL` are
  set, with `baren-server` running `MAIL_TRANSPORT=file:<dir>`): the "against a real server"
  block in `screens.spec.ts` (register → verify → forgot → reset → sign in; invite email + resend;
  change password) and `server.spec.ts` (email + password sign-in, emailed invite accepted, a shared
  file's images uploaded by one client and rendered by the other, live).
- `packages/sync-client/tests/e2e-phase2.test.ts` (real binary): mail-file codes, reset, invites,
  assets, update-feed ranges.

### Phase 2 ownership (historical)

The parallel build used this split; it is still the natural review boundary.

| Workstream | Owned |
|---|---|
| design | reference designs (22–28, D01/D06/D18, the 18/19 OAuth removal), `design/**` |
| server | `crates/server/**`, `crates/proto/**`, `packages/sync-client/**` |
| platform | `apps/desktop/src/main/**`, `src/preload/**`, `renderer/types/bridge.d.ts`, `renderer/lib/mockBridge.ts` (theme + updates), `electron-builder.yml`, `apps/desktop/package.json`, `scripts/release*` |
| images | `packages/canvas/**`, `packages/schema/**`, `crates/core/**`, `crates/napi/**`, `renderer/editor/**`, `renderer/lib/assets.ts`, `tests/visual/editor.spec.ts` |
| shell-ui | `apps/desktop/src/renderer/**` except `editor/**`, `types/bridge.d.ts`, `lib/assets.ts`; `tests/visual/screens.spec.ts` |
| dark-theme | `packages/ui/**`, every stylesheet under `apps/desktop/src/renderer/**`, canvas chrome colours, `tests/visual/dark.spec.ts` |

---

## Phase 3 — canvas tools

Contract added 2026-10-02 (architect workstream), built by the model, canvas and editor
workstreams, tested by QA and integrated the same day; this section describes what was built.
**The full detail — exact signatures, algorithms, the merge table and the test plan — is in
[`docs/phase3/contract.md`](docs/phase3/contract.md)**, whose top lists the model deviations,
QA changes and integration changes. Everything above still holds.

The six features: **reparent by dragging on the canvas**, **rotation**, **groups**, **the pen
tool with vector editing**, **reusable components** (mains, instances, overrides) and
**copy/paste between files and app windows**. All work end to end, including live
collaboration (`docs/STATUS.md` has the status, numbers and known issues).

### Design additions

Only the design workstream changed the reference designs. It added five artboards and
redrew **15 Editor — Context menu** with "Paste in place", "Group selection" and "Create
component". `design/screens.json` has 36
entries. New tokens (`packages/ui` tokens.css, dark values mirrored in `design/tokens.dark.css`):
`--color-component` (`#7b4dff` / dark `#9b7dff`), `--color-component-faint`,
`--color-component-subtle`, and the canvas chrome token `--color-overlay-component`
(`docs/phase3/design-tokens.md`).

| # | Artboard | Built in |
|---|---|---|
| 29 | 29 Editor — Rotation & groups | `packages/canvas` (rotation zones, angle pill), `editor/inspector/sections/LayoutSection.tsx` |
| 30 | 30 Editor — Pen tool | `packages/canvas/src/interaction/{pen,vectorEdit}.ts`, `editor/inspector/sections/VectorSections.tsx` |
| 31 | 31 Editor — Components | `editor/inspector/sections/ComponentSection.tsx`, `editor/components/ComponentsSection.tsx`, canvas component overlay |
| 32 | 32 Editor — Component picker | `editor/components/ComponentPicker.tsx` |
| 33 | 33 Editor — Drop into frame | `packages/canvas/src/interaction/{move,dropTarget}.ts` |

Editor fixture scenes: `?fixture=design&editorScene=rotation|pen|components|picker|drop`.

### Document model (additive; `schemaVersion` stays 1, no migration)

- `NodeType` adds **`group`**, **`vector`**, **`instance`**; containers are `page`, `frame`,
  `group`; instances are tree leaves. Unknown types still decode as `frame` (pre-Phase-3 clients
  show the new types as plain boxes). A **main component is a `frame` with `componentKey`**.
- New node data keys: `componentKey` (`[0-9a-z]{16}`), `mainId` (instance: TreeID hint of its
  main), `nodeKey` (`[0-9a-z]{10}`; every node inside a main — the address overrides use),
  `overrides` (instance, mergeable map), `vector` (vector, mergeable map). New root map
  **`components`**: `componentKey → { mainId }`. Mergeable children are only ever cleared,
  never deleted and re-created (Loro resurfaces a deleted mergeable child's old state).
- **Rotation**: `styles.rotate = "<deg>deg"`, normalised to (−180, 180], absent = 0, about the
  border-box centre; `left/top/width/height` are the unrotated box. World geometry is
  `NodeFrame { x, y, width, height, rotation }`. Numeric `rotate` renders as degrees.
- **Positioning by parent**: page → `left/top` (world); flex frame → in flow (absolutely
  positioned children stay absolute); other frame → `position: absolute` + `left/top` from the
  padding box (the frame gets `position: relative` when unpositioned); group → children always
  absolute.
- **Groups** store their own box (top level, absolute, or a flex item when they hold a flow
  item), may carry `rotate`, `opacity`, `mixBlendMode`, `filter`; the box is the union of the
  children, refitted by the actor in the same transaction (`fitGroups`); refits only known after
  layout (text edits, font loads) are committed by the canvas for local changes only, with origin
  `derived:group-fit` (not an undo step). Local actions that empty a group delete it.
- **Vectors**: `vector.fillRule` + `vector.subpaths[id] = { closed, order, points:
  MovableList<{ x, y, in?, out?, mode? }> }` in node-local px; paint is ordinary styles
  (`fill`, `stroke`, `strokeWidth`, `strokeDasharray`, `strokeLinecap`, `strokeLinejoin`);
  resizing rescales the points; `vectorToPathD` is the single path generator (TS and Rust print
  identical strings).
- **Instances**: `styles` hold only placement and size; `overrides[path] = { styles (value |
  null = removed), text, hidden, assetId, assetName }` with `path` = `''` (root) or `nodeKey`s
  joined by `/`. Content is resolved at render time, never copied; expanded nodes have **virtual
  ids** `"<instanceId>/<nodeKey>/…"`, accepted by the canvas, editor selection, presence, the
  `*At` helpers and both cores' `exportHtml`. Resolution order: main → overrides of nested
  instances → the outer instance. Main lookup: registry → smallest live TreeID with the key →
  **the retained data of a deleted main** (instances keep rendering; "Restore main component"
  re-creates it) → `unresolved`. Cycles are refused by the helpers and rendered as `cycle` when
  concurrent edits create one; nesting resolves to depth 16.

### Schema API (`@baren/schema`; Rust mirror in `baren_core`)

Modules `ids`, `geometry`, `rotation`, `groups`, `reparent`, `components`, `overrides`,
`resolve`, `vector`, `clipboard`, `html` (plus internal `graph`, `decode`, `refs`). Each
compound helper is one commit with a caller-given origin: `groupNodes`, `ungroupNodes`,
`fitGroups`, `resizeGroup`, `wrapInFrame`, `canReparent`, `reparentNodes`, `removeNodes`,
`setRotation`, `rotateNodes`, `createComponent`, `createInstance`, `detachInstance`,
`restoreMainComponent`, `listComponents`, `findMainComponent(doc, key, hint?)`,
`wouldCreateCycle(ForKeys)`, `setStylesAt` / `setTextAt` / `setPropsAt` / `resetOverrides`,
`createComponentResolver` (`affectedBy(batch)` + `apply(batch)`; one per session; plus the
style-only fast path `stylePaths(batch)` before `apply` and `resolveStyles(instance, path)`),
`toRenderSubtree`, `getResolvedNode`, `vectorToPathD`, `editVector`, `setVectorGeometry`,
`vectorToSvgMarkup`, `serializeClipboard` → `attachAssetBytes` → `parseClipboardPayload` /
`clipboardPayloadVersion` → `pasteClipboard`, `duplicateNodes`, `clipboardText`,
`tokensReferencedBy`, and `renderHtml` (a TS port of the Rust exporter, used by the JS fallback
core and the clipboard's `text/html`). Helpers take a **`GeometrySource`** (world frames); the
canvas implements it from the measured DOM (`canvas.geometry()`), `docGeometry(doc)` is the
declared-styles fallback. Events add `{ kind: 'overrides', id, paths }`,
`{ kind: 'vector', id }` and `NodeChangeBatch.components`. The Rust core mirrors types,
decoding, `to_render_subtree`, `vector_to_path_d`, `read_rotation` and HTML/JSON export
(groups, vectors, resolved instances, rotation, virtual roots); parity fixtures
(`crates/core/tests/fixtures/parity3.*`) prove byte-identical output. Mutation helpers are
TS-only. The napi surface is unchanged.

### Canvas (`packages/canvas`)

`Tool` adds `pen`; `CanvasController` adds `getNodeFrame(id)`, `geometry()`, `editVector(id)`,
`getEditingVector()`, `dropTargetAt(client, { deep, accept })`; `CanvasOptions` adds
`onVectorEditChange`; the default undo exclusions include `derived`. Behaviour:

- **Drag-reparent**: the deepest eligible frame under the pointer (not locked/hidden, not a
  group or inside an instance, no cycles) is highlighted; flex targets get an insertion line and
  index, others an absolute position; dragged layers are drawn as copies in a world-space layer
  while the originals are hidden; one `reparentNodes` commit (`canvas:reparent`). **Ctrl/⌘ keeps
  the parent.** Dragging a flow child over a sibling frame moves it into that frame.
- **Rotation**: 16 px zones outside the selection corners, a rotate cursor, **Shift = 15°**, a
  live angle pill, multi-selection around the common centre, transform-only preview, one
  `rotateNodes` commit; rotated hit-testing (rbush AABB + exact test), selection, handles,
  resize in local axes; snapping uses AABBs. Peers see rotation previews as axis-aligned
  `resize` ghosts (no protocol change).
- **Groups**: a click selects the outermost group or instance, double-click enters; groups move,
  rotate and resize as one (`resizeGroup` scales descendants).
- **Pen and vector editing**: P; click = corner, click-drag = smooth point, clicking the first
  point closes, Enter/Escape finish; double-click (or Enter) edits a vector: drag anchors and
  handles (Shift = 45°), insert points on segments, Delete removes points, double-click toggles
  smooth/corner; vectors are hit on their stroke with a 4 px tolerance.
- **Instances** expand at render time with one resolver per canvas (documents without components
  do no resolver work); a main edit that only restyles main content patches just the changed
  virtual node of each instance (`stylePaths` + `resolveStyles` + `Scene.patchStyles`); other
  main edits re-expand affected instances and patch their subtrees in place (paint-only changes
  keep measurements; structural ones reconcile children by key); stand-in thumbnails never start
  in the frame that applies a document change; text edits, moves, resizes and
  Delete on instance content become overrides. The overlay draws main labels (full name, with
  the four-diamond mark) and component-coloured selection for mains, instances and their
  content, plus an outline around the main of a selected instance.

### Editor (`apps/desktop/src/renderer/editor`)

One `ComponentResolver` per session (`DocEvents` runs `affectedBy` + `apply` before the
watchers); inspector reads and writes go through it, so edits to instance content become
overrides. New: the left panel's collapsible **Components** section (instance counts, search,
click = go to main, drag to insert) above a "Layers" header; the **component picker** (K or the
rail button; search, live previews, click or drag to insert); layer rows for groups, vectors,
instances (expandable into their content: select, hover and hide only); the inspector's
**Component** section ("N overrides · Text, Fill", Reset overrides, Go to main component,
Detach, and the deleted-main/missing/cycle states with Restore) and override dots; **Stroke**
for vectors; the Layout rotation field (`setRotation`, previews while scrubbing); group sizes
scale the group; context-menu items Paste in place, Group selection, Create component (artboard
15). The layers panel reparents through the same `reparentNodes` as the canvas drag.

### Clipboard and bridge

One atomic clipboard item: **`web application/x-baren-clipboard+json`** (payload
`{ kind: 'baren/clipboard', version: 2, source, bounds, nodes, components, tokens, assets }`,
asset bytes embedded up to 24 MiB, smallest first; blob type
`application/x-baren-clipboard+json` — Chromium rejects any other), `text/html`
(`renderHtml`, small images inlined) and `text/plain`. Paste priority: payload → legacy v1
JSON → images → SVG markup (svg layer) → plain text (text layer). Paste stores asset bytes in
the local core first, adds missing tokens (existing names keep the target's value), creates
missing mains on a **"Components"** page (reused when already present), refuses cycles ("Can't
paste a component inside itself") and payloads from a newer version; it never targets a locked
or hidden container. Ctrl+V offsets by 24 px when the copy's bounds are visible in the same
file (else it centres in the target page or frame), Ctrl+Shift+V pastes in place, "Paste
here" pastes at the clicked point inside the deepest frame there, Ctrl+D duplicates next to the
original, Ctrl+X copies then removes.

The bridge gained `clipboard` (see "Desktop bridge" above): main implements it with Electron 44's
`clipboard.write([new ClipboardItem(…)])` / `clipboard.read()` (`src/main/clipboard/`, IPC
`clipboard:write` / `clipboard:read` with strict validation and the trusted-sender check); the
mock bridge uses `navigator.clipboard` with the same format, falling back to a
`BroadcastChannel('baren-clipboard')` clipboard.

### Origins, shortcuts, commands

Undo origins: `canvas:reparent`, `canvas:rotate`, `canvas:pen`, `canvas:vector`,
`editor:group`, `editor:ungroup`, `editor:component`, `editor:detach`,
`editor:reset-overrides`, `editor:insert` (instances), `editor:clipboard`; **`derived:`** is
excluded from undo (canvas default and the editor's `UNDO_EXCLUDE`). Shortcuts: Mod+G group,
Mod+Shift+G ungroup, Mod+Alt+K create component, Mod+Alt+B detach, Mod+Shift+V paste in place,
Mod+D duplicate, P pen, K component picker, Ctrl/⌘ while dragging keeps the parent. Command ids:
`edit.pasteInPlace`, `edit.duplicate`, `object.group`, `object.ungroup`,
`object.createComponent`, `object.detachInstance`, `object.resetOverrides`,
`object.goToMainComponent` (the HTML menu bar is unchanged; these are reachable through
shortcuts, the context menu and `runCommand`).

### Phase 3 tests

- `packages/schema/tests`: unit tests per module, `checkInvariants`, two-peer convergence for
  every row of the merge table (contract 2.9), QA's scenario suite, a seeded random-sequence
  fuzz (invariants, one-step undo/redo, two-peer convergence) and `stylePaths.test.ts` (the fast
  path equals the full expansion).
- `crates/core`: parity tests against `parity3.*` (snapshot, render subtree, path data, HTML).
- `packages/canvas`: unit tests (frames, selection rules, drop targets, vector editing), e2e for
  every gesture with an in-page two-peer sync harness (`tests/e2e/phase3.spec.ts`,
  `qa-phase3.spec.ts`, and `integration-phase3.spec.ts` for the style-only fast path), perf presets `20k-mixed`, `propagation`, `propagation-2k` and a
  drop-target timer (`tests/perf.spec.ts`).
- `apps/desktop/tests/visual`: `editor.spec.ts` 29–33 (3 % budget) and the redrawn 15;
  `phase3-editor.spec.ts`, `qa-phase3-editor.spec.ts` (behaviour, clipboard within and across
  files and pages). Opt-in: `phase3-server.spec.ts`, `qa-phase3-server.spec.ts` (partitioned
  peers), `phase3-integration-server.spec.ts` (all six features through real input, two
  peers) and `phase3-electron-server.spec.ts` (B in the built Electron app; copy/paste between
  two app windows) against a real server; `phase3-electron.spec.ts` (the clipboard bridge in
  Electron). The Electron specs run with `--ozone-platform=headless` (no window, no OS
  clipboard).
- `packages/sync-client/tests/e2e-phase3.test.ts`: eight concurrent scenarios through the real
  server binary.

### Phase 3 ownership (historical)

| Workstream | Owned |
|---|---|
| model | `packages/schema/**`, `crates/core/**`, `crates/napi/**`, `apps/desktop/src/main/core/**` |
| canvas | `packages/canvas/**` |
| editor | `apps/desktop/src/renderer/editor/**`, command ids, the `clipboard` bridge member (types, preload, IPC, `src/main/clipboard/**`, mock bridge), `packages/ui` icons/editor components/additive tokens, `tests/visual/editor.spec.ts`, `phase3-*.spec.ts` |
| design | reference designs (29–33, redrawn 15), `design/**` |
| qa | fixes across schema, canvas and editor (`docs/requests/phase3-qa.md`), `qa-*` tests |
| integration | everything (docs, the integration e2e specs, the follow-ups in the contract's "Integration changes") |

Server, proto and sync-client code were not changed in this phase.

---

## Phase 4 contract — MCP server

Contract added 2026-10-02 by the architect workstream, built by the **server**, **runtime**,
**html**, **ui** and **design** workstreams, tested by QA and integrated the same day; this
section describes what was built. **The full detail — every tool's input and output, the
HTML/CSS mapping, the IPC protocol, the UI states and the test plan — is in
[`docs/phase4/contract.md`](docs/phase4/contract.md)**, whose §17 ("As built") records every
amendment from the workstreams, QA and integration and wins where it differs from earlier
sections; the text agents read is
[`docs/phase4/guide.md`](docs/phase4/guide.md); the
design notes are [`docs/phase4/design-tokens.md`](docs/phase4/design-tokens.md). Everything
above still holds.

Goal: a built-in MCP server so coding agents (Claude Code, Cursor, Codex, any MCP client) read
and edit Baren files live, with the same edits, undo and presence as a human collaborator.

### Architecture (binding)

- **Server in Electron main**, started lazily after the first window's `baren:ready` (or
  3 s): `import('./mcp/controller')`; nothing from the SDK, zod, parse5 or `@baren/html` on
  the cold path; cold start stays < 1 s. **Streamable HTTP** (`@modelcontextprotocol/sdk`
  1.31), `http://127.0.0.1:29170/mcp` (then +1…+9, then ephemeral; the bound port is
  persisted), one `StreamableHTTPServerTransport` + one `McpServer` per session (≤ 32; 30 min
  idle timeout). Every request: loopback socket, `Host` ∈ {`127.0.0.1:<port>`,
  `localhost:<port>`}, `Origin` absent or loopback (DNS rebinding), `Authorization: Bearer
  <token>` (timing-safe; more than 30 wrong tokens a minute → 429 for everyone; requests with
  no `Authorization` header get 401 but are not counted, so a web page cannot lock the agent
  out). No CORS. A client that drops its stream without `DELETE` is disconnected after 60 s.
- **Files** in `<userData>/mcp/`: `config.json` (0600: `enabled` (default true), `port`,
  `token` = `brn_` + 32 random bytes base64url), `endpoint.json` (live URL + pid, no token),
  `agents.json` (recently seen agents), `baren-mcp-stdio.cjs`. Flags: `BAREN_MCP=0|1`,
  `BAREN_MCP_PORT`, `BAREN_MCP_ALLOWED_ORIGINS`, `BAREN_EXPORT_DIR`,
  `BAREN_MCP_TOOL_TIMEOUT_MS`. Smoke runs keep MCP off unless `BAREN_MCP=1`.
- **stdio shim** for stdio-only clients: `src/main/mcp/stdio/shim.ts`, built by a Vite plugin
  (esbuild, `electron.vite.config.ts`) into one self-contained CommonJS file
  `out/main/mcp-stdio.js` (packaged inside `app.asar`), copied to
  `<userData>/mcp/baren-mcp-stdio.cjs`, run as `ELECTRON_RUN_AS_NODE=1 <app executable>
  <shim>` (or `node <shim>`); it bridges SDK `StdioServerTransport` ↔
  `StreamableHTTPClientTransport`, reading port and token from `<userData>/mcp/` (its config
  holds no secret), and re-establishes its session when the app restarts (404), the token is
  regenerated (401) or the app comes back on another port.
- **All document work runs in a renderer.** Main validates (zod), resolves the file
  (`fileId` optional everywhere: default = the file in the most recently focused window),
  pre-resolves image sources (absolute paths, `file://`, `baren-file://`, http(s) → core
  assets; the renderer never reads disk or network for agents) and sends `agent:request` to
  the file's **host**: the visible editor window that has it open, or a **headless host** — a
  hidden window at `#/agent-host/<fileId>` running `openSession(fileId, …, { headless: true })`
  with a hidden canvas and live sync (≤ 4, released after 120 s idle). One renderer hosts a file
  at a time: `files:open` from a visible window first makes a headless host flush and close
  (handoff). Requests lease their host (eviction, idle release and handoff wait for them); a
  host that misses a deadline and then a ping is discarded and the file reopened. Hidden windows
  are outside `WindowManager`; main quits itself when the last visible window closes
  (Linux/Windows). `open_file` fails at once with an actionable message when its window lands on
  the sign-in screen (signed-out profile); headless hosts need no session.
- **IPC**: `agent:request {id, fileId, tool, args, agent, assets?, deadline}` →
  `agent:response {id, ok, header, result, touched?} | {id, ok:false, error:{code, message}}`,
  `agent:cancel`, `agent:host {fileId, state, headless}`, `agent:presence {fileId, agents}`,
  `mcp:status`, `files:changed`. Writes to one file are serialised in main (`KeyedMutex`);
  reads run in parallel; each executor finishes all async preparation before one synchronous
  transaction, so a cancel either applies nothing or everything.
- **One tool call = one transaction** with origin **`agent:<tool>`**: one event batch, one sync
  update, **one undo step** (`agent:` is not excluded from undo).
- **Pixels** (screenshots, image exports, browser-computed styles, font probing, transcoding)
  go through one shared hidden **off-screen render window** (`#/agent-render`): the host builds a
  render stage (the exporter's HTML + canvas base rules, isolated in a shadow root), main
  captures it with `capturePage` (retried after resizes, falling back to the latest full
  `paint` frame; Electron 44 briefly fails with `UnknownVizError` after a resize). Alpha is kept
  and off-screen `printToPDF` works, so PDF export is supported. Independent of the user's
  viewport, zoom and LOD; never visible.

### Tools

Registered with zod `.strict()` schemas; results are two text blocks (`{ file: {id, name},
contentHash: {tokens} }` header + pretty JSON body; screenshots add an `image/jpeg` block);
failures are tool results `Error [<code>]: <message>`.

| Tools | Notes |
|---|---|
| `get_guide` | topics `baren-mcp-instructions`, `mobile-status-bar`, `images`, `code-export`, `image-generation` (from `guide.md`) |
| `get_basic_info`, `list_files`, `open_file`, `create_file`, `create_page`, `rename_pages`, `get_selection` | `open_file` navigates a home window or opens a new one; `create_file` is local |
| `get_tree_summary`, `get_children`, `get_node_info`, `find_nodes` | geometry measured from an isolated layout of the node's artboard (the canvas's rules, independent of the viewport), else declared, else null; whole-file reads use a plain-object mirror of the document |
| `get_jsx` (tailwind / inline-styles), `get_computed_styles` (declared; `resolved: true` = browser values), `get_tokens` (json/css/tailwind) | deterministic output |
| `get_screenshot` (JPEG, ≤ 1568 px / 1.15 MP), `get_fill_image`, `get_font_family_info`, `export` (png, jpg, webp, svg for vectors, pdf) | via the render window |
| `create_tokens`, `set_tokens`, `create_artboard`, `write_html`, `update_styles`, `set_text_content`, `rename_nodes`, `duplicate_nodes` (`descendantIdMap`), `move_nodes`, `delete_nodes` | writes; per-entry errors in-band |
| `finish_working_on_nodes` | presence only |

There are no comment tools. Node ids are TreeIDs and
instance virtual ids; writes on virtual ids become overrides, structural writes on them fail
with `instance_content`.

### write_html (package `@baren/html`)

DOM-free TypeScript (parse5), imported by main (`collectImageSources`) and the renderer
(`parseHtml`, `applyHtml`, `normalizeStyles`, `partitionStyles`, `canonicalStyles`, `toJsx`,
`renderStage`, `tokensToCss`, `tokensHash`); main imports only the parse5-only subpath
`@baren/html/sources`. It never commits (the runtime wraps it in `transact`). Mapping:
text-only elements → `text`, a flex or grid container with element children → `frame` (each
child its own layer, so a flex row of `<span>`s keeps its items), other elements → `frame`, `<img>` →
`image` (or `svg` for SVG sources), `<svg>` → sanitised `svg`, `<x-baren-clone node-id>` →
deep copy (clipboard helpers) with the element's styles applied.
Inline styles only, camelCase keys, a fixed shorthand policy (`padding` 2 values →
`paddingBlock`/`paddingInline`, `border` → width/style/colour longhands, `flex` → grow/shrink/
basis, …), `rem` → px, `var(--token)` kept; margin/grid/inline kept with a
`discouraged-property` warning; animations, cursor and similar dropped with a warning;
`position: fixed|sticky` → `absolute`. Results list `createdNodes` (id, name, component,
parentId, worldX/worldY, size), a tree `summary` and `warnings`.

### Agent presence and UI

- Main's agent registry: display name from `clientInfo` (e.g. "Claude Code"), per-file activity
  and **working sets** (artboards touched by write calls; renewed by any call touching them;
  cleared by `finish_working_on_nodes`, 120 s idle, or the session ending), recent agents
  (`agents.json`). Every agent uses the one agent accent (`--color-agent` and its ring, glow and
  overlay tokens); presence carries no colour.
- Editor: `EditorState.agents` (local from `agent:presence`, remote from peers); the inspector
  header shows rounded-square avatars with the Baren medallion after the people; the canvas
  overlay draws, per working artboard, a ring, halo and glow plus one island fused to the
  ring's top edge: the medallion and the agents' names, "Claude Code & Cursor"
  (`RemotePresence.kind = 'agent'`, `badge`). Layers an agent adds are staged in
  (`packages/canvas/src/overlay/incoming.ts`): hidden for 450 ms while a placeholder in the agent
  colour (tint, outline, one shimmer pass) marks where they land, then faded in as the
  placeholder fades out. Layers an agent edits (styles, text, moves, vectors, overrides, visible
  props; not renames) get the same placeholder flash without being hidden. Local writes are
  recognised by their `agent:` commit origin, remote ones by landing on an artboard in an
  agent's working set. With reduced motion the layer shows at once and only the placeholder
  fades. Only the presentation is delayed; the document is not.
- Live sync: presence frames gain an optional **`agents: [{ id, name, working }]`** (proto,
  server relay, sync-client types; additive and backwards compatible).
- UI (artboards **34** Connect your agent, **35** Agent working, **36** Home — Agents connected,
  **D34**, **D35**): the app-level Connect dialog (Switch, Claude Code / Cursor / Codex / Other
  snippets with masked token, Reveal, Copy, Regenerate token, status line); the MCP section
  (Not connected / Connected with agent rows and "Agent settings" / Off / Error); the home
  "Using agents" card with recent agents; a Preferences row.

### Bridge additions

`bridge.mcp` (`status`, `onStatus`, `setEnabled`, `setup` → URL, token and snippets,
`resetToken`), `bridge.agent` (`onRequest`, `respond`, `onCancel`, `onPresence`, `host`) and
`bridge.files.onChanged`. The token reaches the renderer only through `setup()` while the
dialog is open. The mock bridge implements all of it (`?mcp=off|not-connected|connected|error`)
and exposes `window.__barenAgent.dispatch/presence` in browser mode for tests.

### Design content line height (integration)

Canvas content used to inherit the app chrome's `line-height: 16px`, so text without its own
line height sat in a 16 px line box at any size (an agent's 56 px heading overlapped the next
layer). The document scope (`.ic-root, [data-design-content]` in `packages/ui` `tokens.css`)
now sets `line-height: normal`, matching browsers, the exported HTML, `get_jsx` and the
inspector's "Auto"; the render stage and the runtime's measurement use the same default. Text
that sets a line height (everything the text tool creates, every fixture) is unchanged; the
pixel diffs of every reference artboard are identical before and after.

### Phase 4 ownership (historical)

| Workstream | Owned |
|---|---|
| server | `apps/desktop/src/main/mcp/**` (incl. the stdio shim), the listed main/preload/bridge/mock hooks, `electron.vite.config.ts`, the wire presence (`crates/proto` presence, `crates/server` rooms, `packages/sync-client` protocol), `apps/desktop/tests/mcp/**` |
| runtime | `apps/desktop/src/renderer/agent/**` + hooks in `main.tsx`, `editor/session/{openSession,context,store}`, `editor/collab/{presence,useCollaboration}` |
| html | `packages/html/**` |
| ui | Connect dialog, `state/mcp.ts`, MCP section, inspector avatars, home card, Preferences row, `state/files.ts` reload, `packages/canvas` overlay (types, overlay, the frame-loop hook in `controller.ts`), `packages/ui` (agent tokens, Switch, Avatar variants) |
| design | artboards 34–36, D34, D35 (delivered), `design/**`, `docs/phase4/design-tokens.md` |
| architect | `docs/phase4/**` (except `design-tokens.md`), this section |
| qa | fixes across main, runtime, `packages/schema` (`createNode` appends without counting children) and `packages/canvas` (`collectFits`) (`docs/requests/phase4-qa.md`), `tests/mcp/qa-*` |
| integration | everything (docs, `tests/mcp/integration-packaged.spec.ts`, the contract's §17) |

`crates/core` and `crates/napi` were not changed in this phase; `packages/schema` only by QA's
performance fix.

### Tests (summary)

html: parser/normaliser/applier unit tests, an HTML corpus with expected trees
(`packages/html/tests/fixtures/html/`), `toJsx` golden files and a write → JSX → write round
trip. runtime: unit tests plus browser-mode Playwright tests of every executor through the mock
bridge (one undo step per call). server: security, config, routing, timeouts, assets, snippets,
an SDK client integration test without Electron, the stdio shim, Rust presence tests. ui: visual
tests of 34–36/D34/D35 (3 % budget) and behaviour. End to end (opt-in,
`apps/desktop/tests/mcp`, `BAREN_MCP_E2E=1`): the built app hidden
(`--ozone-platform=headless`, scratch userData, ephemeral port) driven by SDK clients over HTTP
and through the stdio shim: a full design session (`mcp-e2e`, `qa-session`), security,
restarts, robustness and latency (`qa-security`, `qa-restart`, `qa-robustness`, `qa-perf`), and
collaboration against a real server (`mcp-collab`,
`qa-collab`). `integration-packaged.spec.ts` runs the **packaged** app
(`BAREN_PACKAGED_APP`): an agent builds a pricing screen while a second packaged instance,
signed in as a collaborator, watches every layer appear on its canvas, sees the agent's avatar
and working badge and A's Ctrl+Z; then a stdio agent launched from the app's own setup snippet
reads and edits the same screen.
