//! Persistent store for design files, assets and thumbnails (SQLite).
//!
//! Durability model: every accepted Loro update is appended to
//! `file_updates` and committed before the call returns, so nothing ever
//! needs flushing for safety. Compaction (every N updates / M bytes, when a
//! document is evicted or on [`Store::flush`]) folds the log into one
//! snapshot per file, atomically.
//!
//! Concurrency: `Store` is `Send + Sync`. Calls on different files run in
//! parallel (one lock per open document); writes share one SQLite writer
//! connection and reads use a small pool. Updates for the same file may
//! arrive out of order (the N-API layer runs calls on a thread pool); an
//! update whose dependencies are missing is still persisted and its rows are
//! kept through compaction until the dependencies arrive.

mod cache;
mod db;
mod migrations;
mod sql;

use std::path::Path;

use loro::{ExportMode, LoroDoc, VersionRange};
use serde::Serialize;

use self::cache::{DocCache, DocState, SlotGuard};
use self::db::Db;
use crate::error::{CoreError, Result};
use crate::export::html::{self, HtmlInput, HtmlOptions};
use crate::schema::doc::{doc_name, export_snapshot, nodes_tree, set_doc_name};
use crate::schema::edit::get_node_type;
use crate::schema::resolve::to_render_subtree;
use crate::schema::snapshot::{get_tokens, parse_node_id, to_snapshot, to_subtree_snapshot};
use crate::schema::{DocSnapshot, NodeMap, NodeType};
use crate::util::{is_blake3_hex, new_file_id, now_ms};

/// Largest single update `apply_update` accepts.
pub const MAX_UPDATE_BYTES: usize = 64 * 1024 * 1024;
/// Largest asset `put_asset` accepts.
pub const MAX_ASSET_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_THUMBNAIL_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_NAME_BYTES: usize = 1024;
/// Database file name used when [`Store::open`] is given a directory.
pub const DB_FILE_NAME: &str = "baren.sqlite";

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Tuning knobs; the defaults suit the desktop app.
#[derive(Clone, Debug)]
pub struct StoreOptions {
    /// Compact a file after this many appended updates.
    pub compact_every: u32,
    /// …or after this many bytes of appended updates.
    pub compact_bytes: u64,
    /// Documents kept in memory (least recently used are compacted and dropped).
    pub cache_capacity: usize,
    /// Read-only SQLite connections in the pool.
    pub readers: usize,
}

impl Default for StoreOptions {
    fn default() -> Self {
        StoreOptions {
            compact_every: 500,
            compact_bytes: 8 * 1024 * 1024,
            cache_capacity: 8,
            readers: 2,
        }
    }
}

/// `FileMeta` from the desktop bridge (timestamps are ms since the epoch).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub team_id: Option<String>,
    pub remote_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// What [`Store::asset_info`] reports: the stored mime, the byte size and, for
/// images, the pixel size read from the header (no decoding).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub mime: String,
    pub size: usize,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Options for [`Store::export_json_with`].
#[derive(Clone, Debug, Default)]
pub struct JsonOptions {
    /// Add `"assets": { "<hash>": "data:<mime>;base64,…" }` for every asset the
    /// document references (image layers and image fills).
    pub embed_assets: bool,
}

/// Image mime from the header bytes (`imagesize`), for blobs stored without a
/// specific type (e.g. `application/octet-stream` from a drag and drop).
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    use imagesize::{Compression, ImageType};
    Some(match imagesize::image_type(bytes).ok()? {
        ImageType::Png => "image/png",
        ImageType::Jpeg => "image/jpeg",
        ImageType::Gif => "image/gif",
        ImageType::Webp => "image/webp",
        ImageType::Heif(Compression::Av1) => "image/avif",
        ImageType::Heif(_) => "image/heif",
        ImageType::Bmp => "image/bmp",
        ImageType::Ico => "image/x-icon",
        ImageType::Tiff => "image/tiff",
        ImageType::Jxl => "image/jxl",
        _ => return None,
    })
}

pub struct Store {
    db: Db,
    cache: DocCache,
    options: StoreOptions,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Store>();
};

impl Store {
    /// Open (creating if needed) the database and run migrations. `path` is
    /// either an existing directory — the database is then
    /// `<path>/baren.sqlite` — or the database file itself. Only one
    /// `Store` may own a database at a time ([`CoreError::Locked`]).
    pub fn open(path: impl AsRef<Path>) -> Result<Store> {
        Store::open_with(path, StoreOptions::default())
    }

    pub fn open_with(path: impl AsRef<Path>, options: StoreOptions) -> Result<Store> {
        let path = path.as_ref();
        let file = if path.is_dir() {
            path.join(DB_FILE_NAME)
        } else {
            path.to_path_buf()
        };
        Ok(Store {
            db: Db::open(&file, options.readers)?,
            cache: DocCache::new(options.cache_capacity),
            options,
        })
    }

    // -- files ---------------------------------------------------------------

    /// Every file, most recently updated first (archived files included).
    pub fn list_files(&self) -> Result<Vec<FileMeta>> {
        self.db.read(sql::list_files)
    }

    pub fn get_file(&self, id: &str) -> Result<FileMeta> {
        self.db.read(|c| sql::get_file(c, id))
    }

    /// Create a file holding `createEmptyDoc(name)`.
    pub fn create_file(&self, name: &str) -> Result<FileMeta> {
        validate_name(name)?;
        let doc = crate::schema::create_empty_doc(name)?;
        self.insert_new(name, doc)
    }

    /// Create a file from an existing Loro snapshot (e.g. a team file fetched
    /// from the server). `name` overrides the document's `meta.name`.
    pub fn import_file(&self, bytes: &[u8], name: Option<&str>) -> Result<FileMeta> {
        validate_blob("snapshot", bytes)?;
        if let Some(n) = name {
            validate_name(n)?;
        }
        let doc = LoroDoc::new();
        let status = doc
            .import(bytes)
            .map_err(|e| CoreError::InvalidUpdate(e.to_string()))?;
        if status.pending.is_some() {
            return Err(CoreError::InvalidUpdate(
                "the snapshot depends on history it does not contain".into(),
            ));
        }
        nodes_tree(&doc);
        let name = name
            .map(str::to_owned)
            .or_else(|| doc_name(&doc))
            .unwrap_or_else(|| "Untitled".to_owned());
        if set_doc_name(&doc, &name)? {
            doc.commit();
        }
        self.insert_new(&name, doc)
    }

    fn insert_new(&self, name: &str, doc: LoroDoc) -> Result<FileMeta> {
        let snapshot = export_snapshot(&doc)?;
        let now = now_ms();
        let meta = FileMeta {
            id: new_file_id(),
            name: name.to_owned(),
            created_at: now,
            updated_at: now,
            archived: false,
            team_id: None,
            remote_id: None,
        };
        self.db.write(|c| sql::insert_file(c, &meta, &snapshot))?;
        // Keep it warm: a new file is almost always opened next.
        self.with_entry(&meta.id, |slot| {
            slot.fill(DocState {
                doc,
                max_seq: 0,
                pending_updates: 0,
                pending_bytes: 0,
                unresolved: Vec::new(),
                name: name.to_owned(),
                poisoned: false,
                compact_failures: 0,
            });
            Ok(())
        })?;
        Ok(meta)
    }

    /// Rename a file. The name is also written into the document's
    /// `meta.name` (as an op from this store's peer) so exports agree.
    pub fn rename_file(&self, id: &str, name: &str) -> Result<()> {
        validate_name(name)?;
        self.with_doc(id, |state| {
            let before = state.doc.oplog_vv();
            if set_doc_name(&state.doc, name)? {
                state.doc.commit();
                let update = state.doc.export(ExportMode::updates(&before))?;
                self.persist_update(id, state, &update, Some(name.to_owned()), None)
            } else {
                state.name = name.to_owned();
                self.db.write(|c| sql::set_name(c, id, name, now_ms()))
            }
        })
    }

    pub fn archive_file(&self, id: &str, archived: bool) -> Result<()> {
        self.db
            .write(|c| sql::set_archived(c, id, archived, now_ms()))
    }

    /// Link a local file to a team file on the server (or unlink with `None`s).
    pub fn set_file_remote(
        &self,
        id: &str,
        team_id: Option<&str>,
        remote_id: Option<&str>,
    ) -> Result<()> {
        self.db
            .write(|c| sql::set_remote(c, id, team_id, remote_id))
    }

    /// Delete a file with its history and thumbnail. Assets are shared
    /// between files and are kept.
    pub fn remove_file(&self, id: &str) -> Result<()> {
        self.with_entry(id, |slot| {
            let result = self.db.write(|c| sql::delete_file(c, id));
            slot.clear();
            result
        })
    }

    /// The file's current Loro snapshot. Served straight from disk when no
    /// updates are pending; otherwise pending updates are replayed and the
    /// result is compacted, so the next open is a single read again.
    pub fn open_file(&self, id: &str) -> Result<Vec<u8>> {
        self.with_entry(id, |slot| {
            let loaded_and_clean = slot.state().map(|s| s.is_clean());
            if loaded_and_clean != Some(false) {
                if let Some(snapshot) = self.db.read(|c| sql::clean_snapshot(c, id))? {
                    return Ok(snapshot);
                }
            }
            if slot.state().is_none() {
                slot.fill(self.load_state(id)?);
            }
            let state = slot.state().expect("slot was just filled");
            self.compact_state(id, state)
        })
    }

    /// Validate `update` by importing it into the cached document, then
    /// append it to the file's log. Rejects bytes Loro cannot decode.
    /// Updates that add nothing new are accepted and not stored.
    pub fn apply_update(&self, id: &str, update: &[u8]) -> Result<()> {
        validate_blob("update", update)?;
        self.with_doc(id, |state| {
            let status = match state.doc.import(update) {
                Ok(status) => status,
                Err(e) => {
                    // A failed import may have touched the in-memory doc;
                    // reload it from disk next time.
                    state.poisoned = true;
                    return Err(CoreError::InvalidUpdate(e.to_string()));
                }
            };
            let pending = status.pending.filter(has_ops);
            if !has_ops(&status.success) && pending.is_none() {
                return Ok(());
            }
            let name = doc_name(&state.doc).unwrap_or_default();
            let rename = (name != state.name).then_some(name);
            self.persist_update(id, state, update, rename, pending)
        })
    }

    /// Compact one file now (no-op when nothing is pending).
    pub fn compact(&self, id: &str) -> Result<()> {
        self.with_doc(id, |state| {
            if !state.is_clean() {
                self.compact_state(id, state)?;
            }
            Ok(())
        })
    }

    /// Compact every open document with pending updates and checkpoint the
    /// WAL. Call on app quit; the store stays usable afterwards.
    pub fn flush(&self) -> Result<()> {
        let mut first_error = None;
        for entry in self.cache.loaded() {
            let mut slot = entry.lock();
            if let Some(state) = slot.state().filter(|s| !s.is_clean()) {
                if let Err(e) = self.compact_state(&entry.id, state) {
                    first_error.get_or_insert(e);
                }
            }
        }
        if let Err(e) = self.db.write(|c| sql::checkpoint(c)) {
            first_error.get_or_insert(e);
        }
        first_error.map_or(Ok(()), Err)
    }

    // -- assets & thumbnails -------------------------------------------------

    /// Store a blob and return its blake3 hex digest (deduplicated).
    pub fn put_asset(&self, bytes: &[u8], mime: &str) -> Result<String> {
        if bytes.is_empty() {
            return Err(CoreError::invalid("asset is empty"));
        }
        check_size("asset", bytes.len(), MAX_ASSET_BYTES)?;
        let mut mime = normalize_mime(mime)?;
        // A generic type (drag and drop, clipboard) is replaced by the sniffed
        // image type so `baren-asset://` serves the right `Content-Type`.
        if !mime.starts_with("image/") {
            if let Some(sniffed) = sniff_image_mime(bytes) {
                sniffed.clone_into(&mut mime);
            }
        }
        let hash = blake3::hash(bytes).to_hex().to_string();
        self.db
            .write(|c| sql::put_asset(c, &hash, &mime, bytes, now_ms()))?;
        Ok(hash)
    }

    /// The asset with this blake3 hex digest, if stored.
    pub fn get_asset(&self, hash: &str) -> Result<Option<Asset>> {
        if !is_blake3_hex(hash) {
            return Ok(None);
        }
        Ok(self
            .db
            .read(|c| sql::get_asset(c, hash))?
            .map(|(bytes, mime)| Asset { bytes, mime }))
    }

    /// Mime, byte size and (for images) pixel size of a stored asset.
    pub fn asset_info(&self, hash: &str) -> Result<Option<AssetInfo>> {
        Ok(self.get_asset(hash)?.map(|a| {
            let dims = imagesize::blob_size(&a.bytes)
                .ok()
                .and_then(|s| Some((u32::try_from(s.width).ok()?, u32::try_from(s.height).ok()?)));
            AssetInfo {
                size: a.bytes.len(),
                width: dims.map(|d| d.0),
                height: dims.map(|d| d.1),
                mime: a.mime,
            }
        }))
    }

    /// Store the file's thumbnail (must be a PNG).
    pub fn set_thumbnail(&self, id: &str, png: &[u8]) -> Result<()> {
        check_size("thumbnail", png.len(), MAX_THUMBNAIL_BYTES)?;
        if !png.starts_with(PNG_SIGNATURE) {
            return Err(CoreError::invalid("thumbnail must be a PNG image"));
        }
        self.db.write(|c| sql::set_thumbnail(c, id, png, now_ms()))
    }

    /// The file's thumbnail, or `None` if it has none (error if no such file).
    pub fn get_thumbnail(&self, id: &str) -> Result<Option<Vec<u8>>> {
        self.db.read(|c| sql::get_thumbnail(c, id))
    }

    // -- export --------------------------------------------------------------

    /// The whole document as a `DocSnapshot`.
    pub fn snapshot(&self, id: &str) -> Result<DocSnapshot> {
        self.with_doc(id, |state| Ok(to_snapshot(&state.doc)))
    }

    /// What `JSON.stringify(toSnapshot(doc), null, 2)` prints: same values,
    /// layout, escaping, number formatting and node order. (Key order inside
    /// `styles`/`tokens` is Loro's map order, which differs between the
    /// native and wasm builds; JSON gives it no meaning.)
    pub fn export_json(&self, id: &str) -> Result<String> {
        crate::export::json::to_string_pretty(&self.snapshot(id)?)
    }

    /// [`Store::export_json`], optionally with the referenced assets inlined as
    /// `data:` URIs under a top-level `assets` key (a self-contained copy).
    pub fn export_json_with(&self, id: &str, options: &JsonOptions) -> Result<String> {
        let snapshot = self.snapshot(id)?;
        if !options.embed_assets {
            return crate::export::json::to_string_pretty(&snapshot);
        }
        let mut assets = std::collections::BTreeMap::new();
        for hash in crate::export::json::snapshot_asset_refs(&snapshot.nodes) {
            if let Some(asset) = self.get_asset(&hash)? {
                let uri = format!(
                    "data:{};base64,{}",
                    asset.mime,
                    crate::export::base64::encode(&asset.bytes)
                );
                assets.insert(hash, uri);
            }
        }
        #[derive(Serialize)]
        struct WithAssets<'a> {
            #[serde(flatten)]
            snapshot: &'a DocSnapshot,
            assets: std::collections::BTreeMap<String, String>,
        }
        crate::export::json::to_string_pretty(&WithAssets {
            snapshot: &snapshot,
            assets,
        })
    }

    /// One node's subtree (a real or virtual id) as semantic HTML with inline
    /// styles, instances resolved (contract §3); tokens are emitted as `:root`
    /// custom properties. See [`HtmlOptions`].
    pub fn export_html(&self, id: &str, node_id: &str, options: &HtmlOptions) -> Result<String> {
        let (subtree, tokens, doc_title, root_is_artboard) = self.with_doc(id, |state| {
            let doc = &state.doc;
            // Subtrees without instances keep the Phase 2 path (no resolution work).
            let plain = to_subtree_snapshot(doc, node_id)
                .filter(|sub| !sub.nodes.iter().any(|n| n.node_type == NodeType::Instance));
            let nodes = match plain {
                Some(sub) => sub.nodes,
                None => {
                    let rendered = to_render_subtree(doc, node_id)
                        .ok_or_else(|| CoreError::NodeNotFound(node_id.to_owned()))?;
                    let mut nodes = NodeMap::with_capacity(rendered.nodes.len());
                    for n in rendered.nodes {
                        nodes.insert(n.node);
                    }
                    nodes
                }
            };
            let root = nodes.get(node_id).expect("subtree contains its root");
            let root_is_artboard = match &root.parent_id {
                Some(parent) if parse_node_id(node_id).is_some() => {
                    get_node_type(doc, parent)? == NodeType::Page
                }
                _ => false,
            };
            Ok((
                nodes,
                get_tokens(doc),
                doc_name(doc).unwrap_or_default(),
                root_is_artboard,
            ))
        })?;
        let mut assets = std::collections::HashMap::new();
        if options.embed_assets {
            for hash in html::referenced_assets(&subtree, node_id) {
                if let Some(asset) = self.get_asset(hash)? {
                    assets.insert(hash.to_owned(), asset);
                }
            }
        }
        Ok(html::render(
            &HtmlInput {
                root_id: node_id,
                nodes: &subtree,
                tokens: &tokens,
                title: &doc_title,
                root_is_artboard,
                assets: &assets,
            },
            options,
        ))
    }

    // -- internals -----------------------------------------------------------

    /// Run `f` with exclusive access to the file's cache slot, then drop the
    /// slot if `f` poisoned it and evict documents over capacity.
    fn with_entry<R>(
        &self,
        id: &str,
        f: impl FnOnce(&mut SlotGuard<'_>) -> Result<R>,
    ) -> Result<R> {
        let entry = self.cache.acquire(id);
        let result = {
            let mut slot = entry.lock();
            let result = f(&mut slot);
            if slot.state().is_some_and(|s| s.poisoned) {
                slot.clear();
            }
            result
        };
        drop(entry);
        self.evict_excess(id);
        result
    }

    /// `with_entry`, loading the document first if needed.
    fn with_doc<R>(&self, id: &str, f: impl FnOnce(&mut DocState) -> Result<R>) -> Result<R> {
        self.with_entry(id, |slot| {
            if slot.state().is_none() {
                slot.fill(self.load_state(id)?);
            }
            f(slot.state().expect("slot was just filled"))
        })
    }

    fn evict_excess(&self, keep: &str) {
        for victim in self.cache.eviction_candidates(keep) {
            let mut slot = victim.lock();
            if let Some(state) = slot.state().filter(|s| !s.is_clean()) {
                // Best effort: the update log is durable; a failed
                // compaction just means a longer replay on next load.
                let _ = self.compact_state(&victim.id, state);
            }
            slot.clear();
        }
        self.cache.prune();
    }

    fn load_state(&self, id: &str) -> Result<DocState> {
        let stored = self.db.read(|c| sql::load_doc(c, id))?;
        let max_seq = stored.updates.last().map_or(0, |(seq, _)| *seq);
        let pending_updates = u32::try_from(stored.updates.len()).unwrap_or(u32::MAX);
        let pending_bytes = stored.updates.iter().map(|(_, b)| b.len() as u64).sum();
        let has_snapshot = stored.snapshot.is_some();
        let blobs: Vec<Vec<u8>> = stored
            .snapshot
            .into_iter()
            .chain(stored.updates.into_iter().map(|(_, b)| b))
            .collect();

        let mut doc = LoroDoc::new();
        let mut unresolved = Vec::new();
        if !blobs.is_empty() {
            match doc.import_batch(&blobs) {
                Ok(status) => unresolved.extend(status.pending),
                Err(_) => {
                    // Should not happen (updates are validated before they are
                    // stored), but never lock the user out of a file: replay
                    // blob by blob and skip what cannot be read.
                    doc = LoroDoc::new();
                    for (i, blob) in blobs.iter().enumerate() {
                        match doc.import(blob) {
                            Ok(status) => unresolved.extend(status.pending),
                            Err(e) if i == 0 && has_snapshot => {
                                return Err(CoreError::Loro(format!(
                                    "stored snapshot of file {id} is unreadable: {e}"
                                )));
                            }
                            Err(_) => {}
                        }
                    }
                }
            }
        }
        nodes_tree(&doc);
        Ok(DocState {
            name: doc_name(&doc).unwrap_or_default(),
            doc,
            max_seq,
            pending_updates,
            pending_bytes,
            unresolved,
            poisoned: false,
            compact_failures: 0,
        })
    }

    fn persist_update(
        &self,
        id: &str,
        state: &mut DocState,
        bytes: &[u8],
        rename: Option<String>,
        pending: Option<VersionRange>,
    ) -> Result<()> {
        let seq = match self
            .db
            .write(|c| sql::append_update(c, id, bytes, now_ms(), rename.as_deref()))
        {
            Ok(seq) => seq,
            Err(e) => {
                // The doc now holds ops the disk does not: reload on next use.
                state.poisoned = true;
                return Err(e);
            }
        };
        state.max_seq = seq;
        state.pending_updates = state.pending_updates.saturating_add(1);
        state.pending_bytes += bytes.len() as u64;
        state.unresolved.extend(pending);
        if let Some(name) = rename {
            state.name = name;
        }
        let backoff = 1 + state.compact_failures;
        if state.pending_updates >= self.options.compact_every.saturating_mul(backoff)
            || state.pending_bytes
                >= self
                    .options
                    .compact_bytes
                    .saturating_mul(u64::from(backoff))
        {
            // The update is already durable; a failed compaction is retried
            // later with backoff, so it is not reported to the caller.
            let _ = self.compact_state(id, state);
        }
        Ok(())
    }

    /// Write a fresh snapshot and fold the update log into it. Returns the
    /// snapshot bytes.
    fn compact_state(&self, id: &str, state: &mut DocState) -> Result<Vec<u8>> {
        let bytes = export_snapshot(&state.doc)?;
        let fold_upto = state.settle_unresolved().then_some(state.max_seq);
        match self
            .db
            .write(|c| sql::write_snapshot(c, id, &bytes, now_ms(), fold_upto))
        {
            Ok(()) => {
                state.pending_updates = 0;
                state.pending_bytes = 0;
                state.compact_failures = 0;
                Ok(bytes)
            }
            Err(e) => {
                state.compact_failures = state.compact_failures.saturating_add(1);
                Err(e)
            }
        }
    }
}

/// True when the range covers at least one op.
fn has_ops(range: &VersionRange) -> bool {
    range.iter().any(|(_, (start, end))| end > start)
}

fn check_size(what: &'static str, size: usize, max: usize) -> Result<()> {
    if size > max {
        Err(CoreError::TooLarge { what, size, max })
    } else {
        Ok(())
    }
}

/// Cheap structural check before touching any document: size limits and a
/// Loro header/checksum decode.
fn validate_blob(what: &'static str, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        return Err(CoreError::InvalidUpdate(format!("{what} is empty")));
    }
    check_size(what, bytes.len(), MAX_UPDATE_BYTES)?;
    LoroDoc::decode_import_blob_meta(bytes, true)
        .map(|_| ())
        .map_err(|e| CoreError::InvalidUpdate(e.to_string()))
}

fn validate_name(name: &str) -> Result<()> {
    check_size("name", name.len(), MAX_NAME_BYTES)?;
    if name.contains('\0') {
        return Err(CoreError::invalid("name must not contain NUL characters"));
    }
    Ok(())
}

/// `type/subtype` (RFC 6838 restricted names), lowercased; parameters such as
/// `; charset=utf-8` are dropped.
fn normalize_mime(mime: &str) -> Result<String> {
    let essence = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let valid_part = |s: &str| {
        !s.is_empty()
            && s.len() <= 127
            && s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    match essence.split_once('/') {
        Some((t, s)) if valid_part(t) && valid_part(s) => Ok(essence),
        _ => Err(CoreError::invalid(format!("not a MIME type: {mime:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_normalisation() {
        assert_eq!(normalize_mime("Image/PNG").unwrap(), "image/png");
        assert_eq!(
            normalize_mime("image/svg+xml; charset=utf-8").unwrap(),
            "image/svg+xml"
        );
        assert!(normalize_mime("png").is_err());
        assert!(normalize_mime("image/").is_err());
        assert!(normalize_mime("image/p ng").is_err());
        assert!(normalize_mime("text/html\"><script>").is_err());
    }

    #[test]
    fn blob_validation() {
        assert_eq!(
            validate_blob("update", b"").unwrap_err().code(),
            "invalid-update"
        );
        assert_eq!(
            validate_blob("update", b"garbage").unwrap_err().code(),
            "invalid-update"
        );
        let doc = crate::schema::create_empty_doc("x").unwrap();
        let bytes = export_snapshot(&doc).unwrap();
        validate_blob("update", &bytes).unwrap();
        let mut corrupt = bytes.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0xff;
        assert!(
            validate_blob("update", &corrupt).is_err(),
            "checksum is verified"
        );
    }

    #[test]
    fn name_validation() {
        assert!(validate_name("").is_ok());
        assert!(validate_name("a\0b").is_err());
        assert_eq!(
            validate_name(&"x".repeat(MAX_NAME_BYTES + 1))
                .unwrap_err()
                .code(),
            "too-large"
        );
    }
}
