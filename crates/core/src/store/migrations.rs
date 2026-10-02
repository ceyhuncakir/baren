//! Schema migrations, tracked with `PRAGMA user_version`. Append new steps;
//! never edit a shipped one.

use rusqlite::Connection;

use crate::error::{CoreError, Result};

const MIGRATIONS: &[&str] = &[
    // v1 — initial layout.
    r#"
    CREATE TABLE files (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        team_id     TEXT,
        remote_id   TEXT
    );
    CREATE INDEX files_by_updated ON files (updated_at DESC);

    -- Latest compacted Loro snapshot per file (state + history).
    CREATE TABLE file_snapshots (
        file_id     TEXT PRIMARY KEY NOT NULL REFERENCES files (id) ON DELETE CASCADE,
        bytes       BLOB NOT NULL,
        created_at  INTEGER NOT NULL
    );

    -- Append-only Loro updates not yet folded into the snapshot.
    -- AUTOINCREMENT keeps seq strictly increasing even after compaction
    -- deletes the newest rows.
    CREATE TABLE file_updates (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id     TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
        bytes       BLOB NOT NULL,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX file_updates_by_file ON file_updates (file_id, seq);

    -- Content-addressed blobs (blake3 hex); shared by every file.
    CREATE TABLE assets (
        hash        TEXT PRIMARY KEY NOT NULL,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        bytes       BLOB NOT NULL,
        created_at  INTEGER NOT NULL
    );

    CREATE TABLE thumbnails (
        file_id     TEXT PRIMARY KEY NOT NULL REFERENCES files (id) ON DELETE CASCADE,
        png         BLOB NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    "#,
];

/// Latest schema version this build understands.
pub(crate) const LATEST: i64 = MIGRATIONS.len() as i64;

pub(crate) fn run(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current > LATEST {
        return Err(CoreError::DatabaseTooNew {
            found: current,
            supported: LATEST,
        });
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}
