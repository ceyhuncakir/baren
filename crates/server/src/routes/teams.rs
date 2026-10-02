//! `/api/teams/**`: teams ("parties") and their members.

use axum::extract::{Path, State};
use axum::Json;
use baren_proto::dto::{
    CreateTeamRequest, Member, OkResponse, Role, Team, UpdateMemberRequest, UpdateTeamRequest,
};

use crate::db::{self, new_id, now_ms, parse_role, require_team_role};
use crate::error::{ApiError, ApiResult, JsonBody};
use crate::session::AuthUser;
use crate::state::AppState;
use crate::validate;

const MAX_TEAMS_PER_USER: i64 = 100;

pub async fn list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<Team>>> {
    Ok(Json(db::teams_for_user(&state.db, &user.id).await?))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    JsonBody(req): JsonBody<CreateTeamRequest>,
) -> ApiResult<Json<Team>> {
    let name = validate::label(&req.name, "Team name", 80)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM memberships WHERE user_id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await?;
    if count >= MAX_TEAMS_PER_USER {
        return Err(ApiError::conflict(
            "too_many_teams",
            "You are in too many teams.",
        ));
    }
    let team_id = new_id();
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
        .bind(&team_id)
        .bind(&name)
        .bind(&user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO memberships (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
        .bind(&team_id)
        .bind(&user.id)
        .bind(Role::Admin.as_str())
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    team_view(&state, &team_id, &user.id).await.map(Json)
}

pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<String>,
    JsonBody(req): JsonBody<UpdateTeamRequest>,
) -> ApiResult<Json<Team>> {
    require_team_role(&state.db, &team_id, &user.id, Role::Admin).await?;
    if let Some(name) = &req.name {
        let name = validate::label(name, "Team name", 80)?;
        sqlx::query("UPDATE teams SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&team_id)
            .execute(&state.db)
            .await?;
    }
    if let Some(access) = req.file_access {
        sqlx::query("UPDATE teams SET file_access = ? WHERE id = ?")
            .bind(access.as_str())
            .bind(&team_id)
            .execute(&state.db)
            .await?;
    }
    team_view(&state, &team_id, &user.id).await.map(Json)
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<String>,
) -> ApiResult<Json<OkResponse>> {
    require_team_role(&state.db, &team_id, &user.id, Role::Admin).await?;
    let file_ids: Vec<String> = sqlx::query_scalar("SELECT id FROM files WHERE team_id = ?")
        .bind(&team_id)
        .fetch_all(&state.db)
        .await?;
    // Close live rooms first so they do not write updates for files that are about to vanish.
    for file_id in &file_ids {
        state.rooms.close_file(file_id).await;
    }
    sqlx::query("DELETE FROM teams WHERE id = ?")
        .bind(&team_id)
        .execute(&state.db)
        .await?;
    Ok(Json(OkResponse { ok: true }))
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    user_id: String,
    name: String,
    email: String,
    role: String,
    joined_at: i64,
    last_seen_at: Option<i64>,
}

pub async fn members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<String>,
) -> ApiResult<Json<Vec<Member>>> {
    require_team_role(&state.db, &team_id, &user.id, Role::Viewer).await?;
    let rows = sqlx::query_as::<_, MemberRow>(
        "SELECT u.id AS user_id, u.name, u.email, m.role, m.joined_at, u.last_seen_at \
         FROM memberships m JOIN users u ON u.id = m.user_id \
         WHERE m.team_id = ? ORDER BY m.joined_at, u.name",
    )
    .bind(&team_id)
    .fetch_all(&state.db)
    .await?;
    let members = rows
        .into_iter()
        .map(|row| {
            Ok(Member {
                online: state.rooms.is_online(&row.user_id),
                role: parse_role(&row.role)?,
                user_id: row.user_id,
                name: row.name,
                email: row.email,
                joined_at: row.joined_at,
                last_seen_at: row.last_seen_at,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(members))
}

pub async fn update_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, member_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<UpdateMemberRequest>,
) -> ApiResult<Json<OkResponse>> {
    require_team_role(&state.db, &team_id, &user.id, Role::Admin).await?;
    let current = db::team_role(&state.db, &team_id, &member_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Member"))?;
    if current == req.role {
        return Ok(Json(OkResponse { ok: true }));
    }
    if current.is_admin() && admin_count(&state, &team_id).await? <= 1 {
        return Err(last_admin());
    }
    sqlx::query("UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?")
        .bind(req.role.as_str())
        .bind(&team_id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    let files = team_file_ids(&state, &team_id).await?;
    state
        .rooms
        .update_access(&files, &member_id, Some(req.role))
        .await;
    Ok(Json(OkResponse { ok: true }))
}

/// Admins remove anyone; any member may remove themselves (leave the team).
pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((team_id, member_id)): Path<(String, String)>,
) -> ApiResult<Json<OkResponse>> {
    let min = if member_id == user.id {
        Role::Viewer
    } else {
        Role::Admin
    };
    require_team_role(&state.db, &team_id, &user.id, min).await?;
    let current = db::team_role(&state.db, &team_id, &member_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Member"))?;
    if current.is_admin() && admin_count(&state, &team_id).await? <= 1 {
        return Err(last_admin());
    }
    sqlx::query("DELETE FROM memberships WHERE team_id = ? AND user_id = ?")
        .bind(&team_id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    let files = team_file_ids(&state, &team_id).await?;
    state.rooms.update_access(&files, &member_id, None).await;
    Ok(Json(OkResponse { ok: true }))
}

fn last_admin() -> ApiError {
    ApiError::conflict(
        "last_admin",
        "A team needs at least one admin. Make someone else an admin first.",
    )
}

async fn admin_count(state: &AppState, team_id: &str) -> ApiResult<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM memberships WHERE team_id = ? AND role = 'admin'")
            .bind(team_id)
            .fetch_one(&state.db)
            .await?,
    )
}

async fn team_file_ids(state: &AppState, team_id: &str) -> ApiResult<Vec<String>> {
    Ok(sqlx::query_scalar("SELECT id FROM files WHERE team_id = ?")
        .bind(team_id)
        .fetch_all(&state.db)
        .await?)
}

pub async fn team_view(state: &AppState, team_id: &str, user_id: &str) -> ApiResult<Team> {
    db::team_for_user(&state.db, team_id, user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Team"))
}
