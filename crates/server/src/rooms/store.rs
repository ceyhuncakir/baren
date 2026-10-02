//! Room persistence: a compacted snapshot per file plus an append-only update log.
//!
//! Invariant: `files.snapshot` contains every update with `seq <= files.snapshot_seq`, and
//! `file_updates` only holds rows newer than that. Only the single live room of a file
//! writes either table for that file, so compaction (snapshot + delete covered rows) is exact.

use axum::body::Bytes;
use loro::{ExportMode, LoroDoc, LoroValue, ValueOrContainer};
use sqlx::SqlitePool;

use crate::db::now_ms;

pub struct Stored {
    pub snapshot: Option<Vec<u8>>,
    pub updates: Vec<Vec<u8>>,
    pub name: String,
}

/// Read a file's snapshot and pending updates in one consistent read. `None` if the file
/// does not exist.
pub async fn load(db: &SqlitePool, file_id: &str) -> Result<Option<Stored>, sqlx::Error> {
    let mut tx = db.begin().await?;
    let row: Option<(Option<Vec<u8>>, String)> =
        sqlx::query_as("SELECT snapshot, name FROM files WHERE id = ?")
            .bind(file_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((snapshot, name)) = row else {
        return Ok(None);
    };
    let updates: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT data FROM file_updates WHERE file_id = ? ORDER BY seq")
            .bind(file_id)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(Some(Stored {
        snapshot,
        updates,
        name,
    }))
}

/// Rebuild a document from stored bytes. Runs Loro decoding; call from a blocking thread for
/// large documents.
pub fn build_doc(stored: &Stored) -> anyhow::Result<LoroDoc> {
    let doc = LoroDoc::new();
    if let Some(snapshot) = &stored.snapshot {
        doc.import(snapshot)
            .map_err(|e| anyhow::anyhow!("importing snapshot: {e}"))?;
    }
    if !stored.updates.is_empty() {
        doc.import_batch(&stored.updates)
            .map_err(|e| anyhow::anyhow!("importing {} updates: {e}", stored.updates.len()))?;
    }
    Ok(doc)
}

/// The stored document as one Loro snapshot, without opening a room.
pub async fn snapshot_from_db(db: &SqlitePool, file_id: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(stored) = load(db, file_id).await? else {
        return Ok(None);
    };
    if stored.updates.is_empty() {
        if let Some(snapshot) = stored.snapshot {
            return Ok(Some(snapshot));
        }
    }
    let bytes = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let doc = build_doc(&stored)?;
        doc.export(ExportMode::Snapshot)
            .map_err(|e| anyhow::anyhow!("exporting snapshot: {e}"))
    })
    .await??;
    Ok(Some(bytes))
}

/// Append updates (one transaction) and bump `updated_at`; optionally mirror the document's
/// `meta.name` into the file list.
pub async fn append(
    db: &SqlitePool,
    file_id: &str,
    updates: &[Bytes],
    name: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = now_ms();
    let mut tx = db.begin().await?;
    for data in updates {
        sqlx::query("INSERT INTO file_updates (file_id, data, created_at) VALUES (?, ?, ?)")
            .bind(file_id)
            .bind(data.as_ref())
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    match name {
        Some(name) => {
            sqlx::query("UPDATE files SET name = ?, updated_at = ? WHERE id = ?")
                .bind(name)
                .bind(now)
                .bind(file_id)
                .execute(&mut *tx)
                .await?;
        }
        None => {
            sqlx::query("UPDATE files SET updated_at = ? WHERE id = ?")
                .bind(now)
                .bind(file_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await
}

/// Replace the snapshot with `snapshot` (which must include every appended row) and drop the
/// rows it covers.
pub async fn compact(db: &SqlitePool, file_id: &str, snapshot: &[u8]) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    let max_seq: Option<i64> =
        sqlx::query_scalar("SELECT MAX(seq) FROM file_updates WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&mut *tx)
            .await?;
    match max_seq {
        Some(seq) => {
            sqlx::query("UPDATE files SET snapshot = ?, snapshot_seq = ? WHERE id = ?")
                .bind(snapshot)
                .bind(seq)
                .bind(file_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM file_updates WHERE file_id = ? AND seq <= ?")
                .bind(file_id)
                .bind(seq)
                .execute(&mut *tx)
                .await?;
        }
        None => {
            sqlx::query("UPDATE files SET snapshot = ? WHERE id = ?")
                .bind(snapshot)
                .bind(file_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await
}

/// `meta.name` of a design document (see ARCHITECTURE.md, "Document model").
pub fn doc_name(doc: &LoroDoc) -> Option<String> {
    match doc.get_map("meta").get("name")? {
        ValueOrContainer::Value(LoroValue::String(s)) => {
            let name = s.trim();
            (!name.is_empty()).then(|| name.chars().take(200).collect())
        }
        _ => None,
    }
}
