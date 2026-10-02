//! Document lifecycle, mirroring `packages/schema/src/doc.ts`.
//!
//! Unlike the JS helpers, nothing here commits: Rust callers group their ops
//! and call `doc.commit()` (or `commit_with`) themselves.

use loro::{ExportMode, LoroDoc, LoroMap, LoroTree, LoroValue, ValueOrContainer};

use crate::error::Result;
use crate::{container, node_key, SCHEMA_VERSION};

/// Fractional-index jitter used for sibling order (`FRACTIONAL_INDEX_JITTER`).
pub const FRACTIONAL_INDEX_JITTER: u8 = 0;
pub const DEFAULT_PAGE_NAME: &str = "Page 1";
pub const DEFAULT_PAGE_BACKGROUND: &str = "#EEEEEE";

/// The layer tree, with fractional indexes enabled (required for ordered
/// inserts and moves; a runtime setting, not an op).
pub fn nodes_tree(doc: &LoroDoc) -> LoroTree {
    let tree = doc.get_tree(container::NODES);
    if !tree.is_fractional_index_enabled() {
        tree.enable_fractional_index(FRACTIONAL_INDEX_JITTER);
    }
    tree
}

pub fn meta_map(doc: &LoroDoc) -> LoroMap {
    doc.get_map(container::META)
}

pub fn tokens_map(doc: &LoroDoc) -> LoroMap {
    doc.get_map(container::TOKENS)
}

/// Options for [`create_empty_doc_with`] (mirror of `CreateEmptyDocOptions`).
#[derive(Clone, Debug)]
pub struct EmptyDocOptions {
    /// Name of the initial page, or `None` for a doc without pages.
    pub page_name: Option<String>,
    pub page_background: String,
    /// Fixed peer id (tests, fixtures, benches); random by default.
    pub peer_id: Option<u64>,
}

impl Default for EmptyDocOptions {
    fn default() -> Self {
        EmptyDocOptions {
            page_name: Some(DEFAULT_PAGE_NAME.to_owned()),
            page_background: DEFAULT_PAGE_BACKGROUND.to_owned(),
            peer_id: None,
        }
    }
}

/// A new design file, op-for-op what `createEmptyDoc(name)` writes:
/// `meta = { name, schemaVersion: 1 }` and one page "Page 1" (#EEEEEE).
/// The returned doc is committed.
pub fn create_empty_doc(name: &str) -> Result<LoroDoc> {
    create_empty_doc_with(name, &EmptyDocOptions::default())
}

pub fn create_empty_doc_with(name: &str, options: &EmptyDocOptions) -> Result<LoroDoc> {
    let doc = LoroDoc::new();
    if let Some(peer) = options.peer_id {
        doc.set_peer_id(peer)?;
    }
    let tree = nodes_tree(&doc);
    let meta = meta_map(&doc);
    meta.insert("name", name)?;
    // JS numbers are doubles; write the same value type the JS side writes.
    meta.insert("schemaVersion", SCHEMA_VERSION as f64)?;
    if let Some(page_name) = &options.page_name {
        let page = tree.create(None)?;
        let data = tree.get_meta(page)?;
        data.insert(node_key::TYPE, "page")?;
        data.insert(node_key::NAME, page_name.as_str())?;
        data.insert(node_key::BACKGROUND, options.page_background.as_str())?;
        data.ensure_mergeable_map(node_key::STYLES)?;
    }
    doc.commit();
    Ok(doc)
}

/// Load a design file from a snapshot or update blob.
pub fn load_doc(bytes: &[u8]) -> Result<LoroDoc> {
    let doc = LoroDoc::new();
    doc.import(bytes)?;
    nodes_tree(&doc);
    Ok(doc)
}

/// Full snapshot (state + history), what `exportSnapshot` returns in JS.
pub fn export_snapshot(doc: &LoroDoc) -> Result<Vec<u8>> {
    Ok(doc.export(ExportMode::Snapshot)?)
}

/// `meta.name`, if it is a string.
pub fn doc_name(doc: &LoroDoc) -> Option<String> {
    match meta_map(doc).get("name")? {
        ValueOrContainer::Value(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

/// Set `meta.name`; writes no op when unchanged. Does not commit.
pub fn set_doc_name(doc: &LoroDoc, name: &str) -> Result<bool> {
    if doc_name(doc).as_deref() == Some(name) {
        return Ok(false);
    }
    meta_map(doc).insert("name", name)?;
    Ok(true)
}

/// `meta.schemaVersion` as a number, if present.
pub fn schema_version(doc: &LoroDoc) -> Option<f64> {
    match meta_map(doc).get("schemaVersion")? {
        ValueOrContainer::Value(LoroValue::Double(v)) => Some(v),
        ValueOrContainer::Value(LoroValue::I64(v)) => Some(v as f64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_doc_has_meta_and_one_page() {
        let doc = create_empty_doc("Untitled").unwrap();
        assert_eq!(doc_name(&doc).as_deref(), Some("Untitled"));
        assert_eq!(schema_version(&doc), Some(1.0));
        let tree = nodes_tree(&doc);
        let roots = tree.roots();
        assert_eq!(roots.len(), 1);
        let data = tree.get_meta(roots[0]).unwrap().get_deep_value();
        let LoroValue::Map(m) = data else {
            panic!("page data is a map")
        };
        assert_eq!(m.get("type"), Some(&LoroValue::from("page")));
        assert_eq!(m.get("name"), Some(&LoroValue::from("Page 1")));
        assert_eq!(m.get("background"), Some(&LoroValue::from("#EEEEEE")));
        assert!(matches!(m.get("styles"), Some(LoroValue::Map(_))));
    }

    #[test]
    fn set_doc_name_skips_unchanged() {
        let doc = create_empty_doc("A").unwrap();
        assert!(!set_doc_name(&doc, "A").unwrap());
        assert!(set_doc_name(&doc, "B").unwrap());
        doc.commit();
        assert_eq!(doc_name(&doc).as_deref(), Some("B"));
    }

    #[test]
    fn snapshot_round_trip() {
        let doc = create_empty_doc("Round").unwrap();
        let bytes = export_snapshot(&doc).unwrap();
        let loaded = load_doc(&bytes).unwrap();
        assert_eq!(loaded.get_deep_value(), doc.get_deep_value());
        assert!(load_doc(b"not loro").is_err());
    }
}
