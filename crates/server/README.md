# baren-server

The collaboration backend for Baren. It handles accounts (email + password; there is
no OAuth/social sign-in), email (verification codes, password resets, team invites), teams
("parties"), invite links, team files, the images used in them, live Loro rooms and the desktop
auto-update feed. It is a single Rust binary (axum + tokio + sqlx/SQLite) with no other
services to run; email goes out through any SMTP relay. Billing does not exist.

- REST endpoints are listed in [ARCHITECTURE.md → Server API](../../ARCHITECTURE.md). Request
  and response bodies are defined in `crates/proto/src/dto.rs`, mirrored for TypeScript in
  `packages/sync-client/src/types.ts`.
- Live sync runs over `GET /ws/files/:id?token=…`. See [the protocol section](#live-sync-protocol)
  below.
- The TypeScript client is `@baren/sync-client` (`createApiClient`, `connectFile`).

## Run it locally

```sh
CARGO_TARGET_DIR=$PWD/target/sync-server cargo run -p baren-server
# → baren-server listening on http://127.0.0.1:8787 (public URL http://127.0.0.1:8787)
```

Without `SMTP_URL` nothing is sent: codes and invite links are written to the log
(`MAIL_TRANSPORT=log`, the default):

```
INFO baren_server::mailer: verification code for you@example.com: 482713 (to You; dev mailer, not sent)
INFO baren_server::mailer: password reset code for you@example.com: 604918 (to You; dev mailer, not sent)
INFO baren_server::mailer: team invite for friend@example.com: http://127.0.0.1:8787/i/… (Your Team, from You; dev mailer, not sent)
```

To see the real messages without sending them, write them to a directory instead:

```sh
MAIL_TRANSPORT=file:/tmp/baren-mail cargo run -p baren-server
# each message → /tmp/baren-mail/<ms>-<seq>-<kind>.eml (open it in any mail client)
#              + a .json sidecar { kind, to, subject, code, url, text, html }
```

Run the tests:

```sh
export CARGO_TARGET_DIR=$PWD/target/sync-server
cargo test -p baren-server -p baren-proto       # unit + integration (real server, random port)
cargo clippy -p baren-server -p baren-proto --all-targets -- -D warnings
cargo build -p baren-server                         # the binary the sync-client e2e suites spawn
pnpm --filter @baren/sync-client test               # unit + e2e (log mailer, and file mailer for Phase 2)
node crates/server/scripts/email-preview.mjs           # render the emails, compare with artboards 26–28
```

The integration tests include an SMTP run against a scripted local SMTP server (a transient
`451` that must be retried, and a check that the log never contains the code), and a
`MAIL_TRANSPORT=file:` run of register → verify → forgot → reset → login.

## Configuration

Every setting comes from an environment variable.

| Variable                | Default                                      | Meaning                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BIND`                  | `127.0.0.1:8787`                             | Listen address. Port `0` picks a free port.                                                                                                                                              |
| `DATABASE_URL`          | `sqlite://baren.db`                          | SQLite file, created if it is missing. Migrations are embedded and run at startup. Use `sqlite:///var/lib/baren/baren.db` for an absolute path.                                          |
| `PUBLIC_URL`            | `http://<bound address>`                     | External base URL used in invite (`/i/<token>`) and device (`/device?code=`) links. Set it to your `https://` domain in production.                                                      |
| `CORS_ORIGINS`          | `app://renderer` + Vite dev URLs             | Comma-separated allowed origins, or `*`. The packaged desktop app's origin is `app://renderer`.                                                                                          |
| `SESSION_TTL_DAYS`      | `30`                                         | Sliding session lifetime. Every request refreshes it, at most once per 5 minutes.                                                                                                        |
| `ROOM_IDLE_SECS`        | `30`                                         | How long a room stays loaded after its last client leaves.                                                                                                                               |
| `COMPACT_EVERY_UPDATES` | `500`                                        | Compact a room's snapshot after this many appended updates.                                                                                                                              |
| `COMPACT_INTERVAL_SECS` | `120`                                        | Compact at least this often while a room has pending updates.                                                                                                                            |
| `MAX_MESSAGE_BYTES`     | `33554432` (32 MiB)                          | Largest WebSocket message, and the largest snapshot accepted in `POST /api/teams/:id/files`.                                                                                             |
| `MAIL_TRANSPORT`        | `smtp` if `SMTP_URL` is set, else `log`      | `log` (codes and links go to the log, nothing is sent), `file:<dir>` (write `.eml` + `.json` per message) or `smtp`. See [Email](#email).                                                |
| `SMTP_URL`              | unset                                        | SMTP relay with credentials: `smtps://user:pass@host:465` (implicit TLS) or `smtp://user:pass@host:587?tls=required` (STARTTLS). Percent-encode `@ : / ?` in the user name and password. |
| `MAIL_FROM`             | `Baren <no-reply@baren.localhost>`           | Sender mailbox. **Required with SMTP**, and it must be an address your provider lets you send from.                                                                                      |
| `MAIL_MAX_ATTEMPTS`     | `5`                                          | Delivery attempts per message (transient failures only; a `5xx` reply is final).                                                                                                         |
| `MAIL_RETRY_BASE_MS`    | `2000`                                       | First retry delay; it doubles each attempt (±20 % jitter, at most 5 min).                                                                                                                |
| `ASSETS_DIR`            | `<db file stem>-assets` next to the database | Where image bytes are stored (see [Images](#images-assets)). `sqlite:///var/lib/baren/baren.db` → `/var/lib/baren/baren-assets`.                                                         |
| `UPDATES_DIR`           | unset (`/updates/*` answers 404)             | Directory served at `/updates/*`: the desktop auto-update feed. See [Update feed](#update-feed).                                                                                         |
| `RUST_LOG`              | `info`                                       | Log filter, for example `info,baren_server=debug`.                                                                                                                                       |

## Email

Three messages exist, each as HTML (600 px, table layout with inline styles, no images or
scripts, matching the artboards 26–28) plus plain text. The templates live in
[`templates/`](templates/) (`layout.html` + `<kind>.html` + `<kind>.txt`) and are compiled into
the binary:

| Kind                | Sent by                                                                       | Subject                                    |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `verification_code` | `POST /api/auth/register`, `/resend`, a login before verifying                | `482719 is your Baren verification code`   |
| `password_reset`    | `POST /api/auth/password/forgot`                                              | `604918 is your Baren password reset code` |
| `team_invite`       | `POST /api/teams/:id/invites` with an `email`, `POST /api/invites/:id/resend` | `<inviter> invited you to <team> on Baren` |

Sending never happens on the request path: handlers put the message on a bounded in-memory
queue and return. A background worker renders it and delivers up to 4 messages at a time, retrying
transient failures (connection errors, timeouts, `4xx` replies) with exponential backoff
(`MAIL_MAX_ATTEMPTS`, `MAIL_RETRY_BASE_MS`) and giving up at once on permanent ones (`5xx`).
On shutdown the server waits up to 5 s for queued mail. Log lines carry the kind, a masked
recipient (`c***@example.com`), the `Message-ID`, the attempt and the error — never the code or
the invite link (only the `log` transport prints those, on purpose).

`GET /api/auth/providers` answers `{ "email": true }` only with `MAIL_TRANSPORT=smtp`; the app
uses it to say "check your email" or "ask the server admin for your code".

### Configuring SMTP

Any SMTP relay works. Use implicit TLS (`smtps://…:465`) when the provider offers it, otherwise
STARTTLS (`smtp://…:587?tls=required`). Plain `smtp://host:25` without `tls=` is unencrypted and
only meant for a relay on the same machine. Certificates are checked against the operating
system's trust store. User names and passwords go in the URL and must be percent-encoded
(`@` → `%40`, `:` → `%3A`, `/` → `%2F`, space → `%20`); the server never logs the password. The
server checks the connection once at startup and logs a warning if it fails.

```sh
# Generic provider / your own mail server
SMTP_URL='smtps://mailer%40example.com:app-password@smtp.example.com:465'
MAIL_FROM='Baren <no-reply@example.com>'

# Resend (user name is literally "resend", password is an API key; verify your domain first)
SMTP_URL='smtps://resend:re_XXXXXXXXXXXX@smtp.resend.com:465'
MAIL_FROM='Baren <no-reply@mail.example.com>'

# Postmark (server API token as both user name and password; use a verified sender signature)
SMTP_URL='smtp://TOKEN:TOKEN@smtp.postmarkapp.com:587?tls=required'
MAIL_FROM='Baren <no-reply@example.com>'

# Gmail / Google Workspace (2-step verification on, then an app password; 16 letters, no spaces)
SMTP_URL='smtps://you%40gmail.com:abcdefghijklmnop@smtp.gmail.com:465'
MAIL_FROM='Baren <you@gmail.com>'
```

Gmail limits how many messages an account may send a day and rewrites the sender to the account
you authenticate as; use it for a small private team, and a transactional provider (Resend,
Postmark, Amazon SES, Mailgun, …) for anything bigger.

**Deliverability (SPF, DKIM, DMARC).** Mail from your own domain lands in spam or is rejected
unless the domain says who may send for it. Set these DNS records for the domain in `MAIL_FROM`
(your provider's dashboard shows the exact values):

- **SPF**: a TXT record authorising the provider for the envelope-sender (bounce) domain, e.g.
  `v=spf1 include:amazonses.com ~all` on `send.example.com` for Resend (which sends through
  SES); for Postmark, the custom Return-Path CNAME it asks for (`pm-bounces` →
  `pm.mtasv.net`) covers SPF; for Gmail/Workspace, `v=spf1 include:_spf.google.com ~all`. Only
  one SPF record per name: merge the `include:`s if you already have one.
- **DKIM**: the TXT/CNAME records the provider gives you (e.g. `resend._domainkey`,
  `<id>pm._domainkey`). The provider signs every message; nothing is configured in this server.
- **DMARC**: a TXT record on `_dmarc.example.com`, starting with
  `v=DMARC1; p=none; rua=mailto:dmarc@example.com` and tightening to `p=quarantine` once reports
  look clean.
- Use a `MAIL_FROM` address on the verified domain, and keep `PUBLIC_URL` on `https://` so the
  invite links in the emails are not flagged.

## Password reset

- `POST /api/auth/password/forgot {email}` → `204` whether or not the account exists (an invalid
  address is a `400`; more than 5 requests per address in 10 minutes is a `429 rate_limited`).
  An existing account gets a 6-digit code, at most one every 30 s; it is stored as a SHA-256
  hash, expires after 10 minutes and allows 5 wrong attempts.
- `POST /api/auth/password/reset {email, code, password}` → `{ token, user }`. Errors:
  `invalid_code` (also for unknown accounts), `code_expired`, `too_many_attempts`,
  `weak_password`, `rate_limited`. It sets the password, marks the email verified (the code
  proves the address), deletes every session of the account and closes their live WebSockets
  with `4401`, then starts a new session.
- `POST /api/auth/password/change {currentPassword?, newPassword}` (signed in) → `204`. Every
  account has a password, so `currentPassword` is required (`current_password_required`); a
  wrong one is `400 invalid_credentials` (not `401`: the session is fine). Other sessions are
  signed out (sockets closed with `4401`), the calling one stays.
- Sign-out (`POST /api/auth/logout`) also closes that session's sockets with `4401`.

## Images (assets)

`PUT`/`GET`/`HEAD /api/files/:id/assets/:hash`, where `:hash` is the blake3 of the bytes (64 hex
characters, the desktop core's asset id).

- **Storage: on disk, content-addressed**, in `ASSETS_DIR/<first 2 hex>/<hash>`: one copy
  however many files use it. SQLite only records each asset's type and size (`assets`) and which
  file may use it (`file_assets`). Bodies are streamed in both directions, so a 20 MB image never
  sits in memory, and the database stays small. Back up `ASSETS_DIR` together with the database.
- `PUT` (editors and admins): the body is streamed to `ASSETS_DIR/tmp` while it is hashed. It
  must be at most 20 MB (`413 asset_too_large`, checked from `Content-Length` before reading),
  hash to `:hash` (`400 hash_mismatch`) and be a png, jpeg, webp, gif or avif image, detected
  from its bytes whatever `Content-Type` says (`415 unsupported_media_type`). The full body is
  always required: a hash alone never links someone else's image to your file. `201` when the
  asset was added to the file, `200` when it already had it; the body is
  `{ hash, mime, size }`.
- `GET`/`HEAD` (anyone who can open the file, including "anyone with the link" viewers): the
  bytes with the detected `Content-Type`, `Cache-Control: public, max-age=31536000, immutable`,
  `ETag: "<hash>"` (`If-None-Match` → `304`), `X-Content-Type-Options: nosniff` and a sandboxing
  CSP. `404 asset_not_found` when the file has no such asset.
- Deleting a file removes its links; bytes no file references are swept from disk after 24 h by
  the background purge task (every 10 minutes).

## Update feed

With `UPDATES_DIR` set, `GET`/`HEAD /updates/<path>` serves files from that directory for
electron-updater's generic provider (`latest-linux.yml`, the AppImage/deb/rpm files and their
`.blockmap`s): `Accept-Ranges: bytes`, single ranges (`206`), multiple ranges
(`206 multipart/byteranges`, parts in request order and never merged, as electron-updater's
differential download expects), `If-Range`, `ETag`/`Last-Modified` and `304`s. `.yml`/`.json`
are sent with `Cache-Control: no-cache`, everything else with `max-age=3600`. Hidden files,
`..`, directories and symlinks that leave the directory answer `404`; so does everything when
`UPDATES_DIR` is unset. `pnpm release:linux` builds the files and `RELEASE_TARGET=user@host:/path`
rsyncs them into `UPDATES_DIR`.

## Live sync protocol

Binary frames are `[type, ...payload]`:

| Type   | Direction       | Payload                                                                                        |
| ------ | --------------- | ---------------------------------------------------------------------------------------------- |
| `0x01` | both            | Loro update. The server imports it, fans it out to the other clients and appends it to SQLite. |
| `0x02` | both            | Encoded version vector of the sender's oplog (a sync request).                                 |
| `0x03` | server → client | Updates the requester is missing. An empty payload means it is already in sync.                |

1. The client sends `0x02(clientVV)` when the socket opens. The server answers with `0x03`, and
   the client reports `synced` once that answer arrives.
2. When a client joins, the server sends `0x02(serverVV)`. The client answers with `0x01`
   carrying everything the server lacks. This is how offline edits get uploaded. The client
   queues nothing itself, because the document is the queue.
3. Each local commit is then sent as one `0x01`. The client repeats `0x02` every 25 s. This
   works as a heartbeat and also as an anti-entropy pass that picks up anything missed.

Text frames carry presence and are never persisted. A client sends
`{ pageId, cursor: {x,y}|null, selection: string[], transient? }` at most 30 times a second.
`transient` is an optional in-progress move/resize (`{ kind: 'move'|'resize', nodes: [{ id, rect:
{x,y,width,height} }] }` or `null`), which the canvas draws as ghosts; the server validates it
(finite numbers, bounded size) and relays it. The server fills in `userId`, `name` and a per-room
`color`, so clients cannot spoof them. The server sends these
JSON messages, each tagged with a `type` field:

- `welcome`: `{ clientId, userId, name, color, role }`. Sent once on join, and again if the
  user's role changes.
- `presence`: the contract fields plus `clientId`.
- `leave`: `{ clientId, userId }`.
- `error`: `{ code, message }`. For example, `read_only` is sent when a viewer tries to edit.

The server closes connections with these codes:

| Code          | Meaning                                        | Client should          |
| ------------- | ---------------------------------------------- | ---------------------- |
| `4401`        | Missing or expired token                       | Stop and sign in again |
| `4403`        | No access to the file, or access was revoked   | Stop                   |
| `4404`        | The file does not exist or was deleted         | Stop                   |
| `4400`        | Malformed frame or update                      | Reconnect              |
| `4408`        | No traffic for 3 ping intervals                | Reconnect              |
| `4429`        | The client fell `client_queue` messages behind | Reconnect (and resync) |
| `4500`/`1012` | Room error, or the server is restarting        | Reconnect              |

### How rooms work

- Each open file runs as one tokio task that owns the file's `LoroDoc`. Connections talk to it
  through bounded queues. The room never waits on a client. If a client's outbound queue is
  full, the room drops that client with `4429`, and the version-vector handshake catches it up
  when it reconnects. Presence is lossy and is dropped instead.
- Writes are group-committed. The room drains its queue, fans updates out immediately, then
  appends the whole batch to `file_updates` in one SQLite transaction.
- Every 500 updates or every 2 minutes, the full-history snapshot in `files.snapshot` is
  rewritten and the update rows it covers are deleted. The same happens when a room unloads
  and when the server shuts down.
- A room unregisters itself only after its final compaction. The next visitor therefore always
  loads the complete document, and two rooms never write the same file.
- If a client sends a malformed update, only that client is disconnected. A Loro panic shuts
  down the room without persisting the offending update.

On loopback, `cargo test` measures a remote edit (A → server → B) at about 0.1 ms p50 and
0.3 ms p99. Eight peers editing at once converge at about 0.3 ms per edit.

## Deploying to a small VPS

These steps use one VM (1 vCPU / 1 GB RAM is plenty for small teams), systemd, and Caddy for
TLS and the WebSocket upgrade. Replace `sync.example.com` with your domain and point its DNS
`A`/`AAAA` records at the VM.

### 1. Build and install the binary

```sh
# On a build machine with the same OS/libc as the VPS (or on the VPS itself):
cargo build --release -p baren-server
scp target/release/baren-server vps:/tmp/

# On the VPS:
sudo install -m 0755 /tmp/baren-server /usr/local/bin/baren-server
sudo useradd --system --home /var/lib/baren --shell /usr/sbin/nologin baren
```

SQLite is compiled into the binary, so there is nothing else to install.

### 2. systemd unit

Create `/etc/systemd/system/baren-server.service`:

```ini
[Unit]
Description=Baren sync server
After=network-online.target
Wants=network-online.target

[Service]
User=baren
Group=baren
ExecStart=/usr/local/bin/baren-server
Environment=BIND=127.0.0.1:8787
Environment=DATABASE_URL=sqlite:///var/lib/baren/baren.db
Environment=PUBLIC_URL=https://sync.example.com
Environment=CORS_ORIGINS=app://renderer
Environment=RUST_LOG=info
# Email (see "Configuring SMTP"). Keep the secret out of the unit file:
#   /etc/baren/mail.env (mode 0600) with SMTP_URL=… and MAIL_FROM=…
EnvironmentFile=-/etc/baren/mail.env
# Image bytes (default: next to the database, inside StateDirectory) and the update feed.
Environment=ASSETS_DIR=/var/lib/baren/assets
Environment=UPDATES_DIR=/srv/baren/updates
# /var/lib/baren, owned by the service user.
StateDirectory=baren
# SIGTERM makes the server close rooms (flushing and compacting every document) before exiting.
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
RestartSec=2
LimitNOFILE=65536

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now baren-server
journalctl -u baren-server -f          # codes appear here only with MAIL_TRANSPORT=log
```

### 3. Caddy (TLS and WebSockets)

Install Caddy from its official package repository, then write `/etc/caddy/Caddyfile`:

```caddyfile
sync.example.com {
	# reverse_proxy passes WebSocket upgrades (/ws/files/...) through automatically and
	# streams frames without buffering.
	reverse_proxy 127.0.0.1:8787 {
		# Caddy closes WebSockets on config reloads; keep them up a while instead of
		# making every editor reconnect at once. (No stream_timeout: rooms are long-lived,
		# and the server pings every 25 s.)
		stream_close_delay 5m
	}

	encode zstd gzip

	log {
		output file /var/log/caddy/baren.log
		format filter {
			# WebSocket URLs carry the session token as ?token=...; never write it to disk.
			request>uri query {
				delete token
			}
			request>headers>Authorization delete
			request>headers>Cookie delete
		}
	}
}
```

```sh
sudo systemctl reload caddy
curl https://sync.example.com/health      # → ok
curl -I https://sync.example.com/updates/latest-linux.yml   # → 200 once a release is published
```

Caddy gets and renews the Let's Encrypt certificate itself. Open only ports 80 and 443 in the
firewall (`ufw allow 80,443/tcp`). The server listens on loopback only.

### 4. Point the desktop app at it

Build the renderer with `VITE_SERVER_URL=https://sync.example.com` (in `apps/desktop/.env`).
The packaged app's origin is `app://renderer`, which is why `CORS_ORIGINS` contains it (CORS
allows `GET HEAD POST PUT PATCH DELETE`; `PUT`/`HEAD` are the asset endpoints). The production
Content-Security-Policy (`connect-src`, `img-src`) is derived from the same `VITE_SERVER_URL` at
build time, so there is nothing to add by hand. The auto-update feed defaults to
`<VITE_SERVER_URL>/updates/`; `pnpm release:linux` builds the packages with both baked in.

### Backups and upgrades

- The database is a single SQLite file in WAL mode. Back it up online with
  `sqlite3 /var/lib/baren/baren.db ".backup '/var/backups/baren-$(date +%F).db'"`,
  for example from a daily systemd timer. Back up `ASSETS_DIR` too (images are immutable files,
  so `rsync -a` is enough; copy the database first so every asset it references exists).
- The update feed is just files: publish a release by rsyncing it into `UPDATES_DIR` (the
  service only reads it, so a separate deploy user can own the directory).
- To upgrade, install the new binary and run `systemctl restart baren-server`. Migrations run
  at startup. Clients reconnect on their own with backoff and resync through the handshake, so a
  restart loses no edits.
- Memory use scales with the documents that are open: each open room keeps its `LoroDoc`
  in RAM, and a room unloads `ROOM_IDLE_SECS` after its last client leaves.

### Before going public

- Configure SMTP (and SPF/DKIM/DMARC) before opening sign-ups: with the default `log` transport
  an operator has to pass codes on, which is fine for a private team.
- Login, verify, resend, password reset and invite emails are rate-limited per address/sender
  in memory. Add an IP-based limit in Caddy (for example the `caddy-ratelimit` module) if you
  expect abuse.
