//! HTTP routing.

pub mod assets;
pub mod auth;
pub mod files;
pub mod invites;
pub mod teams;
pub mod updates;

use std::borrow::Cow;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderValue, Method, Request};
use axum::routing::{get, patch, post, put};
use axum::Router;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::CorsOrigins;
use crate::error::ApiError;
use crate::rooms::ws;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    // Base64 inflates snapshot uploads by 4/3; leave room for the JSON around them.
    let body_limit = state.config.max_message_bytes / 3 * 4 + 64 * 1024;
    let cors = cors_layer(&state.config.cors_origins);

    let api = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/verify", post(auth::verify))
        .route("/auth/resend", post(auth::resend))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/providers", get(auth::providers))
        .route("/auth/password/forgot", post(auth::forgot_password))
        .route("/auth/password/reset", post(auth::reset_password))
        .route("/auth/password/change", post(auth::change_password))
        .route("/me", get(auth::me))
        .route("/teams", get(teams::list).post(teams::create))
        .route("/teams/{id}", patch(teams::update).delete(teams::delete))
        .route("/teams/{id}/members", get(teams::members))
        .route(
            "/teams/{id}/members/{user_id}",
            patch(teams::update_member).delete(teams::remove_member),
        )
        .route(
            "/teams/{id}/invites",
            get(invites::list).post(invites::create),
        )
        .route("/teams/{id}/files", get(files::list).post(files::create))
        // `GET` takes an invite token (preview); `DELETE` takes an invite id (revoke). The
        // segment shares one parameter name because the router requires it.
        .route(
            "/invites/{token}",
            get(invites::preview).delete(invites::revoke),
        )
        .route("/invites/{token}/accept", post(invites::accept))
        // Takes an invite id, like `DELETE`.
        .route("/invites/{token}/resend", post(invites::resend))
        .route("/files/{id}", patch(files::update).delete(files::delete))
        .route("/files/{id}/snapshot", get(files::snapshot))
        // Uploads stream their body and enforce their own 20 MB limit.
        .route(
            "/files/{id}/assets/{hash}",
            put(assets::put).get(assets::get).head(assets::head),
        )
        .fallback(|| async { ApiError::not_found("Endpoint") });

    Router::new()
        .nest("/api", api)
        .route("/health", get(|| async { "ok" }))
        .route("/i/{token}", get(invites::landing))
        .route("/ws/files/{id}", get(ws::handler))
        .route("/updates/{*path}", get(updates::serve))
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(cors)
        .layer(
            TraceLayer::new_for_http().make_span_with(|req: &Request<_>| {
                tracing::info_span!(
                    "http",
                    method = %req.method(),
                    path = %redact_path(req.uri().path()),
                )
            }),
        )
        .with_state(state)
}

fn cors_layer(origins: &CorsOrigins) -> CorsLayer {
    let allow_origin = match origins {
        CorsOrigins::Any => AllowOrigin::any(),
        CorsOrigins::List(list) => AllowOrigin::list(
            list.iter()
                .filter_map(|o| HeaderValue::from_str(o).ok())
                .collect::<Vec<_>>(),
        ),
    };
    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .max_age(Duration::from_secs(3600))
}

/// Keep invite tokens out of request logs (query strings, which carry WebSocket tokens, are
/// never logged at all).
fn redact_path(path: &str) -> Cow<'_, str> {
    for prefix in ["/i/", "/api/invites/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            let suffix = rest.find('/').map_or("", |i| &rest[i..]);
            return Cow::Owned(format!("{prefix}…{suffix}"));
        }
    }
    Cow::Borrowed(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_invite_tokens() {
        assert_eq!(redact_path("/i/secret"), "/i/…");
        assert_eq!(
            redact_path("/api/invites/secret/accept"),
            "/api/invites/…/accept"
        );
        assert_eq!(redact_path("/api/me"), "/api/me");
    }
}
