# Phase 2 — server workstream notes

Implements "Server additions" of the Phase 2 contract (ARCHITECTURE.md). Accounts are email +
password only; there is no OAuth/social sign-in anywhere in the server or the client.
Details for operators are in `crates/server/README.md` (Email, Password reset, Images, Update
feed). This file lists what other workstreams need to know, and the points where the contract
left a choice open.

## For shell-ui (and anyone implementing `ApiClient`)

`@baren/sync-client/api` gained these **top-level** methods, named as in the contract
(the existing grouped methods are unchanged):

```ts
providers(): Promise<ProvidersResponse>                       // { email: boolean }
forgotPassword(email: string): Promise<void>                  // 204 always (unknown emails too)
resetPassword(email: string, code: string, password: string): Promise<AuthResponse>
changePassword(req: { currentPassword?: string; newPassword: string }): Promise<void>
resendInvite(inviteId: string): Promise<CreateInviteResponse> // new token + url (see below)
uploadAsset(fileId: string, hash: string, bytes: Uint8Array, mime: string): Promise<AssetInfo>
downloadAsset(fileId: string, hash: string): Promise<{ bytes: Uint8Array; mime: string } | null>
hasAsset(fileId: string, hash: string): Promise<boolean>
```

New exported types: `ProvidersResponse`, `ResetPasswordRequest`, `ChangePasswordRequest`,
`AssetInfo`, `DownloadedAsset`.

**`apps/desktop/src/renderer/lib/mockApi.ts` must implement them** — until it does,
`apps/desktop` typecheck fails at `mockApi.ts:111` ("missing … providers, forgotPassword,
resetPassword, changePassword, and 4 more"). That file belongs to shell-ui, which starts after
this workstream, so I did not touch it.

Error codes for UI copy (all `{ error: { code, message } }`, messages are user-facing):

| Endpoint         | Codes                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forgotPassword` | `invalid_email` (400), `rate_limited` (429, > 5 per address per 10 min)                                                                                                                                                                                             |
| `resetPassword`  | `invalid_code` (400; also for unknown accounts), `code_expired`, `too_many_attempts` (after 5 wrong codes: request a new one), `weak_password`, `rate_limited`                                                                                                      |
| `changePassword` | `current_password_required` (400), `invalid_credentials` (**400**, not 401 — don't sign the user out), `weak_password`, `rate_limited`, `unauthorized` (401)                                                                                                        |
| `resendInvite`   | `invite_has_no_email` (400), `forbidden` (403: only admins or the invite's creator), `not_found` (404), `invite_revoked` / `invite_expired` / `invite_used_up` (410), `rate_limited` (429: one re-send per invite per minute; 30 invite emails per sender per hour) |
| `uploadAsset`    | `asset_too_large` (413, > 20 MB), `hash_mismatch` (400), `unsupported_media_type` (415: not png/jpeg/webp/gif/avif), `invalid_hash` (400), `forbidden` (viewers)                                                                                                    |

Behaviour worth knowing in the UI:

- Codes are 6 digits; the server ignores spaces and dashes, so `482 719` (how the emails show
  them) can be pasted as is. Reset codes expire after 10 minutes; a new code can be requested
  every 30 s (requests inside the cooldown still answer 204 and keep the previous code valid).
- `resetPassword` signs out **every** session of the account (including other devices) and marks
  the email verified, then returns a fresh `{ token, user }`. An unverified account can therefore
  finish sign-up through "Forgot password".
- `changePassword` keeps the calling session and signs out all others.
- Revoked sessions' live WebSockets are closed with **4401** (already terminal in
  `connectFile`). This also happens on `auth.logout()` for that session's sockets.
- `providers().email` is `true` only with `MAIL_TRANSPORT=smtp`. With the default `log`
  transport, codes and invite links are printed in the server log; with `file:<dir>` they are
  written to files. Copy for `false`: "ask the server admin for your code".
- An invite created with `email` is mailed immediately. `resendInvite` **rotates the link**:
  invite tokens are stored hashed, so the old link cannot be re-sent; the previously mailed or
  copied link stops working and the response carries the new `token`/`url`. The invite keeps its
  id, role, uses and expiry.

## For images

- `uploadAsset` resolves with `{ hash, mime, size }` (HTTP 201 when newly linked to the file,
  200 when it already was). The body is always read and re-hashed, even for re-uploads, so call
  `hasAsset` first to skip the transfer (as `assetSync` already does).
- The stored `mime` is sniffed from the bytes; the `mime` argument is only the `Content-Type`
  of the request.
- Access is per file: viewers (including "anyone with the link" viewers) can download, editors
  and admins can upload. Knowing a hash alone never gives access; the same bytes uploaded to
  another file are stored once on disk.
- Downloads: `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<hash>"`. They are
  fetched with `fetch` (CORS now allows `PUT` and `HEAD`), so no CSP change is needed for them.

## For platform (auto-update)

`GET /updates/*` serves `UPDATES_DIR` with single **and multiple** byte ranges
(`multipart/byteranges`, parts in request order, never merged), which is what
electron-updater's generic provider uses for differential downloads by default
(`useMultipleRangeRequest` can stay on). 404 when `UPDATES_DIR` is unset. `.yml` is served with
`Cache-Control: no-cache`.

## Choices the contract left open

1. **`currentPassword?` is required in practice.** Every account has a password (email +
   password only), so the server answers `400 current_password_required` without it. The field
   stays optional on the wire so password-less accounts could be supported later without a
   breaking change. Accepting a missing current password would let a stolen session token lock
   the owner out.
2. **Resend rotates the invite token** (see above), because only token hashes are stored.
3. **Assets are stored on disk** (`ASSETS_DIR`, default `<db stem>-assets` next to the
   database), content-addressed by blake3, with SQLite holding `assets(hash, mime, size)` and
   `file_assets(file_id, hash)`. Bodies stream both ways. Unreferenced bytes are swept after 24 h.
4. **`MAIL_TRANSPORT=file:<dir>`** writes `<ms>-<seq>-<kind>.eml` plus a `.json` sidecar
   (`{ kind, to, subject, preheader, code, url, text, html, messageId, createdAt }`); the `.json`
   appears last, atomically. Tests read codes from it.
5. Extra settings beyond the contract: `MAIL_MAX_ATTEMPTS` (5), `MAIL_RETRY_BASE_MS` (2000),
   `ASSETS_DIR`.

## Dependencies

No packages were installed. `crates/server/Cargo.toml` now lists `blake3` (workspace),
`tokio-util` (`io`) and `futures-util` as direct dependencies; all three were already in
`Cargo.lock`, so the lockfile only gained those names in `baren-server`'s dependency list.
tower-http's `fs` feature (`ServeDir`) was **not** enabled: it needs `http-range-header` and
`mime_guess`, which are neither in `Cargo.lock` nor in the local registry cache. The update feed
uses its own small static handler instead (with multi-range support, which `ServeDir` lacks).
The reserved `smtp` cargo feature was removed; SMTP (lettre, rustls) is always built in.
