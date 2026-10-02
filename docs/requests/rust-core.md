# Contract notes from rust-core

rust-core owns `crates/core` (baren-core) and `crates/napi` (`@baren/core-native`).
Everything below is built and tested. Items marked **request** need another workstream or a
contract decision at integration.

## 1. Native module shape (answers desktop-shell §1)

`crates/napi/index.d.ts` is the source of truth. The module exports
`CoreHandle` and `coreVersion()`. `apps/desktop/src/main/core/nativeBackend.ts` accepts it
unchanged: the class is named `CoreHandle`, it is constructed with the data dir, it has all 13
`CORE_METHODS` and it has `close()`. The smoke script checks this shape.

```ts
new CoreHandle(path: string, options?: { cacheCapacity?: number; compactEvery?: number; compactBytes?: number })
```

- **`path`** is either an existing directory, where the database is `<path>/baren.sqlite`,
  or the database file itself. Parent directories are created if needed. The constructor does
  not touch the disk: the database is opened and migrated by the first call, on a worker
  thread.
- **The 13 operations** have the exact names and signatures of `CoreOperations`. They return
  `Promise`s that run on the libuv pool (`AsyncTask`). Binary results are `Buffer`s, absent
  values are `null`, `FileMeta` timestamps are plain numbers, and `teamId`/`remoteId` are
  `string | null`.
- **Extras:**
  - `importFile(snapshot, name?)` creates a file from a Loro snapshot, for example a team file
    fetched from the server.
  - `setFileRemote(id, teamId, remoteId)` links a file to a server file or unlinks it.
  - `compactFile(id)` compacts now, for example when a window closes.
  - `close()` compacts open documents, checkpoints the WAL and releases the database. Call it
    at quit. Any later call rejects with `[closed]`.
- **Errors** reject with `Error`s whose message starts with a stable code:
  `[not-found] file … does not exist`, plus `[invalid-update]`, `[invalid-input]`,
  `[too-large]`, `[locked]`, `[database-too-new]`, `[db]`, `[loro]`, `[io]`, `[closed]` and
  `[internal]`. A panic inside the core becomes an `[internal]` rejection and never unwinds
  into libuv. Suggested mapping to desktop-shell's `CoreErrorCode`:
  - not-found → `NOT_FOUND`
  - invalid-\* and too-large → `INVALID_ARGUMENT`
  - loro → `CORRUPT`
  - everything else → `UNAVAILABLE`
- **One owner per database.** Each open takes an exclusive SQLite lock on
  `<database>.lock`. A second `CoreHandle` on the same database, in this process or another,
  rejects its first call with `[locked]`. The lock is released after `close()` resolves (and
  any in-flight calls finish) or when the process exits.
  - Without this lock, two owners would each cache documents and compact the shared log
    independently, and they would silently drop each other's edits.
  - desktop-shell's single-instance lock already guarantees one owner in production.
  - Two dev instances sharing `userData` now get a clear `[locked]` instead of corrupting
    data. **Request (desktop-shell):** treat `[locked]` as fatal with a readable message
    rather than falling back to the JS core.
- **Durability.** When `applyUpdate` resolves, the update has been committed (SQLite WAL,
  `synchronous=NORMAL`: safe across app crashes). `close()` is never needed for safety; it
  only compacts.
- **Concurrency.** Calls may be issued concurrently. Updates for one file may run out of order
  because the libuv pool is not FIFO. An update whose dependencies have not arrived yet is
  still persisted, and compaction keeps its log rows until the dependencies arrive. The smoke
  script fires 200 dependent updates in reverse order to test this.
- **Inputs.** `Uint8Array` or `Buffer` is read in place on the worker thread with no copy on
  the event loop. Do not mutate an input buffer until its promise settles. IPC buffers are
  fresh copies, so this is satisfied automatically.
- **Electron.** The module uses N-API 8, so no `electron-rebuild` is needed. The full smoke
  passes under `ELECTRON_RUN_AS_NODE=1` Electron 44.5.1 (Node 24.21, V8 memory cage on, which
  makes napi-rs copy `Buffer` results instead of using external buffers).
- **Build.** Run `CARGO_TARGET_DIR=<absolute path> pnpm --filter @baren/core-native build`.
  The output is `baren-core.linux-x64-gnu.node` (~6.4 MB). `pnpm --filter
@baren/core-native smoke` runs the end-to-end check. It is a `smoke` script, not `test`,
  because it needs the built binary.

## 2. Behaviour the bridge and screens can rely on

- `listFiles` returns all files, archived ones included, ordered by `updatedAt` descending
  (then id).
- `updatedAt` is bumped by `applyUpdate` (when it adds ops), `renameFile` and `archiveFile`.
  It is not bumped by `setThumbnail`, `setFileRemote` or no-op updates, so Recents order stays
  stable.
- `renameFile` also writes `meta.name` into the document, as an op from the core's peer, so
  exports agree with the file list. A renderer that has the file open sees the new name only
  after reopening.
  - In the other direction, the core mirrors `meta.name` changes from applied updates into
    the file list.
  - **Request (editor):** rename an open file with `setDocName` on the live doc. The update
    flows through `applyUpdate` and the file list follows. Use `bridge.files.rename` from
    Recents.
- `removeFile` deletes the file's history and thumbnail. Assets are shared between files and
  are kept; there is no asset GC yet.
- `openFile` returns a compacted snapshot. When no updates are pending it is a single disk
  read (8 ms cold for an 8.5 MB, 50k-node file).
- `getThumbnail` on an unknown file rejects `[not-found]`, as the mock does. `getAsset` on an
  unknown or malformed hash resolves `null`.
- Limits match the JS fallback:
  - updates and snapshots: 64 MiB;
  - assets: 256 MiB and non-empty;
  - thumbnails: 16 MiB, PNG signature required;
  - names: 1024 bytes, no NUL.
    `putAsset` lowercases the MIME type and drops its parameters. The hash is the blake3 hex of
    the bytes, the same as the JS fallback.
- `applyUpdate` rejects bytes that are empty, undecodable or fail the checksum with
  `[invalid-update]`. It accepts full snapshots, and duplicates are no-ops. `importFile`
  rejects snapshots that depend on history they do not contain.

## 3. Export formats

- **`exportJson`** prints exactly what `JSON.stringify(toSnapshot(doc), null, 2)` prints:
  the same values, layout, string escaping, ECMAScript number formatting (`1e+21`,
  `1.5e-7`) and node order. This is checked line for line against fixtures written by
  `loro-crdt`.
  - Only the key order inside `styles` and token maps can differ. That order is Loro's
    internal hash order, which differs between the wasm (32-bit) and native builds, and JSON
    gives it no meaning.
- **`exportHtml(fileId, nodeId, options?)`** returns semantic HTML with inline styles.
  - **Element mapping:**
    - page → `<main>`, with artboards absolutely positioned relative to their bounding box;
    - artboard → `<section>`, with its canvas `left`/`top` dropped and `position: relative`
      added;
    - frame and rect → `<div>`;
    - text → `<h1>`, `<h2>` or `<h3>` for font sizes of at least 32, 24 or 20 px, otherwise
      `<p>`, with the margin reset;
    - svg → inline `<svg>`, sanitised against an allowlist (scripts, handlers,
      `foreignObject` and remote URLs removed);
    - image → `<img>`.
  - **Visibility and tokens:** hidden descendants are omitted. Tokens are emitted as `:root`
    custom properties, with descriptions as comments; unsafe names and values are skipped.
  - **Escaping:** text is escaped and newlines become `<br>`. Declarations are sorted in a
    conventional order: position, layout, box, type, then visuals.
  - **Numbers:** a numeric style value gets `px` unless the property is unitless. The unitless
    list is React's (`opacity`, `lineHeight`, `fontWeight`, `zIndex`, `flex*`, …).
    **Request (canvas-engine):** render numeric styles with the same convention so that
    exports match the canvas, or tell rust-core which convention you use.
  - **Options:**
    - `document` (default `false`) produces a full HTML page;
    - `embedAssets` (default `true`) embeds images as `data:` URIs; when disabled, `src` is
      `baren-asset://<hash>` (`assetUrlPrefix`);
    - `includeNodeIds` (default `false`) adds `data-node-id` attributes.
  - The bridge signature `export.html(fileId, nodeId)` does not change; options are an extra
    optional native argument.

## 4. Rust mirror of the document model

- `baren_core::schema` mirrors `packages/schema`:
  - `create_empty_doc` writes op-for-op what `createEmptyDoc` writes. Numbers are written as
    `f64`, as JS writes them; `schemaVersion` is `1.0`.
  - `to_snapshot`, `to_subtree_snapshot`, `get_node` and `get_tokens` use the same decoding
    rules: unknown types become `frame`, non-scalar styles are dropped, and so on.
  - The mutation helpers (`create_node`, `move_node`, `delete_node`, `set_styles`,
    `set_text`, `set_tokens`, `set_doc_name`) use mergeable containers like JS but do not
    auto-commit. They are intended for the later MCP work.
  - `bench::generate_bench_doc` reproduces `generateBenchDoc`, including the same mulberry32.
- The parity fixture is generated by `crates/core/tests/fixtures/make-parity.mjs`, which
  writes `parity.loro` and `parity.{snapshot,subtree}.txt` (Node ≥ 22.18).
  - The files are `.txt` so that Prettier keeps the exact `JSON.stringify` bytes.
  - Regenerate them if the schema's decoding rules change.

## 5. Housekeeping

- `Cargo.lock` gained one line: `baren-core` now depends on `uuid` (UUIDv7 file ids). The
  dependency is already in `[workspace.dependencies]` and was already locked.
- On-disk files in the data dir are `baren.sqlite`, `baren.sqlite-wal`,
  `baren.sqlite-shm` and `baren.sqlite.lock`. `auto_vacuum=INCREMENTAL` is set, and
  `close()` returns free pages to the OS (a 50k-node file went from 17 MB to 8.6 MB).
