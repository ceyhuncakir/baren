//! Session tokens and the `AuthUser` extractor.
//!
//! A session token is 32 random bytes (base64url); the database stores `sha256(token)`.
//! Expiry slides: each use more than [`BUMP_EVERY`] after the previous bump pushes
//! `expires_at` out by the configured TTL (and refreshes the user's `last_seen_at`).

use std::time::Duration;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::HeaderMap;
use baren_proto::dto;
use sqlx::SqlitePool;

use crate::db::{ms, now_ms};
use crate::error::ApiError;
use crate::secrets::{hash_secret, new_token};
use crate::state::AppState;

const BUMP_EVERY: Duration = Duration::from_secs(5 * 60);

/// The authenticated caller of a request.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: i64,
    pub token_hash: Vec<u8>,
}

impl AuthUser {
    pub fn dto(&self) -> dto::User {
        dto::User {
            id: self.id.clone(),
            name: self.name.clone(),
            email: self.email.clone(),
            created_at: self.created_at,
        }
    }
}

/// Create a session and return its (unhashed) token.
pub async fn create_session(
    db: &SqlitePool,
    user_id: &str,
    ttl: Duration,
) -> Result<String, sqlx::Error> {
    let token = new_token();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(hash_secret(&token))
    .bind(user_id)
    .bind(now)
    .bind(now)
    .bind(now + ms(ttl))
    .execute(db)
    .await?;
    sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?")
        .bind(now)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(token)
}

pub async fn delete_session(db: &SqlitePool, token_hash: &[u8]) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(token_hash)
        .execute(db)
        .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: String,
    name: String,
    email: String,
    created_at: i64,
    last_used_at: i64,
}

/// Resolve a token to its user, sliding the expiry. `Ok(None)` for unknown/expired tokens.
pub async fn authenticate(
    db: &SqlitePool,
    token: &str,
    ttl: Duration,
) -> Result<Option<AuthUser>, sqlx::Error> {
    if token.is_empty() || token.len() > 256 {
        return Ok(None);
    }
    let token_hash = hash_secret(token);
    let now = now_ms();
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT u.id, u.name, u.email, u.created_at, s.last_used_at \
         FROM sessions s JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .bind(&token_hash)
    .bind(now)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    if now - row.last_used_at >= ms(BUMP_EVERY) {
        sqlx::query("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?")
            .bind(now)
            .bind(now + ms(ttl))
            .bind(&token_hash)
            .execute(db)
            .await?;
        touch_user(db, &row.id).await?;
    }
    Ok(Some(AuthUser {
        id: row.id,
        name: row.name,
        email: row.email,
        created_at: row.created_at,
        token_hash,
    }))
}

/// Record activity for "Last seen" in Team → Members.
pub async fn touch_user(db: &SqlitePool, user_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// `Authorization: Bearer <token>`.
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = bearer_token(&parts.headers).ok_or_else(ApiError::unauthorized)?;
        authenticate(&state.db, token, state.config.session_ttl)
            .await?
            .ok_or_else(ApiError::unauthorized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn parses_bearer_token() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer_token(&h), None);
        h.insert(AUTHORIZATION, HeaderValue::from_static("Bearer abc"));
        assert_eq!(bearer_token(&h), Some("abc"));
        h.insert(AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer_token(&h), None);
    }
}
