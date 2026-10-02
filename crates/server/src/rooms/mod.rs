//! Live rooms: one task per open file (see [`actor`]), a registry that maps file ids to room
//! tasks, and the WebSocket endpoint (see [`ws`]).
//!
//! Lifecycle invariant: a room removes itself from the registry only after its final flush and
//! compaction, and only while its queue is empty (checked under the registry lock). A later
//! visitor therefore always spawns a fresh room that loads the complete document, and two
//! rooms never write the same file concurrently.

pub mod actor;
pub mod store;
pub mod ws;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use baren_proto::dto::Role;
use baren_proto::wire::close_code;
use sqlx::SqlitePool;
use tokio::sync::{mpsc, oneshot};

use crate::config::Config;
use actor::{ClientInit, JoinError, RoomCmd};

/// WebSocket close code 1012 ("service restart").
const SERVICE_RESTART: u16 = 1012;

#[derive(Debug, Clone, Copy)]
pub struct RoomSettings {
    pub room_idle: Duration,
    pub compact_every_updates: usize,
    pub compact_interval: Duration,
    pub room_queue: usize,
}

impl RoomSettings {
    pub fn from_config(config: &Config) -> Self {
        Self {
            room_idle: config.room_idle,
            compact_every_updates: config.compact_every_updates.max(1),
            compact_interval: config.compact_interval,
            room_queue: config.room_queue.max(16),
        }
    }
}

#[derive(Clone)]
struct RoomEntry {
    tx: mpsc::Sender<RoomCmd>,
    generation: u64,
}

pub struct Registry {
    rooms: Mutex<HashMap<String, RoomEntry>>,
    /// Live WebSocket connections per user, for `online` in the member list.
    online: Mutex<HashMap<String, usize>>,
    next_generation: AtomicU64,
    closing: AtomicBool,
    db: SqlitePool,
    settings: RoomSettings,
}

impl Registry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RoomEntry>> {
        self.rooms.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forget a room if the registered one is still `generation`.
    pub(crate) fn remove(&self, file_id: &str, generation: u64) {
        let mut rooms = self.lock();
        if rooms
            .get(file_id)
            .is_some_and(|e| e.generation == generation)
        {
            rooms.remove(file_id);
        }
    }

    /// Forget a room if it is still `generation` and `can_remove()` holds while the registry is
    /// locked. Returns true when the room may exit (removed now, or already replaced).
    pub(crate) fn remove_if(
        &self,
        file_id: &str,
        generation: u64,
        can_remove: impl FnOnce() -> bool,
    ) -> bool {
        let mut rooms = self.lock();
        match rooms.get(file_id) {
            Some(entry) if entry.generation == generation => {
                if can_remove() {
                    rooms.remove(file_id);
                    true
                } else {
                    false
                }
            }
            _ => true,
        }
    }
}

/// Handle to the room registry (cheap to clone).
#[derive(Clone)]
pub struct Rooms {
    inner: Arc<Registry>,
}

impl Rooms {
    pub fn new(db: SqlitePool, settings: RoomSettings) -> Self {
        Self {
            inner: Arc::new(Registry {
                rooms: Mutex::new(HashMap::new()),
                online: Mutex::new(HashMap::new()),
                next_generation: AtomicU64::new(1),
                closing: AtomicBool::new(false),
                db,
                settings,
            }),
        }
    }

    /// The running room for `file_id`, spawning it when `spawn` is set.
    fn entry(&self, file_id: &str, spawn: bool) -> Option<RoomEntry> {
        let mut rooms = self.inner.lock();
        if let Some(entry) = rooms.get(file_id) {
            return Some(entry.clone());
        }
        if !spawn {
            return None;
        }
        let (tx, rx) = mpsc::channel(self.inner.settings.room_queue);
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let entry = RoomEntry { tx, generation };
        rooms.insert(file_id.to_string(), entry.clone());
        tokio::spawn(actor::run(
            file_id.to_string(),
            generation,
            self.inner.db.clone(),
            self.inner.settings,
            rx,
            Arc::clone(&self.inner),
        ));
        Some(entry)
    }

    /// Join (spawning if needed) the room for `file_id`. Retries when it races with a room
    /// that is shutting down.
    pub(crate) async fn join(
        &self,
        file_id: &str,
        client: ClientInit,
    ) -> Result<mpsc::Sender<RoomCmd>, JoinError> {
        for _ in 0..3 {
            if self.inner.closing.load(Ordering::Relaxed) {
                return Err(JoinError::Unavailable);
            }
            let Some(entry) = self.entry(file_id, true) else {
                return Err(JoinError::Unavailable);
            };
            let (reply, joined) = oneshot::channel();
            let sent = entry
                .tx
                .send(RoomCmd::Join {
                    client: client.clone(),
                    reply,
                })
                .await;
            if sent.is_err() {
                self.inner.remove(file_id, entry.generation);
                continue;
            }
            match joined.await {
                Ok(Ok(())) => return Ok(entry.tx),
                Ok(Err(err)) => return Err(err),
                Err(_) => self.inner.remove(file_id, entry.generation),
            }
        }
        Err(JoinError::Unavailable)
    }

    /// A fresh snapshot from the live room, or `None` when the file has no open room.
    pub async fn snapshot(&self, file_id: &str) -> Option<anyhow::Result<Vec<u8>>> {
        let entry = self.entry(file_id, false)?;
        let (reply, rx) = oneshot::channel();
        entry.tx.send(RoomCmd::Snapshot { reply }).await.ok()?;
        rx.await.ok()
    }

    /// Disconnect everyone from a file that is being deleted and unload its room.
    pub async fn close_file(&self, file_id: &str) {
        self.close(file_id, close_code::NOT_FOUND, "file deleted", false)
            .await;
    }

    async fn close(&self, file_id: &str, code: u16, reason: &'static str, compact: bool) {
        let Some(entry) = self.entry(file_id, false) else {
            return;
        };
        let (done, wait) = oneshot::channel();
        let cmd = RoomCmd::Close {
            code,
            reason,
            compact,
            done: Some(done),
        };
        if entry.tx.send(cmd).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(10), wait).await;
        }
    }

    /// Apply a role change (`Some`) or removal (`None`) to the user's open connections.
    pub async fn update_access(&self, file_ids: &[String], user_id: &str, role: Option<Role>) {
        for file_id in file_ids {
            if let Some(entry) = self.entry(file_id, false) {
                let _ = entry
                    .tx
                    .send(RoomCmd::UpdateAccess {
                        user_id: user_id.to_string(),
                        role,
                    })
                    .await;
            }
        }
    }

    /// Stop accepting joins, then compact and close every room (graceful shutdown).
    pub async fn shutdown(&self) {
        self.inner.closing.store(true, Ordering::Relaxed);
        let ids: Vec<String> = self.inner.lock().keys().cloned().collect();
        let closes = ids
            .iter()
            .map(|id| self.close(id, SERVICE_RESTART, "server restarting", true));
        for close in closes {
            close.await;
        }
    }

    pub fn open_rooms(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_online(&self, user_id: &str) -> bool {
        let online = self.inner.online.lock().unwrap_or_else(|e| e.into_inner());
        online.get(user_id).is_some_and(|n| *n > 0)
    }

    pub(crate) fn connection_opened(&self, user_id: &str) {
        let mut online = self.inner.online.lock().unwrap_or_else(|e| e.into_inner());
        *online.entry(user_id.to_string()).or_insert(0) += 1;
    }

    pub(crate) fn connection_closed(&self, user_id: &str) {
        let mut online = self.inner.online.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = online.get_mut(user_id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                online.remove(user_id);
            }
        }
    }
}
