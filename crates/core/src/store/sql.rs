//! Every SQL statement the store runs, as small functions over a connection.
//! All statements go through `prepare_cached`, so each is compiled once per
//! connection.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::FileMeta;
use crate::error::{CoreError, Result};

const FILE_COLUMNS: &str = "id, name, created_at, updated_at, archived, team_id, remote_id";

fn file_from_row(r: &Row<'_>) -> rusqlite::Result<FileMeta> {
    Ok(FileMeta {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        archived: r.get(4)?,
        team_id: r.get(5)?,
        remote_id: r.get(6)?,
    })
}

pub(crate) fn list_files(c: &Connection) -> Result<Vec<FileMeta>> {
    let mut stmt = c.prepare_cached(&format!(
        "SELECT {FILE_COLUMNS} FROM files ORDER BY updated_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([], file_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn get_file(c: &Connection, id: &str) -> Result<FileMeta> {
    let mut stmt = c.prepare_cached(&format!("SELECT {FILE_COLUMNS} FROM files WHERE id = ?1"))?;
    stmt.query_row([id], file_from_row)
        .optional()?
        .ok_or_else(|| CoreError::FileNotFound(id.to_owned()))
}

/// Insert a file row and its initial snapshot atomically.
pub(crate) fn insert_file(c: &mut Connection, meta: &FileMeta, snapshot: &[u8]) -> Result<()> {
    let tx = c.transaction()?;
    tx.prepare_cached(
        "INSERT INTO files (id, name, created_at, updated_at, archived, team_id, remote_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?
    .execute(params![
        meta.id,
        meta.name,
        meta.created_at,
        meta.updated_at,
        meta.archived,
        meta.team_id,
        meta.remote_id
    ])?;
    tx.prepare_cached(
        "INSERT INTO file_snapshots (file_id, bytes, created_at) VALUES (?1, ?2, ?3)",
    )?
    .execute(params![meta.id, snapshot, meta.created_at])?;
    tx.commit()?;
    Ok(())
}

fn expect_one(changed: usize, id: &str) -> Result<()> {
    if changed == 0 {
        Err(CoreError::FileNotFound(id.to_owned()))
    } else {
        Ok(())
    }
}

pub(crate) fn set_archived(c: &Connection, id: &str, archived: bool, now: i64) -> Result<()> {
    let n = c
        .prepare_cached("UPDATE files SET archived = ?2, updated_at = ?3 WHERE id = ?1")?
        .execute(params![id, archived, now])?;
    expect_one(n, id)
}

pub(crate) fn set_remote(
    c: &Connection,
    id: &str,
    team_id: Option<&str>,
    remote_id: Option<&str>,
) -> Result<()> {
    let n = c
        .prepare_cached("UPDATE files SET team_id = ?2, remote_id = ?3 WHERE id = ?1")?
        .execute(params![id, team_id, remote_id])?;
    expect_one(n, id)
}

pub(crate) fn delete_file(c: &Connection, id: &str) -> Result<()> {
    // Snapshots, updates and thumbnails go with it (ON DELETE CASCADE).
    let n = c
        .prepare_cached("DELETE FROM files WHERE id = ?1")?
        .execute([id])?;
    expect_one(n, id)
}

/// What a file's document is made of on disk.
pub(crate) struct StoredDoc {
    pub snapshot: Option<Vec<u8>>,
    /// `(seq, bytes)` in append order.
    pub updates: Vec<(i64, Vec<u8>)>,
}

/// Read the snapshot and pending updates in one read transaction.
pub(crate) fn load_doc(c: &Connection, id: &str) -> Result<StoredDoc> {
    let tx = c.unchecked_transaction()?;
    let snapshot: Option<Option<Vec<u8>>> = tx
        .prepare_cached(
            "SELECT (SELECT bytes FROM file_snapshots WHERE file_id = f.id)
             FROM files f WHERE f.id = ?1",
        )?
        .query_row([id], |r| r.get(0))
        .optional()?;
    let snapshot = snapshot.ok_or_else(|| CoreError::FileNotFound(id.to_owned()))?;
    let updates = tx
        .prepare_cached("SELECT seq, bytes FROM file_updates WHERE file_id = ?1 ORDER BY seq")?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    tx.finish()?;
    Ok(StoredDoc { snapshot, updates })
}

/// The stored snapshot when no updates are pending — lets `open_file` skip
/// loading the document. `Ok(None)` means updates are pending.
pub(crate) fn clean_snapshot(c: &Connection, id: &str) -> Result<Option<Vec<u8>>> {
    let row: Option<(Option<Vec<u8>>, bool)> = c
        .prepare_cached(
            "SELECT (SELECT bytes FROM file_snapshots WHERE file_id = f.id),
                    EXISTS (SELECT 1 FROM file_updates WHERE file_id = f.id)
             FROM files f WHERE f.id = ?1",
        )?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match row {
        None => Err(CoreError::FileNotFound(id.to_owned())),
        Some((Some(snapshot), false)) => Ok(Some(snapshot)),
        Some(_) => Ok(None),
    }
}

/// Append one update and bump `updated_at` (and `name` when the document's
/// `meta.name` changed). Returns the update's seq.
pub(crate) fn append_update(
    c: &mut Connection,
    id: &str,
    bytes: &[u8],
    now: i64,
    rename: Option<&str>,
) -> Result<i64> {
    let tx = c.transaction()?;
    tx.prepare_cached("INSERT INTO file_updates (file_id, bytes, created_at) VALUES (?1, ?2, ?3)")?
        .execute(params![id, bytes, now])?;
    let seq = tx.last_insert_rowid();
    let n = match rename {
        Some(name) => tx
            .prepare_cached("UPDATE files SET updated_at = ?2, name = ?3 WHERE id = ?1")?
            .execute(params![id, now, name])?,
        None => tx
            .prepare_cached("UPDATE files SET updated_at = ?2 WHERE id = ?1")?
            .execute(params![id, now])?,
    };
    expect_one(n, id)?;
    tx.commit()?;
    Ok(seq)
}

/// Rename without a document op (used when the doc already has the name).
pub(crate) fn set_name(c: &Connection, id: &str, name: &str, now: i64) -> Result<()> {
    let n = c
        .prepare_cached("UPDATE files SET name = ?2, updated_at = ?3 WHERE id = ?1")?
        .execute(params![id, name, now])?;
    expect_one(n, id)
}

/// Replace the snapshot and, when `fold_upto` is set, delete the updates it
/// now contains — atomically, so a crash leaves either the old or new state.
pub(crate) fn write_snapshot(
    c: &mut Connection,
    id: &str,
    bytes: &[u8],
    now: i64,
    fold_upto: Option<i64>,
) -> Result<()> {
    let tx = c.transaction()?;
    tx.prepare_cached(
        "INSERT INTO file_snapshots (file_id, bytes, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (file_id) DO UPDATE SET bytes = excluded.bytes, created_at = excluded.created_at",
    )?
    .execute(params![id, bytes, now])?;
    if let Some(seq) = fold_upto {
        tx.prepare_cached("DELETE FROM file_updates WHERE file_id = ?1 AND seq <= ?2")?
            .execute(params![id, seq])?;
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn put_asset(
    c: &Connection,
    hash: &str,
    mime: &str,
    bytes: &[u8],
    now: i64,
) -> Result<()> {
    c.prepare_cached(
        "INSERT INTO assets (hash, mime, size, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (hash) DO NOTHING",
    )?
    .execute(params![hash, mime, bytes.len() as i64, bytes, now])?;
    Ok(())
}

pub(crate) fn get_asset(c: &Connection, hash: &str) -> Result<Option<(Vec<u8>, String)>> {
    Ok(
        c.prepare_cached("SELECT bytes, mime FROM assets WHERE hash = ?1")?
            .query_row([hash], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?,
    )
}

pub(crate) fn set_thumbnail(c: &mut Connection, id: &str, png: &[u8], now: i64) -> Result<()> {
    let tx = c.transaction()?;
    let exists: bool = tx
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM files WHERE id = ?1)")?
        .query_row([id], |r| r.get(0))?;
    expect_one(usize::from(exists), id)?;
    tx.prepare_cached(
        "INSERT INTO thumbnails (file_id, png, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (file_id) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at",
    )?
    .execute(params![id, png, now])?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn get_thumbnail(c: &Connection, id: &str) -> Result<Option<Vec<u8>>> {
    let row: Option<Option<Vec<u8>>> = c
        .prepare_cached(
            "SELECT t.png FROM files f LEFT JOIN thumbnails t ON t.file_id = f.id WHERE f.id = ?1",
        )?
        .query_row([id], |r| r.get(0))
        .optional()?;
    row.ok_or_else(|| CoreError::FileNotFound(id.to_owned()))
}

/// Return free pages to the OS, fold the WAL into the main file and refresh
/// query-planner statistics. Best effort under concurrent readers (SQLite
/// then checkpoints what it can).
pub(crate) fn checkpoint(c: &Connection) -> Result<()> {
    // Each step frees one page, so drain the statement.
    let mut vacuum = c.prepare("PRAGMA incremental_vacuum")?;
    let mut rows = vacuum.query([])?;
    while rows.next()?.is_some() {}
    drop(rows);
    c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    c.execute_batch("PRAGMA optimize")?;
    Ok(())
}
