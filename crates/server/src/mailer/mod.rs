//! Outgoing email: verification codes, password-reset codes and team invites.
//!
//! Handlers call [`Mailer::send`], which never waits on the network. What happens next depends
//! on `MAIL_TRANSPORT` (see [`from_config`]):
//!
//! - `log` ([`LogMailer`], the default without `SMTP_URL`): the code or link is written to the
//!   server log. Nothing is sent. The sync-client e2e test relies on the line format
//!   `verification code for <email>: <code>`.
//! - `file:<dir>` and `smtp` ([`MailQueue`]): the message is queued, rendered from
//!   `crates/server/templates/` (HTML + plain text) and delivered by a background task, with
//!   retries and exponential backoff. Logs carry the kind, a masked recipient and the message
//!   id, never the code or the invite link.
//!
//! Tests use [`MemoryMailer`], which keeps every message in memory.

mod queue;
pub mod templates;

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use baren_proto::dto::Role;

use crate::config::{MailConfig, MailTransport};

pub use queue::{FileTransport, MailQueue, SmtpTransport};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One message to send. Rendering into a subject, plain text and HTML happens in
/// [`templates::render`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Email {
    /// The 6-digit code that verifies a new account's address.
    VerificationCode {
        to: String,
        name: String,
        code: String,
    },
    /// The 6-digit code for `POST /api/auth/password/reset`.
    PasswordReset {
        to: String,
        name: String,
        code: String,
    },
    /// An invite created with an `email` (or re-sent).
    TeamInvite {
        to: String,
        inviter_name: String,
        inviter_email: String,
        team_name: String,
        /// Members right now (shown as "Invited by … · 3 members").
        member_count: u32,
        role: Role,
        /// `<PUBLIC_URL>/i/<token>`.
        url: String,
        /// Unix ms; `None` = never.
        expires_at: Option<i64>,
    },
}

impl Email {
    /// Stable name used in logs and file names.
    pub fn kind(&self) -> &'static str {
        match self {
            Email::VerificationCode { .. } => "verification_code",
            Email::PasswordReset { .. } => "password_reset",
            Email::TeamInvite { .. } => "team_invite",
        }
    }

    pub fn to(&self) -> &str {
        match self {
            Email::VerificationCode { to, .. }
            | Email::PasswordReset { to, .. }
            | Email::TeamInvite { to, .. } => to,
        }
    }

    /// The recipient's display name, when we know it.
    pub fn recipient_name(&self) -> Option<&str> {
        match self {
            Email::VerificationCode { name, .. } | Email::PasswordReset { name, .. } => Some(name),
            Email::TeamInvite { .. } => None,
        }
    }

    /// The secret code of a code email.
    pub fn code(&self) -> Option<&str> {
        match self {
            Email::VerificationCode { code, .. } | Email::PasswordReset { code, .. } => Some(code),
            Email::TeamInvite { .. } => None,
        }
    }

    /// The invite link of an invite email.
    pub fn url(&self) -> Option<&str> {
        match self {
            Email::TeamInvite { url, .. } => Some(url),
            _ => None,
        }
    }
}

pub trait Mailer: Send + Sync + 'static {
    /// Queue `email` for delivery and return at once. Delivery, retries and error logging
    /// happen in the background; a request handler never waits on (or fails because of) mail.
    fn send(&self, email: Email);

    /// True when messages actually reach people (SMTP). Exposed as
    /// `GET /api/auth/providers` → `{ email }`.
    fn delivers(&self) -> bool {
        false
    }

    /// Wait until every queued message was delivered or given up, at most `timeout`.
    fn flush(&self, timeout: Duration) -> BoxFuture<'_, ()> {
        let _ = timeout;
        Box::pin(async {})
    }
}

/// Build the mailer for `MAIL_TRANSPORT`. Must run inside a Tokio runtime (the queue spawns
/// its worker).
pub fn from_config(config: &MailConfig) -> anyhow::Result<Arc<dyn Mailer>> {
    Ok(match &config.transport {
        MailTransport::Log => Arc::new(LogMailer),
        MailTransport::File(dir) => Arc::new(MailQueue::start(
            config,
            Arc::new(FileTransport::new(dir)?),
        )?),
        MailTransport::Smtp(url) => {
            let transport = Arc::new(SmtpTransport::new(url)?);
            // Check TLS, credentials and reachability once, without delaying startup.
            let check = Arc::clone(&transport);
            tokio::spawn(async move {
                match check.test_connection().await {
                    Ok(true) => {
                        tracing::info!(target: "baren_server::mailer", "SMTP connection check passed")
                    }
                    Ok(false) => {
                        tracing::warn!(target: "baren_server::mailer", "SMTP connection check failed: the server did not accept the connection")
                    }
                    Err(err) => {
                        tracing::warn!(target: "baren_server::mailer", error = %err, "SMTP connection check failed; emails will be retried but may not arrive")
                    }
                }
            });
            Arc::new(MailQueue::start(config, transport)?)
        }
    })
}

/// `ceyhun@example.com` → `c***@example.com`, for logs.
pub fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first: String = local.chars().take(1).collect();
            format!("{first}***@{domain}")
        }
        None => "***".into(),
    }
}

/// Writes codes and links to the log (development). Line formats:
///
/// - `verification code for <email>: <code> (to <name>; dev mailer, not sent)`
/// - `password reset code for <email>: <code> (to <name>; dev mailer, not sent)`
/// - `team invite for <email>: <url> (<team>, from <inviter>; dev mailer, not sent)`
#[derive(Debug, Default, Clone, Copy)]
pub struct LogMailer;

impl Mailer for LogMailer {
    fn send(&self, email: Email) {
        match &email {
            Email::VerificationCode { to, name, code } => tracing::info!(
                target: "baren_server::mailer",
                "verification code for {to}: {code} (to {name}; dev mailer, not sent)"
            ),
            Email::PasswordReset { to, name, code } => tracing::info!(
                target: "baren_server::mailer",
                "password reset code for {to}: {code} (to {name}; dev mailer, not sent)"
            ),
            Email::TeamInvite {
                to,
                inviter_name,
                team_name,
                url,
                ..
            } => tracing::info!(
                target: "baren_server::mailer",
                "team invite for {to}: {url} ({team_name}, from {inviter_name}; dev mailer, not sent)"
            ),
        }
    }
}

/// Keeps every message in memory so tests can read codes and links back.
#[derive(Debug, Default, Clone)]
pub struct MemoryMailer {
    sent: Arc<Mutex<Vec<Email>>>,
    delivers: bool,
}

impl MemoryMailer {
    pub fn new() -> Self {
        Self::default()
    }

    /// A memory mailer that claims real delivery (for `GET /api/auth/providers` tests).
    pub fn delivering() -> Self {
        Self {
            delivers: true,
            ..Self::default()
        }
    }

    /// Everything sent so far, oldest first.
    pub fn sent(&self) -> Vec<Email> {
        self.lock().clone()
    }

    /// The most recent verification code sent to `email` (case-insensitive).
    pub fn last_code_for(&self, email: &str) -> Option<String> {
        self.last(email, |e| matches!(e, Email::VerificationCode { .. }))
            .and_then(|e| e.code().map(str::to_string))
    }

    /// The most recent password-reset code sent to `email` (case-insensitive).
    pub fn last_reset_code_for(&self, email: &str) -> Option<String> {
        self.last(email, |e| matches!(e, Email::PasswordReset { .. }))
            .and_then(|e| e.code().map(str::to_string))
    }

    /// The most recent invite sent to `email` (case-insensitive).
    pub fn last_invite_for(&self, email: &str) -> Option<Email> {
        self.last(email, |e| matches!(e, Email::TeamInvite { .. }))
    }

    /// How many messages of `kind` (see [`Email::kind`]) went to `email`.
    pub fn count(&self, email: &str, kind: &str) -> usize {
        self.lock()
            .iter()
            .filter(|e| e.kind() == kind && e.to().eq_ignore_ascii_case(email))
            .count()
    }

    fn last(&self, email: &str, pick: impl Fn(&Email) -> bool) -> Option<Email> {
        self.lock()
            .iter()
            .rev()
            .find(|e| pick(e) && e.to().eq_ignore_ascii_case(email))
            .cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Email>> {
        self.sent.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Mailer for MemoryMailer {
    fn send(&self, email: Email) {
        self.lock().push(email);
    }

    fn delivers(&self) -> bool {
        self.delivers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_addresses() {
        assert_eq!(mask_email("ceyhun@example.com"), "c***@example.com");
        assert_eq!(mask_email("nope"), "***");
    }

    #[test]
    fn memory_mailer_finds_the_latest_message_per_kind() {
        let m = MemoryMailer::new();
        m.send(Email::VerificationCode {
            to: "A@x.io".into(),
            name: "A".into(),
            code: "111111".into(),
        });
        m.send(Email::PasswordReset {
            to: "a@x.io".into(),
            name: "A".into(),
            code: "222222".into(),
        });
        m.send(Email::VerificationCode {
            to: "a@x.io".into(),
            name: "A".into(),
            code: "333333".into(),
        });
        assert_eq!(m.last_code_for("a@X.io").as_deref(), Some("333333"));
        assert_eq!(m.last_reset_code_for("a@x.io").as_deref(), Some("222222"));
        assert_eq!(m.last_invite_for("a@x.io"), None);
        assert_eq!(m.count("a@x.io", "verification_code"), 2);
        assert!(!m.delivers() && MemoryMailer::delivering().delivers());
    }
}
