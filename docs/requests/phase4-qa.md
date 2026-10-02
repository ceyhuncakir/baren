# Phase 4 — QA workstream: contract requests

QA workstream, 2026-10-02. The QA fixes changed behaviour that `docs/phase4/contract.md` states
differently, or does not state. The architect should record these in the contract. The tests are
`apps/desktop/tests/mcp/qa-*.spec.ts` (opt-in, `BAREN_MCP_E2E=1`) plus the unit tests named
below.

1. **§4.1 rate limit.** Only requests that send an `Authorization` header with a wrong token count
   towards "30 failures in 60 s → 429". Requests without an `Authorization` header still get 401
   but are not counted. Otherwise any web page could lock out the user's agent for a minute:
   `<img src="http://127.0.0.1:29170/mcp">` sends no `Origin` header and no credentials, so it
   gets past the `Origin` check. Tests: `security.test.ts` and `qa-security`.
2. **§4.12 stdio shim.** Besides 404 (the app restarted), the shim re-establishes its session in
   two more cases:
   - a 401 while `config.json` holds a different token (the token was regenerated);
   - a network error while `endpoint.json` names a different URL (the app came back on another
     port).

   This is what "stdio configurations keep working" (§3.2) needs for a shim that is already
   running. Tests: `shim.test.ts` and `qa-restart`.

3. **§4.5 hosts.**
   - Requests take a lease on a headless host. Making room in the pool (LRU), idle release and
     handoff never release a host that is serving a request; the waiting file starts its host
     once a slot is free. Before this, with five files at once, one call failed with `cancelled`.
     A handoff lets reads already on their way finish first (at most 10 s).
   - When a request to a headless host times out, main pings the host (`flush`, 2 s). If the ping
     times out too, main destroys the host. Requests that arrive meanwhile wait for the result,
     and the next request opens the file in a new host. This implements §13 ("a hung renderer
     costs one request").
   - `resolveFile` trusts only a visible window that has the file open. A headless host no longer
     counts as proof that the file exists. When the user deleted the file from Home, writes used
     to report success and were lost; they now fail with `file_not_found`, and the host is
     released.

   Tests: `hosts.test.ts` and `qa-robustness`.

4. **§4.6 internal tools.** `artboards_of` and `render_job` answer with the file header (`release`
   and `flush` still do not). Before this, `get_screenshot` and `get_computed_styles` with
   `resolved: true` were missing the header block. Test: `dispatch.test.ts`.
5. **§11.7 runtime reads.**
   - `resolveRef` caches resolved nodes for as long as the document's op count stays the same.
     Loro counts pending ops too, so any change, including one inside a transaction, invalidates
     the cache.
   - The doc index re-reads each node once per change batch.
   - `get_basic_info` finishes a warm-up that is already running instead of walking the Loro
     tree on every call.
6. **Outside Phase 4 ownership (performance bugs, fixed minimally).**
   - `packages/schema` `createNode` no longer counts the parent's children when it appends (no
     `index`). Loro has no child count, so creating N children of one parent was O(N²).
   - `packages/canvas` `collectFits` looks up each ancestor's type once per batch.

   Together with item 5: a 3,600-layer `write_html` took 7.8 s and now takes 0.6–0.7 s. An
   `update_styles` right after a large write took 10–12 s and now takes about 0.4 s.

## Resolution (integration, 2026-10-02)

All six items are recorded in `docs/phase4/contract.md` §17.1 (items 1, 3, 4, 7), §17.2 (item 5)
and §17.5, with in-place pointers from §4.1, §4.5, §4.6, §4.12, §11.7 and §1. The QA numbers are
in `docs/STATUS.md` (re-measured in this run). The 35 MCP specs pass against the integration
build.
