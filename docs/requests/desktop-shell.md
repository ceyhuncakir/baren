# Contract notes from desktop-shell

desktop-shell owns `apps/desktop/src/{main,preload}`, `apps/desktop/package.json`,
`electron.vite.config.ts`, `electron-builder.yml` and `apps/desktop/resources/`. Everything
below is built and tested. Items marked **request** need another workstream or a contract
change at integration.

## 1. Native core module shape (rust-core) — request

Main loads the napi addon with `require()` and adapts it in
`src/main/core/nativeBackend.ts`. It expects the following (all methods async, running on the
libuv pool):

```ts
export declare class Core {
  constructor(dataDir: string) // or: static open(dataDir: string): Promise<Core>
  listFiles(): Promise<FileMeta[]>
  createFile(name: string): Promise<FileMeta>
  renameFile(id: string, name: string): Promise<void>
  archiveFile(id: string, archived: boolean): Promise<void>
  removeFile(id: string): Promise<void>
  openFile(id: string): Promise<Buffer> // compacted Loro snapshot
  applyUpdate(id: string, update: Buffer): Promise<void>
  setThumbnail(id: string, png: Buffer): Promise<void>
  getThumbnail(id: string): Promise<Buffer | null>
  putAsset(bytes: Buffer, mime: string): Promise<string> // blake3 hex
  getAsset(hash: string): Promise<Buffer | null>
  exportHtml(fileId: string, nodeId: string): Promise<string>
  exportJson(fileId: string): Promise<string>
  close?(): Promise<void> // or dispose()/flush(): called once at quit
}
```

- **`dataDir` is a directory** (`<userData>/core`, already created). The core chooses its
  SQLite file name inside it. `Store::open` currently takes a database _file_ path, so the
  napi layer should do `Store::open(dataDir.join("baren.sqlite"))` or similar.
- The class may be exported as `Core`, `BarenCore`, `NativeCore`, `CoreHandle` or `Store`.
  Free functions plus `init(dataDir)` are accepted as well. If the shape does not match, main
  logs the missing methods and uses the JS fallback, so the app keeps running. The current
  skeleton (`coreVersion` only) is rejected that way.
- `FileMeta` fields: camelCase. `teamId`/`remoteId` may be `null` or `undefined`, and
  timestamps may be number or BigInt; main normalises both.
- Errors: throw with a readable message, for example `File not found: <id>`. The renderer
  only sees the message.
- Binary name: `baren-core.<platform>-<arch>[-abi].node` in `crates/napi/` (napi
  `--platform`). `BAREN_NATIVE_PATH=/abs/file.node` overrides this.
  `BAREN_CORE=native` makes a missing or broken addon fatal (for CI);
  `BAREN_CORE=js` forces the fallback.
- Packaging: electron-builder copies `crates/napi/*.node` to `native/` and unpacks it to
  `resources/app.asar.unpacked/native/`. Run `pnpm build:native` before `pnpm package`.

## 2. JS fallback core

`src/main/core/js/` contains a complete implementation of the 13 operations, run in a
`worker_threads` worker. Loro (loro-crdt's web build, initialised from the bundled `.wasm`)
and blake3 never run on the main thread. It stores data in `<userData>/core-js/`:
per-file `meta.json`, a `doc.loro` snapshot and an append-only `updates.bin` log that is
folded into the snapshot on open or past 8 MiB. Assets are content-addressed by blake3, the
same hashes the Rust core produces. Limits match the Rust store: update 64 MiB, thumbnail
16 MiB (PNG only), asset 256 MiB, name 1024 bytes.

There is **no migration** between `core-js/` and the native `core/`. Files created while
the fallback was active do not show up once the native core loads.

## 3. Renderer integration (screens / editor) — request

- **Cold-start signal:** once Recents is interactive (real file list rendered), run
  `window.dispatchEvent(new Event('baren:ready'))`. The preload forwards it to main
  as `rendererAppReady`. It is the cold-start number in the startup log and in
  `BAREN_SMOKE`. Without it, smoke runs fall back to first paint plus 1.5 s.
- **Native menu commands (macOS):** the preload dispatches
  `window.dispatchEvent(new CustomEvent('baren:command', { detail: id }))`. Please
  forward it with
  `addEventListener('baren:command', (e) => runCommand((e as CustomEvent<string>).detail))`.
  Ids sent: `edit.undo edit.redo edit.cut edit.copy edit.paste edit.delete edit.selectAll`
  and `help.documentation help.videoTutorials help.releaseNotes help.discord help.slack
help.reddit help.twitter`. The `help.*` ids are new, and the HTML Help menu should
  register the same ids. When a text field is focused, `edit.*` commands run natively
  (undo/copy/paste in the input) and are not dispatched.
- **Keyboard shortcuts for app commands (Linux/Windows):** main owns them through
  `before-input-event`, so the page never receives them: Ctrl+Shift+N (new window),
  Ctrl+Q, Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I, F11, Ctrl+M (minimize) and Ctrl+W (close
  window), as shown in the menu artboards (09–13). The HTML menu should only display these labels and
  call `bridge.app.*` / `bridge.window.*` on click. Do not bind them again in the renderer.
  On macOS the native menu provides them.
- **Title bar:** 36 px (the "Title bar" layer of the reference designs). Linux/Windows are
  frameless: mark the bar with `-webkit-app-region: drag` and its buttons and menus with
  `no-drag`, and draw the window controls. On macOS (`bridge.platform === 'darwin'`), hide the
  window controls and leave about 80 px on the left for the traffic lights (positioned at x=14,
  y=11).
- **CSP (production, app://):** `script-src 'self' 'wasm-unsafe-eval'` (no inline scripts,
  no eval), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob: <server>`,
  `connect-src 'self' <server http+ws origin>` (from `VITE_SERVER_URL` at build time),
  `worker-src 'self' blob:`, no frames, no objects. Remote avatars or images from other
  hosts would need a contract change.
- Bridge errors arrive as plain `Error`s that carry the main-process message, with the IPC
  prefix stripped.

## 4. Contract change proposals — request

1. **`tsconfig.preload.json`:** the preload uses DOM APIs, but `tsconfig.node.json` has no
   DOM lib. For now `src/preload/dom.d.ts` adds `/// <reference lib="dom" />`, which also
   makes DOM globals type-check in main code. Proposal: give the preload its own config with
   `lib: [ES2023, DOM]`, and remove `dom.d.ts`.
2. Consider adding `onCommand(cb)` and `app.ready()` to `BarenBridge` instead of the two
   DOM events above. That makes the coupling typed. The DOM events work today and keep the
   bridge identical to the contract.
3. `package.json` now sets `"productName": "Baren"`, so userData is
   `~/.config/Baren` (it was `~/.config/@baren/desktop`), the macOS app menu
   reads "Baren" and `WM_CLASS` matches the `.desktop` `StartupWMClass`.

## 5. Runtime switches (documented in `src/main/startup/flags.ts`)

`BAREN_SMOKE=1` (`pnpm --filter @baren/desktop smoke` after a build): hidden window,
one JSON line on stdout with startup timings, the selected backend and a bridge round trip
(create, open and remove a file through IPC, which also checks that the CSP blocks eval).
Exits 0 or 1, using a temporary userData. Other switches: `BAREN_SMOKE_TIMEOUT_MS`,
`BAREN_SMOKE_READY_GRACE_MS`, `BAREN_USER_DATA_DIR`, `BAREN_CORE`,
`BAREN_NATIVE_PATH`, `BAREN_DISABLE_GPU`, `BAREN_IGNORE_GPU_BLOCKLIST`,
`BAREN_REGISTER_PROTOCOL` (register baren:// from a dev build), `BAREN_DEBUG`.
