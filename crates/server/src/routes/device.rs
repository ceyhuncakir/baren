//! `GET/POST /device`: the browser half of "Continue in browser" (device-code flow).
//!
//! The app shows a user code and opens `/device?code=ABC-123`. Here a signed-in user (via the
//! page's own `baren_session` cookie, or by signing in with email + password) approves or
//! denies the request; the app's poll then receives a session token. Cookie-authenticated
//! posts are protected by `SameSite=Strict` plus a same-origin check on `Origin`.

use axum::extract::{Query, State};
use axum::http::header::{HOST, LOCATION, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Form;
use serde::Deserialize;

use crate::db::now_ms;
use crate::html::{self, escape, heading, icons};
use crate::routes::auth::check_credentials;
use crate::secrets::{format_user_code, normalize_user_code};
use crate::session::{
    authenticate, cookie_token, create_session, delete_session, AuthUser, SESSION_COOKIE,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct DeviceQuery {
    #[serde(default)]
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeviceForm {
    #[serde(default)]
    code: String,
    #[serde(default)]
    action: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

enum CodeState {
    Pending,
    Done,
    Invalid,
}

async fn code_state(state: &AppState, code: &str) -> Result<CodeState, sqlx::Error> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT status, expires_at FROM device_codes WHERE user_code = ?")
            .bind(code)
            .fetch_optional(&state.db)
            .await?;
    Ok(match row {
        Some((status, expires_at)) if status == "pending" && expires_at > now_ms() => {
            CodeState::Pending
        }
        Some((status, _)) if status == "approved" || status == "consumed" => CodeState::Done,
        _ => CodeState::Invalid,
    })
}

async fn browser_user(state: &AppState, headers: &HeaderMap) -> Option<AuthUser> {
    let token = cookie_token(headers)?;
    authenticate(&state.db, token, state.config.session_ttl)
        .await
        .ok()
        .flatten()
}

pub async fn page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DeviceQuery>,
) -> Response {
    let Some(code) = query.code.as_deref().and_then(normalize_user_code) else {
        let error = query
            .code
            .as_ref()
            .map(|_| "That code does not look right.");
        return enter_code_page(error);
    };
    match code_state(&state, &code).await {
        Err(err) => error_page(err),
        Ok(CodeState::Invalid) => enter_code_page(Some(
            "That code has expired or does not exist. Start again from the app.",
        )),
        Ok(CodeState::Done) => done_page(&code),
        Ok(CodeState::Pending) => {
            approve_page(&code, browser_user(&state, &headers).await.as_ref(), None)
        }
    }
}

pub async fn submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<DeviceForm>,
) -> Response {
    if !same_origin(&headers) {
        return html::page(
            StatusCode::FORBIDDEN,
            "Request blocked",
            icons::ALERT,
            &heading(
                "Request blocked",
                "This form must be submitted from this site.",
            ),
        );
    }
    let Some(code) = normalize_user_code(&form.code) else {
        return enter_code_page(Some("That code does not look right."));
    };

    if form.action == "signout" {
        if let Some(user) = browser_user(&state, &headers).await {
            let _ = delete_session(&state.db, &user.token_hash).await;
        }
        let mut response = StatusCode::SEE_OTHER.into_response();
        let location = format!("/device?code={}", format_user_code(&code));
        if let Ok(value) = HeaderValue::from_str(&location) {
            response.headers_mut().insert(LOCATION, value);
        }
        response.headers_mut().insert(SET_COOKIE, clear_cookie());
        return response;
    }

    match code_state(&state, &code).await {
        Err(err) => return error_page(err),
        Ok(CodeState::Invalid) => {
            return enter_code_page(Some(
                "That code has expired or does not exist. Start again from the app.",
            ))
        }
        Ok(CodeState::Done) => return done_page(&code),
        Ok(CodeState::Pending) => {}
    }

    // Who is approving: the cookie session, or fresh credentials from the form.
    let mut new_cookie = None;
    let user = match (form.email.as_deref(), form.password.as_deref()) {
        (Some(email), Some(password)) if !email.is_empty() => {
            match check_credentials(&state, email, password).await {
                Ok(user) => {
                    match create_session(&state.db, &user.id, state.config.session_ttl).await {
                        Ok(token) => new_cookie = Some(token),
                        Err(err) => return error_page(err),
                    }
                    (user.id, user.name)
                }
                Err(err) => return approve_page(&code, None, Some(&err.message)),
            }
        }
        _ => match browser_user(&state, &headers).await {
            Some(user) => (user.id, user.name),
            None => return approve_page(&code, None, Some("Sign in to continue.")),
        },
    };

    let (status_sql, approved) = match form.action.as_str() {
        "deny" => ("denied", false),
        _ => ("approved", true),
    };
    let updated = sqlx::query(
        "UPDATE device_codes SET status = ?, user_id = ? \
         WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
    )
    .bind(status_sql)
    .bind(&user.0)
    .bind(&code)
    .bind(now_ms())
    .execute(&state.db)
    .await;
    let mut response = match updated {
        Err(err) => error_page(err),
        Ok(r) if r.rows_affected() == 0 => enter_code_page(Some(
            "That code has expired or was already used. Start again from the app.",
        )),
        Ok(_) if approved => approved_page(&code, &user.1),
        Ok(_) => html::page(
            StatusCode::OK,
            "Request denied",
            icons::ALERT,
            &heading(
                "Request denied",
                "The app was not signed in. You can close this tab.",
            ),
        ),
    };
    if let Some(token) = new_cookie {
        if let Ok(value) = HeaderValue::from_str(&session_cookie(&state, &token)) {
            response.headers_mut().append(SET_COOKIE, value);
        }
    }
    response
}

fn session_cookie(state: &AppState, token: &str) -> String {
    let secure = if state.public_url.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{SESSION_COOKIE}={token}; Path=/device; HttpOnly; SameSite=Strict; Max-Age={}{secure}",
        state.config.session_ttl.as_secs()
    )
}

fn clear_cookie() -> HeaderValue {
    HeaderValue::from_static("baren_session=; Path=/device; HttpOnly; SameSite=Strict; Max-Age=0")
}

/// `Origin`, when present, must name the host this request was sent to.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(HOST))
        .and_then(|v| v.to_str().ok());
    let origin_host = origin.split_once("://").map(|(_, rest)| rest);
    matches!((origin_host, host), (Some(o), Some(h)) if o.eq_ignore_ascii_case(h))
}

fn code_card(code: &str) -> String {
    format!(
        r#"<div class="card"><div class="label">Make sure the app shows this code</div><div class="code">{}</div></div>"#,
        escape(&format_user_code(code))
    )
}

fn enter_code_page(error: Option<&str>) -> Response {
    let error_html = error
        .map(|e| format!(r#"<div class="error" role="alert">{}</div>"#, escape(e)))
        .unwrap_or_default();
    let body = format!(
        r#"{}
<form method="get" action="/device">
  <div class="field"><label for="code">Code</label>
  <input id="code" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" placeholder="ABC-123" required></div>
  {error_html}
  <button class="button" type="submit">Continue</button>
</form>"#,
        heading(
            "Sign in to Baren",
            "Enter the code shown in the app to finish signing in."
        ),
    );
    let status = if error.is_some() {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::OK
    };
    html::page(status, "Sign in", icons::EXTERNAL, &body)
}

fn approve_page(code: &str, user: Option<&AuthUser>, error: Option<&str>) -> Response {
    let shown = escape(&format_user_code(code));
    let error_html = error
        .map(|e| format!(r#"<div class="error" role="alert">{}</div>"#, escape(e)))
        .unwrap_or_default();
    let body = match user {
        Some(user) => format!(
            r#"{}
{}
<form method="post" action="/device">
  <input type="hidden" name="code" value="{shown}">
  {error_html}
  <div class="row">
    <button class="button secondary" type="submit" name="action" value="deny">Deny</button>
    <button class="button" type="submit" name="action" value="approve">Approve</button>
  </div>
</form>
<form method="post" action="/device"><input type="hidden" name="code" value="{shown}">
  <div class="row"><span></span><button class="link" type="submit" name="action" value="signout">Not you? Use another account</button></div>
</form>"#,
            heading(
                "Approve sign-in",
                &format!(
                    "Signed in as <strong>{}</strong> ({}). Only approve if this code matches the one in your Baren window.",
                    escape(&user.name),
                    escape(&user.email)
                )
            ),
            code_card(code),
        ),
        None => format!(
            r#"{}
{}
<form method="post" action="/device">
  <input type="hidden" name="code" value="{shown}">
  <input type="hidden" name="action" value="approve">
  <div class="field"><label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required></div>
  <div class="field"><label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required></div>
  {error_html}
  <button class="button" type="submit">Sign in and approve</button>
</form>"#,
            heading(
                "Continue to Baren",
                "Sign in to connect the app on your computer. No account yet? Create one in the app."
            ),
            code_card(code),
        ),
    };
    let status = if error.is_some() {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::OK
    };
    html::page(status, "Approve sign-in", icons::EXTERNAL, &body)
}

fn approved_page(code: &str, name: &str) -> Response {
    let body = format!(
        r#"{}
<a class="button" href="baren://auth/{}">Open Baren</a>"#,
        heading(
            "You're signed in",
            &format!(
                "Welcome back, <strong>{}</strong>. The app will update on its own; you can close this tab.",
                escape(name)
            )
        ),
        escape(&format_user_code(code)),
    );
    html::page(StatusCode::OK, "Signed in", icons::CHECK, &body)
}

fn done_page(code: &str) -> Response {
    let body = format!(
        r#"{}
<a class="button secondary" href="baren://auth/{}">Open Baren</a>"#,
        heading(
            "Already approved",
            "This sign-in request is complete. You can close this tab."
        ),
        escape(&format_user_code(code)),
    );
    html::page(StatusCode::OK, "Signed in", icons::CHECK, &body)
}

fn error_page(err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "device page error");
    html::page(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Something went wrong",
        icons::ALERT,
        &heading("Something went wrong", "Please try again in a moment."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_origin_check() {
        let mut h = HeaderMap::new();
        assert!(same_origin(&h), "no Origin header (non-browser client)");
        h.insert(HOST, HeaderValue::from_static("sync.example.com"));
        h.insert(ORIGIN, HeaderValue::from_static("https://sync.example.com"));
        assert!(same_origin(&h));
        h.insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        assert!(!same_origin(&h));
        h.insert(ORIGIN, HeaderValue::from_static("null"));
        assert!(!same_origin(&h));
    }
}
