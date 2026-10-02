//! `GET /ws/files/:id?token=…`: one task per connection that pumps frames between the socket
//! and the file's room.
//!
//! Authorization happens before the upgrade, but failures are reported *after* it as a close
//! frame with an application code (4401/4403/4404), because browsers hide the HTTP status of
//! a rejected upgrade and clients need to know whether reconnecting makes sense.

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::Response;
use baren_proto::dto::Role;
use baren_proto::presence::MAX_PRESENCE_BYTES;
use baren_proto::wire::close_code;
use baren_proto::{decode_frame, ClientPresence, MsgType};
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc};
use tokio::time::MissedTickBehavior;

use super::actor::{ClientInit, JoinError, Outbound, RoomCmd};
use crate::db::{file_role, FileAccessError};
use crate::secrets::new_token;
use crate::session::{authenticate, touch_user, AuthUser};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    token: Option<String>,
}

type Rejection = (u16, &'static str);

pub async fn handler(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let access = authorize(&state, &file_id, query.token.as_deref()).await;
    let max = state.config.max_message_bytes;
    ws.max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| async move {
            match access {
                Ok((user, role)) => {
                    Connection::new(state, file_id, user, role)
                        .run(socket)
                        .await
                }
                Err((code, reason)) => close(socket, code, reason).await,
            }
        })
}

async fn authorize(
    state: &AppState,
    file_id: &str,
    token: Option<&str>,
) -> Result<(AuthUser, Role), Rejection> {
    let unauthorized = (close_code::UNAUTHORIZED, "unauthorized");
    let unavailable = (close_code::ROOM_ERROR, "server error");
    let token = token.ok_or(unauthorized)?;
    let user = authenticate(&state.db, token, state.config.session_ttl)
        .await
        .map_err(|_| unavailable)?
        .ok_or(unauthorized)?;
    match file_role(&state.db, file_id, &user.id)
        .await
        .map_err(|_| unavailable)?
    {
        Ok((_, role)) => Ok((user, role)),
        Err(FileAccessError::NotFound) => Err((close_code::NOT_FOUND, "file not found")),
        Err(FileAccessError::Forbidden) => Err((close_code::FORBIDDEN, "forbidden")),
    }
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
    let frame = CloseFrame {
        code,
        reason: Utf8Bytes::from_static(reason),
    };
    let _ = socket.send(Message::Close(Some(frame))).await;
}

struct Connection {
    state: AppState,
    file_id: String,
    user: AuthUser,
    role: Role,
    client_id: String,
}

impl Connection {
    fn new(state: AppState, file_id: String, user: AuthUser, role: Role) -> Self {
        Self {
            state,
            file_id,
            user,
            role,
            client_id: new_token()[..12].to_string(),
        }
    }

    async fn run(self, mut socket: WebSocket) {
        let (out_tx, mut out_rx) = mpsc::channel::<Outbound>(self.state.config.client_queue);
        let kick = Arc::new(AtomicU16::new(0));
        let init = ClientInit {
            client_id: self.client_id.clone(),
            user_id: self.user.id.clone(),
            name: self.user.name.clone(),
            role: self.role,
            out: out_tx,
            kick: Arc::clone(&kick),
        };
        let room = match self.state.rooms.join(&self.file_id, init).await {
            Ok(room) => room,
            Err(JoinError::NotFound) => {
                return close(socket, close_code::NOT_FOUND, "file not found").await
            }
            Err(JoinError::Unavailable) => {
                return close(socket, close_code::ROOM_ERROR, "room unavailable").await
            }
        };
        self.state.rooms.connection_opened(&self.user.id);
        let _ = touch_user(&self.state.db, &self.user.id).await;
        tracing::debug!(
            file_id = self.file_id,
            client_id = self.client_id,
            "client joined"
        );

        // Password resets/changes and sign-outs close this socket (4401) if its session is gone.
        let mut revocations = self.state.revocations.subscribe();
        let mut watching_revocations = true;

        let ping_every = self.state.config.ping_interval;
        let mut ping = tokio::time::interval(ping_every);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ping.tick().await;
        let mut last_seen = Instant::now();

        let closing: Option<(u16, &'static str)> = loop {
            tokio::select! {
                incoming = socket.recv() => {
                    let Some(Ok(message)) = incoming else { break None };
                    last_seen = Instant::now();
                    match self.inbound(&room, message).await {
                        Ok(true) => {}
                        Ok(false) => break None,
                        Err(rejection) => break Some(rejection),
                    }
                }
                outgoing = out_rx.recv() => {
                    let message = match outgoing {
                        Some(Outbound::Binary(bytes)) => Message::Binary(bytes),
                        Some(Outbound::Text(text)) => Message::Text(text),
                        Some(Outbound::Close(code, reason)) => break Some((code, reason)),
                        None => {
                            // The room dropped us; the reason is in `kick`.
                            let code = match kick.load(Ordering::Relaxed) {
                                0 => close_code::ROOM_ERROR,
                                code => code,
                            };
                            break Some((code, "disconnected by room"));
                        }
                    };
                    if socket.send(message).await.is_err() {
                        break None;
                    }
                }
                revoked = revocations.recv(), if watching_revocations => {
                    match revoked {
                        Ok(r) if r.applies_to(&self.user.id, &self.user.token_hash) => {
                            break Some((close_code::UNAUTHORIZED, "session revoked"));
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Missed some: check our own session directly.
                            if !self.session_alive().await {
                                break Some((close_code::UNAUTHORIZED, "session revoked"));
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => watching_revocations = false,
                    }
                }
                _ = ping.tick() => {
                    if last_seen.elapsed() > ping_every * 3 {
                        break Some((close_code::TIMEOUT, "timeout"));
                    }
                    if socket.send(Message::Ping(Default::default())).await.is_err() {
                        break None;
                    }
                }
            }
        };

        let _ = room
            .send(RoomCmd::Leave {
                client_id: self.client_id.clone(),
            })
            .await;
        self.state.rooms.connection_closed(&self.user.id);
        if let Some((code, reason)) = closing {
            close(socket, code, reason).await;
        }
        tracing::debug!(
            file_id = self.file_id,
            client_id = self.client_id,
            "client left"
        );
    }

    /// Whether this connection's session still exists (errors count as alive).
    async fn session_alive(&self) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT 1 FROM sessions WHERE token_hash = ?")
            .bind(&self.user.token_hash)
            .fetch_optional(&self.state.db)
            .await
            .map_or(true, |row| row.is_some())
    }

    /// Handle one frame from the client. `Ok(false)` ends the connection quietly.
    async fn inbound(
        &self,
        room: &mpsc::Sender<RoomCmd>,
        message: Message,
    ) -> Result<bool, Rejection> {
        let room_gone = (close_code::ROOM_ERROR, "room closed");
        match message {
            Message::Binary(frame) => {
                let cmd = match decode_frame(&frame) {
                    Ok((MsgType::Update, _)) => RoomCmd::Update {
                        client_id: self.client_id.clone(),
                        frame,
                    },
                    Ok((MsgType::SyncRequest, _)) => RoomCmd::SyncRequest {
                        client_id: self.client_id.clone(),
                        frame,
                    },
                    Ok((MsgType::SyncResponse, _)) | Err(_) => {
                        return Err((close_code::BAD_REQUEST, "unexpected frame"))
                    }
                };
                // Awaiting here applies backpressure to a client that floods a busy room.
                room.send(cmd).await.map_err(|_| room_gone)?;
            }
            Message::Text(text) => {
                if text.len() > MAX_PRESENCE_BYTES {
                    return Ok(true);
                }
                let presence = match serde_json::from_str::<ClientPresence>(text.as_str()) {
                    Ok(p) if p.validate().is_ok() => p,
                    _ => return Ok(true),
                };
                // Presence is lossy: never block on a busy room for it.
                if let Err(mpsc::error::TrySendError::Closed(_)) =
                    room.try_send(RoomCmd::Presence {
                        client_id: self.client_id.clone(),
                        presence,
                    })
                {
                    return Err(room_gone);
                }
            }
            Message::Close(_) => return Ok(false),
            Message::Ping(_) | Message::Pong(_) => {}
        }
        Ok(true)
    }
}
