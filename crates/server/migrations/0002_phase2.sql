-- baren-server schema v2 (Phase 2): password-reset codes and image assets.

-- One pending reset per account. Like email_codes, only sha256("reset:<user id>:<code>") is
-- stored; codes expire after 10 minutes and allow 5 wrong attempts.
CREATE TABLE password_resets (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash  BLOB NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Image bytes live on disk in ASSETS_DIR (content-addressed by blake3, stored once however
-- many files use them); this table describes them.
CREATE TABLE assets (
    hash       TEXT PRIMARY KEY,   -- blake3, lowercase hex
    mime       TEXT NOT NULL,      -- sniffed image type
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Which team files may use (and serve) which assets. Access to an asset always goes through
-- one of these rows, so knowing a hash is never enough to download it. Rows go away with the
-- file; assets nobody references are swept from disk after a grace period.
CREATE TABLE file_assets (
    file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    hash       TEXT NOT NULL REFERENCES assets(hash),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, hash)
) WITHOUT ROWID;
CREATE INDEX file_assets_hash ON file_assets(hash);
