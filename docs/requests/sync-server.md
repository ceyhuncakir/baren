# Contract notes from sync-server

Everything below is built and tested (`cargo test -p baren-server`,
`pnpm --filter @baren/sync-client test`). Please fold these into ARCHITECTURE.md at
integration, or reject them. Operational details are in `crates/server/README.md`.

## 1. Live-sync protocol details (additions to "Live sync")

- **`0x02` goes both ways.** Whoever receives a `0x02` replies with what the sender is missing:
  the server replies with `0x03`, a client replies with `0x01`.
  - When the socket opens, the client sends `0x02(clientVV)`. The server answers with `0x03`.
    An **empty** `0x03` payload means "already in sync". The client is `synced` once it has
    this answer.
  - When a client joins, the server sends `0x02(serverVV)` and the client uploads what the
    server lacks as `0x01`. This is how offline edits reach the server. Clients do not queue
    bytes; the Loro doc itself is the offline queue.
  - Clients never send `0x03`. Unknown or unexpected frames close the socket with `4400`.
  - Clients repeat `0x02` every 25 s. This acts as a heartbeat and also as an anti-entropy pass.
- **Text frames carry a `type` field.** Server → client messages:
  - `welcome`: `{ clientId, userId, name, color, role }`. Sent once on join, and again when the
    user's role changes.
  - `presence`: the contract fields `{ userId, name, color, pageId, cursor, selection }` plus
    `clientId`, because one user can have a file open in two windows.
  - `leave`: `{ clientId, userId }`.
  - `error`: `{ code, message }`, for example `read_only` when a viewer sends an edit. Viewer
    edits are not applied.

  Client → server messages are just `{ pageId, cursor, selection }`. The server adds identity
  and a per-room colour (palette starting `#6D4AFF`, `#F04E1E` from the reference designs).

- **Close codes.** These three are terminal and the client must not retry: `4401` (bad or
  expired token), `4403` (no access, or access revoked), `4404` (the file is unknown or was
  deleted). These are retryable: `4400` (malformed frame), `4408` (heartbeat timeout), `4429`
  (client too slow; the room never blocks on a client), and `4500`/`1012` (room error or server
  restart). The server rejects bad auth _after_ the upgrade with these codes, because browsers
  hide the HTTP status of a failed upgrade.

## 2. REST additions and clarifications

- `GET /api/me` returns `{ user, teams }`, so one request is enough at startup.
- `Team` is `{ id, name, role /* caller's role */, fileAccess: 'members'|'link', memberCount, createdAt }`.
  `PATCH /api/teams/:id` takes `{ name?, fileAccess? }`, matching "File access" in artboard 03.
  With `link`, any signed-in user who has the file id gets **viewer** access.
- `Member` is `{ userId, name, email, role, joinedAt, lastSeenAt, online }`. This supports
  "Last seen" and "Active now" in artboard 02.
- **New endpoints:**
  - `POST /api/auth/resend {email}`: always returns `{ok:true}`, with a 30 s cooldown. It backs
    "Resend in 0:24".
  - `POST /api/auth/logout`.
  - `DELETE /api/teams/:id`, admin only. It backs "Delete team".
  - `GET /api/teams/:id/invites`: active invites without their tokens. They appear as
    "Invited" rows.
  - `PATCH /api/files/:id {name?, archived?}` and `DELETE /api/files/:id` (an admin or the file's
    creator).
- **Invites:**
  - `POST /api/teams/:id/invites` also accepts an optional `email`. When `expiresInDays` is
    omitted the invite expires after **14 days**. The allowed range is 1–365 days and
    `maxUses` is 1–10 000.
  - Editors may create invites, but only up to their own role.
  - A preview of an invalid invite returns `404 invite_not_found` or
    `410 invite_revoked | invite_expired | invite_used_up`.
  - Accepting is idempotent for existing members (`alreadyMember: true`), even when the link
    has since been used up.
- `POST /api/teams/:id/files` accepts an optional `snapshot` (base64 Loro snapshot or update).
  The server validates it and stores it as a snapshot. This lets "share to team" upload a local
  file in one call.
- **File names follow the document.** The server mirrors `meta.name` from the live doc into the
  file list, so renaming through `setDocName` is enough. `PATCH name` is for files whose doc has
  no name.
- Errors are always `{ error: { code, message } }`, and the codes are stable, for example
  `invalid_credentials`, `email_not_verified`, `email_taken`, `invalid_code`, `code_expired`,
  `too_many_attempts`, `rate_limited` and `last_admin`.

## 3. Product decision taken from the designs

- The team created at registration is named **"<first name>'s Team"**, for example
  "ceyhun's Team" for "ceyhun cakir". This matches artboards 02 and 03. The contract said
  "<name>'s Team".

## 4. For other workstreams

- **screens:** import `@baren/sync-client/api` (the new subpath export) in startup code. It
  never loads `loro-crdt`, so the WASM stays lazy. `@baren/sync-client` (the root export)
  adds `connectFile`.
  - Create the API client with
    `createApiClient({ baseUrl: SERVER_URL, getToken: () => bridge.auth.getToken() })`.
- **editor:**

  ```ts
  connectFile({
    baseUrl,
    token: () => bridge.auth.getToken(),
    fileId: meta.remoteId,
    doc,
    onStatus,
    onPresence,
    onWelcome,
  })
  ```

  It returns `{ setPresence, disconnect, reconnectNow, status, self, peers(), whenSynced() }`.
  - `onPresence` is coalesced to at most one call per animation frame.
  - `setPresence` merges partial updates and is throttled to 30 Hz.
  - Remote edits reach the doc as `import` events, so `subscribeNodes` reports `by: 'import'`.

- **desktop-shell:**
  - The default `CORS_ORIGINS` already allows `app://renderer` and the Vite dev ports.
  - The production CSP needs `connect-src` for both the server's `http(s)://` origin and its
    `ws(s)://` origin.
- **Config naming:** the server reads `BIND`. The skeleton's `BAREN_ADDR` is still accepted.
