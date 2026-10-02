//! Shared application state.

use std::ops::Deref;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::sync::{broadcast, RwLock};

use crate::config::Config;
use crate::mailer::Mailer;
use crate::ratelimit::RateLimiter;
use crate::rooms::Rooms;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub db: SqlitePool,
    pub config: Config,
    /// Base URL used in links we hand out (no trailing slash).
    pub public_url: String,
    pub mailer: Arc<dyn Mailer>,
    pub rooms: Rooms,
    /// Login / verify / approve attempts per email.
    pub credential_limiter: RateLimiter,
    /// Registrations, code re-sends and password-reset requests per email.
    pub email_limiter: RateLimiter,
    /// Invite emails per sender (creating email invites and re-sending them).
    pub invite_email_limiter: RateLimiter,
    /// Re-sends per invite (one a minute).
    pub invite_resend_limiter: RateLimiter,
    /// Content-addressed asset files (see `routes::assets`).
    pub assets_dir: PathBuf,
    /// Uploads finalise under the read lock; the orphan sweep takes the write lock, so a file
    /// is never deleted while an upload is linking it.
    pub assets_lock: RwLock<()>,
    /// Sessions revoked by a password reset/change or a sign-out; open WebSockets listen and
    /// close with 4401.
    pub revocations: broadcast::Sender<Revocation>,
}

/// "These sessions of `user_id` are gone": every session except `keep` (`None` = all of them).
#[derive(Debug, Clone)]
pub struct Revocation {
    pub user_id: String,
    pub keep: Option<Vec<u8>>,
    /// Only this session (a sign-out); `keep` is ignored.
    pub only: Option<Vec<u8>>,
}

impl Revocation {
    /// Whether a connection authenticated with `token_hash` must close.
    pub fn applies_to(&self, user_id: &str, token_hash: &[u8]) -> bool {
        if self.user_id != user_id {
            return false;
        }
        if let Some(only) = &self.only {
            return only.as_slice() == token_hash;
        }
        self.keep.as_deref() != Some(token_hash)
    }
}

impl AppState {
    pub fn new(
        db: SqlitePool,
        config: Config,
        public_url: String,
        mailer: Arc<dyn Mailer>,
        rooms: Rooms,
    ) -> Self {
        Self(Arc::new(Inner {
            credential_limiter: RateLimiter::new(10, Duration::from_secs(10 * 60)),
            email_limiter: RateLimiter::new(5, Duration::from_secs(10 * 60)),
            invite_email_limiter: RateLimiter::new(30, Duration::from_secs(60 * 60)),
            invite_resend_limiter: RateLimiter::new(1, Duration::from_secs(60)),
            assets_dir: config.resolved_assets_dir(),
            assets_lock: RwLock::new(()),
            revocations: broadcast::channel(64).0,
            db,
            config,
            public_url,
            mailer,
            rooms,
        }))
    }

    /// Tell open WebSockets that sessions were revoked.
    pub fn revoke_sessions(&self, revocation: Revocation) {
        // No receivers simply means no open sockets.
        let _ = self.revocations.send(revocation);
    }
}

impl Deref for AppState {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}
