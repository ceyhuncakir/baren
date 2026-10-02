<p align="center"><img src="design/brand/baren-icon.png" width="128" height="128" alt="Baren"></p>

# Baren

Baren is a local-first, multiplayer design tool for the desktop. Your files live on your machine
(a Rust core with SQLite), so the app works offline and does not need an account. When you share a
file with your team, it syncs live through a small server that you host yourself. Edits are merged
with the Loro CRDT, so changes from several people, including changes made offline, combine
without conflicts. Coding agents can read and edit your designs through the MCP server built into
the app. There is no billing: accounts are an email address and a password on your own server,
and teams grow through email invites.

![The Baren editor with a layer selected and the inspector open](design/reference/06-editor-selection-inspector.png)

- **Desktop app:** Electron + React 19 + TypeScript, with a custom DOM canvas that handles
  50,000-node documents at well over 60 fps.
- **Local backend:** Rust (`crates/core`) loaded into Electron through napi-rs. It handles
  persistence, assets, thumbnails and HTML/JSON export.
- **Server:** one Rust binary (`crates/server`, axum + SQLite) for accounts (email + password,
  with emailed verification and password-reset codes), teams, email invites, live rooms, shared
  images and the desktop auto-update feed.
- **Light and dark theme** for the app (designs always render in their own colours), image layers
  and image fills, and auto-update for the Linux packages.
- **Canvas tools:** drag layers into and out of frames on the canvas, rotation (Shift snaps to
  15°), groups (Ctrl+G / Ctrl+Shift+G), the pen tool with vector editing (P), reusable components
  with per-instance overrides (Ctrl+Alt+K, the component picker on K), and copy/paste between
  files and app windows (Ctrl+C/X/V, Ctrl+Shift+V, Ctrl+D) that carries styles, images, tokens and
  components. All of it works live between collaborators.
- **Built-in MCP server:** coding agents (Claude Code, Cursor, Codex, any MCP client) read and
  edit your files live through 30 tools: read the layer tree, write HTML into the document,
  change styles and text, take screenshots, and export JSX and images. Every agent edit appears
  on the canvas at once, syncs to collaborators and undoes as one step, and the agent shows up
  like a collaborator. See [Connect your agent](#connect-your-agent).

How it fits together is in [ARCHITECTURE.md](ARCHITECTURE.md). What works and what does not, with
test and performance numbers, is in [docs/STATUS.md](docs/STATUS.md).

## Prerequisites

| Tool                | Version                     | Notes                                                                     |
| ------------------- | --------------------------- | ------------------------------------------------------------------------- |
| Node.js             | ≥ 22.18 (tested with 22.22) | 22.18+ strips TypeScript types natively, which some repo scripts rely on. |
| pnpm                | 10.x (`corepack enable`)    | The workspace pins `pnpm@10.17.1`.                                        |
| Rust                | ≥ 1.85 (tested with 1.94)   | Install with [rustup](https://rustup.rs).                                 |
| C compiler          | gcc or clang                | SQLite is compiled into the Rust crates.                                  |
| Playwright Chromium | optional                    | Only for the visual tests: `pnpm exec playwright install chromium`.       |

Development and testing so far have been on Linux (Fedora, x64). macOS and Windows are wired up
(window chrome, menus, packaging targets) but have not been run.

## Run it locally (one command)

```sh
pnpm install
pnpm dev:all
```

`pnpm dev:all` (`scripts/dev.mjs`) runs these steps:

1. It builds the Rust core (`crates/napi/baren-core.<platform>.node`) if it is missing.
2. It starts the sync server on `127.0.0.1:8787`, unless one is already running there.
3. It launches the desktop app with hot reload.

Ctrl+C stops both. The steps can also be run separately:

```sh
pnpm build:native      # Rust core → crates/napi/*.node (the app falls back to a slower JS core without it)
pnpm server            # cargo run -p baren-server  (SQLite file: ./baren.db)
pnpm dev               # electron-vite dev
```

Locally the server does not send email (`MAIL_TRANSPORT=log`): to create an account, register in
the app, then copy the 6-digit code from the server's log. Password-reset codes and invite links
appear there too, and the app tells you to "ask the server admin for your code":

```
INFO baren_server::mailer: verification code for you@example.com: 482713 …
```

To get the messages as files instead (open the `.eml` in any mail client), start the server with
`MAIL_TRANSPORT=file:/tmp/baren-mail pnpm server`. Real email is set up in
[Email (SMTP)](#email-smtp).

**Continue offline** on the sign-in screen skips the account entirely. Local files work without a
server.

The renderer also runs in a plain browser with an in-memory mock bridge. This is how the visual
tests run:

```sh
pnpm --filter @baren/desktop dev:web            # http://localhost:5199
# http://localhost:5199/?fixture=design#/recents   → every screen with the design fixture data
```

## Build and package

```sh
pnpm build                                        # electron-vite build → apps/desktop/out
pnpm package:linux                                # Rust core + AppImage / deb / rpm in apps/desktop/release/
pnpm --filter @baren/desktop exec electron-builder --config electron-builder.yml --linux dir   # unpacked app only
```

The app reaches the server at `VITE_SERVER_URL`, which is read **at build time**. It defaults to
`http://127.0.0.1:8787`. The same value goes into the production Content-Security-Policy, and the
auto-update feed defaults to `<VITE_SERVER_URL>/updates/`. Releases for other people are built with
`pnpm release:linux` (see [Releases and auto-update](#releases-and-auto-update)).

## Email (SMTP)

The server sends three emails: the verification code, the password-reset code and team invites.
Any SMTP provider works; set two variables on the server (full guide, including Resend, Postmark
and Gmail app passwords, percent-encoding and SPF/DKIM/DMARC, in
[crates/server/README.md → Email](crates/server/README.md#email)):

```sh
SMTP_URL='smtps://USER:PASSWORD@smtp.example.com:465'   # or smtp://…:587?tls=required (STARTTLS)
MAIL_FROM='Baren <no-reply@example.com>'      # an address your provider lets you send from
```

With `SMTP_URL` set the server uses SMTP (`MAIL_TRANSPORT=smtp`), checks the connection at
startup and retries failed deliveries in the background. Percent-encode `@ : / ?` in the user name
and password (`you@gmail.com` → `you%40gmail.com`). The app then says "check your email" instead of
"ask the server admin". Without DNS records for your sending domain (SPF, DKIM, DMARC) the mail is
likely to land in spam.

## Releases and auto-update

Installed Linux packages update themselves from the server's `/updates/` directory
(electron-updater, generic provider). Releasing a new version:

```sh
# on your machine: bump the version, build AppImage + deb + rpm with the server URL baked in,
# then upload the packages and latest-linux.yml (last) into the server's UPDATES_DIR
VITE_SERVER_URL=https://sync.example.com \
RELEASE_TARGET=deploy@sync.example.com:/srv/baren/updates/ \
  pnpm release:linux patch
```

- `pnpm release:linux [<version>|major|minor|patch]` writes `apps/desktop/release/<version>/`
  (`--targets AppImage,deb,rpm`, `--skip-native`, `--no-save`, `--out`, `--feed`, `--dry-run`; see
  `scripts/release.mjs`). The server needs `UPDATES_DIR=/srv/baren/updates` (see
  [crates/server/README.md → Update feed](crates/server/README.md#update-feed)).
- The app checks 10 s after it starts and every 4 hours, downloads in the background, and shows
  "Version x.y.z is ready" with **Restart**. Help → **Check for Updates…** checks right away.
- **AppImage** installs replace their own file (no password) and also update on a normal quit.
  **deb/rpm** installs update through the system package manager, so clicking **Restart** shows a
  password prompt (never on a plain quit).
- Updates are off in development builds and in the unpacked `linux-unpacked` directory.

## Invite a friend

1. **Deploy the server** on a small VPS. Follow
   [crates/server/README.md → Deploying to a small VPS](crates/server/README.md#deploying-to-a-small-vps):
   - one binary;
   - a systemd unit;
   - Caddy for TLS and WebSockets.

   Set `PUBLIC_URL=https://sync.example.com` so that invite links point at your domain.

   Add `SMTP_URL` and `MAIL_FROM` ([Email (SMTP)](#email-smtp)) so codes and invites are emailed,
   and `UPDATES_DIR` so the app can update itself.

2. **Build the app against it** and publish the first release, then give your friend the AppImage
   (simplest: it updates itself without a password), deb or rpm from `apps/desktop/release/<version>/`:
   ```sh
   VITE_SERVER_URL=https://sync.example.com RELEASE_TARGET=deploy@sync.example.com:/srv/baren/updates/ \
     pnpm release:linux
   ```
   Later versions reach them automatically ([Releases and auto-update](#releases-and-auto-update)).
3. **Both of you create an account** (email + password; there is no Google/GitHub sign-in). The
   6-digit verification code arrives by email. Without SMTP it is in the server log
   (`journalctl -u baren-server`). A forgotten password is reset from **Forgot password?** on the
   sign-in screen with an emailed code. **Sign in with browser** also works: it opens the server's
   page, where you sign in and approve the code shown in the app.
4. **Invite them to your team.** Go to Team → Members → Invite and enter their email: they get an
   email with a link like `https://sync.example.com/i/<token>` (without SMTP, the link is copied for
   you to send). The page has an **Open in Baren** button that launches the app on the
   invite (`baren://invite/<token>`). **Resend invite** emails a fresh link (the old one stops
   working).
   - If the deep link handler is not registered (for example, when running from a dev build),
     start the app with the link as an argument: `baren 'baren://invite/<token>'`.
5. **Share a file.** In the editor, open **Share**, then either invite them by email or click
   **Copy link**. Either action puts the file in the team. The file then appears in their Recents,
   and while both of you have it open you see each other's edits, cursors and selections live.
   Images you add (picker, drag and drop, or paste) are uploaded to the server and appear on their
   side as well.

## Connect your agent

The desktop app runs an MCP server for coding agents while it is open. It listens on
`http://127.0.0.1:29170/mcp` (loopback only; if that port is taken, the next free one) and
every request needs the app's bearer token. The server has 30 tools:

- **Read:** `get_basic_info` (pages, artboards, fonts, tokens and components; agents call it
  first), `get_tree_summary`, `get_children`, `get_node_info`, `find_nodes`, `get_selection`,
  `get_computed_styles`, `get_tokens`.
- **Write:** `write_html` (HTML with inline styles becomes layers), `update_styles`,
  `set_text_content`, `create_artboard`, `duplicate_nodes`, `move_nodes`, `delete_nodes`,
  `rename_nodes`, `create_tokens`, `set_tokens`.
- **Look and export:** `get_screenshot`, `get_jsx` (Tailwind or inline styles), `export`
  (PNG, JPG, WebP, PDF; SVG for vector layers), `get_fill_image`, `get_font_family_info`.
- **Files and pages:** `list_files`, `open_file`, `create_file`, `create_page`, `rename_pages`.
- **Session:** `get_guide` serves the instructions an agent reads before it starts, and
  `finish_working_on_nodes` tells collaborators the agent is done.

An agent can work on any local file, including files that are not open: the app opens them in a
hidden window.

1. In the app, open **Connect your agent**: the **MCP** section of the editor's inspector, the
   **Using agents** card on Home, or Preferences → **MCP server**. The dialog shows the
   server's address and status, and a ready-made snippet per client with your token (masked).
   **Copy** copies the snippet with the full token; **Reveal** shows it.
2. Add the server to your agent (replace the URL and token with the ones the dialog shows):

   **Claude Code**

   ```sh
   claude mcp add --scope user --transport http \
     baren http://127.0.0.1:29170/mcp \
     --header "Authorization: Bearer brn_…"
   ```

   **Cursor** (`~/.cursor/mcp.json`)

   ```json
   {
     "mcpServers": {
       "baren": {
         "url": "http://127.0.0.1:29170/mcp",
         "headers": { "Authorization": "Bearer brn_…" }
       }
     }
   }
   ```

   **Codex** (`~/.codex/config.toml`)

   ```toml
   [mcp_servers.baren]
   url = "http://127.0.0.1:29170/mcp"
   http_headers = { "Authorization" = "Bearer brn_…" }
   ```

   **Other clients** with Streamable HTTP: the same URL with `"type": "http"` and the
   `Authorization` header. Clients that only speak **stdio** use the shim the app keeps in
   `<userData>/mcp/` (`~/.config/baren.dev/mcp/` for the installed Linux app). It reads
   the address and token itself, so its config holds no secret and keeps working after a token
   reset or a port change:

   ```json
   {
     "mcpServers": {
       "baren": {
         "command": "/opt/baren.dev/baren",
         "args": ["/home/you/.config/baren.dev/mcp/baren-mcp-stdio.cjs"],
         "env": { "ELECTRON_RUN_AS_NODE": "1" }
       }
     }
   }
   ```

   (The dialog's **Other** tab has the exact paths: `command` is the app's executable, or the
   AppImage for AppImage installs; `node <shim>` works too.)

3. Ask the agent to design something ("Make a pricing page in Baren"). The status line
   turns to **Connected** with the agent's name; artboards it is editing show an "… is working"
   badge until it calls `finish_working_on_nodes` (or after two minutes idle), and
   collaborators in a shared file see the agent next to you in the inspector. Each tool call is
   one undo step for you (Ctrl+Z).

The token is per installation (`<userData>/mcp/config.json`, readable only by you).
**Regenerate token** in the dialog invalidates the old one and disconnects agents that use it;
the **MCP server** switch turns the server off. `BAREN_MCP=0` (or `1`) overrides the
switch, `BAREN_MCP_PORT` picks the port. The server answers only requests to
`127.0.0.1`/`localhost` with no foreign `Origin` (DNS-rebinding protection) and never sends
CORS headers, so web pages cannot reach it. If the app shows its sign-in screen, `open_file`
asks the agent to have you sign in or choose **Continue offline**; the other tools still work.

## Repository

```
apps/desktop/         Electron app: main process (+ MCP server), preload bridge, renderer (screens + editor)
packages/schema/      Loro document model shared by every part
packages/html/        HTML ⇄ document conversion for the MCP tools (write_html, get_jsx)
packages/ui/          design tokens, fonts and React components (+ playground)
packages/canvas/      canvas engine (+ benchmarks)
packages/sync-client/ REST + WebSocket client for the server
crates/core/          Rust core: SQLite store, export, schema mirror
crates/napi/          napi-rs binding of the core for Electron
crates/server/        sync server; crates/proto: its wire types
design/               reference designs (PNGs, screens.json), tokens, brand (visual source of truth)
```

## Tests

```sh
pnpm typecheck                                     # every TS project
pnpm test                                          # vitest (schema, ui, canvas, sync-client, desktop)
cargo test --workspace                             # Rust core, server (real server + WebSocket peers), proto
pnpm test:visual                                   # Playwright: screens + editor + dark vs design/reference PNGs
UPDATE_REFERENCES=1 pnpm test:visual               # after an intentional design change: rewrite those PNGs
pnpm --filter @baren/ui test:visual             # ui-kit gallery
pnpm --filter @baren/canvas test:e2e            # canvas behaviour in Chromium
pnpm --filter @baren/canvas test:perf           # 20k / 50k-node pan & zoom budgets
pnpm --filter @baren/core-native smoke          # end-to-end check of the built Rust addon
pnpm --filter @baren/desktop build && pnpm --filter @baren/desktop smoke   # Electron startup check (hidden window)
```

Two clients against a real server (browser mode; opt-in, skipped unless the variables are set):

```sh
MAIL_TRANSPORT=file:/tmp/baren-mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
  cargo run -p baren-server &
BAREN_E2E_MAIL_DIR=/tmp/baren-mail VITE_SERVER_URL=http://127.0.0.1:8899 \
  pnpm test:visual --grep "real server"
```

They cover register → emailed code → verify, forgot → reset, sign-in through the browser (device
flow), an emailed invite accepted by a second user, invite re-send and password change, and a
shared file whose images one client inserts and the other renders. With the same two variables,
the Phase 3 suites run too (`pnpm test:visual` runs everything):

```sh
# all six canvas tools through real input, two people (phase3-integration-server.spec.ts);
# components live, partitioned concurrent edits (phase3-server, qa-phase3-server)
BAREN_E2E_MAIL_DIR=/tmp/baren-mail VITE_SERVER_URL=http://127.0.0.1:8899 \
  pnpm test:visual tests/visual/phase3-integration-server.spec.ts

# the built Electron app as one peer, plus copy/paste between two app windows
# (headless Ozone: no window is shown and the OS clipboard is not used)
VITE_SERVER_URL=http://127.0.0.1:8899 pnpm --filter @baren/desktop exec electron-vite build --outDir /tmp/e2e-out
BAREN_ELECTRON_E2E=1 BAREN_ELECTRON_OUT=/tmp/e2e-out BAREN_E2E_MAIL_DIR=/tmp/baren-mail \
  VITE_SERVER_URL=http://127.0.0.1:8899 pnpm test:visual tests/visual/phase3-electron-server.spec.ts
```

The MCP server end to end (opt-in): the built app runs hidden (`--ozone-platform=headless`,
scratch profile, ephemeral port) and SDK clients drive it over HTTP and through the stdio shim.
The collaboration specs need the same scratch server as above and a build made for it:

```sh
VITE_SERVER_URL=http://127.0.0.1:8899 pnpm --filter @baren/desktop exec electron-vite build --outDir /tmp/e2e-out
BAREN_MCP_E2E=1 BAREN_ELECTRON_OUT=/tmp/e2e-out BAREN_E2E_MAIL_DIR=/tmp/baren-mail \
  VITE_SERVER_URL=http://127.0.0.1:8899 \
  pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts
```

`tests/mcp/integration-packaged.spec.ts` also runs when `BAREN_PACKAGED_APP` points at a
packaged build for that server (`…/linux-unpacked/baren`): an agent builds a screen in
one packaged instance while a second one, signed in as a collaborator, watches it appear, and a
stdio agent joins the same session.

`packages/sync-client/tests/e2e*.test.ts` start their own server from a built `baren-server`
binary (`BAREN_SERVER_BIN=<path>`; otherwise they look in the `target/` directories listed at
the top of each file) and run with `pnpm test`.
