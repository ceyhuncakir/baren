//! SQLite connections: one writer plus a small pool of readers (WAL mode lets
//! readers run concurrently with the writer). Each connection is owned by a
//! mutex, so SQLite runs in its cheaper multi-thread (no-mutex) mode.
//!
//! A database has exactly one owner: an exclusive lock on `<db>.lock` is held
//! for the lifetime of the `Db`. Two owners would each cache documents and
//! compact the shared update log independently, silently dropping each
//! other's edits, so a second open fails with `CoreError::Locked` instead.
//! The OS releases the lock if the process dies.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::migrations;
use crate::error::{CoreError, Result};
use crate::util::{lock, try_lock};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const STATEMENT_CACHE: usize = 32;

pub(crate) struct Db {
    writer: Mutex<Connection>,
    readers: Box<[Mutex<Connection>]>,
    next_reader: AtomicUsize,
    /// Holds the owner lock; released when dropped.
    _owner: Mutex<Connection>,
}

impl Db {
    pub(crate) fn open(path: &Path, readers: usize) -> Result<Db> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let owner = acquire_owner_lock(path)?;
        let mut writer = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        configure(&writer)?;
        // Only takes effect while the database is still empty (i.e. before
        // migration v1 creates tables). Compaction rewrites large snapshot
        // blobs; incremental vacuum lets `flush` hand the freed pages back.
        writer.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
        // WAL: readers never block the writer and commits are a single append.
        // NORMAL is durable across app crashes; only an OS crash/power loss can
        // drop the last few commits (the standard WAL trade-off).
        writer.pragma_update(None, "journal_mode", "WAL")?;
        writer.pragma_update(None, "synchronous", "NORMAL")?;
        writer.pragma_update(None, "foreign_keys", true)?;
        writer.pragma_update(None, "journal_size_limit", 64 * 1024 * 1024)?;
        migrations::run(&mut writer)?;

        let readers = (0..readers.max(1))
            .map(|_| open_reader(path).map(Mutex::new))
            .collect::<Result<Vec<_>>>()?;
        Ok(Db {
            writer: Mutex::new(writer),
            readers: readers.into_boxed_slice(),
            next_reader: AtomicUsize::new(0),
            _owner: Mutex::new(owner),
        })
    }

    /// Run `f` on the writer connection (serialised).
    pub(crate) fn write<R>(&self, f: impl FnOnce(&mut Connection) -> Result<R>) -> Result<R> {
        f(&mut lock(&self.writer))
    }

    /// Run `f` on an idle reader connection (or wait for one).
    pub(crate) fn read<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        let n = self.readers.len();
        let start = self.next_reader.fetch_add(1, Ordering::Relaxed) % n;
        for i in 0..n {
            if let Some(conn) = try_lock(&self.readers[(start + i) % n]) {
                return f(&conn);
            }
        }
        f(&lock(&self.readers[start]))
    }
}

fn lock_path(db: &Path) -> PathBuf {
    let mut name = OsString::from(db.as_os_str());
    name.push(".lock");
    PathBuf::from(name)
}

/// Take an exclusive SQLite lock on `<db>.lock` and keep it: in
/// `locking_mode=EXCLUSIVE` a connection keeps its lock after the first write
/// transaction until it is closed.
fn acquire_owner_lock(db: &Path) -> Result<Connection> {
    let path = lock_path(db);
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::ZERO)?;
    conn.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
    let taken = conn.execute_batch(
        "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (n INTEGER); \
         DELETE FROM owner; INSERT INTO owner VALUES (1); COMMIT;",
    );
    match taken {
        Ok(()) => Ok(conn),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            Err(CoreError::Locked(db.display().to_string()))
        }
        Err(e) => Err(e.into()),
    }
}

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // Negative = KiB: 16 MiB page cache per connection.
    conn.pragma_update(None, "cache_size", -16_000)?;
    Ok(())
}

fn open_reader(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}
