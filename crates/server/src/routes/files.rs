//! `/api/teams/:id/files`, `/api/files/:id[/snapshot]`.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use baren_proto::dto::{CreateFileRequest, File, OkResponse, Role, UpdateFileRequest};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use loro::{ExportMode, LoroDoc};

use crate::db::{new_id, now_ms, require_file_role, require_team_role, FileRow};
use crate::error::{ApiError, ApiResult, JsonBody};
use crate::html::{self, escape, heading, icons};
use crate::rooms::store;
use crate::session::AuthUser;
use crate::state::AppState;
use crate::validate;

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<String>,
) -> ApiResult<Json<Vec<File>>> {
    require_team_role(&state.db, &team_id, &user.id, Role::Viewer).await?;
    let rows = sqlx::query_as::<_, FileRow>(
        "SELECT id, team_id, name, archived, created_at, updated_at, created_by \
         FROM files WHERE team_id = ? ORDER BY updated_at DESC",
    )
    .bind(&team_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(File::from).collect()))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<String>,
    JsonBody(req): JsonBody<CreateFileRequest>,
) -> ApiResult<Json<File>> {
    require_team_role(&state.db, &team_id, &user.id, Role::Editor).await?;
    let name = validate::label(&req.name, "File name", 200)?;
    let snapshot = match req.snapshot.as_deref() {
        None | Some("") => None,
        Some(b64) => {
            let bytes = STANDARD.decode(b64).map_err(|_| {
                ApiError::bad_request("invalid_snapshot", "snapshot must be base64.")
            })?;
            if bytes.len() > state.config.max_message_bytes {
                return Err(ApiError::bad_request(
                    "snapshot_too_large",
                    "The snapshot is too large.",
                ));
            }
            Some(normalize_snapshot(bytes).await?)
        }
    };
    let id = new_id();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO files (id, team_id, name, snapshot, snapshot_seq, created_by, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&team_id)
    .bind(&name)
    .bind(snapshot)
    .bind(&user.id)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(Json(File {
        id,
        team_id,
        name,
        archived: false,
        created_at: now,
        updated_at: now,
        created_by: Some(user.id),
    }))
}

/// Validate client-provided Loro bytes (snapshot or update) and store them as a snapshot.
async fn normalize_snapshot(bytes: Vec<u8>) -> ApiResult<Vec<u8>> {
    let result = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(move || {
            let doc = LoroDoc::new();
            doc.import(&bytes).ok()?;
            doc.export(ExportMode::Snapshot).ok()
        })
        .ok()
        .flatten()
    })
    .await
    .map_err(ApiError::internal)?;
    result.ok_or_else(|| {
        ApiError::bad_request("invalid_snapshot", "snapshot is not a valid Loro document.")
    })
}

pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(file_id): Path<String>,
    JsonBody(req): JsonBody<UpdateFileRequest>,
) -> ApiResult<Json<File>> {
    require_file_role(&state.db, &file_id, &user.id, Role::Editor).await?;
    let now = now_ms();
    if let Some(name) = &req.name {
        let name = validate::label(name, "File name", 200)?;
        sqlx::query("UPDATE files SET name = ?, updated_at = ? WHERE id = ?")
            .bind(name)
            .bind(now)
            .bind(&file_id)
            .execute(&state.db)
            .await?;
    }
    if let Some(archived) = req.archived {
        sqlx::query("UPDATE files SET archived = ? WHERE id = ?")
            .bind(archived)
            .bind(&file_id)
            .execute(&state.db)
            .await?;
    }
    let row = sqlx::query_as::<_, FileRow>(
        "SELECT id, team_id, name, archived, created_at, updated_at, created_by \
         FROM files WHERE id = ?",
    )
    .bind(&file_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("File"))?;
    Ok(Json(row.into()))
}

/// Delete a file (team admins, or the editor who created it).
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(file_id): Path<String>,
) -> ApiResult<Json<OkResponse>> {
    let (_, role) = require_file_role(&state.db, &file_id, &user.id, Role::Editor).await?;
    if !role.is_admin() {
        let created_by: Option<String> =
            sqlx::query_scalar("SELECT created_by FROM files WHERE id = ?")
                .bind(&file_id)
                .fetch_optional(&state.db)
                .await?
                .flatten();
        if created_by.as_deref() != Some(user.id.as_str()) {
            return Err(ApiError::forbidden(
                "Only admins or the file's creator can delete it.",
            ));
        }
    }
    state.rooms.close_file(&file_id).await;
    sqlx::query("DELETE FROM files WHERE id = ?")
        .bind(&file_id)
        .execute(&state.db)
        .await?;
    Ok(Json(OkResponse { ok: true }))
}

/// The current document as a binary Loro snapshot (full history). Served from the live room
/// when one is open, otherwise from SQLite (snapshot + pending updates).
pub async fn snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    Path(file_id): Path<String>,
) -> ApiResult<Response> {
    require_file_role(&state.db, &file_id, &user.id, Role::Viewer).await?;
    // A room that closes mid-request has already persisted everything, so fall back to SQLite.
    let bytes = match state.rooms.snapshot(&file_id).await {
        Some(Ok(bytes)) => bytes,
        _ => store::snapshot_from_db(&state.db, &file_id)
            .await?
            .ok_or_else(|| ApiError::not_found("File"))?,
    };
    let mut response = Bytes::from(bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[derive(serde::Deserialize)]
pub struct LandingQuery {
    node: Option<String>,
}

/// `GET /f/:id`: the page behind the app's "Copy link". It hands the file to the desktop app
/// and says nothing about it: the app checks access when it opens the file. `?node=<id>` (a
/// link to a layer) is passed on.
pub async fn landing(Path(id): Path<String>, Query(query): Query<LandingQuery>) -> Response {
    if !is_link_id(&id, 64, b"-") {
        return html::page(
            StatusCode::NOT_FOUND,
            "Link not valid",
            icons::ALERT,
            &heading("This link is not valid", "Check the link and try again."),
        );
    }
    let href = match query.node.filter(|n| is_link_id(n, 128, b"-_.@")) {
        Some(node) => format!("baren://file/{id}?node={}", node.replace('@', "%40")),
        None => format!("baren://file/{id}"),
    };
    let body = format!(
        r#"{}
<a class="button" href="{}">Open in Baren</a>
<p>Don't have the app yet? Install Baren, then open this link again.</p>"#,
        heading(
            "Open this design",
            "It opens in the Baren app. You need to be a member of its team to see it.",
        ),
        escape(&href),
    );
    html::page(StatusCode::OK, "Open file", icons::FILE, &body)
}

/// Ids in file links: ASCII letters, digits and `extra`, so they never need escaping.
fn is_link_id(value: &str, max: usize, extra: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}
