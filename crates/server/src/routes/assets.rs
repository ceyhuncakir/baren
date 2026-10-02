//! `PUT`/`GET`/`HEAD /api/files/:id/assets/:hash`: the image bytes behind `assetId`s and
//! `url("baren-asset://<hash>")` fills in team files.
//!
//! Storage: bytes live on disk in `ASSETS_DIR`, content-addressed as `<dir>/<hash[0..2]>/<hash>`
//! (one copy however many files use them); SQLite only describes them (`assets`) and records
//! which file may use which asset (`file_assets`). Bodies are streamed both ways, so a 20 MB
//! upload never sits in memory.
//!
//! - `PUT` (editors and admins): the body is streamed to a temp file while it is hashed; it
//!   must be at most [`MAX_ASSET_BYTES`], its blake3 must equal `:hash`, and it must be a png,
//!   jpeg, webp, gif or avif image (sniffed from the bytes, whatever `Content-Type` says).
//!   The whole body is always required and verified, even when the server already stores
//!   those bytes (for this or another file): proving possession is what links them to a
//!   file. `201` when newly linked, `200` when this file already had it. Answers
//!   [`AssetInfo`]. Clients check with `HEAD` first to skip uploads.
//! - `GET`/`HEAD` (anyone who can open the file): the bytes, `immutable` for a year.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ETAG, IF_NONE_MATCH,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use baren_proto::dto::{AssetInfo, Role};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::db::{ms, now_ms, require_file_role};
use crate::error::{ApiError, ApiResult};
use crate::session::AuthUser;
use crate::state::AppState;

/// Largest accepted asset (the editor accepts images up to 20 MB).
pub const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;
/// Assets no file references are deleted after this long (so an upload that races a file
/// deletion, or an editor that re-adds an image, does not lose bytes).
pub const ORPHAN_GRACE: Duration = Duration::from_secs(24 * 3600);
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const SNIFF_BYTES: usize = 64;

/// `abc…` (64 hex chars, any case) → lowercase, or `invalid_hash`.
fn parse_hash(input: &str) -> ApiResult<String> {
    if input.len() == 64 && input.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(input.to_ascii_lowercase())
    } else {
        Err(ApiError::bad_request(
            "invalid_hash",
            "Asset ids are blake3 hashes (64 hex characters).",
        ))
    }
}

pub fn asset_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(&hash[..2]).join(hash)
}

/// The image type of `head` (the first bytes), if it is one we accept.
pub fn sniff_image(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // ISO-BMFF: `size ftyp major minor compatible…`; AVIF lists `avif`/`avis` among its brands.
    if head.len() >= 16 && &head[4..8] == b"ftyp" {
        let size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let end = size.clamp(16, head.len());
        let brands = std::iter::once(&head[8..12]).chain(head[16..end].chunks_exact(4));
        if brands.into_iter().any(|b| b == b"avif" || b == b"avis") {
            return Some("image/avif");
        }
    }
    None
}

#[derive(sqlx::FromRow)]
struct AssetRow {
    mime: String,
    size: i64,
}

async fn linked_asset(state: &AppState, file_id: &str, hash: &str) -> ApiResult<Option<AssetRow>> {
    Ok(sqlx::query_as::<_, AssetRow>(
        "SELECT a.mime, a.size FROM file_assets fa JOIN assets a ON a.hash = fa.hash \
         WHERE fa.file_id = ? AND fa.hash = ?",
    )
    .bind(file_id)
    .bind(hash)
    .fetch_optional(&state.db)
    .await?)
}

fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "asset_too_large",
        "Images can be at most 20 MB.",
    )
}

/// Removes the temp file when the upload fails or the bytes were already stored (after a
/// successful rename there is nothing left to remove).
struct TempFile(Option<PathBuf>);

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub async fn put(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath((file_id, hash)): UrlPath<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    let hash = parse_hash(&hash)?;
    require_file_role(&state.db, &file_id, &user.id, Role::Editor).await?;
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_ASSET_BYTES) {
        return Err(too_large());
    }
    // The body is always read and verified, even when this file already has the asset
    // (clients skip uploads with `HEAD` first).

    // Stream to a temp file while hashing.
    let tmp_dir = state.assets_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(ApiError::internal)?;
    let tmp = TempFile(Some(
        tmp_dir.join(format!("{}.part", uuid::Uuid::new_v4().simple())),
    ));
    let tmp_path = tmp.0.clone().expect("set above");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(ApiError::internal)?;
    let mut hasher = blake3::Hasher::new();
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    let mut size: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            ApiError::bad_request("invalid_body", format!("The upload failed: {e}"))
        })?;
        size += chunk.len() as u64;
        if size > MAX_ASSET_BYTES {
            return Err(too_large());
        }
        if head.len() < SNIFF_BYTES {
            let take = (SNIFF_BYTES - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..take]);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    file.flush().await.map_err(ApiError::internal)?;
    file.sync_data().await.map_err(ApiError::internal)?;
    drop(file);

    if hasher.finalize().to_hex().as_str() != hash {
        return Err(ApiError::bad_request(
            "hash_mismatch",
            "The uploaded bytes do not match the asset id (blake3).",
        ));
    }
    let Some(mime) = sniff_image(&head) else {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Only png, jpeg, webp, gif and avif images can be uploaded.",
        ));
    };

    // Move into place and link, excluded from the orphan sweep.
    let _guard = state.assets_lock.read().await;
    let final_path = asset_path(&state.assets_dir, &hash);
    if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
        // Same hash, same bytes: keep the existing copy.
    } else {
        let shard = final_path.parent().expect("sharded path");
        tokio::fs::create_dir_all(shard)
            .await
            .map_err(ApiError::internal)?;
        tokio::fs::rename(&tmp_path, &final_path)
            .await
            .map_err(ApiError::internal)?;
    }
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO assets (hash, mime, size, created_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (hash) DO NOTHING",
    )
    .bind(&hash)
    .bind(mime)
    .bind(size as i64)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let linked = sqlx::query(
        "INSERT INTO file_assets (file_id, hash, created_by, created_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (file_id, hash) DO NOTHING",
    )
    .bind(&file_id)
    .bind(&hash)
    .bind(&user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    drop(tmp);

    let status = if linked == 1 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(AssetInfo {
            hash,
            mime: mime.to_string(),
            size,
        }),
    )
        .into_response())
}

fn asset_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "asset_not_found",
        "This file has no asset with that id.",
    )
}

/// Shared by `GET` and `HEAD`: check access and build the headers.
async fn lookup(
    state: &AppState,
    user: &AuthUser,
    file_id: &str,
    hash: &str,
    headers: &HeaderMap,
) -> ApiResult<Result<(Response, AssetRow, String), Response>> {
    let hash = parse_hash(hash)?;
    require_file_role(&state.db, file_id, &user.id, Role::Viewer).await?;
    let row = linked_asset(state, file_id, &hash)
        .await?
        .ok_or_else(asset_not_found)?;
    let etag = format!("\"{hash}\"");
    let mut response = StatusCode::OK.into_response();
    let h = response.headers_mut();
    h.insert(CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
    h.insert(
        ETAG,
        HeaderValue::from_str(&etag).map_err(ApiError::internal)?,
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    if etag_matches(headers, &etag) {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        return Ok(Err(response));
    }
    let h = response.headers_mut();
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&row.mime).map_err(ApiError::internal)?,
    );
    h.insert(CONTENT_LENGTH, HeaderValue::from(row.size.max(0) as u64));
    Ok(Ok((response, row, hash)))
}

/// `If-None-Match: "a", W/"b"` or `*`.
pub fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().trim_start_matches("W/"))
        .any(|t| t == "*" || t == etag)
}

pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath((file_id, hash)): UrlPath<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (response, _row, hash) = match lookup(&state, &user, &file_id, &hash, &headers).await? {
        Ok(found) => found,
        Err(not_modified) => return Ok(not_modified),
    };
    let file = match tokio::fs::File::open(asset_path(&state.assets_dir, &hash)).await {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            tracing::error!(hash, "asset row without bytes on disk");
            return Err(asset_not_found());
        }
        Err(err) => return Err(ApiError::internal(err)),
    };
    let (parts, _) = response.into_parts();
    let body = Body::from_stream(ReaderStream::with_capacity(file, 64 * 1024));
    Ok(Response::from_parts(parts, body))
}

pub async fn head(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath((file_id, hash)): UrlPath<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    Ok(
        match lookup(&state, &user, &file_id, &hash, &headers).await? {
            Ok((response, _, _)) => response,
            Err(not_modified) => not_modified,
        },
    )
}

/// Delete assets that no file references and that are older than `grace` (rows and bytes),
/// and leftover temp files of interrupted uploads. The purge task runs it with
/// [`ORPHAN_GRACE`].
pub async fn sweep_orphans(state: &AppState, grace: Duration) -> anyhow::Result<usize> {
    let _guard = state.assets_lock.write().await;
    let cutoff = now_ms() - ms(grace);
    let hashes: Vec<String> = sqlx::query_scalar(
        "DELETE FROM assets WHERE created_at <= ? \
         AND NOT EXISTS (SELECT 1 FROM file_assets fa WHERE fa.hash = assets.hash) \
         RETURNING hash",
    )
    .bind(cutoff)
    .fetch_all(&state.db)
    .await?;
    for hash in &hashes {
        if hash.len() == 64 {
            match tokio::fs::remove_file(asset_path(&state.assets_dir, hash)).await {
                Ok(()) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => tracing::warn!(hash, error = %err, "removing an orphaned asset failed"),
            }
        }
    }
    // Temp files older than an hour belong to uploads that died mid-way.
    if let Ok(mut entries) = tokio::fs::read_dir(state.assets_dir.join("tmp")).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let stale = entry
                .metadata()
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(3600));
            if stale {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
    if !hashes.is_empty() {
        tracing::info!(count = hashes.len(), "swept unreferenced assets");
    }
    Ok(hashes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_64_hex_chars() {
        let h = "AB".repeat(32);
        assert_eq!(parse_hash(&h).unwrap(), "ab".repeat(32));
        assert!(parse_hash("abc").is_err());
        assert!(parse_hash(&"g".repeat(64)).is_err());
        assert!(parse_hash(&format!("../{}", "a".repeat(61))).is_err());
    }

    #[test]
    fn sniffs_accepted_image_types() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n\0\0"), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(
            sniff_image(b"\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf"),
            Some("image/avif")
        );
        assert_eq!(
            sniff_image(b"\0\0\0\x20ftypmif1\0\0\0\0mif1avifmiafMA1B"),
            Some("image/avif")
        );
        assert_eq!(sniff_image(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"), None);
        assert_eq!(sniff_image(b"<svg xmlns="), None);
        assert_eq!(sniff_image(b"<html>"), None);
        assert_eq!(sniff_image(b""), None);
    }

    #[test]
    fn if_none_match_lists_and_weak_tags() {
        let mut h = HeaderMap::new();
        assert!(!etag_matches(&h, "\"x\""));
        h.insert(IF_NONE_MATCH, HeaderValue::from_static("\"a\", W/\"x\""));
        assert!(etag_matches(&h, "\"x\""));
        h.insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
        assert!(etag_matches(&h, "\"y\""));
    }
}
