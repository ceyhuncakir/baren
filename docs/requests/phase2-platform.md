# Phase 2 notes from platform

platform owns `apps/desktop/src/{main,preload}/**`, `renderer/types/bridge.d.ts`, the theme and
update parts of `renderer/lib/mockBridge.ts`, `electron-builder.yml`, `apps/desktop/package.json`
and `scripts/release*`. Everything below is built and unit-tested. Items marked **request** need
another workstream; items marked **contract** are precisions of the Phase 2 contract that the
other workstreams should rely on.

## 1. Bridge additions (contract)

`renderer/types/bridge.d.ts` now exports `ThemePreference`, `ResolvedTheme`, `UpdateState` and
`UpdateStatus`, and `BarenBridge` has `theme` and `updates` exactly as in ARCHITECTURE.md.
Precisions:

- **`UpdateStatus.progress` is an integer percent, 0–100** (only in `downloading`). The contract
  left the unit open.
- `version` is set in `available`, `downloading` and `ready`, and is **kept in `error`** when the
  failed download/install had one (so the UI can say "Couldn't install 0.2.0").
- `error` is one readable line (≤ 300 chars), never a stack.
- `check()` resolves when the _check_ is over — usually `available` (the download continues in
  the background and arrives through `onStatus`), `none` or `error`. While `checking`,
  `available`, `downloading` or `ready` it does not start another check; concurrent calls share
  one check. `app.checkForUpdates()` is the same call.
- `install()` does nothing unless the state is `ready`.
- A periodic background check that fails (offline) also ends in `error`. The UI should probably
  only _announce_ errors after a check the user started.
- `theme.initial` is correct before first paint also after a reload or in a new window (see §3).
  `theme.onChange` fires only on an actual light ↔ dark switch of the resolved theme, in every
  window, including the window that called `setPreference`.

## 2. Mock bridge (browser / Playwright) (contract)

- Theme: `?theme=light|dark|system` (default `system`), resolved with `prefers-color-scheme`
  (Playwright `colorScheme` works, and is followed live). `createMockBridge({ theme, systemDark })`
  overrides both. `setPreference` notifies `onChange` like the real bridge.
- Updates: `?updates=ready|downloading|available|checking|none|error|disabled|idle` (default
  `idle`) gives a static status for visual tests: `ready`/`available` carry version `0.2.0`
  (`MOCK_UPDATE_VERSION`), `downloading` is `0.2.0` at 42 %, `error` says "Could not reach the
  update server". `check()` from `idle`/`none`/`error` goes `checking` → `none` after 400 ms.
- Mock controls (`mockControls`): `setUpdateStatus(stateOrStatus)`, `updateInstalls()`,
  `setSystemDark(bool)`.
- `renderer/lib/bridge.ts` (shell-ui) needs no change: the mock reads the query string itself.

## 3. Theme (dark-theme, shell-ui) (contract)

- Main persists the preference in `<userData>/theme.json` and applies it with
  `nativeTheme.themeSource` (native menus, DevTools and `prefers-color-scheme` follow it).
- The window background is the resolved theme's surface: light `#F7F7F7`, dark `#202020`
  (`src/main/theme/theme.ts`, `THEME_BACKGROUND`). **dark-theme:** if `--color-surface` changes in
  `design/tokens.dark.css`, tell platform so the two stay equal (otherwise a frame of the wrong
  colour shows before first paint).
- `theme.initial` comes from `webPreferences.additionalArguments` (`--baren-theme=dark`) — no
  IPC on the cold-start path. A reload asks main synchronously (argv is fixed per window). A theme
  change that lands before the renderer subscribes is replayed to the first `onChange`.
- **shell-ui request:** set `document.documentElement.dataset.theme = bridge.theme.initial`
  before the first render (top of the renderer entry), subscribe with `bridge.theme.onChange`, and
  drive the Account menu's Light/Dark/System control with `theme.preference()` /
  `theme.setPreference()` instead of the current localStorage value (`home/AccountMenu.tsx`).
  The smoke report (`BAREN_SMOKE=1`) prints `bridge.theme.dataTheme`, so this is visible there.

## 4. Auto-update (shell-ui, server) (contract)

- Feed: `BAREN_UPDATE_URL` (run time, staging/tests) › `VITE_UPDATE_URL` › `<VITE_SERVER_URL>/updates/`
  › `http://127.0.0.1:8787/updates/`, always normalised to a directory URL (trailing `/`).
- Checks 10 s after start and every 4 h; downloads in the background. electron-updater is loaded
  lazily on the first check (zero cold-start cost; `status()` never loads it).
- Runs only in packaged builds installed as **AppImage** (`$APPIMAGE`), **deb**, **rpm** or pacman
  (electron-builder's `resources/package-type`), plus macOS/Windows (untested). Otherwise the state
  is `disabled`: dev builds (unless `BAREN_FORCE_UPDATES=1`), smoke runs (same),
  `linux-unpacked`/tarballs, no valid feed URL.
- **AppImage**: replaces its own file, no privileges. Installs on a normal quit too when an update
  is ready. "Restart to update" relaunches the new version.
- **deb/rpm**: electron-updater installs the downloaded package with the system package manager
  (`dpkg -i`/apt, `dnf`/`zypper`/`yum`/`rpm`) through **`pkexec`**: the user sees a polkit password
  prompt after clicking "Restart to update"; the app then relaunches. Packages are not GPG-verified
  by default (only sha512 against `latest-linux.yml`). Install-on-quit is **off** for deb/rpm so a
  plain quit never pops a password prompt; the downloaded update stays `ready` (cached in
  `~/.cache/@barendesktop-updater/`) until the user installs it. Dismissing the prompt → state
  `error`, the app keeps running and `install()` can be retried after a new `check()`.
- Before quit-and-install, main flushes window state, closes the core database and releases the
  single-instance lock, so the relaunched version can start while this one exits. If the install
  does not happen, it takes them back.
- **server:** the `/updates/*` route in `crates/server/src/routes/updates.rs` matches what the
  client needs (`latest-linux.yml` no-cache, ranges incl. multipart for AppImage differential
  downloads). Platform's end-to-end test used it (see §8).
- **shell-ui (screen 25):** show `ready` with `version` and a "Restart to update" button →
  `bridge.updates.install()`. Help → "Check for Updates…" → `bridge.app.checkForUpdates()` and
  report `none`/`error` from `updates.status()`.

## 5. baren-asset:// (images) (contract + request)

- `baren-asset://<hash>` (64 lowercase hex; Chromium normalises to `…/<hash>/`). Query strings
  and fragments are ignored, so `?v=2` can bust Chromium's per-document image cache after a missing
  asset arrives. Any other path, a port or credentials → 404.
- Privileged scheme: standard, secure, `supportFetchAPI`, `corsEnabled`, `stream`. Responses carry
  `Access-Control-Allow-Origin: *`, so `<img crossOrigin="anonymous">` does not taint canvases
  (thumbnails, Copy as PNG).
- 200 with the stored mime (`image/*`, `video/*`, `audio/*`, `font/*`; anything else is served as
  `application/octet-stream`), `Cache-Control: public, max-age=31536000, immutable`, `ETag`, byte
  ranges (206/416), HEAD. Unknown hash → 404 with `no-store`. Core unavailable → 503.
- Production CSP: `img-src`, `media-src` and `connect-src` include `baren-asset:`.
- Works with both cores. The JS core reads the mime from its `.json` sidecar.
- **Request (images, owner of `crates/napi`):** the napi `CoreHandle` has no way to read an
  asset's stored mime (`getAsset` returns bytes only), so the native path currently **sniffs** the
  type from magic bytes (png, jpeg, gif, webp, avif, bmp, ico, svg). Please add one of:
  `getAssetEntry(hash): Promise<{ bytes: Buffer; mime: string } | null>` (preferred: one query) or
  `getAssetMime(hash): Promise<string | null>`. `NativeCoreBackend` already uses either when present
  (`src/main/core/nativeBackend.ts`); no other change needed.

## 6. Release tooling (contract)

`pnpm release:linux [<version>|major|minor|patch] [--no-save] [--targets AppImage,deb,rpm]
[--skip-native] [--out <dir>] [--feed <url>] [--dry-run]` (`scripts/release.mjs`). It builds the
native core, bundles with the feed URL baked in, runs electron-builder (`--publish never`, generic
publish config so `latest-linux.yml` and `app-update.yml` are written) into
`apps/desktop/release/<version>/`, and with `RELEASE_TARGET=user@host:/path/` rsyncs the packages
and then `latest-linux.yml` (last) to the server's `UPDATES_DIR`. AppImage is always packed first:
the deb/rpm targets write `resources/package-type` into the shared `linux-unpacked` directory.

**Root `package.json`:** platform added the single script line `"release:linux": "node
scripts/release.mjs"` (the contract names `pnpm release:linux`; the root manifest has no Phase 2
owner).

## 7. Runtime switches added (`src/main/startup/flags.ts`)

`BAREN_FORCE_UPDATES=1`, `BAREN_UPDATE_URL=<feed>`, `BAREN_SMOKE_UPDATES=<state>` (smoke
run checks for updates immediately and passes only if it settles in `<state>`; `1` = `ready`;
never installs; reports every transition). The smoke report also includes an
`baren-asset://` round trip (put → fetch → `<img>` decode → 404s) and `bridge.theme`/`updates`.

## 8. Verification (STATUS input, 2026-10-02)

- Unit tests: `apps/desktop` vitest 361/361 (new: theme resolution + controller, feed URL,
  availability, update state machine + controller with fake timers, asset URL/range/response,
  preload theme/updates bridge, mock bridge theme/updates, core `getAssetEntry`).
- `BAREN_SMOKE=1 electron .` (dev build, native core): ok, cold start 304–362 ms (baseline
  before Phase 2: 332–422 ms); the asset probe (put → `fetch` → `<img>` decode → 404s) passes
  under the production CSP with the native and the JS core.
- Theme, live (Playwright driving the hidden smoke app): preference dark → every window's
  background `#F7F7F7` → `#202020`, `theme:changed` delivered; a reload gets `initial: dark` (argv
  still said light); a new window gets `dark` from argv; back to light repaints all windows.
- Auto-update, real packages: release A = 0.1.0 (AppImage + deb + rpm) and B = 0.1.1 (AppImage,
  `--no-save`) built with `scripts/release.mjs`; B rsynced into a temp `UPDATES_DIR` served by
  `baren-server` (`/updates/*`). Packaged A, run as an AppImage in hidden smoke mode
  (`BAREN_FORCE_UPDATES=1 BAREN_SMOKE_UPDATES=ready`, isolated `XDG_CACHE_HOME`):
  `idle → checking (307 ms) → available 0.1.1 → downloading 100 % → ready 0.1.1 (570 ms)`,
  differential download (6.9 MB of 130 MB, multipart ranges), downloaded file sha512 = B's.
  Again with the cache: `checking → available → ready` ("already downloaded"). B against the same
  feed: `none`. Unreachable feed: `error` "net::ERR_CONNECTION_REFUSED".
- Install, on a scratch copy only (`BAREN_SMOKE_INSTALL=1`): A replaced its AppImage file with
  `baren-0.1.1-x86_64.AppImage`, quit with code 0, and the 0.1.1 AppImage relaunched
  (hidden, inherited smoke env) and exited.
- deb/rpm: built; each contains `resources/package-type` (`deb` / `rpm`) and `app-update.yml`;
  the AppImage does not contain `package-type`. The pkexec install path was **not** run (it would
  install system-wide).
