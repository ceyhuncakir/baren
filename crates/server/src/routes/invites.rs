//! Invite links: `/api/teams/:id/invites`, `/api/invites/:token[/accept]`, `DELETE
//! /api/invites/:id`, `POST /api/invites/:id/resend`, and the `/i/:token` landing page.
//!
//! Tokens are 32 random bytes; only their SHA-256 is stored, so a link can be shown exactly
//! once (in the create response). An invite with an `email` is also mailed to that address.
//! Re-sending mails a fresh link: the token is rotated, so the previous link stops working.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use baren_proto::dto::{
    AcceptInviteResponse, CreateInviteRequest, CreateInviteResponse, Invite, InvitePreview,
    OkResponse, Role,
};

use crate::db::{self, ms, new_id, now_ms, parse_role, require_team_role};
use crate::error::{ApiError, ApiResult, JsonBody};
use crate::html::{self, escape, heading, icons};
use crate::mailer::Email;
use crate::routes::teams::team_view;
use crate::secrets::{hash_secret, new_token};
use crate::session::AuthUser;
use crate::state::AppState;
use crate::validate;

pub const DEFAULT_EXPIRY_DAYS: u32 = 14;
pub const MAX_EXPIRY_DAYS: u32 = 365;
pub const MAX_USES: u32 = 10_000;

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<String>,
    JsonBody(req): JsonBody<CreateInviteRequest>,
) -> ApiResult<Json<CreateInviteResponse>> {
    let my_role = require_team_role(&state.db, &team_id, &user.id, Role::Editor).await?;
    if req.role.rank() > my_role.rank() {
        return Err(ApiError::forbidden(
            "You can only invite people with a role up to your own.",
        ));
    }
    if req.max_uses.is_some_and(|n| n == 0 || n > MAX_USES) {
        return Err(ApiError::bad_request(
            "invalid_max_uses",
            format!("maxUses must be between 1 and {MAX_USES}."),
        ));
    }
    let days = req.expires_in_days.unwrap_or(DEFAULT_EXPIRY_DAYS);
    if days == 0 || days > MAX_EXPIRY_DAYS {
        return Err(ApiError::bad_request(
            "invalid_expiry",
            format!("expiresInDays must be between 1 and {MAX_EXPIRY_DAYS}."),
        ));
    }
    let email = req.email.as_deref().map(validate::email).transpose()?;
    if email.is_some() && !state.invite_email_limiter.check(&user.id) {
        return Err(ApiError::too_many_requests());
    }
    let id = new_id();
    let token = new_token();
    let now = now_ms();
    let expires_at = now + ms(Duration::from_secs(u64::from(days) * 86_400));
    sqlx::query(
        "INSERT INTO invites (id, team_id, token_hash, role, email, max_uses, uses, expires_at, \
         created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&team_id)
    .bind(hash_secret(&token))
    .bind(req.role.as_str())
    .bind(&email)
    .bind(req.max_uses.map(i64::from))
    .bind(expires_at)
    .bind(&user.id)
    .bind(now)
    .execute(&state.db)
    .await?;
    let url = invite_url(&state, &token);
    if let Some(to) = &email {
        let mail = invite_email(
            &state,
            &team_id,
            &user,
            to,
            req.role,
            &url,
            Some(expires_at),
        )
        .await?;
        state.mailer.send(mail);
    }
    Ok(Json(CreateInviteResponse {
        url,
        id,
        token,
        role: req.role,
        max_uses: req.max_uses,
        expires_at: Some(expires_at),
        email,
    }))
}

fn invite_url(state: &AppState, token: &str) -> String {
    format!("{}/i/{token}", state.public_url)
}

/// The invite email for `to`, sent by `inviter`.
async fn invite_email(
    state: &AppState,
    team_id: &str,
    inviter: &AuthUser,
    to: &str,
    role: Role,
    url: &str,
    expires_at: Option<i64>,
) -> ApiResult<Email> {
    let (team_name, member_count): (String, i64) = sqlx::query_as(
        "SELECT t.name, (SELECT COUNT(*) FROM memberships m WHERE m.team_id = t.id) \
         FROM teams t WHERE t.id = ?",
    )
    .bind(team_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Email::TeamInvite {
        to: to.to_string(),
        inviter_name: inviter.name.clone(),
        inviter_email: inviter.email.clone(),
        team_name,
        member_count: member_count.clamp(0, i64::from(u32::MAX)) as u32,
        role,
        url: url.to_string(),
        expires_at,
    })
}

#[derive(sqlx::FromRow)]
struct ResendRow {
    team_id: String,
    created_by: Option<String>,
    email: Option<String>,
    role: String,
    max_uses: Option<i64>,
    uses: i64,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
}

/// `POST /api/invites/:id/resend`: mail an email invite again (team admins, or the editor who
/// created it). The token is rotated, so the response carries the new link and the previous
/// one stops working. One re-send per invite per minute.
pub async fn resend(
    State(state): State<AppState>,
    user: AuthUser,
    Path(invite_id): Path<String>,
) -> ApiResult<Json<CreateInviteResponse>> {
    let row = sqlx::query_as::<_, ResendRow>(
        "SELECT team_id, created_by, email, role, max_uses, uses, expires_at, revoked_at \
         FROM invites WHERE id = ?",
    )
    .bind(&invite_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("Invite"))?;
    let my_role = db::team_role(&state.db, &row.team_id, &user.id)
        .await?
        .ok_or_else(|| ApiError::not_found("Invite"))?;
    let is_creator = row.created_by.as_deref() == Some(user.id.as_str());
    if !(my_role.is_admin() || (my_role.can_edit() && is_creator)) {
        return Err(ApiError::forbidden(
            "Only admins or the person who created an invite can resend it.",
        ));
    }
    let Some(to) = row.email else {
        return Err(ApiError::bad_request(
            "invite_has_no_email",
            "This invite has no email address to send to.",
        ));
    };
    let now = now_ms();
    if row.revoked_at.is_some() {
        return Err(ApiError::gone(
            "invite_revoked",
            "This invite link was revoked.",
        ));
    }
    if row.expires_at.is_some_and(|at| at <= now) {
        return Err(ApiError::gone(
            "invite_expired",
            "This invite link has expired.",
        ));
    }
    if row.max_uses.is_some_and(|max| row.uses >= max) {
        return Err(ApiError::gone(
            "invite_used_up",
            "This invite link has already been used.",
        ));
    }
    if !state.invite_resend_limiter.check(&invite_id) || !state.invite_email_limiter.check(&user.id)
    {
        return Err(ApiError::too_many_requests());
    }
    let role = parse_role(&row.role)?;
    let token = new_token();
    sqlx::query("UPDATE invites SET token_hash = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(hash_secret(&token))
        .bind(&invite_id)
        .execute(&state.db)
        .await?;
    let url = invite_url(&state, &token);
    let mail = invite_email(&state, &row.team_id, &user, &to, role, &url, row.expires_at).await?;
    state.mailer.send(mail);
    Ok(Json(CreateInviteResponse {
        id: invite_id,
        token,
        url,
        role,
        max_uses: row.max_uses.map(|n| n.clamp(0, i64::from(u32::MAX)) as u32),
        expires_at: row.expires_at,
        email: Some(to),
    }))
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    id: String,
    role: String,
    email: Option<String>,
    max_uses: Option<i64>,
    uses: i64,
    expires_at: Option<i64>,
    created_at: i64,
    invited_by: Option<String>,
}

/// Active invites (not revoked, expired or used up), newest first.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(team_id): Path<String>,
) -> ApiResult<Json<Vec<Invite>>> {
    require_team_role(&state.db, &team_id, &user.id, Role::Editor).await?;
    let rows = sqlx::query_as::<_, InviteRow>(
        "SELECT i.id, i.role, i.email, i.max_uses, i.uses, i.expires_at, i.created_at, \
         u.name AS invited_by FROM invites i LEFT JOIN users u ON u.id = i.created_by \
         WHERE i.team_id = ? AND i.revoked_at IS NULL \
         AND (i.expires_at IS NULL OR i.expires_at > ?) \
         AND (i.max_uses IS NULL OR i.uses < i.max_uses) \
         ORDER BY i.created_at DESC",
    )
    .bind(&team_id)
    .bind(now_ms())
    .fetch_all(&state.db)
    .await?;
    let invites = rows
        .into_iter()
        .map(|r| {
            Ok(Invite {
                id: r.id,
                role: parse_role(&r.role)?,
                email: r.email,
                max_uses: r.max_uses.map(|n| n.clamp(0, i64::from(u32::MAX)) as u32),
                uses: r.uses.clamp(0, i64::from(u32::MAX)) as u32,
                expires_at: r.expires_at,
                created_at: r.created_at,
                invited_by: r.invited_by,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(invites))
}

#[derive(sqlx::FromRow)]
struct ValidInvite {
    id: String,
    team_id: String,
    team_name: String,
    inviter_name: Option<String>,
    role: String,
    expires_at: Option<i64>,
    member_count: i64,
}

#[derive(sqlx::FromRow)]
struct FoundInvite {
    #[sqlx(flatten)]
    invite: ValidInvite,
    revoked_at: Option<i64>,
    max_uses: Option<i64>,
    uses: i64,
}

impl FoundInvite {
    /// Whether the invite can still be used to join.
    fn check(self) -> ApiResult<ValidInvite> {
        if self.revoked_at.is_some() {
            return Err(ApiError::gone(
                "invite_revoked",
                "This invite link was revoked.",
            ));
        }
        if self.invite.expires_at.is_some_and(|at| at <= now_ms()) {
            return Err(ApiError::gone(
                "invite_expired",
                "This invite link has expired.",
            ));
        }
        if self.max_uses.is_some_and(|max| self.uses >= max) {
            return Err(ApiError::gone(
                "invite_used_up",
                "This invite link has already been used.",
            ));
        }
        Ok(self.invite)
    }
}

/// Look up an invite by token, whatever its state (404 if unknown).
async fn find(state: &AppState, token: &str) -> ApiResult<FoundInvite> {
    sqlx::query_as::<_, FoundInvite>(
        "SELECT i.id, i.team_id, t.name AS team_name, u.name AS inviter_name, i.role, \
         i.expires_at, i.revoked_at, i.max_uses, i.uses, \
         (SELECT COUNT(*) FROM memberships m WHERE m.team_id = i.team_id) AS member_count \
         FROM invites i JOIN teams t ON t.id = i.team_id \
         LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?",
    )
    .bind(hash_secret(token))
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "invite_not_found",
            "This invite link is not valid.",
        )
    })
}

/// Look up a token and check that the invite can still be used.
async fn find_valid(state: &AppState, token: &str) -> ApiResult<ValidInvite> {
    find(state, token).await?.check()
}

pub async fn preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Json<InvitePreview>> {
    let invite = find_valid(&state, &token).await?;
    Ok(Json(InvitePreview {
        role: parse_role(&invite.role)?,
        team_id: invite.team_id,
        team_name: invite.team_name,
        inviter_name: invite.inviter_name,
        member_count: invite.member_count.max(0) as u32,
        expires_at: invite.expires_at,
    }))
}

/// Join the team. Idempotent: an existing member keeps their role and no use is consumed.
pub async fn accept(
    State(state): State<AppState>,
    user: AuthUser,
    Path(token): Path<String>,
) -> ApiResult<Json<AcceptInviteResponse>> {
    let found = find(&state, &token).await?;
    // Members can always "accept" again (even once the link is used up or revoked).
    let team_id = found.invite.team_id.clone();
    if db::team_role(&state.db, &team_id, &user.id)
        .await?
        .is_some()
    {
        return Ok(Json(AcceptInviteResponse {
            team: team_view(&state, &team_id, &user.id).await?,
            already_member: true,
        }));
    }
    let invite = found.check()?;
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    // Re-check limits atomically so concurrent accepts cannot exceed maxUses.
    let claimed = sqlx::query(
        "UPDATE invites SET uses = uses + 1 WHERE id = ? AND revoked_at IS NULL \
         AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(&invite.id)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if claimed != 1 {
        return Err(ApiError::gone(
            "invite_used_up",
            "This invite link has already been used.",
        ));
    }
    let inserted = sqlx::query(
        "INSERT INTO memberships (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (team_id, user_id) DO NOTHING",
    )
    .bind(&invite.team_id)
    .bind(&user.id)
    .bind(&invite.role)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        // A concurrent accept by the same user won; do not consume a use for this one.
        tx.rollback().await?;
    } else {
        tx.commit().await?;
    }
    Ok(Json(AcceptInviteResponse {
        team: team_view(&state, &invite.team_id, &user.id).await?,
        already_member: inserted == 0,
    }))
}

/// Revoke an invite (team admins, or the editor who created it).
pub async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(invite_id): Path<String>,
) -> ApiResult<Json<OkResponse>> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT team_id, created_by FROM invites WHERE id = ?")
            .bind(&invite_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((team_id, created_by)) = row else {
        return Err(ApiError::not_found("Invite"));
    };
    let role = db::team_role(&state.db, &team_id, &user.id)
        .await?
        .ok_or_else(|| ApiError::not_found("Invite"))?;
    let is_creator = created_by.as_deref() == Some(user.id.as_str());
    if !(role.is_admin() || (role.can_edit() && is_creator)) {
        return Err(ApiError::forbidden(
            "Only admins or the person who created an invite can revoke it.",
        ));
    }
    sqlx::query("UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
        .bind(now_ms())
        .bind(&invite_id)
        .execute(&state.db)
        .await?;
    Ok(Json(OkResponse { ok: true }))
}

/// `GET /i/:token`: a small page that hands the invite to the desktop app.
pub async fn landing(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    match find_valid(&state, &token).await {
        Ok(invite) => {
            let inviter = invite
                .inviter_name
                .as_deref()
                .map(|n| format!("<strong>{}</strong> invited you", escape(n)))
                .unwrap_or_else(|| "You've been invited".to_string());
            let role = Role::parse(&invite.role).map_or("member", |r| r.as_str());
            let body = format!(
                r#"{}
<a class="button" href="baren://invite/{}">Open in Baren</a>
<p>Don't have the app yet? Install Baren, then open this link again.</p>"#,
                heading(
                    &format!("Join {}", invite.team_name),
                    &format!(
                        "{inviter} to join <strong>{}</strong> on Baren as {} ({} member{}).",
                        escape(&invite.team_name),
                        if role == "admin" {
                            "an admin"
                        } else if role == "editor" {
                            "an editor"
                        } else {
                            "a viewer"
                        },
                        invite.member_count,
                        if invite.member_count == 1 { "" } else { "s" },
                    )
                ),
                escape(&token),
            );
            html::page(StatusCode::OK, "Join team", icons::USERS, &body)
        }
        Err(err) if err.status.is_server_error() => html::page(
            err.status,
            "Something went wrong",
            icons::ALERT,
            &heading("Something went wrong", "Please try again in a moment."),
        ),
        Err(err) => html::page(
            err.status,
            "Invite unavailable",
            icons::ALERT,
            &heading(
                "This invite can't be used",
                &format!("{} Ask a team admin for a new link.", escape(&err.message)),
            ),
        ),
    }
}
