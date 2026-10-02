//! `GET`/`HEAD /updates/*`: the desktop auto-update feed (electron-updater's generic provider),
//! served from `UPDATES_DIR` (`latest-linux.yml`, the AppImage/deb/rpm files and their
//! `.blockmap`s). 404 when `UPDATES_DIR` is unset.
//!
//! Supports what electron-updater needs: `Accept-Ranges: bytes`, single ranges (`206` +
//! `Content-Range`), multiple ranges (`206 multipart/byteranges`, parts in request order and
//! never merged: its differential downloader asks for up to 1000 blocks at once and splits
//! the response by the lengths it asked for), `If-Range`, `ETag`/`Last-Modified` and `304`s.
//! Bodies are streamed from disk.

use std::io::{ErrorKind, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG,
    IF_MODIFIED_SINCE, IF_RANGE, LAST_MODIFIED, RANGE,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use super::assets::etag_matches;
use crate::dates::http_date;
use crate::error::ApiError;
use crate::state::AppState;

/// More ranges than this in one request are answered with the whole file.
const MAX_RANGES: usize = 2000;
const CHUNK: usize = 64 * 1024;

pub async fn serve(
    State(state): State<AppState>,
    method: Method,
    UrlPath(path): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(root) = state.config.updates_dir.as_deref() else {
        return ApiError::not_found("Update feed").into_response();
    };
    match resolve(root, &path).await {
        Some((file_path, meta)) => serve_file(&method, &headers, &file_path, &meta)
            .await
            .unwrap_or_else(|err| ApiError::internal(err).into_response()),
        None => ApiError::not_found("Update file").into_response(),
    }
}

/// Map a request path to a regular file inside `root` (no `..`, no hidden files, no symlinks
/// out of the directory).
async fn resolve(root: &Path, request: &str) -> Option<(PathBuf, std::fs::Metadata)> {
    let mut relative = PathBuf::new();
    for part in request.split('/') {
        if part.is_empty() || part.starts_with('.') || part.contains('\\') || part.contains('\0') {
            return None;
        }
        let mut components = Path::new(part).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) => relative.push(name),
            _ => return None,
        }
    }
    let root = tokio::fs::canonicalize(root).await.ok()?;
    let full = tokio::fs::canonicalize(root.join(&relative)).await.ok()?;
    if !full.starts_with(&root) {
        return None;
    }
    let meta = tokio::fs::metadata(&full).await.ok()?;
    meta.is_file().then_some((full, meta))
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "yml" | "yaml" => "text/yaml; charset=utf-8",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "zip" => "application/zip",
        "deb" => "application/vnd.debian.binary-package",
        "rpm" => "application/x-rpm",
        "dmg" => "application/x-apple-diskimage",
        _ => "application/octet-stream",
    }
}

async fn serve_file(
    method: &Method,
    headers: &HeaderMap,
    path: &Path,
    meta: &std::fs::Metadata,
) -> std::io::Result<Response> {
    let len = meta.len();
    let modified = meta.modified().unwrap_or(UNIX_EPOCH);
    let mtime = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let etag = format!("\"{len:x}-{mtime:x}\"");
    let last_modified = http_date(modified);
    let ctype = content_type(path);
    // Feed metadata must be revalidated; installers and blockmaps are versioned file names.
    let cache = if ctype.starts_with("text/yaml") || ctype == "application/json" {
        "no-cache"
    } else {
        "public, max-age=3600"
    };

    let mut base = HeaderMap::new();
    base.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    base.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    base.insert(ETAG, header(&etag));
    base.insert(LAST_MODIFIED, header(&last_modified));

    let not_modified = if headers.contains_key(axum::http::header::IF_NONE_MATCH) {
        etag_matches(headers, &etag)
    } else {
        headers
            .get(IF_MODIFIED_SINCE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim() == last_modified)
    };
    if not_modified {
        return Ok((StatusCode::NOT_MODIFIED, base).into_response());
    }

    // `If-Range` must match exactly, else the range is ignored and the whole file is sent.
    let range_allowed = headers
        .get(IF_RANGE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v.trim() == etag || v.trim() == last_modified);
    let ranges = match headers.get(RANGE).and_then(|v| v.to_str().ok()) {
        Some(spec) if range_allowed => parse_ranges(spec, len),
        _ => RangeRequest::Full,
    };
    let head = method == Method::HEAD;

    match ranges {
        RangeRequest::Full => {
            let mut response = base;
            response.insert(CONTENT_TYPE, HeaderValue::from_static(ctype));
            response.insert(CONTENT_LENGTH, HeaderValue::from(len));
            let body = if head {
                Body::empty()
            } else {
                file_body(path, 0, len).await?
            };
            Ok((StatusCode::OK, response, body).into_response())
        }
        RangeRequest::Unsatisfiable => {
            let mut response = base;
            response.insert(CONTENT_RANGE, header(&format!("bytes */{len}")));
            Ok((StatusCode::RANGE_NOT_SATISFIABLE, response).into_response())
        }
        RangeRequest::Ranges(ranges) if ranges.len() == 1 => {
            let (start, end) = ranges[0];
            let mut response = base;
            response.insert(CONTENT_TYPE, HeaderValue::from_static(ctype));
            response.insert(CONTENT_RANGE, header(&format!("bytes {start}-{end}/{len}")));
            response.insert(CONTENT_LENGTH, HeaderValue::from(end - start + 1));
            let body = if head {
                Body::empty()
            } else {
                file_body(path, start, end - start + 1).await?
            };
            Ok((StatusCode::PARTIAL_CONTENT, response, body).into_response())
        }
        RangeRequest::Ranges(ranges) => {
            let boundary = format!("baren-{}", uuid::Uuid::new_v4().simple());
            let part_heads: Vec<Vec<u8>> = ranges
                .iter()
                .enumerate()
                .map(|(i, (start, end))| {
                    format!(
                        "{}--{boundary}\r\nContent-Type: {ctype}\r\nContent-Range: bytes {start}-{end}/{len}\r\n\r\n",
                        if i == 0 { "" } else { "\r\n" }
                    )
                    .into_bytes()
                })
                .collect();
            let tail = format!("\r\n--{boundary}--\r\n").into_bytes();
            let total: u64 = part_heads.iter().map(|h| h.len() as u64).sum::<u64>()
                + ranges.iter().map(|(s, e)| e - s + 1).sum::<u64>()
                + tail.len() as u64;
            let mut response = base;
            response.insert(
                CONTENT_TYPE,
                header(&format!("multipart/byteranges; boundary={boundary}")),
            );
            response.insert(CONTENT_LENGTH, HeaderValue::from(total));
            let body = if head {
                Body::empty()
            } else {
                multipart_body(path.to_path_buf(), ranges, part_heads, tail).await?
            };
            Ok((StatusCode::PARTIAL_CONTENT, response, body).into_response())
        }
    }
}

fn header(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

async fn file_body(path: &Path, start: u64, len: u64) -> std::io::Result<Body> {
    let mut file = tokio::fs::File::open(path).await?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await?;
    }
    Ok(Body::from_stream(ReaderStream::with_capacity(
        file.take(len),
        CHUNK,
    )))
}

/// Stream `multipart/byteranges` through a pipe filled by a background task, so any number of
/// parts needs one open file and bounded memory.
async fn multipart_body(
    path: PathBuf,
    ranges: Vec<(u64, u64)>,
    heads: Vec<Vec<u8>>,
    tail: Vec<u8>,
) -> std::io::Result<Body> {
    let mut file = tokio::fs::File::open(&path).await?;
    let (mut writer, reader) = tokio::io::duplex(CHUNK);
    tokio::spawn(async move {
        let result: std::io::Result<()> = async {
            for ((start, end), head) in ranges.into_iter().zip(heads) {
                writer.write_all(&head).await?;
                file.seek(SeekFrom::Start(start)).await?;
                let mut part = (&mut file).take(end - start + 1);
                tokio::io::copy(&mut part, &mut writer).await?;
            }
            writer.write_all(&tail).await?;
            writer.shutdown().await
        }
        .await;
        // A client that hangs up mid-way is not an error worth logging.
        if let Err(err) = result {
            if err.kind() != ErrorKind::BrokenPipe {
                tracing::debug!(error = %err, "multipart range response ended early");
            }
        }
    });
    Ok(Body::from_stream(ReaderStream::with_capacity(
        reader, CHUNK,
    )))
}

#[derive(Debug, PartialEq, Eq)]
enum RangeRequest {
    /// No (usable) `Range`: send everything.
    Full,
    /// Inclusive `(start, end)` pairs in request order.
    Ranges(Vec<(u64, u64)>),
    Unsatisfiable,
}

/// Parse `bytes=0-99, 200-, -50` against a file of `len` bytes. Unsatisfiable parts are
/// dropped (416 if none is left); syntax errors, other units, too many ranges or ranges that
/// add up to more than the file (overlap abuse) fall back to the whole file.
fn parse_ranges(spec: &str, len: u64) -> RangeRequest {
    let Some(list) = spec.trim().strip_prefix("bytes=") else {
        return RangeRequest::Full;
    };
    let mut out = Vec::new();
    let mut total: u64 = 0;
    for (i, part) in list.split(',').enumerate() {
        if i >= MAX_RANGES {
            return RangeRequest::Full;
        }
        let part = part.trim();
        let Some((a, b)) = part.split_once('-') else {
            return RangeRequest::Full;
        };
        let (a, b) = (a.trim(), b.trim());
        let range = if a.is_empty() {
            // Suffix: the last `b` bytes.
            let Ok(n) = b.parse::<u64>() else {
                return RangeRequest::Full;
            };
            if n == 0 || len == 0 {
                continue;
            }
            (len.saturating_sub(n), len - 1)
        } else {
            let Ok(start) = a.parse::<u64>() else {
                return RangeRequest::Full;
            };
            let end = if b.is_empty() {
                u64::MAX
            } else {
                match b.parse::<u64>() {
                    Ok(end) if end >= start => end,
                    _ => return RangeRequest::Full,
                }
            };
            if start >= len {
                continue;
            }
            (start, end.min(len - 1))
        };
        total = total.saturating_add(range.1 - range.0 + 1);
        out.push(range);
    }
    if out.is_empty() {
        return RangeRequest::Unsatisfiable;
    }
    if out.len() > 1 && total > len {
        return RangeRequest::Full;
    }
    RangeRequest::Ranges(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges() {
        use RangeRequest::*;
        assert_eq!(parse_ranges("bytes=0-9", 100), Ranges(vec![(0, 9)]));
        assert_eq!(parse_ranges("bytes=90-", 100), Ranges(vec![(90, 99)]));
        assert_eq!(parse_ranges("bytes=-10", 100), Ranges(vec![(90, 99)]));
        assert_eq!(parse_ranges("bytes=95-200", 100), Ranges(vec![(95, 99)]));
        // Order is kept, ranges are not merged (electron-updater relies on both).
        assert_eq!(
            parse_ranges("bytes=50-59, 0-9, 10-19", 100),
            Ranges(vec![(50, 59), (0, 9), (10, 19)])
        );
        assert_eq!(parse_ranges("bytes=100-", 100), Unsatisfiable);
        assert_eq!(parse_ranges("bytes=0-0", 0), Unsatisfiable);
        assert_eq!(
            parse_ranges("bytes=200-300, 5-6", 100),
            Ranges(vec![(5, 6)])
        );
        assert_eq!(parse_ranges("items=0-9", 100), Full);
        assert_eq!(parse_ranges("bytes=9-0", 100), Full);
        assert_eq!(parse_ranges("bytes=abc", 100), Full);
        // Overlapping ranges that add up to more than the file: send it once instead.
        assert_eq!(parse_ranges("bytes=0-99, 0-99", 100), Full);
        let many = (0..2001)
            .map(|i| format!("{i}-{i}"))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_ranges(&format!("bytes={many}"), 10_000), Full);
    }

    #[tokio::test]
    async fn resolves_only_files_inside_the_root() {
        let root = std::env::temp_dir().join(format!("baren-updates-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("latest-linux.yml"), "version: 1").unwrap();
        std::fs::write(root.join("sub/a.bin"), "x").unwrap();
        std::fs::write(root.join(".secret"), "x").unwrap();
        assert!(resolve(&root, "latest-linux.yml").await.is_some());
        assert!(resolve(&root, "sub/a.bin").await.is_some());
        for bad in [
            "",
            "sub",
            "../etc/passwd",
            "sub/../latest-linux.yml",
            ".secret",
            "a//b",
            "missing",
        ] {
            assert!(resolve(&root, bad).await.is_none(), "{bad}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hostname", root.join("escape")).unwrap();
            assert!(resolve(&root, "escape").await.is_none());
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
