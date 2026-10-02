//! `baren-core` — the local backend behind the Electron main process.
//!
//! * [`schema`] mirrors the document layout defined by `@baren/schema`
//!   (ARCHITECTURE.md, "Document model"): node/token types, `to_snapshot`,
//!   and a few mutation helpers.
//! * [`Store`] persists design files in SQLite: an append-only log of Loro
//!   updates per file, compacted into snapshots, plus content-addressed assets
//!   and thumbnails. It is `Send + Sync` and every method is blocking — call it
//!   from worker threads (the N-API layer runs each call on the libuv pool).
//! * [`export`] turns documents into JSON (`DocSnapshot`) and semantic HTML.

pub use loro;

mod error;
pub mod export;
pub mod schema;
pub mod store;
mod util;

pub use error::{CoreError, Result};
pub use export::html::HtmlOptions;
pub use schema::{
    DesignNode, DocSnapshot, NodeMap, NodeType, OverrideEntry, Overrides, StyleValue, Styles,
    Token, VectorData,
};
pub use store::{sniff_image_mime, Asset, AssetInfo, FileMeta, JsonOptions, Store, StoreOptions};

/// Must equal `SCHEMA_VERSION` in `packages/schema/src/types.ts`.
pub const SCHEMA_VERSION: i64 = 1;

/// Root container names (mirror of `CONTAINER` in `@baren/schema`).
pub mod container {
    pub const META: &str = "meta";
    pub const NODES: &str = "nodes";
    pub const TOKENS: &str = "tokens";
    /// Component registry: `componentKey` → mergeable `{ mainId }` (Phase 3).
    pub const COMPONENTS: &str = "components";
}

/// Keys of a tree node's `data` map (mirror of `NODE_KEY` in `@baren/schema`).
pub mod node_key {
    pub const TYPE: &str = "type";
    pub const NAME: &str = "name";
    pub const STYLES: &str = "styles";
    pub const TEXT: &str = "text";
    pub const SVG: &str = "svg";
    pub const ASSET_ID: &str = "assetId";
    pub const ASSET_NAME: &str = "assetName";
    pub const LOCKED: &str = "locked";
    pub const HIDDEN: &str = "hidden";
    pub const BACKGROUND: &str = "background";
    pub const COMPONENT_KEY: &str = "componentKey";
    pub const NODE_KEY: &str = "nodeKey";
    pub const MAIN_ID: &str = "mainId";
    pub const OVERRIDES: &str = "overrides";
    pub const VECTOR: &str = "vector";
}

/// Crate version, exposed to JS through `baren-napi`.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The design file's display name from `meta.name`, if present.
pub fn doc_name(doc: &loro::LoroDoc) -> Option<String> {
    schema::doc::doc_name(doc)
}
