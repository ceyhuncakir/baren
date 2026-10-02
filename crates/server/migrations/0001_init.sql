-- baren-server schema v1. Timestamps are Unix milliseconds. Secrets (session tokens,
-- invite tokens, device codes, email codes) are stored as SHA-256 hashes only.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER
);

CREATE TABLE sessions (
    token_hash   BLOB PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE email_codes (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash  BLOB NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE device_codes (
    id               TEXT PRIMARY KEY,
    device_code_hash BLOB NOT NULL UNIQUE,
    user_code        TEXT NOT NULL UNIQUE,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL
);
CREATE INDEX device_codes_expiry ON device_codes(expires_at);

CREATE TABLE teams (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    file_access TEXT NOT NULL DEFAULT 'members' CHECK (file_access IN ('members', 'link')),
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE memberships (
    team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id)
) WITHOUT ROWID;
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invites (
    id         TEXT PRIMARY KEY,
    team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    token_hash BLOB NOT NULL UNIQUE,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    email      TEXT,
    max_uses   INTEGER,
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX invites_team ON invites(team_id);

CREATE TABLE files (
    id           TEXT PRIMARY KEY,
    team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    archived     INTEGER NOT NULL DEFAULT 0,
    -- Compacted Loro snapshot (full history) covering every update with seq <= snapshot_seq.
    snapshot     BLOB,
    snapshot_seq INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX files_team ON files(team_id, updated_at DESC);

-- Append-only Loro updates since the last compaction.
CREATE TABLE file_updates (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    data       BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX file_updates_file ON file_updates(file_id, seq);
