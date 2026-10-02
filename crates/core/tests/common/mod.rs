//! Shared helpers for integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use baren_core::loro::{ExportMode, LoroDoc, VersionVector};

/// A unique temporary directory, removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let path = std::env::temp_dir().join(format!(
            "baren-core-{tag}-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A "renderer" peer: a doc loaded from a snapshot that records each commit
/// as an update, like `subscribeLocalUpdates` would.
pub struct Client {
    pub doc: LoroDoc,
    last: VersionVector,
}

impl Client {
    pub fn load(snapshot: &[u8]) -> Client {
        let doc = baren_core::schema::load_doc(snapshot).unwrap();
        let last = doc.oplog_vv();
        Client { doc, last }
    }

    /// Commit and return the update since the previous call.
    pub fn take_update(&mut self) -> Vec<u8> {
        self.doc.commit();
        let update = self.doc.export(ExportMode::updates(&self.last)).unwrap();
        self.last = self.doc.oplog_vv();
        update
    }

    pub fn page(&self) -> String {
        baren_core::schema::to_snapshot(&self.doc).page_ids[0].clone()
    }
}
