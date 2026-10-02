//! N-API surface of `baren-core`, loaded by the Electron main process as
//! `@baren/core-native`.
//!
//! Every method returns a Promise and runs on the libuv thread pool
//! (`AsyncTask`), so SQLite I/O, Loro imports and exports never block the
//! Node event loop. Binary inputs are read in place on the worker thread
//! (do not mutate a buffer until its promise settles); binary results are
//! returned as `Buffer`s.
//!
//! Errors reject with an `Error` whose message starts with a stable code in
//! brackets: `[not-found]`, `[invalid-update]`, `[invalid-input]`,
//! `[too-large]`, `[locked]`, `[database-too-new]`, `[db]`, `[loro]`, `[io]`,
//! `[closed]`, `[internal]`.

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use baren_core::{CoreError, Store, StoreOptions};
use napi::bindgen_prelude::{AsyncTask, Buffer, Uint8Array};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

/// Version of the native core (for diagnostics / About dialog).
#[napi]
pub fn core_version() -> String {
    baren_core::version().to_string()
}

/// File metadata, as in the desktop bridge's `FileMeta`.
#[napi(object, use_nullable = true)]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
    /// Milliseconds since the Unix epoch; bumped by edits, renames and archiving.
    pub updated_at: i64,
    pub archived: bool,
    pub team_id: Option<String>,
    pub remote_id: Option<String>,
}

impl From<baren_core::FileMeta> for FileMeta {
    fn from(m: baren_core::FileMeta) -> Self {
        FileMeta {
            id: m.id,
            name: m.name,
            created_at: m.created_at,
            updated_at: m.updated_at,
            archived: m.archived,
            team_id: m.team_id,
            remote_id: m.remote_id,
        }
    }
}

/// Options for `exportHtml`.
#[napi(object)]
pub struct HtmlExportOptions {
    /// A complete `<!doctype html>` document instead of a fragment. Default false.
    pub document: Option<bool>,
    /// Inline images as `data:` URIs. Default true.
    pub embed_assets: Option<bool>,
    /// Add `data-node-id` attributes. Default false.
    pub include_node_ids: Option<bool>,
    /// `src` prefix for images that are not embedded. Default `"baren-asset://"`.
    pub asset_url_prefix: Option<String>,
}

impl From<HtmlExportOptions> for baren_core::HtmlOptions {
    fn from(o: HtmlExportOptions) -> Self {
        let defaults = baren_core::HtmlOptions::default();
        baren_core::HtmlOptions {
            document: o.document.unwrap_or(defaults.document),
            embed_assets: o.embed_assets.unwrap_or(defaults.embed_assets),
            include_node_ids: o.include_node_ids.unwrap_or(defaults.include_node_ids),
            asset_url_prefix: o.asset_url_prefix.unwrap_or(defaults.asset_url_prefix),
        }
    }
}

/// Options for `exportJson`.
#[napi(object)]
pub struct JsonExportOptions {
    /// Add `assets: { <hash>: "data:<mime>;base64,…" }` for every referenced
    /// asset (a self-contained copy). Default false.
    pub embed_assets: Option<bool>,
}

/// What `getAssetInfo` reports. `width`/`height` come from the image header
/// (no decoding) and are `null` for non-images.
#[napi(object, use_nullable = true)]
pub struct AssetInfo {
    pub mime: String,
    /// Byte size.
    pub size: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl From<baren_core::AssetInfo> for AssetInfo {
    fn from(i: baren_core::AssetInfo) -> Self {
        AssetInfo {
            mime: i.mime,
            size: u32::try_from(i.size).unwrap_or(u32::MAX),
            width: i.width,
            height: i.height,
        }
    }
}

/// An asset's bytes with its stored mime (what `baren-asset://` serves).
#[napi(object)]
pub struct AssetFile {
    pub bytes: Buffer,
    pub mime: String,
}

/// Optional tuning for `new CoreHandle(dbPath, options)`. Defaults suit the app.
#[napi(object)]
pub struct CoreOptions {
    /// Documents kept loaded in memory (least recently used are compacted
    /// and dropped). Default 8.
    pub cache_capacity: Option<u32>,
    /// Compact a file's update log after this many updates. Default 500.
    pub compact_every: Option<u32>,
    /// …or after this many bytes of updates. Default 8 MiB.
    pub compact_bytes: Option<u32>,
}

impl From<CoreOptions> for StoreOptions {
    fn from(o: CoreOptions) -> Self {
        let d = StoreOptions::default();
        StoreOptions {
            cache_capacity: o
                .cache_capacity
                .map_or(d.cache_capacity, |v| v.max(1) as usize),
            compact_every: o.compact_every.map_or(d.compact_every, |v| v.max(1)),
            compact_bytes: o
                .compact_bytes
                .map_or(d.compact_bytes, |v| u64::from(v.max(1))),
            ..d
        }
    }
}

// ---------------------------------------------------------------------------
// Store handle shared by all tasks of one CoreHandle
// ---------------------------------------------------------------------------

enum StoreState {
    Unopened,
    Open(Arc<Store>),
    Closed,
}

struct Shared {
    path: PathBuf,
    options: StoreOptions,
    state: Mutex<StoreState>,
}

impl Shared {
    /// The open store, opening (and migrating) it on first use. Always called
    /// from a worker thread.
    fn store(&self) -> napi::Result<Arc<Store>> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match &*state {
            StoreState::Open(store) => Ok(Arc::clone(store)),
            StoreState::Closed => Err(closed()),
            StoreState::Unopened => {
                let store = Store::open_with(&self.path, self.options.clone());
                let store = Arc::new(store.map_err(to_napi_error)?);
                *state = StoreState::Open(Arc::clone(&store));
                Ok(store)
            }
        }
    }

    /// Mark closed and hand back the store (if it was ever opened).
    fn close(&self) -> Option<Arc<Store>> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match std::mem::replace(&mut *state, StoreState::Closed) {
            StoreState::Open(store) => Some(store),
            StoreState::Unopened | StoreState::Closed => None,
        }
    }
}

fn closed() -> Error {
    Error::new(
        Status::GenericFailure,
        "[closed] this CoreHandle has been closed",
    )
}

fn to_napi_error(e: CoreError) -> Error {
    let status = match e {
        CoreError::InvalidInput(_) | CoreError::InvalidUpdate(_) | CoreError::TooLarge { .. } => {
            Status::InvalidArg
        }
        _ => Status::GenericFailure,
    };
    Error::new(status, format!("[{}] {e}", e.code()))
}

fn panic_message(panic: &(dyn Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}

type Job<T> = Box<dyn FnOnce(&Store) -> baren_core::Result<T> + Send>;

/// Run a job on the current (worker) thread. A panic inside the core must
/// not unwind across the FFI boundary into libuv: it becomes a rejection.
fn run_job<T>(shared: &Shared, job: Option<Job<T>>) -> napi::Result<T> {
    let job = job.ok_or_else(|| Error::new(Status::GenericFailure, "[internal] task ran twice"))?;
    let store = shared.store()?;
    match catch_unwind(AssertUnwindSafe(|| job(&store))) {
        Ok(result) => result.map_err(to_napi_error),
        Err(panic) => Err(Error::new(
            Status::GenericFailure,
            format!(
                "[internal] baren-core panicked: {}",
                panic_message(panic.as_ref())
            ),
        )),
    }
}

/// One `Task` type per JS result type (napi-rs derives the TypeScript
/// `Promise<…>` type from each `impl Task`).
macro_rules! core_task {
    ($name:ident, $output:ty => $js:ty, |$value:ident| $convert:expr) => {
        pub struct $name {
            shared: Arc<Shared>,
            job: Option<Job<$output>>,
        }

        #[napi]
        impl Task for $name {
            type Output = $output;
            type JsValue = $js;

            fn compute(&mut self) -> napi::Result<Self::Output> {
                run_job(&self.shared, self.job.take())
            }

            fn resolve(&mut self, _env: Env, $value: Self::Output) -> napi::Result<Self::JsValue> {
                Ok($convert)
            }
        }
    };
}

core_task!(VoidTask, () => (), |v| v);
core_task!(StringTask, String => String, |v| v);
core_task!(BufferTask, Vec<u8> => Buffer, |v| Buffer::from(v));
core_task!(OptionalBufferTask, Option<Vec<u8>> => Option<Buffer>, |v| v.map(Buffer::from));
core_task!(FileMetaTask, baren_core::FileMeta => FileMeta, |v| FileMeta::from(v));
core_task!(FileListTask, Vec<baren_core::FileMeta> => Vec<FileMeta>, |v| v.into_iter().map(FileMeta::from).collect());
core_task!(AssetInfoTask, Option<baren_core::AssetInfo> => Option<AssetInfo>, |v| v.map(AssetInfo::from));
core_task!(AssetFileTask, Option<baren_core::Asset> => Option<AssetFile>, |v| v.map(|a| AssetFile { bytes: Buffer::from(a.bytes), mime: a.mime }));

/// Closes the store on a worker thread: compacts open documents, checkpoints
/// the WAL and releases the database.
pub struct CloseTask {
    shared: Arc<Shared>,
}

#[napi]
impl Task for CloseTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<()> {
        let Some(store) = self.shared.close() else {
            return Ok(());
        };
        let result = catch_unwind(AssertUnwindSafe(|| store.flush()));
        // Drop our reference here (worker thread); in-flight tasks hold their own.
        drop(store);
        match result {
            Ok(r) => r.map_err(to_napi_error),
            Err(panic) => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "[internal] baren-core panicked: {}",
                    panic_message(panic.as_ref())
                ),
            )),
        }
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> napi::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// CoreHandle
// ---------------------------------------------------------------------------

/// The local persistence backend: design files (Loro documents), assets and
/// thumbnails in one SQLite database. Create one per process.
#[napi]
pub struct CoreHandle {
    shared: Arc<Shared>,
}

#[napi]
impl CoreHandle {
    /// `path` is the data directory (an existing directory; the database is
    /// `<path>/baren.sqlite`) or the database file itself. The constructor
    /// does not touch the disk: the database is opened (created and migrated
    /// if needed) by the first call, on a worker thread, and open errors reject
    /// that call. One handle owns a database at a time; another open rejects
    /// with `[locked]` until `close()` resolves or the owning process exits.
    #[napi(constructor)]
    pub fn new(path: String, options: Option<CoreOptions>) -> napi::Result<Self> {
        if path.trim().is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "[invalid-input] path is empty",
            ));
        }
        Ok(CoreHandle {
            shared: Arc::new(Shared {
                path: PathBuf::from(path),
                options: options.map(Into::into).unwrap_or_default(),
                state: Mutex::new(StoreState::Unopened),
            }),
        })
    }

    fn job<T>(
        &self,
        f: impl FnOnce(&Store) -> baren_core::Result<T> + Send + 'static,
    ) -> (Arc<Shared>, Option<Job<T>>) {
        (Arc::clone(&self.shared), Some(Box::new(f)))
    }

    /// Every file, most recently updated first (archived files included).
    #[napi]
    pub fn list_files(&self) -> AsyncTask<FileListTask> {
        let (shared, job) = self.job(|s| s.list_files());
        AsyncTask::new(FileListTask { shared, job })
    }

    /// Create a file holding an empty document (one page, "Page 1").
    #[napi]
    pub fn create_file(&self, name: String) -> AsyncTask<FileMetaTask> {
        let (shared, job) = self.job(move |s| s.create_file(&name));
        AsyncTask::new(FileMetaTask { shared, job })
    }

    /// Create a file from a Loro snapshot (e.g. fetched from the server).
    /// `name` overrides the document's `meta.name`.
    #[napi]
    pub fn import_file(
        &self,
        snapshot: Uint8Array,
        name: Option<String>,
    ) -> AsyncTask<FileMetaTask> {
        let (shared, job) = self.job(move |s| s.import_file(&snapshot, name.as_deref()));
        AsyncTask::new(FileMetaTask { shared, job })
    }

    /// Rename a file (also written into the document's `meta.name`).
    #[napi]
    pub fn rename_file(&self, id: String, name: String) -> AsyncTask<VoidTask> {
        let (shared, job) = self.job(move |s| s.rename_file(&id, &name));
        AsyncTask::new(VoidTask { shared, job })
    }

    #[napi]
    pub fn archive_file(&self, id: String, archived: bool) -> AsyncTask<VoidTask> {
        let (shared, job) = self.job(move |s| s.archive_file(&id, archived));
        AsyncTask::new(VoidTask { shared, job })
    }

    /// Link a local file to a team file on the server (`null`s unlink).
    #[napi]
    pub fn set_file_remote(
        &self,
        id: String,
        team_id: Option<String>,
        remote_id: Option<String>,
    ) -> AsyncTask<VoidTask> {
        let (shared, job) =
            self.job(move |s| s.set_file_remote(&id, team_id.as_deref(), remote_id.as_deref()));
        AsyncTask::new(VoidTask { shared, job })
    }

    /// Delete a file, its history and thumbnail (assets are shared and kept).
    #[napi]
    pub fn remove_file(&self, id: String) -> AsyncTask<VoidTask> {
        let (shared, job) = self.job(move |s| s.remove_file(&id));
        AsyncTask::new(VoidTask { shared, job })
    }

    /// The file's current Loro snapshot (load it with `loadDoc`).
    #[napi]
    pub fn open_file(&self, id: String) -> AsyncTask<BufferTask> {
        let (shared, job) = self.job(move |s| s.open_file(&id));
        AsyncTask::new(BufferTask { shared, job })
    }

    /// Validate a Loro update (or snapshot) against the file's document and
    /// append it durably. Updates may arrive out of order; ones that add
    /// nothing new are ignored. Rejects with `[invalid-update]` otherwise.
    #[napi]
    pub fn apply_update(&self, id: String, update: Uint8Array) -> AsyncTask<VoidTask> {
        let (shared, job) = self.job(move |s| s.apply_update(&id, &update));
        AsyncTask::new(VoidTask { shared, job })
    }

    /// Fold the file's update log into a fresh snapshot now (e.g. when its
    /// window closes). Happens automatically every 500 updates.
    #[napi]
    pub fn compact_file(&self, id: String) -> AsyncTask<VoidTask> {
        let (shared, job) = self.job(move |s| s.compact(&id));
        AsyncTask::new(VoidTask { shared, job })
    }

    /// Store the file's thumbnail (PNG bytes).
    #[napi]
    pub fn set_thumbnail(&self, id: String, png: Uint8Array) -> AsyncTask<VoidTask> {
        let (shared, job) = self.job(move |s| s.set_thumbnail(&id, &png));
        AsyncTask::new(VoidTask { shared, job })
    }

    /// The file's thumbnail, or `null` when it has none.
    #[napi]
    pub fn get_thumbnail(&self, id: String) -> AsyncTask<OptionalBufferTask> {
        let (shared, job) = self.job(move |s| s.get_thumbnail(&id));
        AsyncTask::new(OptionalBufferTask { shared, job })
    }

    /// Store a blob; resolves to its blake3 hex digest (deduplicated).
    #[napi]
    pub fn put_asset(&self, bytes: Uint8Array, mime: String) -> AsyncTask<StringTask> {
        let (shared, job) = self.job(move |s| s.put_asset(&bytes, &mime));
        AsyncTask::new(StringTask { shared, job })
    }

    /// The asset's bytes, or `null` when no asset has this hash.
    #[napi]
    pub fn get_asset(&self, hash: String) -> AsyncTask<OptionalBufferTask> {
        let (shared, job) = self.job(move |s| Ok(s.get_asset(&hash)?.map(|a| a.bytes)));
        AsyncTask::new(OptionalBufferTask { shared, job })
    }

    /// The asset's bytes and stored mime type, or `null` (for serving
    /// `baren-asset://<hash>` with the right `Content-Type`).
    #[napi]
    pub fn get_asset_file(&self, hash: String) -> AsyncTask<AssetFileTask> {
        let (shared, job) = self.job(move |s| s.get_asset(&hash));
        AsyncTask::new(AssetFileTask { shared, job })
    }

    /// Mime, byte size and pixel size (from the image header) of an asset, or
    /// `null` when no asset has this hash.
    #[napi]
    pub fn get_asset_info(&self, hash: String) -> AsyncTask<AssetInfoTask> {
        let (shared, job) = self.job(move |s| s.asset_info(&hash));
        AsyncTask::new(AssetInfoTask { shared, job })
    }

    /// A node's subtree as semantic HTML with inline styles; tokens become
    /// `:root` custom properties. Image layers and image fills are inlined as
    /// `data:` URIs by default (clipboard export).
    #[napi]
    pub fn export_html(
        &self,
        file_id: String,
        node_id: String,
        options: Option<HtmlExportOptions>,
    ) -> AsyncTask<StringTask> {
        let options: baren_core::HtmlOptions = options.map(Into::into).unwrap_or_default();
        let (shared, job) = self.job(move |s| s.export_html(&file_id, &node_id, &options));
        AsyncTask::new(StringTask { shared, job })
    }

    /// The document as `DocSnapshot` JSON, printed like
    /// `JSON.stringify(toSnapshot(doc), null, 2)`; with `embedAssets`, plus the
    /// referenced assets as `data:` URIs under `assets`.
    #[napi]
    pub fn export_json(
        &self,
        file_id: String,
        options: Option<JsonExportOptions>,
    ) -> AsyncTask<StringTask> {
        let options = baren_core::JsonOptions {
            embed_assets: options.and_then(|o| o.embed_assets).unwrap_or(false),
        };
        let (shared, job) = self.job(move |s| s.export_json_with(&file_id, &options));
        AsyncTask::new(StringTask { shared, job })
    }

    /// Compact open documents, checkpoint the database and release it. Call
    /// on app quit; later calls reject with `[closed]`. Nothing is lost if
    /// this is never called (every update is durable when its promise resolves).
    #[napi]
    pub fn close(&self) -> AsyncTask<CloseTask> {
        AsyncTask::new(CloseTask {
            shared: Arc::clone(&self.shared),
        })
    }
}
