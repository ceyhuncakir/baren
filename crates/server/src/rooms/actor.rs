//! One task per open file ("room"). The task owns the room's `LoroDoc` and its client list,
//! so no locks are needed: connections talk to it through a bounded command queue and it
//! talks back through each client's bounded outbound queue.
//!
//! Backpressure: the room never awaits a client. Binary updates are pushed with `try_send`; a
//! client whose queue is full is disconnected (`TOO_SLOW`) and catches up through the version
//! vector handshake when it reconnects, so no update is silently lost. Presence is lossy and
//! simply dropped for full queues.
//!
//! Persistence is group-committed: the room drains every queued command, fans updates out
//! immediately, then appends the batch to SQLite in one transaction.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU16, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::Utf8Bytes;
use baren_proto::dto::Role;
use baren_proto::wire::close_code;
use baren_proto::{encode_frame, ClientPresence, MsgType, Presence, ServerText};
use loro::{ExportMode, LoroDoc, VersionVector};
use sqlx::SqlitePool;
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use super::store;
use super::{Registry, RoomSettings};
use crate::db::is_foreign_key_violation;

/// Commands processed per batch before flushing to SQLite.
const MAX_BATCH: usize = 256;
/// Updates larger than this are imported on the blocking pool.
const BLOCKING_IMPORT_BYTES: usize = 256 * 1024;
/// Documents with more ops than this export on the blocking pool.
const BLOCKING_EXPORT_OPS: usize = 50_000;
/// Presence frames accepted per client per second.
const PRESENCE_PER_SECOND: u32 = 60;
/// Unflushed updates kept in memory while SQLite is failing before the room gives up.
const MAX_UNFLUSHED: usize = 10_000;

/// Cursor/avatar colours handed out per room (first two from the designs).
pub const PALETTE: &[&str] = &[
    "#6D4AFF", "#F04E1E", "#0E9F6E", "#E0368C", "#0B84C6", "#D97706", "#7C3AED", "#DC2626",
    "#0D9488", "#4F46E5", "#65A30D", "#C026D3",
];

/// Messages queued for one connection.
#[derive(Debug)]
pub enum Outbound {
    Binary(Bytes),
    Text(Utf8Bytes),
    Close(u16, &'static str),
}

#[derive(Debug, Clone)]
pub struct ClientInit {
    pub client_id: String,
    pub user_id: String,
    pub name: String,
    pub role: Role,
    pub out: mpsc::Sender<Outbound>,
    /// Close code chosen by the room when it drops this client (0 = none).
    pub kick: Arc<AtomicU16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinError {
    NotFound,
    Unavailable,
}

pub enum RoomCmd {
    Join {
        client: ClientInit,
        reply: oneshot::Sender<Result<(), JoinError>>,
    },
    Leave {
        client_id: String,
    },
    /// A full `0x01` frame.
    Update {
        client_id: String,
        frame: Bytes,
    },
    /// A full `0x02` frame.
    SyncRequest {
        client_id: String,
        frame: Bytes,
    },
    Presence {
        client_id: String,
        presence: ClientPresence,
    },
    Snapshot {
        reply: oneshot::Sender<anyhow::Result<Vec<u8>>>,
    },
    /// A member's role changed (`Some`) or they lost access (`None`).
    UpdateAccess {
        user_id: String,
        role: Option<Role>,
    },
    Close {
        code: u16,
        reason: &'static str,
        compact: bool,
        done: Option<oneshot::Sender<()>>,
    },
}

struct Client {
    user_id: String,
    name: String,
    role: Role,
    color: &'static str,
    out: mpsc::Sender<Outbound>,
    kick: Arc<AtomicU16>,
    presence: Option<Utf8Bytes>,
    presence_window: (Instant, u32),
    warned_read_only: bool,
}

struct Stop {
    code: u16,
    reason: &'static str,
    compact: bool,
    done: Option<oneshot::Sender<()>>,
}

enum ImportFailure {
    Invalid,
    Panicked,
}

pub struct Room {
    file_id: String,
    db: SqlitePool,
    settings: RoomSettings,
    doc: LoroDoc,
    clients: HashMap<String, Client>,
    /// Update payloads not yet appended to SQLite.
    pending: Vec<Bytes>,
    /// Rows in `file_updates` not yet folded into the snapshot.
    rows_since_compact: usize,
    last_compact: Instant,
    empty_since: Option<Instant>,
    mirrored_name: Option<String>,
    stop: Option<Stop>,
}

/// Entry point of the room task.
pub async fn run(
    file_id: String,
    generation: u64,
    db: SqlitePool,
    settings: RoomSettings,
    mut rx: mpsc::Receiver<RoomCmd>,
    registry: Arc<Registry>,
) {
    let mut room = match Room::load(file_id.clone(), db, settings).await {
        Ok(Some(room)) => room,
        Ok(None) => {
            registry.remove(&file_id, generation);
            reject_queued(&mut rx, JoinError::NotFound);
            return;
        }
        Err(err) => {
            tracing::error!(file_id, error = %err, "failed to load room");
            registry.remove(&file_id, generation);
            reject_queued(&mut rx, JoinError::Unavailable);
            return;
        }
    };
    tracing::debug!(file_id, generation, "room loaded");

    let tick_every =
        (settings.room_idle / 2).clamp(Duration::from_millis(100), Duration::from_secs(1));
    let mut tick = tokio::time::interval(tick_every);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else {
                    // Every sender is gone: the registry already forgot this room.
                    room.flush_logged().await;
                    room.compact_logged().await;
                    break;
                };
                room.handle(cmd).await;
                for _ in 1..MAX_BATCH {
                    if room.stop.is_some() {
                        break;
                    }
                    match rx.try_recv() {
                        Ok(cmd) => room.handle(cmd).await,
                        Err(_) => break,
                    }
                }
                room.flush_logged().await;
            }
            _ = tick.tick() => {
                room.maintain().await;
                if room.idle_expired() {
                    // Persist everything *before* leaving the registry, so a room created for
                    // the next visitor always loads the complete document.
                    room.compact_logged().await;
                    if room.pending.is_empty()
                        && registry.remove_if(&room.file_id, generation, || rx.is_empty())
                    {
                        tracing::debug!(file_id = room.file_id, "room unloaded (idle)");
                        break;
                    }
                }
            }
        }

        if let Some(stop) = room.stop.take() {
            room.flush_logged().await;
            if stop.compact {
                room.compact_logged().await;
            }
            room.close_all(stop.code, stop.reason);
            registry.remove(&room.file_id, generation);
            reject_queued(&mut rx, JoinError::Unavailable);
            if let Some(done) = stop.done {
                let _ = done.send(());
            }
            tracing::debug!(file_id = room.file_id, code = stop.code, "room closed");
            break;
        }
    }
}

/// Refuse everything still queued once the room is gone from the registry.
fn reject_queued(rx: &mut mpsc::Receiver<RoomCmd>, err: JoinError) {
    rx.close();
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            RoomCmd::Join { reply, .. } => {
                let _ = reply.send(Err(err));
            }
            RoomCmd::Snapshot { reply } => {
                let _ = reply.send(Err(anyhow::anyhow!("room closed")));
            }
            RoomCmd::Close {
                done: Some(done), ..
            } => {
                let _ = done.send(());
            }
            _ => {}
        }
    }
}

impl Room {
    async fn load(
        file_id: String,
        db: SqlitePool,
        settings: RoomSettings,
    ) -> anyhow::Result<Option<Self>> {
        let Some(stored) = store::load(&db, &file_id).await? else {
            return Ok(None);
        };
        let rows = stored.updates.len();
        let name = stored.name.clone();
        let doc = tokio::task::spawn_blocking(move || store::build_doc(&stored)).await??;
        Ok(Some(Self {
            file_id,
            db,
            settings,
            doc,
            clients: HashMap::new(),
            pending: Vec::new(),
            rows_since_compact: rows,
            last_compact: Instant::now(),
            empty_since: Some(Instant::now()),
            mirrored_name: Some(name),
            stop: None,
        }))
    }

    async fn handle(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::Join { client, reply } => self.join(client, reply),
            RoomCmd::Leave { client_id } => self.leave(&client_id),
            RoomCmd::Update { client_id, frame } => self.update(&client_id, frame).await,
            RoomCmd::SyncRequest { client_id, frame } => self.sync_request(&client_id, frame).await,
            RoomCmd::Presence {
                client_id,
                presence,
            } => self.presence(&client_id, presence),
            RoomCmd::Snapshot { reply } => {
                let _ = reply.send(self.export_snapshot().await);
            }
            RoomCmd::UpdateAccess { user_id, role } => self.update_access(&user_id, role),
            RoomCmd::Close {
                code,
                reason,
                compact,
                done,
            } => {
                self.stop = Some(Stop {
                    code,
                    reason,
                    compact,
                    done,
                })
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Membership

    fn join(&mut self, init: ClientInit, reply: oneshot::Sender<Result<(), JoinError>>) {
        if reply.is_closed() {
            return; // The connection gave up while queued.
        }
        let color = self.pick_color(&init.user_id);
        let welcome = ServerText::Welcome {
            client_id: init.client_id.clone(),
            user_id: init.user_id.clone(),
            name: init.name.clone(),
            color: color.to_string(),
            role: init.role,
        };
        // Queue: welcome, everyone's current presence, then our version vector so the client
        // uploads whatever we are missing (offline edits).
        let mut queued = init
            .out
            .try_send(Outbound::Text(welcome.to_json().into()))
            .is_ok();
        for other in self.clients.values() {
            if let Some(p) = &other.presence {
                queued &= init.out.try_send(Outbound::Text(p.clone())).is_ok();
            }
        }
        let vv = self.doc.oplog_vv().encode();
        queued &= init
            .out
            .try_send(Outbound::Binary(
                encode_frame(MsgType::SyncRequest, &vv).into(),
            ))
            .is_ok();
        if !queued {
            let _ = reply.send(Err(JoinError::Unavailable));
            return;
        }
        self.clients.insert(
            init.client_id,
            Client {
                user_id: init.user_id,
                name: init.name,
                role: init.role,
                color,
                out: init.out,
                kick: init.kick,
                presence: None,
                presence_window: (Instant::now(), 0),
                warned_read_only: false,
            },
        );
        self.empty_since = None;
        let _ = reply.send(Ok(()));
    }

    fn leave(&mut self, client_id: &str) {
        let Some(client) = self.clients.remove(client_id) else {
            return;
        };
        let leave = ServerText::Leave {
            client_id: client_id.to_string(),
            user_id: client.user_id,
        };
        self.broadcast_text(None, leave.to_json().into());
        if self.clients.is_empty() {
            self.empty_since = Some(Instant::now());
        }
    }

    /// Drop a client with a close code; its connection closes once its queue drains.
    fn kick(&mut self, client_id: &str, code: u16, reason: &'static str) {
        if let Some(client) = self.clients.get(client_id) {
            client.kick.store(code, AtomicOrdering::Relaxed);
            let _ = client.out.try_send(Outbound::Close(code, reason));
            tracing::debug!(
                file_id = self.file_id,
                client_id,
                code,
                reason,
                "client dropped"
            );
        }
        self.leave(client_id);
    }

    fn close_all(&mut self, code: u16, reason: &'static str) {
        for client in self.clients.values() {
            client.kick.store(code, AtomicOrdering::Relaxed);
            let _ = client.out.try_send(Outbound::Close(code, reason));
        }
        self.clients.clear();
    }

    fn update_access(&mut self, user_id: &str, role: Option<Role>) {
        let ids: Vec<String> = self
            .clients
            .iter()
            .filter(|(_, c)| c.user_id == user_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            match role {
                None => self.kick(&id, close_code::FORBIDDEN, "access revoked"),
                Some(role) => {
                    if let Some(client) = self.clients.get_mut(&id) {
                        client.role = role;
                        client.warned_read_only = false;
                        let welcome = ServerText::Welcome {
                            client_id: id.clone(),
                            user_id: client.user_id.clone(),
                            name: client.name.clone(),
                            color: client.color.to_string(),
                            role,
                        };
                        let _ = client
                            .out
                            .try_send(Outbound::Text(welcome.to_json().into()));
                    }
                }
            }
        }
    }

    fn pick_color(&self, user_id: &str) -> &'static str {
        if let Some(existing) = self.clients.values().find(|c| c.user_id == user_id) {
            return existing.color;
        }
        let start = fnv1a(user_id.as_bytes()) as usize % PALETTE.len();
        (0..PALETTE.len())
            .map(|i| PALETTE[(start + i) % PALETTE.len()])
            .find(|color| self.clients.values().all(|c| c.color != *color))
            .unwrap_or(PALETTE[start])
    }

    // -----------------------------------------------------------------------------------------
    // Document sync

    async fn update(&mut self, client_id: &str, frame: Bytes) {
        let Some(client) = self.clients.get_mut(client_id) else {
            return;
        };
        if !client.role.can_edit() {
            if !client.warned_read_only {
                client.warned_read_only = true;
                let err = ServerText::Error {
                    code: "read_only".into(),
                    message: "You have view access to this file; edits are not saved.".into(),
                };
                let _ = client.out.try_send(Outbound::Text(err.to_json().into()));
            }
            return;
        }
        let payload = frame.slice(1..);
        if payload.is_empty() {
            return;
        }
        match self.import(payload.clone()).await {
            Ok(false) => {}
            Ok(true) => {
                self.broadcast_binary(client_id, &frame);
                self.pending.push(payload);
            }
            Err(ImportFailure::Invalid) => {
                self.kick(client_id, close_code::BAD_REQUEST, "invalid update")
            }
            Err(ImportFailure::Panicked) => {
                tracing::error!(file_id = self.file_id, "loro panicked importing an update");
                self.stop = Some(Stop {
                    code: close_code::ROOM_ERROR,
                    reason: "room error",
                    compact: false,
                    done: None,
                });
            }
        }
    }

    /// Import an update; `Ok(true)` if it added anything (or is waiting on dependencies).
    async fn import(&self, payload: Bytes) -> Result<bool, ImportFailure> {
        let doc = self.doc.clone();
        let large = payload.len() > BLOCKING_IMPORT_BYTES;
        let work = move || {
            let before = doc.oplog_vv();
            match catch_unwind(AssertUnwindSafe(|| doc.import(&payload))) {
                Err(_) => Err(ImportFailure::Panicked),
                Ok(Err(err)) => {
                    tracing::debug!(error = %err, "rejected update");
                    Err(ImportFailure::Invalid)
                }
                Ok(Ok(status)) => Ok(status.pending.is_some() || doc.oplog_vv() != before),
            }
        };
        if large {
            tokio::task::spawn_blocking(work)
                .await
                .unwrap_or(Err(ImportFailure::Panicked))
        } else {
            work()
        }
    }

    async fn sync_request(&mut self, client_id: &str, frame: Bytes) {
        if !self.clients.contains_key(client_id) {
            return;
        }
        let Ok(their_vv) = VersionVector::decode(&frame[1..]) else {
            self.kick(client_id, close_code::BAD_REQUEST, "invalid version vector");
            return;
        };
        let response = match self.doc.oplog_vv().partial_cmp(&their_vv) {
            Some(Ordering::Less | Ordering::Equal) => {
                Bytes::from_static(&[MsgType::SyncResponse as u8])
            }
            _ => match self.export_since(their_vv).await {
                Ok(bytes) => encode_frame(MsgType::SyncResponse, &bytes).into(),
                Err(err) => {
                    tracing::error!(file_id = self.file_id, error = %err, "export failed");
                    self.kick(client_id, close_code::ROOM_ERROR, "export failed");
                    return;
                }
            },
        };
        self.send_binary(client_id, response);
    }

    async fn export_since(&self, vv: VersionVector) -> anyhow::Result<Vec<u8>> {
        let doc = self.doc.clone();
        let work = move || {
            doc.export(ExportMode::updates_owned(vv))
                .map_err(|e| anyhow::anyhow!("{e}"))
        };
        if self.doc.len_ops() > BLOCKING_EXPORT_OPS {
            tokio::task::spawn_blocking(work).await?
        } else {
            work()
        }
    }

    async fn export_snapshot(&self) -> anyhow::Result<Vec<u8>> {
        let doc = self.doc.clone();
        tokio::task::spawn_blocking(move || {
            doc.export(ExportMode::Snapshot)
                .map_err(|e| anyhow::anyhow!("{e}"))
        })
        .await?
    }

    fn send_binary(&mut self, client_id: &str, frame: Bytes) {
        let Some(client) = self.clients.get(client_id) else {
            return;
        };
        match client.out.try_send(Outbound::Binary(frame)) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.kick(client_id, close_code::TOO_SLOW, "client too slow")
            }
            Err(mpsc::error::TrySendError::Closed(_)) => self.leave(client_id),
        }
    }

    fn broadcast_binary(&mut self, except: &str, frame: &Bytes) {
        let mut slow = Vec::new();
        let mut gone = Vec::new();
        for (id, client) in &self.clients {
            if id == except {
                continue;
            }
            match client.out.try_send(Outbound::Binary(frame.clone())) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => slow.push(id.clone()),
                Err(mpsc::error::TrySendError::Closed(_)) => gone.push(id.clone()),
            }
        }
        for id in slow {
            self.kick(&id, close_code::TOO_SLOW, "client too slow");
        }
        for id in gone {
            self.leave(&id);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Presence

    fn presence(&mut self, client_id: &str, presence: ClientPresence) {
        let Some(client) = self.clients.get_mut(client_id) else {
            return;
        };
        let now = Instant::now();
        let (window_start, count) = &mut client.presence_window;
        if now.duration_since(*window_start) >= Duration::from_secs(1) {
            *window_start = now;
            *count = 0;
        }
        *count += 1;
        if *count > PRESENCE_PER_SECOND {
            return;
        }
        let text: Utf8Bytes = ServerText::Presence(Presence {
            client_id: client_id.to_string(),
            user_id: client.user_id.clone(),
            name: client.name.clone(),
            color: client.color.to_string(),
            page_id: presence.page_id,
            cursor: presence.cursor,
            selection: presence.selection,
            transient: presence.transient,
            agents: presence.agents,
            viewport: presence.viewport,
        })
        .to_json()
        .into();
        client.presence = Some(text.clone());
        self.broadcast_text(Some(client_id), text);
    }

    /// Lossy fan-out: full queues skip the message, closed ones are cleaned up on `Leave`.
    fn broadcast_text(&self, except: Option<&str>, text: Utf8Bytes) {
        for (id, client) in &self.clients {
            if Some(id.as_str()) != except {
                let _ = client.out.try_send(Outbound::Text(text.clone()));
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Persistence

    async fn flush(&mut self) -> Result<(), sqlx::Error> {
        let name = store::doc_name(&self.doc);
        let rename = name.is_some() && name != self.mirrored_name;
        if self.pending.is_empty() && !rename {
            return Ok(());
        }
        store::append(
            &self.db,
            &self.file_id,
            &self.pending,
            if rename { name.as_deref() } else { None },
        )
        .await?;
        self.rows_since_compact += self.pending.len();
        self.pending.clear();
        if rename {
            self.mirrored_name = name;
        }
        Ok(())
    }

    async fn flush_logged(&mut self) {
        let Err(err) = self.flush().await else { return };
        if is_foreign_key_violation(&err) {
            // The file was deleted underneath us.
            self.pending.clear();
            self.stop.get_or_insert(Stop {
                code: close_code::NOT_FOUND,
                reason: "file deleted",
                compact: false,
                done: None,
            });
            return;
        }
        tracing::error!(file_id = self.file_id, error = %err, pending = self.pending.len(), "flush failed; will retry");
        if self.pending.len() > MAX_UNFLUSHED {
            self.pending.clear();
            self.stop.get_or_insert(Stop {
                code: close_code::ROOM_ERROR,
                reason: "storage unavailable",
                compact: false,
                done: None,
            });
        }
    }

    async fn compact(&mut self) -> anyhow::Result<()> {
        self.flush().await?;
        if self.rows_since_compact == 0 {
            return Ok(());
        }
        let snapshot = self.export_snapshot().await?;
        store::compact(&self.db, &self.file_id, &snapshot).await?;
        tracing::debug!(
            file_id = self.file_id,
            rows = self.rows_since_compact,
            bytes = snapshot.len(),
            "compacted"
        );
        self.rows_since_compact = 0;
        self.last_compact = Instant::now();
        Ok(())
    }

    async fn compact_logged(&mut self) {
        if let Err(err) = self.compact().await {
            tracing::error!(file_id = self.file_id, error = %err, "compaction failed");
        }
    }

    async fn maintain(&mut self) {
        if !self.pending.is_empty() {
            self.flush_logged().await;
        }
        let due = self.rows_since_compact >= self.settings.compact_every_updates
            || (self.rows_since_compact > 0
                && self.last_compact.elapsed() >= self.settings.compact_interval);
        if due {
            self.compact_logged().await;
        }
    }

    fn idle_expired(&self) -> bool {
        self.clients.is_empty()
            && self
                .empty_since
                .is_some_and(|t| t.elapsed() >= self.settings.room_idle)
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &b| {
        (hash ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn palette_colors_are_hex() {
        assert!(PALETTE.len() >= 8);
        for c in PALETTE {
            assert!(c.len() == 7 && c.starts_with('#'));
        }
    }
}
