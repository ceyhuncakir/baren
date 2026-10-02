# Pinned toolchain & dependency versions

Recorded by the foundation workstream on 2026-10-02. All dependencies were installed in one
`pnpm install`; later workstreams must not add packages. Ask for them in their report instead.

At integration the packages that were used but only resolved through hoisting were declared
(no new versions): `@noble/hashes` and `@fontsource-variable/inter` in `apps/desktop`; `react`
(peer), `@types/react`, `react-dom`, `@fontsource-variable/inter` and `electron` (dev) in
`packages/canvas`.

## Runtimes

| Tool                | Version       | Notes                                                                                                      |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| Node (dev machine)  | 22.22.0       | Has built-in TS type stripping, which `packages/schema/scripts/make-fixture.mjs` relies on (Node ≥ 22.18). |
| pnpm                | 10.17.1       | `node-linker=hoisted` (.npmrc) so electron-builder sees a flat `node_modules`.                             |
| Rust / cargo        | 1.94.0        | `rust-version = 1.85` in the workspace.                                                                    |
| Electron            | 44.5.1        | Bundles **Node 24.21.0** and **Chromium 152**.                                                             |
| Playwright Chromium | revision 1243 | Already present in `~/.cache/ms-playwright`, so no browser download was needed.                            |

## Loro (CRDT): keep both sides on the same release line

| Side                               | Package           | Version                                              |
| ---------------------------------- | ----------------- | ---------------------------------------------------- |
| JS (renderer, schema, sync-client) | `loro-crdt` (npm) | **1.16.4**                                           |
| Rust (core, server)                | `loro` (crate)    | **1.16.2** (newest published crate in the 1.16 line) |

Compatibility is checked, not assumed. `crates/core/tests/fixture_compat.rs` loads
`design/fixtures/sample.loro`, which is written by `loro-crdt` 1.16.4 through the schema helpers,
using the 1.16.2 crate. The test passes. The document uses **mergeable child containers**
(`ensureMergeableMap` / `ensureMergeableText`, available since loro 1.13), so the Rust side must
read and create node `styles` / `text` and token entries the same way
(`ensure_mergeable_map` / `ensure_mergeable_text`).

Regenerate the fixture with `node packages/schema/scripts/make-fixture.mjs`. The output is
deterministic, because the peer id is fixed and no timestamps are written.

## npm packages (installed)

| Package                         | Version       | Where                                                                                                                                            |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| typescript                      | 7.0.2         | root. This is the native (Go) compiler. `tsc` is fast, and nothing in the toolchain needs the old JS compiler API.                               |
| vitest                          | 5.0.3         | root                                                                                                                                             |
| @playwright/test                | 1.63.0        | root                                                                                                                                             |
| @types/node                     | 24.19.1       | root. Matches Electron 44's Node 24 rather than the latest 26.x, so main-process code cannot type-check against APIs that Electron's Node lacks. |
| prettier                        | 3.9.9         | root                                                                                                                                             |
| electron                        | 44.5.1        | desktop                                                                                                                                          |
| electron-vite                   | 5.0.0         | desktop                                                                                                                                          |
| electron-builder                | 26.15.3       | desktop                                                                                                                                          |
| vite                            | **7.3.6**     | desktop, ui, canvas. See below.                                                                                                                  |
| @vitejs/plugin-react            | **5.2.0**     | desktop, ui. See below.                                                                                                                          |
| vite-plugin-wasm                | 3.6.0         | desktop, canvas                                                                                                                                  |
| vite-plugin-top-level-await     | 1.6.0         | desktop, canvas. Installed but not wired in. With `build.target: 'esnext'`, Chromium runs native top-level await.                                |
| react / react-dom               | 19.3.0        | desktop, ui                                                                                                                                      |
| @types/react / @types/react-dom | 19.3.0        | desktop, ui                                                                                                                                      |
| zustand                         | 5.0.15        | desktop                                                                                                                                          |
| @tanstack/react-virtual         | 3.14.13       | desktop                                                                                                                                          |
| loro-crdt                       | 1.16.4        | desktop, schema, canvas, sync-client                                                                                                             |
| lucide-react                    | 1.49.0        | desktop, ui                                                                                                                                      |
| wouter                          | 3.13.0        | desktop                                                                                                                                          |
| clsx                            | 2.1.1         | desktop, ui                                                                                                                                      |
| @fontsource-variable/inter      | 5.3.0         | ui. The font family is registered as `'Inter Variable'`.                                                                                         |
| @fontsource/jetbrains-mono      | 5.3.0         | ui                                                                                                                                               |
| rbush / @types/rbush            | 4.0.1 / 4.0.0 | canvas                                                                                                                                           |
| @noble/hashes                   | 1.8.0         | desktop (dev). blake3 for the JS fallback core; declared at integration (it was only hoisted before).                                            |
| @napi-rs/cli                    | 3.10.6        | crates/napi                                                                                                                                      |

### Why Vite 7 and not Vite 8

The newest stable **electron-vite (5.0.0)** declares `vite: ^5 || ^6 || ^7`. electron-vite 6 is
still in beta (6.0.0-beta.5), and `@vitejs/plugin-react` 6.x requires Vite 8. The whole workspace
therefore pins Vite **7.3.6** with `@vitejs/plugin-react` **5.2.0**, which supports Vite 4–8. One
Vite version sits in the hoisted `node_modules`. Move to Vite 8 when electron-vite 6 ships as
stable.

### loro-crdt entry point in the renderer

In production, `loro-crdt`'s `"browser"` export loads its 3.4 MB wasm with a **synchronous XHR
and a synchronous `WebAssembly.Module` compile on the main thread**. The renderer and the canvas
bench therefore alias `loro-crdt` → `loro-crdt/bundler`. That build imports the `.wasm` as an ES
module, and `vite-plugin-wasm` turns the import into an async `fetch` + instantiation. Inside
Electron, `fetch` needs a real origin, so the main process serves the renderer from the privileged
`app://renderer/` scheme rather than `file://`. Both setups have been checked: a production Vite
build in Chromium, and the built Electron app.

## Rust crates (workspace.dependencies, resolved)

| Crate                           | Version                 | Features                                                               |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| loro                            | 1.16.2                  |                                                                        |
| serde / serde_json              | 1.0.229 / 1.0.151       | derive                                                                 |
| thiserror / anyhow              | 2.0.21 / 1.0.104        |                                                                        |
| tokio                           | 1.53.1                  | full                                                                   |
| axum                            | 0.8.9                   | ws                                                                     |
| tower-http                      | 0.7.1                   | cors, trace                                                            |
| sqlx                            | 0.9.0                   | sqlite (bundled), runtime-tokio, macros, migrate (no default features) |
| rusqlite                        | **0.39.0**              | bundled                                                                |
| blake3                          | 1.8.7                   |                                                                        |
| argon2                          | 0.6.0                   |                                                                        |
| rand                            | 0.10.3                  |                                                                        |
| sha2                            | 0.11.0                  |                                                                        |
| base64                          | 0.23.1                  |                                                                        |
| uuid                            | 1.26.1                  | v4, v7, serde                                                          |
| time                            | 0.3.55                  | serde, formatting, parsing                                             |
| tracing / tracing-subscriber    | 0.1.44 / 0.3.23         | env-filter, fmt                                                        |
| napi / napi-derive / napi-build | 3.14.0 / 3.6.10 / 2.6.0 | napi8, async                                                           |

### Why rusqlite 0.39 and not 0.40

`rusqlite` (crates/core) and `sqlx-sqlite` (crates/server) both link the native `sqlite3`
library, so Cargo requires them to share **one** `libsqlite3-sys`. sqlx 0.9.0 accepts
`libsqlite3-sys >=0.30.1, <0.38`, while rusqlite 0.40.x requires `^0.38`. rusqlite **0.39.0**
(using libsqlite3-sys 0.37) is the newest version compatible with both. Do not bump rusqlite
until sqlx widens its range.

## Cargo usage

- Each workstream builds with `CARGO_TARGET_DIR=<repo>/target/<workstream>`. Use an absolute
  path: napi-rs writes type definitions relative to the target dir, and a relative
  `--target-dir` breaks that.
- `pnpm --filter @baren/core-native build` runs `napi build --platform --release` and writes
  `crates/napi/index.js`, `index.d.ts` and `baren-core.<triple>.node`. The `.node` file is
  gitignored.
