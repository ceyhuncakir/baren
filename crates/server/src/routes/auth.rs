//! `/api/auth/**` and `/api/me`.

use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use baren_proto::dto::{
    AuthResponse, ChangePasswordRequest, ForgotPasswordRequest, LoginRequest, MeResponse,
    OkResponse, ProvidersResponse, RegisterRequest, RegisterResponse, ResendCodeRequest,
    ResetPasswordRequest, Role, VerifyRequest,
};
use sqlx::SqlitePool;

use crate::db::{self, ms, new_id, now_ms, UserRow};
use crate::error::{ApiError, ApiResult, JsonBody};
use crate::mailer::{templates::CODE_TTL_MINUTES, Email, Mailer};
use crate::secrets::{self, hash_secret, new_email_code};
use crate::session::{create_session, delete_session, AuthUser};
use crate::state::{AppState, Revocation};
use crate::validate;

pub const EMAIL_CODE_TTL: Duration = Duration::from_secs(CODE_TTL_MINUTES as u64 * 60);
pub const EMAIL_CODE_MAX_ATTEMPTS: i64 = 5;
/// Password-reset codes: same lifetime, attempts and cooldown as verification codes.
pub const RESET_CODE_TTL: Duration = EMAIL_CODE_TTL;
pub const RESET_CODE_MAX_ATTEMPTS: i64 = 5;
/// Minimum gap between two codes for the same account ("Resend in 0:24").
pub const EMAIL_CODE_COOLDOWN: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------
// Register / verify / login

pub async fn register(
    State(state): State<AppState>,
    JsonBody(req): JsonBody<RegisterRequest>,
) -> ApiResult<Json<RegisterResponse>> {
    let name = validate::display_name(&req.name)?;
    let email = validate::email(&req.email)?;
    validate::password(&req.password)?;
    if !state.email_limiter.check(&format!("register:{email}")) {
        return Err(ApiError::too_many_requests());
    }

    let existing: Option<(String, bool)> =
        sqlx::query_as("SELECT id, email_verified FROM users WHERE email = ?")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    if matches!(existing, Some((_, true))) {
        return Err(email_taken());
    }
    let password_hash = secrets::hash_password(req.password).await?;
    let now = now_ms();

    let user_id = match existing {
        // Registering again before verifying replaces the pending account's name and password,
        // so a typo or a lost code never locks the address.
        Some((id, _)) => {
            sqlx::query("UPDATE users SET name = ?, password_hash = ? WHERE id = ?")
                .bind(&name)
                .bind(&password_hash)
                .bind(&id)
                .execute(&state.db)
                .await?;
            id
        }
        None => {
            let user_id = new_id();
            let team_id = new_id();
            let mut tx = state.db.begin().await?;
            let inserted = sqlx::query(
                "INSERT INTO users (id, name, email, password_hash, email_verified, created_at) \
                 VALUES (?, ?, ?, ?, 0, ?)",
            )
            .bind(&user_id)
            .bind(&name)
            .bind(&email)
            .bind(&password_hash)
            .bind(now)
            .execute(&mut *tx)
            .await;
            if let Err(err) = inserted {
                return Err(if db::is_unique_violation(&err) {
                    email_taken()
                } else {
                    err.into()
                });
            }
            sqlx::query("INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
                .bind(&team_id)
                .bind(validate::default_team_name(&name))
                .bind(&user_id)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO memberships (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
            )
            .bind(&team_id)
            .bind(&user_id)
            .bind(Role::Admin.as_str())
            .bind(now)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            user_id
        }
    };

    issue_email_code(
        &state.db,
        state.mailer.as_ref(),
        &user_id,
        &email,
        &name,
        true,
    )
    .await?;
    Ok(Json(RegisterResponse {
        user_id,
        needs_verification: true,
    }))
}

fn email_taken() -> ApiError {
    ApiError::conflict(
        "email_taken",
        "An account with this email already exists. Sign in instead.",
    )
}

/// Create (or replace) the account's verification code and mail it. Without `force`, a code
/// younger than [`EMAIL_CODE_COOLDOWN`] is kept and nothing is sent.
async fn issue_email_code(
    db: &SqlitePool,
    mailer: &dyn Mailer,
    user_id: &str,
    email: &str,
    name: &str,
    force: bool,
) -> Result<bool, sqlx::Error> {
    let now = now_ms();
    if !force {
        let last: Option<i64> =
            sqlx::query_scalar("SELECT created_at FROM email_codes WHERE user_id = ?")
                .bind(user_id)
                .fetch_optional(db)
                .await?;
        if last.is_some_and(|at| now - at < ms(EMAIL_CODE_COOLDOWN)) {
            return Ok(false);
        }
    }
    let code = new_email_code();
    sqlx::query(
        "INSERT INTO email_codes (user_id, code_hash, attempts, created_at, expires_at) \
         VALUES (?, ?, 0, ?, ?) \
         ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, \
         created_at = excluded.created_at, expires_at = excluded.expires_at",
    )
    .bind(user_id)
    .bind(hash_secret(&format!("{user_id}:{code}")))
    .bind(now)
    .bind(now + ms(EMAIL_CODE_TTL))
    .execute(db)
    .await?;
    mailer.send(Email::VerificationCode {
        to: email.to_string(),
        name: name.to_string(),
        code,
    });
    Ok(true)
}

#[derive(sqlx::FromRow)]
struct VerifyRow {
    id: String,
    name: String,
    email: String,
    created_at: i64,
    email_verified: bool,
    code_hash: Option<Vec<u8>>,
    attempts: Option<i64>,
    expires_at: Option<i64>,
}

pub async fn verify(
    State(state): State<AppState>,
    JsonBody(req): JsonBody<VerifyRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let email = validate::email(&req.email)?;
    let invalid = || ApiError::bad_request("invalid_code", "That code is not right. Try again.");
    let code = validate::email_code(&req.code).ok_or_else(invalid)?;
    if !state.credential_limiter.check(&format!("verify:{email}")) {
        return Err(ApiError::too_many_requests());
    }
    let row = sqlx::query_as::<_, VerifyRow>(
        "SELECT u.id, u.name, u.email, u.created_at, u.email_verified, \
         c.code_hash, c.attempts, c.expires_at \
         FROM users u LEFT JOIN email_codes c ON c.user_id = u.id WHERE u.email = ?",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(invalid)?;
    if row.email_verified {
        return Err(ApiError::conflict(
            "already_verified",
            "This email is already verified. Sign in instead.",
        ));
    }
    let (Some(code_hash), Some(attempts), Some(expires_at)) =
        (row.code_hash, row.attempts, row.expires_at)
    else {
        return Err(invalid());
    };
    if expires_at <= now_ms() {
        return Err(ApiError::bad_request(
            "code_expired",
            "That code has expired. Send a new one.",
        ));
    }
    if attempts >= EMAIL_CODE_MAX_ATTEMPTS {
        return Err(ApiError::bad_request(
            "too_many_attempts",
            "Too many wrong codes. Send a new one.",
        ));
    }
    if hash_secret(&format!("{}:{code}", row.id)) != code_hash {
        sqlx::query("UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?")
            .bind(&row.id)
            .execute(&state.db)
            .await?;
        return Err(invalid());
    }

    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET email_verified = 1 WHERE id = ?")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM email_codes WHERE user_id = ?")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let token = create_session(&state.db, &row.id, state.config.session_ttl).await?;
    let user = UserRow {
        id: row.id,
        name: row.name,
        email: row.email,
        created_at: row.created_at,
    };
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

pub async fn resend(
    State(state): State<AppState>,
    JsonBody(req): JsonBody<ResendCodeRequest>,
) -> ApiResult<Json<OkResponse>> {
    let email = validate::email(&req.email)?;
    if !state.email_limiter.check(&format!("resend:{email}")) {
        return Err(ApiError::too_many_requests());
    }
    let row: Option<(String, String, bool)> =
        sqlx::query_as("SELECT id, name, email_verified FROM users WHERE email = ?")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    // Always answer `ok` so the endpoint does not reveal which emails have accounts.
    if let Some((id, name, false)) = row {
        issue_email_code(&state.db, state.mailer.as_ref(), &id, &email, &name, false).await?;
    }
    Ok(Json(OkResponse { ok: true }))
}

#[derive(sqlx::FromRow)]
struct LoginRow {
    id: String,
    name: String,
    email: String,
    created_at: i64,
    password_hash: String,
    email_verified: bool,
}

/// Check email + password for `POST /api/auth/login`. An unverified account gets a fresh
/// verification code and an `email_not_verified` error.
async fn check_credentials(state: &AppState, email: &str, password: &str) -> ApiResult<UserRow> {
    let email = validate::email(email)?;
    if !state.credential_limiter.check(&format!("login:{email}")) {
        return Err(ApiError::too_many_requests());
    }
    let row = sqlx::query_as::<_, LoginRow>(
        "SELECT id, name, email, created_at, password_hash, email_verified \
         FROM users WHERE email = ?",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;
    let ok = secrets::verify_password(
        password.to_string(),
        row.as_ref().map(|r| r.password_hash.clone()),
    )
    .await?;
    let Some(row) = row.filter(|_| ok) else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Email or password is incorrect.",
        ));
    };
    if !row.email_verified {
        issue_email_code(
            &state.db,
            state.mailer.as_ref(),
            &row.id,
            &row.email,
            &row.name,
            false,
        )
        .await?;
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "email_not_verified",
            "Verify your email first. We sent you a new code.",
        ));
    }
    Ok(UserRow {
        id: row.id,
        name: row.name,
        email: row.email,
        created_at: row.created_at,
    })
}

pub async fn login(
    State(state): State<AppState>,
    JsonBody(req): JsonBody<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let user = check_credentials(&state, &req.email, &req.password).await?;
    let token = create_session(&state.db, &user.id, state.config.session_ttl).await?;
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

pub async fn logout(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<OkResponse>> {
    delete_session(&state.db, &user.token_hash).await?;
    state.revoke_sessions(Revocation {
        user_id: user.id.clone(),
        keep: None,
        only: Some(user.token_hash.clone()),
    });
    Ok(Json(OkResponse { ok: true }))
}

/// `GET /api/auth/providers`: which sign-in helpers this server offers. Accounts are email +
/// password only; `email` says whether codes are really emailed (SMTP) or only logged.
pub async fn providers(State(state): State<AppState>) -> Json<ProvidersResponse> {
    Json(ProvidersResponse {
        email: state.mailer.delivers(),
    })
}

// ---------------------------------------------------------------------------------------------
// Password reset / change

/// `POST /api/auth/password/forgot {email}` → 204, whether or not the account exists. An
/// existing account (verified or not) gets a 6-digit code, at most one every
/// [`EMAIL_CODE_COOLDOWN`]; requests are rate-limited per address.
pub async fn forgot_password(
    State(state): State<AppState>,
    JsonBody(req): JsonBody<ForgotPasswordRequest>,
) -> ApiResult<StatusCode> {
    let email = validate::email(&req.email)?;
    if !state.email_limiter.check(&format!("forgot:{email}")) {
        return Err(ApiError::too_many_requests());
    }
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT id, name, email FROM users WHERE email = ?")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    if let Some((user_id, name, address)) = row {
        let now = now_ms();
        let last: Option<i64> =
            sqlx::query_scalar("SELECT created_at FROM password_resets WHERE user_id = ?")
                .bind(&user_id)
                .fetch_optional(&state.db)
                .await?;
        if last.is_none_or(|at| now - at >= ms(EMAIL_CODE_COOLDOWN)) {
            let code = new_email_code();
            sqlx::query(
                "INSERT INTO password_resets (user_id, code_hash, attempts, created_at, expires_at) \
                 VALUES (?, ?, 0, ?, ?) \
                 ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, \
                 created_at = excluded.created_at, expires_at = excluded.expires_at",
            )
            .bind(&user_id)
            .bind(reset_code_hash(&user_id, &code))
            .bind(now)
            .bind(now + ms(RESET_CODE_TTL))
            .execute(&state.db)
            .await?;
            state.mailer.send(Email::PasswordReset {
                to: address,
                name,
                code,
            });
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

fn reset_code_hash(user_id: &str, code: &str) -> Vec<u8> {
    hash_secret(&format!("reset:{user_id}:{code}"))
}

#[derive(sqlx::FromRow)]
struct ResetRow {
    id: String,
    name: String,
    email: String,
    created_at: i64,
    code_hash: Option<Vec<u8>>,
    attempts: Option<i64>,
    expires_at: Option<i64>,
}

/// `POST /api/auth/password/reset {email, code, password}` → `{ token, user }`. Sets the new
/// password, marks the email verified (the code proves the address), signs out every other
/// session (closing their live connections) and starts a new one.
pub async fn reset_password(
    State(state): State<AppState>,
    JsonBody(req): JsonBody<ResetPasswordRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let email = validate::email(&req.email)?;
    let invalid = || ApiError::bad_request("invalid_code", "That code is not right. Try again.");
    let code = validate::email_code(&req.code).ok_or_else(invalid)?;
    validate::password(&req.password)?;
    if !state.credential_limiter.check(&format!("reset:{email}")) {
        return Err(ApiError::too_many_requests());
    }
    let row = sqlx::query_as::<_, ResetRow>(
        "SELECT u.id, u.name, u.email, u.created_at, r.code_hash, r.attempts, r.expires_at \
         FROM users u LEFT JOIN password_resets r ON r.user_id = u.id WHERE u.email = ?",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(invalid)?;
    let (Some(code_hash), Some(attempts), Some(expires_at)) =
        (row.code_hash, row.attempts, row.expires_at)
    else {
        return Err(invalid());
    };
    if expires_at <= now_ms() {
        return Err(ApiError::bad_request(
            "code_expired",
            "That code has expired. Send a new one.",
        ));
    }
    if attempts >= RESET_CODE_MAX_ATTEMPTS {
        return Err(ApiError::bad_request(
            "too_many_attempts",
            "Too many wrong codes. Send a new one.",
        ));
    }
    if reset_code_hash(&row.id, &code) != code_hash {
        sqlx::query("UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?")
            .bind(&row.id)
            .execute(&state.db)
            .await?;
        return Err(invalid());
    }

    let password_hash = secrets::hash_password(req.password).await?;
    let mut tx = state.db.begin().await?;
    // Claim the code exactly once, even if two resets race.
    let claimed = sqlx::query("DELETE FROM password_resets WHERE user_id = ? AND code_hash = ?")
        .bind(&row.id)
        .bind(&code_hash)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if claimed != 1 {
        return Err(invalid());
    }
    sqlx::query("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?")
        .bind(&password_hash)
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM email_codes WHERE user_id = ?")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.revoke_sessions(Revocation {
        user_id: row.id.clone(),
        keep: None,
        only: None,
    });
    tracing::info!(user_id = %row.id, "password reset; all sessions revoked");

    let token = create_session(&state.db, &row.id, state.config.session_ttl).await?;
    let user = UserRow {
        id: row.id,
        name: row.name,
        email: row.email,
        created_at: row.created_at,
    };
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

/// `POST /api/auth/password/change {currentPassword?, newPassword}` → 204. Every account has a
/// password (email + password sign-in only), so `currentPassword` is required; it is optional
/// on the wire only so that accounts without a password could be supported later. Other
/// sessions are signed out; the calling one stays.
pub async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    JsonBody(req): JsonBody<ChangePasswordRequest>,
) -> ApiResult<StatusCode> {
    validate::password(&req.new_password)?;
    if !state
        .credential_limiter
        .check(&format!("change:{}", user.id))
    {
        return Err(ApiError::too_many_requests());
    }
    let current_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await?;
    let Some(current) = req.current_password.filter(|p| !p.is_empty()) else {
        return Err(ApiError::bad_request(
            "current_password_required",
            "Enter your current password.",
        ));
    };
    // Not 401: the session is fine, only the password is wrong.
    if !secrets::verify_password(current, Some(current_hash)).await? {
        return Err(ApiError::bad_request(
            "invalid_credentials",
            "Your current password is incorrect.",
        ));
    }
    let password_hash = secrets::hash_password(req.new_password).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(&password_hash)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
        .bind(&user.id)
        .bind(&user.token_hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM password_resets WHERE user_id = ?")
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.revoke_sessions(Revocation {
        user_id: user.id.clone(),
        keep: Some(user.token_hash.clone()),
        only: None,
    });
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<MeResponse>> {
    let teams = db::teams_for_user(&state.db, &user.id).await?;
    Ok(Json(MeResponse {
        user: user.dto(),
        teams,
    }))
}
