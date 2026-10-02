//! SQLite pool, embedded migrations and shared queries.

use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use baren_proto::dto::{self, FileAccess, Role};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::error::{ApiError, ApiResult};

pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Open (creating if needed) the database and apply pending migrations.
pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(database_url)
        .with_context(|| format!("invalid DATABASE_URL {database_url:?}"))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .with_context(|| format!("opening {database_url}"))?;
    MIGRATOR.run(&pool).await.context("running migrations")?;
    Ok(pool)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn ms(d: Duration) -> i64 {
    d.as_millis() as i64
}

/// Time-ordered unique id (UUID v7, hyphenated).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .is_some_and(|e| e.is_unique_violation())
}

pub fn is_foreign_key_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .is_some_and(|e| e.is_foreign_key_violation())
}

pub fn parse_role(value: &str) -> ApiResult<Role> {
    Role::parse(value).ok_or_else(|| ApiError::internal(format!("bad role in db: {value}")))
}

// ---------------------------------------------------------------------------------------------
// Users

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: i64,
}

impl From<UserRow> for dto::User {
    fn from(row: UserRow) -> Self {
        dto::User {
            id: row.id,
            name: row.name,
            email: row.email,
            created_at: row.created_at,
        }
    }
}

pub async fn user_by_id(db: &SqlitePool, user_id: &str) -> ApiResult<UserRow> {
    sqlx::query_as::<_, UserRow>("SELECT id, name, email, created_at FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| ApiError::not_found("User"))
}

// ---------------------------------------------------------------------------------------------
// Teams

#[derive(Debug, sqlx::FromRow)]
struct TeamRow {
    id: String,
    name: String,
    role: String,
    file_access: String,
    member_count: i64,
    created_at: i64,
}

impl TryFrom<TeamRow> for dto::Team {
    type Error = ApiError;

    fn try_from(row: TeamRow) -> ApiResult<Self> {
        Ok(dto::Team {
            id: row.id,
            name: row.name,
            role: parse_role(&row.role)?,
            file_access: FileAccess::parse(&row.file_access).unwrap_or_default(),
            member_count: row.member_count.max(0) as u32,
            created_at: row.created_at,
        })
    }
}

/// `SELECT` for teams as seen by one member (first bind = user id) plus a literal suffix.
macro_rules! team_select {
    ($suffix:literal) => {
        concat!(
            "SELECT t.id, t.name, m.role, t.file_access, t.created_at, ",
            "(SELECT COUNT(*) FROM memberships mc WHERE mc.team_id = t.id) AS member_count ",
            "FROM teams t JOIN memberships m ON m.team_id = t.id AND m.user_id = ? ",
            $suffix
        )
    };
}

/// Teams the user belongs to, oldest membership first (the registration team comes first).
pub async fn teams_for_user(db: &SqlitePool, user_id: &str) -> ApiResult<Vec<dto::Team>> {
    let rows = sqlx::query_as::<_, TeamRow>(team_select!("ORDER BY m.joined_at, t.created_at"))
        .bind(user_id)
        .fetch_all(db)
        .await?;
    rows.into_iter().map(dto::Team::try_from).collect()
}

/// One team as seen by `user_id`; `None` when the user is not a member.
pub async fn team_for_user(
    db: &SqlitePool,
    team_id: &str,
    user_id: &str,
) -> ApiResult<Option<dto::Team>> {
    let row = sqlx::query_as::<_, TeamRow>(team_select!("WHERE t.id = ?"))
        .bind(user_id)
        .bind(team_id)
        .fetch_optional(db)
        .await?;
    row.map(dto::Team::try_from).transpose()
}

/// The caller's role in a team, or `None` when not a member.
pub async fn team_role(db: &SqlitePool, team_id: &str, user_id: &str) -> ApiResult<Option<Role>> {
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM memberships WHERE team_id = ? AND user_id = ?")
            .bind(team_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    role.as_deref().map(parse_role).transpose()
}

/// Require membership (404 when the team is unknown or the user is not in it) and at least
/// `min` privileges (403 otherwise).
pub async fn require_team_role(
    db: &SqlitePool,
    team_id: &str,
    user_id: &str,
    min: Role,
) -> ApiResult<Role> {
    let role = team_role(db, team_id, user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Team"))?;
    if role.rank() < min.rank() {
        return Err(ApiError::forbidden(format!(
            "This action needs the {} role.",
            min.as_str()
        )));
    }
    Ok(role)
}

// ---------------------------------------------------------------------------------------------
// Files

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileAccessError {
    NotFound,
    Forbidden,
}

/// What `user_id` may do with `file_id`: their team role, or `Viewer` through a team's
/// "anyone with the link" setting.
pub async fn file_role(
    db: &SqlitePool,
    file_id: &str,
    user_id: &str,
) -> Result<Result<(String, Role), FileAccessError>, sqlx::Error> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT f.team_id, t.file_access, m.role FROM files f \
         JOIN teams t ON t.id = f.team_id \
         LEFT JOIN memberships m ON m.team_id = f.team_id AND m.user_id = ? \
         WHERE f.id = ?",
    )
    .bind(user_id)
    .bind(file_id)
    .fetch_optional(db)
    .await?;
    let Some((team_id, access, role)) = row else {
        return Ok(Err(FileAccessError::NotFound));
    };
    let role = match role.as_deref().and_then(Role::parse) {
        Some(role) => role,
        None if FileAccess::parse(&access) == Some(FileAccess::Link) => Role::Viewer,
        None => return Ok(Err(FileAccessError::Forbidden)),
    };
    Ok(Ok((team_id, role)))
}

/// REST flavour of [`file_role`].
pub async fn require_file_role(
    db: &SqlitePool,
    file_id: &str,
    user_id: &str,
    min: Role,
) -> ApiResult<(String, Role)> {
    match file_role(db, file_id, user_id).await? {
        Err(FileAccessError::NotFound) => Err(ApiError::not_found("File")),
        Err(FileAccessError::Forbidden) => {
            Err(ApiError::forbidden("You do not have access to this file."))
        }
        Ok((_, role)) if role.rank() < min.rank() => Err(ApiError::forbidden(format!(
            "This action needs the {} role.",
            min.as_str()
        ))),
        Ok(found) => Ok(found),
    }
}

#[derive(Debug, sqlx::FromRow)]
pub struct FileRow {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub created_by: Option<String>,
}

impl From<FileRow> for dto::File {
    fn from(row: FileRow) -> Self {
        dto::File {
            id: row.id,
            team_id: row.team_id,
            name: row.name,
            archived: row.archived,
            created_at: row.created_at,
            updated_at: row.updated_at,
            created_by: row.created_by,
        }
    }
}

/// Remove expired sessions, codes (verification and password reset) and device requests.
pub async fn purge_expired(db: &SqlitePool) -> Result<(), sqlx::Error> {
    let now = now_ms();
    sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(now)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM email_codes WHERE expires_at <= ?")
        .bind(now - ms(Duration::from_secs(86_400)))
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM device_codes WHERE expires_at <= ?")
        .bind(now - ms(Duration::from_secs(86_400)))
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM password_resets WHERE expires_at <= ?")
        .bind(now - ms(Duration::from_secs(86_400)))
        .execute(db)
        .await?;
    Ok(())
}
