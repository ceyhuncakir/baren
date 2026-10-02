//! Rust mirror of `@baren/schema` (ARCHITECTURE.md, "Document model").
//!
//! Layout, names and decoding rules match `packages/schema/src` exactly; the
//! cross-compat tests in `tests/fixture_compat.rs` prove snapshot parity with
//! documents written by `loro-crdt` in JS.

pub mod bench;
pub mod doc;
pub mod edit;
pub mod resolve;
pub mod snapshot;
pub mod types;
pub mod vector;

pub use doc::{
    create_empty_doc, create_empty_doc_with, doc_name, export_snapshot, load_doc, nodes_tree,
    set_doc_name, EmptyDocOptions,
};
pub use edit::{
    create_node, delete_node, get_node_type, is_token_name, move_node, set_styles, set_text,
    set_tokens, NodeInit,
};
pub use resolve::{
    find_main_component, read_rotation, to_render_subtree, FoundMain, InstanceStatus,
    RenderSubtree, ResolvedNode,
};
pub use snapshot::{get_node, get_tokens, parse_node_id, to_snapshot, to_subtree_snapshot};
pub use types::{
    ComponentEntry, ComponentRegistry, DesignNode, DocSnapshot, JsNum, NodeMap, NodeType,
    OverrideEntry, OverrideStyles, Overrides, StyleValue, Styles, SubtreeSnapshot, Token, TokenMap,
    VectorData, VectorPoint, VectorSubpath,
};
pub use vector::vector_to_path_d;
