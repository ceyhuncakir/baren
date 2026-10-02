# Contract notes from foundation

These are clarifications and additions that foundation made while implementing the contract.
Each one is already built and tested. Please fold them into ARCHITECTURE.md, or reject them, at
integration.

## 1. Document model details (`@baren/schema`, mirrored by `crates/core`)

- **Mergeable child containers.** Node `data.styles` (LoroMap), `data.text` (LoroText) and each
  `tokens[<name>]` (LoroMap) are created with `ensureMergeableMap` / `ensureMergeableText`
  (loro ≥ 1.13), not `setContainer`. Two peers that lazily create the same child therefore get
  the same container and their edits merge; with `setContainer` one fork would be lost. The Rust
  core must use `ensure_mergeable_map` / `ensure_mergeable_text` for these keys.
- **Tree rules.** Only `page` nodes may be roots. Only `page` and `frame` nodes may have
  children. `text`, `rect`, `svg` and `image` are leaves. Any non-page type may sit directly under
  a page; by convention artboards are frames.
- **Every node gets an empty `styles` map at creation**, and text nodes get an empty `text`.
- **`createEmptyDoc(name)` creates one page**: "Page 1" with `background: "#EEEEEE"`, matching
  artboard 04. `meta = { name, schemaVersion: 1 }`.
- **Sibling order**: fractional index enabled with jitter 0. In `moveNode(doc, id, parentId, index)`,
  `index` is the node's **final** position among its new siblings. It is clamped, and leaving it
  out appends.

## 2. Commit semantics (important for undo, sync and events)

- Every mutating helper **commits immediately** unless it runs inside
  `transact(doc, fn, { origin })`. A transaction produces one commit, which means one event
  batch, one Loro undo step and one local update for sync. Nested `transact` calls join the
  outermost one.
- Loro emits events **after commit plus a microtask**. `subscribeNodes` delivers:
  `{ by: 'local'|'import'|'checkout', origin, changes: NodeChange[], tokens: string[], meta: boolean }`
  - `created` / `moved` / `deleted` come first, in the order they happened, with parent and index
    information.
  - `styles` (with changed keys), `text` and `props` (with changed keys) follow, deduplicated per
    node.
  - Content changes are omitted for nodes created or deleted in the same batch.
  - **Deleting a node emits one `deleted` for that node only.** Its descendants are implicitly
    gone.
- Unchanged values (the same style value, or a move to the current position) write **no op**.

## 3. Extra schema exports beyond the contract list

`transact`, `loadDoc(bytes | bytes[])`, `exportSnapshot`, `getNode`, `getChildIds`,
`getParentId`, `getNodeType`, `hasNode`, `setNodeProps` (name, locked, hidden, svg, assetId,
background), `setDocName`, `getTokens`, `toSubtreeSnapshot(doc, rootId)`, `toNodeChangeBatch`,
`benchDocNodeCount`, `SchemaError` (with a `code`), and the constants `CONTAINER`, `NODE_KEY`,
`NODE_TYPES`, `CONTAINER_NODE_TYPES`.

Measured performance, 20,041-node bench doc (Node 22, comparable in Chromium):
`generateBenchDoc` takes ~0.5 s, `toSnapshot` ~0.27 s (almost all of it in Loro's `toJSON`),
and `toSubtreeSnapshot` ~9 ms per 500-node artboard. **The canvas should hydrate visible
artboards with `toSubtreeSnapshot` rather than calling `toSnapshot` on load.**

## 4. Renderer and Electron

- `window.baren` is declared **optional** (`baren?: BarenBridge`) because it is absent
  in the browser and in Playwright. `lib/bridge.ts` exports `bridge` and `isMockBridge`.
- The preload must expose the **complete** bridge or nothing at all. The renderer treats any
  `window.baren` as complete.
- The renderer loads `loro-crdt/bundler` (an ESM wasm import) instead of its `"browser"` build,
  which compiles wasm synchronously on the main thread. Inside Electron this needs `fetch()`, so
  the placeholder main process serves the production renderer from a privileged
  **`app://renderer/`** scheme (`standard`, `secure`, `supportFetchAPI`). Desktop-shell should
  keep this, or provide an equivalent.
- No CSP is set yet. Desktop-shell should add one in production (for example through
  `session.webRequest` response headers). It needs `script-src 'self' 'wasm-unsafe-eval'` for
  Loro, and `connect-src` for the server URL and WebSocket.
- `VITE_SERVER_URL` is read in `lib/env.ts` as `SERVER_URL`. `.env` files live in `apps/desktop/`.
- The command registry (`lib/commands.ts`) **stacks** registrations per id: the latest handler
  wins, and unregistering restores the previous one. A command is enabled while any handler is
  registered. It also exports `isCommandEnabled`, `subscribeCommand`, `COMMAND_IDS` and
  `CommandId`.
