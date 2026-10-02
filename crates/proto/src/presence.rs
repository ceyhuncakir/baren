//! Text frames on `/ws/files/:id`: presence JSON. Never persisted.
//!
//! Client → server: [`ClientPresence`] (`{ pageId, cursor, selection }`). Identity fields
//! (`userId`, `name`, `color`) are filled in by the server so they cannot be spoofed.
//!
//! Server → client: [`ServerText`], discriminated by `type`:
//! `welcome` (sent once after joining), `presence` (a peer moved), `leave` (a peer left) and
//! `error`. A `presence` frame carries the contract fields
//! `{ userId, name, color, pageId, cursor, selection }` plus `clientId`, because one user can
//! have the same file open in several windows.
//!
//! Both directions may carry an optional `transient` field: another peer's move/resize gesture
//! in progress (world coordinates, ~30 Hz, never persisted), drawn by the canvas as ghosts.
//!
//! Both directions may also carry an optional `agents` list (Phase 4): the MCP agents working
//! through that client (`{ id, name, working }`, `working` = artboard ids with a "… is working"
//! indicator). Additive: old servers drop it, old clients ignore it.

use serde::{Deserialize, Serialize};

use crate::dto::Role;

/// Upper bound on `selection` length accepted from a client.
pub const MAX_SELECTION: usize = 2_000;
/// Upper bound on a client presence text frame, in bytes.
pub const MAX_PRESENCE_BYTES: usize = 64 * 1024;
/// Upper bound on `agents` per client.
pub const MAX_AGENTS: usize = 8;
/// Upper bound on an agent's `id` and `name`, in bytes.
pub const MAX_AGENT_FIELD: usize = 64;
/// Upper bound on an agent's `working` list.
pub const MAX_AGENT_WORKING: usize = 200;
/// Upper bound on one `working` id, in bytes.
pub const MAX_AGENT_WORKING_ID: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn is_finite(&self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

/// Axis-aligned rectangle in world (canvas) coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn is_finite(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
    }
}

/// Kind of gesture a [`Transient`] previews.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransientKind {
    Move,
    Resize,
}

/// One node's preview rectangle inside a [`Transient`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransientNode {
    pub id: String,
    pub rect: Rect,
}

/// A peer's move/resize gesture in progress (`@baren/canvas` `TransientChange`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transient {
    pub kind: TransientKind,
    pub nodes: Vec<TransientNode>,
}

/// An MCP agent working through a client (Phase 4): shown as an avatar and as "<name> is
/// working" on the artboards in `working`. Carries no colour (every agent uses the agent accent).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentPresence {
    pub id: String,
    pub name: String,
    pub working: Vec<String>,
}

impl AgentPresence {
    fn validate(&self) -> Result<(), &'static str> {
        if self.id.len() > MAX_AGENT_FIELD || self.name.len() > MAX_AGENT_FIELD {
            return Err("agent id or name too long");
        }
        if self.working.len() > MAX_AGENT_WORKING {
            return Err("agent working set too large");
        }
        if self.working.iter().any(|w| w.len() > MAX_AGENT_WORKING_ID) {
            return Err("agent working id too long");
        }
        Ok(())
    }
}

/// Presence a client reports about itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientPresence {
    pub page_id: Option<String>,
    pub cursor: Option<Point>,
    pub selection: Vec<String>,
    /// In-progress gesture; `null`/absent when the peer is not dragging.
    pub transient: Option<Transient>,
    /// MCP agents working through this client (absent = none).
    pub agents: Vec<AgentPresence>,
}

impl ClientPresence {
    /// Reject values the server should never fan out.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.selection.len() > MAX_SELECTION {
            return Err("selection too large");
        }
        if self.cursor.is_some_and(|c| !c.is_finite()) {
            return Err("cursor must be finite");
        }
        if let Some(t) = &self.transient {
            if t.nodes.len() > MAX_SELECTION {
                return Err("transient too large");
            }
            if t.nodes.iter().any(|n| !n.rect.is_finite()) {
                return Err("transient rects must be finite");
            }
        }
        if self.agents.len() > MAX_AGENTS {
            return Err("too many agents");
        }
        for agent in &self.agents {
            agent.validate()?;
        }
        Ok(())
    }
}

/// Presence of one connected client, as fanned out by the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub client_id: String,
    pub user_id: String,
    pub name: String,
    pub color: String,
    pub page_id: Option<String>,
    pub cursor: Option<Point>,
    pub selection: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transient: Option<Transient>,
    /// MCP agents working through this client; omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentPresence>,
}

/// Every text frame the server sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerText {
    /// Sent once after the server accepted the connection.
    Welcome {
        client_id: String,
        user_id: String,
        name: String,
        color: String,
        role: Role,
    },
    Presence(Presence),
    Leave {
        client_id: String,
        user_id: String,
    },
    Error {
        code: String,
        message: String,
    },
}

impl ServerText {
    pub fn to_json(&self) -> String {
        // Serializing these plain structs cannot fail.
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_is_camel_case_json_with_type() {
        let p = ServerText::Presence(Presence {
            client_id: "c1".into(),
            user_id: "u1".into(),
            name: "ceyhun cakir".into(),
            color: "#F04E1E".into(),
            page_id: None,
            cursor: Some(Point { x: 1.0, y: 2.0 }),
            selection: vec![],
            transient: None,
            agents: vec![],
        });
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["type"], "presence");
        assert_eq!(json["userId"], "u1");
        assert_eq!(json["clientId"], "c1");
        assert_eq!(json["cursor"]["x"], 1.0);
        assert!(json["pageId"].is_null());
        let back: ServerText = serde_json::from_value(json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn welcome_and_leave_shapes() {
        let w = ServerText::Welcome {
            client_id: "c".into(),
            user_id: "u".into(),
            name: "n".into(),
            color: "#6D4AFF".into(),
            role: Role::Editor,
        };
        let json = serde_json::to_value(&w).unwrap();
        assert_eq!(json["type"], "welcome");
        assert_eq!(json["clientId"], "c");
        assert_eq!(json["role"], "editor");
        let l = serde_json::to_value(ServerText::Leave {
            client_id: "c".into(),
            user_id: "u".into(),
        })
        .unwrap();
        assert_eq!(l["type"], "leave");
        assert_eq!(l["userId"], "u");
    }

    #[test]
    fn client_presence_defaults_and_validation() {
        let p: ClientPresence = serde_json::from_str(r#"{"cursor":{"x":3,"y":4}}"#).unwrap();
        assert_eq!(p.cursor, Some(Point { x: 3.0, y: 4.0 }));
        assert!(p.selection.is_empty());
        assert!(p.validate().is_ok());
        let big = ClientPresence {
            selection: vec![String::new(); MAX_SELECTION + 1],
            ..Default::default()
        };
        assert!(big.validate().is_err());
    }

    #[test]
    fn transient_round_trips_and_is_validated() {
        let p: ClientPresence = serde_json::from_str(
            r#"{"selection":[],"transient":{"kind":"move","nodes":[{"id":"1@2","rect":{"x":1,"y":2,"width":30,"height":40}}]}}"#,
        )
        .unwrap();
        let t = p.transient.as_ref().unwrap();
        assert_eq!(t.kind, TransientKind::Move);
        assert_eq!(t.nodes[0].rect.width, 30.0);
        assert!(p.validate().is_ok());

        let none: ClientPresence = serde_json::from_str(r#"{"transient":null}"#).unwrap();
        assert!(none.transient.is_none());

        let presence = Presence {
            client_id: "c".into(),
            user_id: "u".into(),
            name: "n".into(),
            color: "#6D4AFF".into(),
            page_id: None,
            cursor: None,
            selection: vec![],
            transient: p.transient.clone(),
            agents: vec![],
        };
        let json = serde_json::to_value(ServerText::Presence(presence)).unwrap();
        assert_eq!(json["transient"]["kind"], "move");
        assert_eq!(json["transient"]["nodes"][0]["id"], "1@2");

        let idle = serde_json::to_value(ServerText::Presence(Presence {
            client_id: "c".into(),
            user_id: "u".into(),
            name: "n".into(),
            color: "#6D4AFF".into(),
            page_id: None,
            cursor: None,
            selection: vec![],
            transient: None,
            agents: vec![],
        }))
        .unwrap();
        assert!(idle.get("transient").is_none(), "absent when idle");
        assert!(idle.get("agents").is_none(), "absent without agents");

        let bad = ClientPresence {
            transient: Some(Transient {
                kind: TransientKind::Resize,
                nodes: vec![TransientNode {
                    id: "x".into(),
                    rect: Rect {
                        x: f64::NAN,
                        y: 0.0,
                        width: 1.0,
                        height: 1.0,
                    },
                }],
            }),
            ..Default::default()
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn agents_round_trip_and_are_validated() {
        let p: ClientPresence = serde_json::from_str(
            r#"{"selection":[],"agents":[{"id":"k3v9q2m1x8z0","name":"Claude Code","working":["12@34"]}]}"#,
        )
        .unwrap();
        assert_eq!(p.agents.len(), 1);
        assert_eq!(p.agents[0].name, "Claude Code");
        assert_eq!(p.agents[0].working, vec!["12@34".to_string()]);
        assert!(p.validate().is_ok());

        // Missing fields default; an absent list is empty.
        let partial: ClientPresence = serde_json::from_str(r#"{"agents":[{"id":"a"}]}"#).unwrap();
        assert_eq!(partial.agents[0].name, "");
        assert!(partial.agents[0].working.is_empty());
        let none: ClientPresence = serde_json::from_str(r#"{"selection":[]}"#).unwrap();
        assert!(none.agents.is_empty());

        let presence = Presence {
            client_id: "c".into(),
            user_id: "u".into(),
            name: "n".into(),
            color: "#6D4AFF".into(),
            page_id: None,
            cursor: None,
            selection: vec![],
            transient: None,
            agents: p.agents.clone(),
        };
        let json = serde_json::to_value(ServerText::Presence(presence)).unwrap();
        assert_eq!(json["agents"][0]["id"], "k3v9q2m1x8z0");
        assert_eq!(json["agents"][0]["working"][0], "12@34");
        assert!(json["agents"][0].get("color").is_none());

        let agent = |id: &str, name: &str, working: Vec<String>| AgentPresence {
            id: id.into(),
            name: name.into(),
            working,
        };
        let too_many = ClientPresence {
            agents: (0..=MAX_AGENTS)
                .map(|i| agent(&i.to_string(), "a", vec![]))
                .collect(),
            ..Default::default()
        };
        assert!(too_many.validate().is_err());
        let long_name = ClientPresence {
            agents: vec![agent("a", &"n".repeat(MAX_AGENT_FIELD + 1), vec![])],
            ..Default::default()
        };
        assert!(long_name.validate().is_err());
        let big_set = ClientPresence {
            agents: vec![agent("a", "b", vec!["1@1".into(); MAX_AGENT_WORKING + 1])],
            ..Default::default()
        };
        assert!(big_set.validate().is_err());
        let long_id = ClientPresence {
            agents: vec![agent("a", "b", vec!["x".repeat(MAX_AGENT_WORKING_ID + 1)])],
            ..Default::default()
        };
        assert!(long_id.validate().is_err());
        let ok = ClientPresence {
            agents: (0..MAX_AGENTS)
                .map(|i| agent(&i.to_string(), "a", vec!["1@1".into(); MAX_AGENT_WORKING]))
                .collect(),
            ..Default::default()
        };
        assert!(ok.validate().is_ok());
    }
}
