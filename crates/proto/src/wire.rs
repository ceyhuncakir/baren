//! Binary frames on `/ws/files/:id`.
//!
//! Every binary frame is `[type: u8, payload...]`:
//!
//! | type   | direction        | payload                                                     |
//! |--------|------------------|-------------------------------------------------------------|
//! | `0x01` | both             | Loro update bytes. Server imports, persists, fans out.      |
//! | `0x02` | both             | Encoded Loro `VersionVector` of the sender's oplog.         |
//! | `0x03` | server → client  | Updates the requester is missing (empty = already in sync). |
//!
//! Handshake: on open the client sends `0x02(clientVV)` and the server answers `0x03`. On join
//! the server also sends `0x02(serverVV)`; the client answers with `0x01` carrying everything the
//! server lacks (this is how offline edits are uploaded). Periodic `0x02` from the client doubles
//! as a heartbeat and anti-entropy pass.

use thiserror::Error;

/// First byte of a binary WebSocket frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum MsgType {
    /// Loro update (client → server, fanned out to other clients; or a client's reply to a
    /// server sync request).
    Update = 0x01,
    /// Sync request; payload = encoded version vector.
    SyncRequest = 0x02,
    /// Updates since the requested version (server → client).
    SyncResponse = 0x03,
}

impl TryFrom<u8> for MsgType {
    type Error = u8;

    fn try_from(byte: u8) -> Result<Self, Self::Error> {
        match byte {
            0x01 => Ok(Self::Update),
            0x02 => Ok(Self::SyncRequest),
            0x03 => Ok(Self::SyncResponse),
            other => Err(other),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FrameError {
    #[error("empty binary frame")]
    Empty,
    #[error("unknown message type 0x{0:02x}")]
    UnknownType(u8),
}

/// Prefix `payload` with its message type.
pub fn encode_frame(msg_type: MsgType, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(msg_type as u8);
    out.extend_from_slice(payload);
    out
}

/// Split a binary frame into its type and payload.
pub fn decode_frame(frame: &[u8]) -> Result<(MsgType, &[u8]), FrameError> {
    let (&first, payload) = frame.split_first().ok_or(FrameError::Empty)?;
    let msg_type = MsgType::try_from(first).map_err(FrameError::UnknownType)?;
    Ok((msg_type, payload))
}

/// Application close codes (4000–4999) sent by the server. Clients must not reconnect after
/// `UNAUTHORIZED`, `FORBIDDEN` or `NOT_FOUND`; every other code is retryable.
pub mod close_code {
    /// Malformed frame, update or version vector.
    pub const BAD_REQUEST: u16 = 4400;
    /// Missing, invalid or expired session token.
    pub const UNAUTHORIZED: u16 = 4401;
    /// Authenticated but not allowed to open this file.
    pub const FORBIDDEN: u16 = 4403;
    /// The file does not exist (or was deleted while open).
    pub const NOT_FOUND: u16 = 4404;
    /// No traffic within the heartbeat window.
    pub const TIMEOUT: u16 = 4408;
    /// The client could not keep up with the room; reconnect and resync.
    pub const TOO_SLOW: u16 = 4429;
    /// The room hit an internal error and was unloaded; reconnect.
    pub const ROOM_ERROR: u16 = 4500;

    /// Whether a client should stop reconnecting after this close code.
    pub fn is_terminal(code: u16) -> bool {
        matches!(code, UNAUTHORIZED | FORBIDDEN | NOT_FOUND)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msg_type_round_trips() {
        for t in [MsgType::Update, MsgType::SyncRequest, MsgType::SyncResponse] {
            assert_eq!(MsgType::try_from(t as u8), Ok(t));
        }
        assert_eq!(MsgType::try_from(0x7f), Err(0x7f));
    }

    #[test]
    fn frames_round_trip() {
        let frame = encode_frame(MsgType::SyncRequest, &[9, 8, 7]);
        assert_eq!(frame, vec![0x02, 9, 8, 7]);
        assert_eq!(
            decode_frame(&frame),
            Ok((MsgType::SyncRequest, &[9u8, 8, 7][..]))
        );
        assert_eq!(decode_frame(&[0x03]), Ok((MsgType::SyncResponse, &[][..])));
        assert_eq!(decode_frame(&[]), Err(FrameError::Empty));
        assert_eq!(decode_frame(&[0x09, 1]), Err(FrameError::UnknownType(9)));
    }

    #[test]
    fn terminal_close_codes() {
        assert!(close_code::is_terminal(close_code::UNAUTHORIZED));
        assert!(close_code::is_terminal(close_code::NOT_FOUND));
        assert!(!close_code::is_terminal(close_code::TOO_SLOW));
        assert!(!close_code::is_terminal(1006));
    }
}
