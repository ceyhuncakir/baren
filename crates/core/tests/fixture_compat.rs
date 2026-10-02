//! Cross-compat with `loro-crdt` (JS): documents written by `@baren/schema`
//! must load in the `loro` crate and materialise to exactly what the JS
//! `toSnapshot` / `toSubtreeSnapshot` print.
//!
//! Fixtures: `design/fixtures/sample.*` (packages/schema/scripts/make-fixture.mjs)
//! and `tests/fixtures/parity.*` / `parity3.*` (tests/fixtures/make-parity.mjs). The
//! Phase 3 document also pins `toRenderSubtree`, `vectorToPathD` and the HTML export.
//!
//! "Exactly" means: equal JSON values, the same node and page order, and the
//! same printed lines (layout, string escaping, number formatting). Only the
//! key order *inside* `styles`/token maps may differ — it is Loro's internal
//! hash-map order, which differs between the native and the wasm (32-bit)
//! builds and carries no meaning.

mod common;

use std::path::PathBuf;

use baren_core::export::json::to_string_pretty;
use baren_core::schema::{
    self, get_node, to_render_subtree, to_snapshot, to_subtree_snapshot, vector_to_path_d,
};
use baren_core::{HtmlOptions, Store};

fn design_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../design/fixtures")
        .join(name)
}

fn parity_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn read(path: PathBuf) -> Vec<u8> {
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (regenerate the fixture)", path.display()))
}

#[test]
fn loads_js_snapshot() {
    let doc = schema::load_doc(&read(design_fixture("sample.loro"))).expect("snapshot imports");
    assert_eq!(baren_core::doc_name(&doc).as_deref(), Some("Sample"));

    let expected: serde_json::Value =
        serde_json::from_slice(&read(design_fixture("sample.json"))).unwrap();
    let tree = doc.get_tree(baren_core::container::NODES);
    let live = tree
        .nodes()
        .into_iter()
        .filter(|id| !tree.is_node_deleted(id).unwrap_or(true));
    assert_eq!(
        live.count(),
        expected["snapshot"]["nodes"].as_object().unwrap().len()
    );
    assert_eq!(
        tree.roots().len(),
        expected["snapshot"]["pageIds"].as_array().unwrap().len()
    );
}

#[test]
fn sample_snapshot_matches_js() {
    let doc = schema::load_doc(&read(design_fixture("sample.loro"))).unwrap();
    let expected: serde_json::Value =
        serde_json::from_slice(&read(design_fixture("sample.json"))).unwrap();
    let actual = serde_json::to_value(to_snapshot(&doc)).unwrap();
    assert_eq!(actual, expected["snapshot"]);
}

/// Assert `actual` (Rust) prints the same JSON as `expected` (JS).
fn assert_same_json(actual: &str, expected: &str) {
    let a: serde_json::Value = serde_json::from_str(actual).unwrap();
    let e: serde_json::Value = serde_json::from_str(expected).unwrap();
    assert_eq!(a, e, "JSON values differ");

    // Same printed lines (modulo the comma that moves with key order).
    let lines = |s: &str| {
        let mut v: Vec<String> = s
            .lines()
            .map(|l| l.trim_end_matches(',').to_owned())
            .collect();
        v.sort();
        v
    };
    assert_eq!(lines(actual), lines(expected), "printed lines differ");

    // Nodes in the same depth-first order.
    let node_keys = |s: &str| -> Vec<String> {
        s.lines()
            .filter_map(|l| l.strip_prefix("    \"")?.strip_suffix("\": {"))
            .filter(|k| k.contains('@'))
            .map(str::to_owned)
            .collect()
    };
    assert_eq!(node_keys(actual), node_keys(expected), "node order differs");
    assert!(!node_keys(expected).is_empty());
}

#[test]
fn parity_snapshot_matches_js() {
    let doc = schema::load_doc(&read(parity_fixture("parity.loro"))).unwrap();
    let expected = String::from_utf8(read(parity_fixture("parity.snapshot.txt"))).unwrap();
    assert_same_json(&to_string_pretty(&to_snapshot(&doc)).unwrap(), &expected);
}

#[test]
fn parity_subtree_matches_js() {
    let doc = schema::load_doc(&read(parity_fixture("parity.loro"))).unwrap();
    let expected = String::from_utf8(read(parity_fixture("parity.subtree.txt"))).unwrap();
    let root: serde_json::Value = serde_json::from_str(&expected).unwrap();
    let root_id = root["rootId"].as_str().unwrap();
    let subtree = to_subtree_snapshot(&doc, root_id).expect("board exists");
    assert_same_json(&to_string_pretty(&subtree).unwrap(), &expected);
    assert!(to_subtree_snapshot(&doc, "999@999").is_none());
}

#[test]
fn store_round_trip_preserves_js_document() {
    let dir = common::TempDir::new("compat");
    let store = Store::open(dir.path().join("core.db")).unwrap();
    let meta = store
        .import_file(&read(parity_fixture("parity.loro")), None)
        .unwrap();
    assert_eq!(meta.name, "Parity ✦ <file> \"quoted\"");

    let expected = String::from_utf8(read(parity_fixture("parity.snapshot.txt"))).unwrap();
    assert_same_json(&store.export_json(&meta.id).unwrap(), &expected);

    // Same document after the store round-trips the snapshot through SQLite.
    drop(store);
    let store = Store::open(dir.path().join("core.db")).unwrap();
    let reopened = schema::load_doc(&store.open_file(&meta.id).unwrap()).unwrap();
    assert_same_json(
        &to_string_pretty(&to_snapshot(&reopened)).unwrap(),
        &expected,
    );
}

#[test]
fn html_export_of_js_document_is_sanitised() {
    let dir = common::TempDir::new("compat-html");
    let store = Store::open(dir.path().join("core.db")).unwrap();
    let meta = store
        .import_file(&read(parity_fixture("parity.loro")), None)
        .unwrap();
    let subtree: serde_json::Value =
        serde_json::from_slice(&read(parity_fixture("parity.subtree.txt"))).unwrap();
    let board = subtree["rootId"].as_str().unwrap();

    let html = store
        .export_html(&meta.id, board, &HtmlOptions::default())
        .unwrap();
    assert!(html.starts_with("<style>\n:root {\n"), "{html}");
    assert!(html.contains("--color-primary: #141414;"), "{html}");
    assert!(!html.contains("--gone"), "deleted token is not exported");
    assert!(
        html.contains("<section style=\"position: relative; "),
        "{html}"
    );
    assert!(
        !html.contains("left: -120.5px"),
        "artboard canvas position dropped: {html}"
    );
    assert!(
        html.contains("Hey 👋 &lt;b&gt;\"world\"&lt;/b&gt; &amp; ünïcödé — 你好!!<br>second line"),
        "text escaped: {html}"
    );
    assert!(!html.contains("<script"), "{html}");
    assert!(
        html.contains("width: 1e21px") || html.contains("width: 1000000000000000000000px"),
        "{html}"
    );
    assert!(
        html.contains("<img src=\"baren-asset://af1349b9"),
        "missing asset falls back to a URL: {html}"
    );
    let page_html = store
        .export_html(
            &meta.id,
            &meta_page(&store, &meta.id),
            &HtmlOptions::default(),
        )
        .unwrap();
    assert!(
        page_html.contains("<main style=\"position: relative; background-color: #EEEEEE"),
        "{page_html}"
    );
}

fn meta_page(store: &Store, id: &str) -> String {
    let snap = store.snapshot(id).unwrap();
    snap.page_ids
        .iter()
        .find(|p| snap.nodes.get(p).unwrap().name == "Page 1")
        .unwrap()
        .clone()
}

// ---------------------------------------------------------------------------
// Phase 3: groups, vectors, components (contract §4.11)
// ---------------------------------------------------------------------------

fn parity3_doc() -> baren_core::loro::LoroDoc {
    schema::load_doc(&read(parity_fixture("parity3.loro"))).unwrap()
}

#[test]
fn parity3_snapshot_matches_js() {
    let doc = parity3_doc();
    let expected = String::from_utf8(read(parity_fixture("parity3.snapshot.txt"))).unwrap();
    let snapshot = to_snapshot(&doc);
    assert!(snapshot.components.is_some(), "registry decoded");
    assert_same_json(&to_string_pretty(&snapshot).unwrap(), &expected);
}

/// Node ids per root, in the order the JS side printed them (`JSON.stringify` keeps insertion
/// order; `serde_json::Value` would sort keys).
fn printed_node_order(text: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("      \"rootId\": \"") {
            out.push((rest.trim_end_matches("\",").to_owned(), Vec::new()));
        } else if let Some(key) = line
            .strip_prefix("        \"")
            .and_then(|l| l.strip_suffix("\": {"))
        {
            if let Some((_, ids)) = out.last_mut() {
                ids.push(key.to_owned());
            }
        }
    }
    out
}

#[test]
fn parity3_render_subtrees_match_js() {
    let doc = parity3_doc();
    let text = String::from_utf8(read(parity_fixture("parity3.render.txt"))).unwrap();
    let expected: serde_json::Value = serde_json::from_str(&text).unwrap();
    let roots = expected["roots"].as_array().unwrap();
    assert_eq!(roots.len(), 4);
    let orders = printed_node_order(&text);
    assert_eq!(orders.len(), roots.len());
    for (want, (root_id, want_order)) in roots.iter().zip(&orders) {
        assert_eq!(want["rootId"].as_str(), Some(root_id.as_str()));
        let got = to_render_subtree(&doc, root_id).expect("root resolves");
        assert_eq!(
            &serde_json::to_value(&got).unwrap(),
            want,
            "render subtree of {root_id}"
        );
        let order: Vec<&str> = got.nodes.iter().map(|n| n.node.id.as_str()).collect();
        assert_eq!(order, *want_order, "node order of {root_id}");
    }
    assert!(to_render_subtree(&doc, "999@999").is_none());
    assert!(to_render_subtree(&doc, "999@999/abcdefghij").is_none());
}

#[test]
fn parity3_paths_match_js() {
    let doc = parity3_doc();
    let expected: serde_json::Value =
        serde_json::from_slice(&read(parity_fixture("parity3.paths.txt"))).unwrap();
    for (id, d) in expected.as_object().unwrap() {
        let node = get_node(&doc, id).expect("vector exists");
        let vector = node.vector.expect("vector data");
        assert_eq!(vector_to_path_d(&vector), d.as_str().unwrap(), "{id}");
    }
}

#[test]
fn parity3_html_export_matches_js() {
    let dir = common::TempDir::new("compat-html3");
    let store = Store::open(dir.path().join("core.db")).unwrap();
    let meta = store
        .import_file(&read(parity_fixture("parity3.loro")), None)
        .unwrap();
    let expected: serde_json::Value =
        serde_json::from_slice(&read(parity_fixture("parity3.html.txt"))).unwrap();
    let options = HtmlOptions {
        include_node_ids: true,
        ..Default::default()
    };
    for (root, html) in expected.as_object().unwrap() {
        let got = store.export_html(&meta.id, root, &options).unwrap();
        assert_eq!(got, html.as_str().unwrap(), "HTML of {root}");
    }
}
