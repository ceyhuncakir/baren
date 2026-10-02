//! Wire protocol shared by the baren sync server and its clients
//! (ARCHITECTURE.md, "Server API").
//!
//! - [`wire`]: binary WebSocket frames (first byte = [`MsgType`]) and close codes.
//! - [`presence`]: text WebSocket frames (presence JSON, never persisted).
//! - [`dto`]: REST request/response bodies (camelCase JSON).
//!
//! The TypeScript mirror lives in `packages/sync-client/src/{protocol,types}.ts`; keep both in
//! sync when changing anything here.

pub mod dto;
pub mod presence;
pub mod wire;

pub use presence::{
    AgentPresence, ClientPresence, Point, Presence, Rect, ServerText, Transient, TransientKind,
    TransientNode,
};
pub use wire::{close_code, decode_frame, encode_frame, FrameError, MsgType};
