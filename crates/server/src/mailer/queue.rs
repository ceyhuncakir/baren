//! The delivering mailer: a bounded queue drained by a background task, which renders each
//! message and hands it to a [`Transport`] (file or SMTP) with retries and exponential backoff.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::PoolConfig;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use rand::RngExt;
use serde_json::json;
use tokio::sync::{mpsc, Notify, Semaphore};

use super::templates::{self, Rendered};
use super::{mask_email, BoxFuture, Email, Mailer};
use crate::config::{redact_url, MailConfig};
use crate::db::now_ms;

/// Messages waiting for a worker. A full queue drops new messages (with an error log) rather
/// than slowing requests down.
const QUEUE_CAPACITY: usize = 1024;
/// Messages being delivered at once.
const CONCURRENCY: usize = 4;
/// Upper bound for one backoff delay.
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// One SMTP conversation may take this long before it counts as a (transient) failure.
const SMTP_TIMEOUT: Duration = Duration::from_secs(30);

/// A rendered message ready for a transport.
pub struct Outgoing {
    pub email: Email,
    pub rendered: Rendered,
    pub message: Message,
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryError {
    /// Retrying cannot help (e.g. SMTP 5xx: unknown mailbox, sender not allowed).
    pub permanent: bool,
    pub message: String,
}

impl DeliveryError {
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            permanent: false,
            message: message.into(),
        }
    }

    pub fn permanent(message: impl Into<String>) -> Self {
        Self {
            permanent: true,
            message: message.into(),
        }
    }
}

/// Where rendered messages go.
pub trait Transport: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    /// Whether messages reach people.
    fn delivers(&self) -> bool;
    /// Deliver one message. `Ok` carries a short detail for the log (a file path or the SMTP
    /// reply code), never message content.
    fn deliver<'a>(&'a self, message: &'a Outgoing)
        -> BoxFuture<'a, Result<String, DeliveryError>>;
}

// ---------------------------------------------------------------------------------------------
// Queue

struct Settings {
    from: Mailbox,
    /// Domain part of `MAIL_FROM`, used for `Message-ID`s.
    domain: String,
    max_attempts: u32,
    retry_base: Duration,
}

#[derive(Default)]
struct Pending {
    count: AtomicUsize,
    idle: Notify,
}

impl Pending {
    fn add(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }

    fn done(&self) {
        if self.count.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.idle.notify_waiters();
        }
    }
}

/// The background mailer used for `MAIL_TRANSPORT=file:<dir>` and `smtp`.
pub struct MailQueue {
    tx: mpsc::Sender<Email>,
    delivers: bool,
    pending: Arc<Pending>,
}

impl MailQueue {
    /// Spawn the delivery worker. Must run inside a Tokio runtime.
    pub fn start(config: &MailConfig, transport: Arc<dyn Transport>) -> anyhow::Result<Self> {
        let from: Mailbox = config
            .from
            .parse()
            .with_context(|| format!("MAIL_FROM is not a valid mailbox: {:?}", config.from))?;
        let settings = Arc::new(Settings {
            domain: from.email.domain().to_string(),
            from,
            max_attempts: config.max_attempts.max(1),
            retry_base: config.retry_base,
        });
        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        let pending = Arc::new(Pending::default());
        let delivers = transport.delivers();
        tokio::spawn(run(rx, transport, settings, Arc::clone(&pending)));
        Ok(Self {
            tx,
            delivers,
            pending,
        })
    }
}

impl Mailer for MailQueue {
    fn send(&self, email: Email) {
        self.pending.add();
        if let Err(err) = self.tx.try_send(email) {
            self.pending.done();
            let email = match err {
                mpsc::error::TrySendError::Full(e) | mpsc::error::TrySendError::Closed(e) => e,
            };
            tracing::error!(
                target: "baren_server::mailer",
                kind = email.kind(),
                to = %mask_email(email.to()),
                "mail queue is full or stopped; dropping message"
            );
        }
    }

    fn delivers(&self) -> bool {
        self.delivers
    }

    fn flush(&self, timeout: Duration) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let wait = async {
                loop {
                    let idle = self.pending.idle.notified();
                    if self.pending.count.load(Ordering::SeqCst) == 0 {
                        return;
                    }
                    idle.await;
                }
            };
            let _ = tokio::time::timeout(timeout, wait).await;
        })
    }
}

async fn run(
    mut rx: mpsc::Receiver<Email>,
    transport: Arc<dyn Transport>,
    settings: Arc<Settings>,
    pending: Arc<Pending>,
) {
    let slots = Arc::new(Semaphore::new(CONCURRENCY));
    while let Some(email) = rx.recv().await {
        let Ok(slot) = Arc::clone(&slots).acquire_owned().await else {
            break;
        };
        let transport = Arc::clone(&transport);
        let settings = Arc::clone(&settings);
        let pending = Arc::clone(&pending);
        tokio::spawn(async move {
            deliver_with_retries(transport.as_ref(), &settings, email).await;
            drop(slot);
            pending.done();
        });
    }
}

async fn deliver_with_retries(transport: &dyn Transport, settings: &Settings, email: Email) {
    let kind = email.kind();
    let to = mask_email(email.to());
    let outgoing = match build(settings, email) {
        Ok(outgoing) => outgoing,
        Err(err) => {
            tracing::error!(
                target: "baren_server::mailer",
                kind, to = %to, error = %err,
                "could not build email; not sent"
            );
            return;
        }
    };
    for attempt in 1..=settings.max_attempts {
        match transport.deliver(&outgoing).await {
            Ok(detail) => {
                tracing::info!(
                    target: "baren_server::mailer",
                    kind, to = %to, message_id = %outgoing.message_id, attempt,
                    transport = transport.name(), detail = %detail,
                    "email delivered"
                );
                return;
            }
            Err(err) if err.permanent || attempt == settings.max_attempts => {
                tracing::error!(
                    target: "baren_server::mailer",
                    kind, to = %to, message_id = %outgoing.message_id, attempt,
                    transport = transport.name(), permanent = err.permanent, error = %err.message,
                    "email delivery failed; giving up"
                );
                return;
            }
            Err(err) => {
                let delay = backoff(settings.retry_base, attempt);
                tracing::warn!(
                    target: "baren_server::mailer",
                    kind, to = %to, message_id = %outgoing.message_id, attempt,
                    transport = transport.name(), error = %err.message,
                    retry_in_ms = delay.as_millis() as u64,
                    "email delivery failed; retrying"
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
}

/// `base · 2^(attempt-1)`, ±20 % jitter, capped at [`MAX_BACKOFF`].
fn backoff(base: Duration, attempt: u32) -> Duration {
    let exp = base.saturating_mul(1u32 << attempt.saturating_sub(1).min(16));
    let capped = exp.min(MAX_BACKOFF);
    let jitter = rand::rng().random_range(0.8..1.2);
    capped.mul_f64(jitter).min(MAX_BACKOFF)
}

/// Content-ID of the seal image that `templates/layout.html` shows in the brand row.
const MARK_CID: &str = "baren-mark";

fn build(settings: &Settings, email: Email) -> anyhow::Result<Outgoing> {
    let rendered = templates::render(&email);
    let address: Address = email
        .to()
        .parse()
        .with_context(|| format!("invalid recipient address {}", mask_email(email.to())))?;
    let to = Mailbox::new(
        email
            .recipient_name()
            .filter(|n| !n.trim().is_empty())
            .map(str::to_string),
        address,
    );
    let message_id = format!("<{}@{}>", uuid::Uuid::new_v4().simple(), settings.domain);
    let message = Message::builder()
        .message_id(Some(message_id.clone()))
        .from(settings.from.clone())
        .to(to)
        .subject(rendered.subject.clone())
        .multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(rendered.text.clone()))
                .multipart(
                    // The HTML plus the brand-row seal it references as `cid:baren-mark`.
                    MultiPart::related()
                        .singlepart(SinglePart::html(rendered.html.clone()))
                        .singlepart(Attachment::new_inline(MARK_CID.to_string()).body(
                            crate::html::MARK_PNG.to_vec(),
                            ContentType::parse("image/png").expect("valid content type"),
                        )),
                ),
        )
        .context("building the MIME message")?;
    Ok(Outgoing {
        email,
        rendered,
        message,
        message_id,
    })
}

// ---------------------------------------------------------------------------------------------
// File transport

/// `MAIL_TRANSPORT=file:<dir>`: every message becomes `<dir>/<ms>-<seq>-<kind>.eml` (the full
/// MIME message, openable in any mail client) plus a `.json` sidecar with the kind, recipient,
/// subject, text, HTML and the code or link, for tests and template previews. The `.json` is
/// written last (atomically), so a poller that sees it can read both files.
pub struct FileTransport {
    dir: PathBuf,
    seq: AtomicU64,
}

impl FileTransport {
    pub fn new(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating the mail directory {}", dir.display()))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            seq: AtomicU64::new(0),
        })
    }
}

impl Transport for FileTransport {
    fn name(&self) -> &'static str {
        "file"
    }

    fn delivers(&self) -> bool {
        false
    }

    fn deliver<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Result<String, DeliveryError>> {
        Box::pin(async move {
            let seq = self.seq.fetch_add(1, Ordering::Relaxed);
            let stem = format!("{}-{seq:04}-{}", now_ms(), out.email.kind());
            let eml = self.dir.join(format!("{stem}.eml"));
            let json_path = self.dir.join(format!("{stem}.json"));
            let tmp = self.dir.join(format!(".{stem}.json.tmp"));
            let sidecar = json!({
                "kind": out.email.kind(),
                "to": out.email.to(),
                "messageId": out.message_id,
                "subject": out.rendered.subject,
                "preheader": out.rendered.preheader,
                "code": out.email.code(),
                "url": out.email.url(),
                "text": out.rendered.text,
                "html": out.rendered.html,
                "createdAt": now_ms(),
            });
            let io = |e: std::io::Error| DeliveryError::transient(e.to_string());
            tokio::fs::write(&eml, out.message.formatted())
                .await
                .map_err(io)?;
            tokio::fs::write(
                &tmp,
                serde_json::to_vec_pretty(&sidecar).unwrap_or_default(),
            )
            .await
            .map_err(io)?;
            tokio::fs::rename(&tmp, &json_path).await.map_err(io)?;
            Ok(eml.display().to_string())
        })
    }
}

// ---------------------------------------------------------------------------------------------
// SMTP transport

/// `MAIL_TRANSPORT=smtp`: lettre's pooled async SMTP client over rustls. `SMTP_URL` picks the
/// security: `smtps://` = implicit TLS (port 465 by default), `smtp://…?tls=required` =
/// STARTTLS (587), plain `smtp://` = no TLS (only for a relay on localhost).
pub struct SmtpTransport {
    inner: AsyncSmtpTransport<Tokio1Executor>,
}

impl SmtpTransport {
    pub fn new(url: &str) -> anyhow::Result<Self> {
        let inner = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(|e| anyhow::anyhow!("invalid SMTP_URL {}: {e}", redact_url(url)))?
            .timeout(Some(SMTP_TIMEOUT))
            .pool_config(
                PoolConfig::new()
                    .max_size(CONCURRENCY as u32)
                    .idle_timeout(Duration::from_secs(60)),
            )
            .build();
        Ok(Self { inner })
    }

    /// Open a connection (TLS + EHLO + AUTH) to check the settings; used at startup.
    pub async fn test_connection(&self) -> anyhow::Result<bool> {
        Ok(self.inner.test_connection().await?)
    }
}

impl Transport for SmtpTransport {
    fn name(&self) -> &'static str {
        "smtp"
    }

    fn delivers(&self) -> bool {
        true
    }

    fn deliver<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Result<String, DeliveryError>> {
        Box::pin(async move {
            match self.inner.send(out.message.clone()).await {
                Ok(response) => Ok(format!("{}", response.code())),
                Err(err) => Err(DeliveryError {
                    permanent: err.is_permanent(),
                    message: err.to_string(),
                }),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Fails the first `failures` attempts (transiently, or permanently), then succeeds.
    struct Flaky {
        failures: usize,
        permanent: bool,
        attempts: Mutex<Vec<String>>,
    }

    impl Transport for Flaky {
        fn name(&self) -> &'static str {
            "flaky"
        }
        fn delivers(&self) -> bool {
            true
        }
        fn deliver<'a>(
            &'a self,
            out: &'a Outgoing,
        ) -> BoxFuture<'a, Result<String, DeliveryError>> {
            Box::pin(async move {
                let mut attempts = self.attempts.lock().unwrap();
                attempts.push(out.message_id.clone());
                if attempts.len() <= self.failures {
                    Err(DeliveryError {
                        permanent: self.permanent,
                        message: "451 try later".into(),
                    })
                } else {
                    Ok("250".into())
                }
            })
        }
    }

    fn config(max_attempts: u32) -> MailConfig {
        MailConfig {
            max_attempts,
            retry_base: Duration::from_millis(5),
            ..MailConfig::default()
        }
    }

    fn code_email() -> Email {
        Email::VerificationCode {
            to: "ceyhun@example.com".into(),
            name: "ceyhun cakir".into(),
            code: "482713".into(),
        }
    }

    #[tokio::test]
    async fn retries_transient_failures_with_the_same_message() {
        let flaky = Arc::new(Flaky {
            failures: 2,
            permanent: false,
            attempts: Mutex::default(),
        });
        let queue = MailQueue::start(&config(5), flaky.clone()).unwrap();
        assert!(queue.delivers());
        queue.send(code_email());
        queue.flush(Duration::from_secs(5)).await;
        let attempts = flaky.attempts.lock().unwrap().clone();
        assert_eq!(attempts.len(), 3);
        assert!(
            attempts.iter().all(|id| id == &attempts[0]),
            "one Message-ID"
        );
        assert!(attempts[0].ends_with("@baren.localhost>"));
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts_and_on_permanent_errors() {
        let flaky = Arc::new(Flaky {
            failures: 10,
            permanent: false,
            attempts: Mutex::default(),
        });
        let queue = MailQueue::start(&config(3), flaky.clone()).unwrap();
        queue.send(code_email());
        queue.flush(Duration::from_secs(5)).await;
        assert_eq!(flaky.attempts.lock().unwrap().len(), 3);

        let permanent = Arc::new(Flaky {
            failures: 10,
            permanent: true,
            attempts: Mutex::default(),
        });
        let queue = MailQueue::start(&config(5), permanent.clone()).unwrap();
        queue.send(code_email());
        queue.flush(Duration::from_secs(5)).await;
        assert_eq!(permanent.attempts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn send_returns_before_delivery() {
        // A transport that never finishes: `send` must still return immediately.
        struct Stuck;
        impl Transport for Stuck {
            fn name(&self) -> &'static str {
                "stuck"
            }
            fn delivers(&self) -> bool {
                false
            }
            fn deliver<'a>(
                &'a self,
                _: &'a Outgoing,
            ) -> BoxFuture<'a, Result<String, DeliveryError>> {
                Box::pin(std::future::pending())
            }
        }
        let queue = MailQueue::start(&config(1), Arc::new(Stuck)).unwrap();
        let started = std::time::Instant::now();
        for _ in 0..10 {
            queue.send(code_email());
        }
        assert!(started.elapsed() < Duration::from_millis(100));
        queue.flush(Duration::from_millis(20)).await;
        assert_eq!(queue.pending.count.load(Ordering::SeqCst), 10);
    }

    #[test]
    fn backoff_doubles_and_is_capped() {
        let base = Duration::from_secs(2);
        let d1 = backoff(base, 1);
        let d3 = backoff(base, 3);
        assert!(d1 >= Duration::from_millis(1600) && d1 <= Duration::from_millis(2400));
        assert!(d3 >= Duration::from_millis(6400) && d3 <= Duration::from_millis(9600));
        assert!(backoff(base, 40) <= MAX_BACKOFF);
    }

    #[tokio::test]
    async fn file_transport_writes_eml_and_json() {
        let dir = std::env::temp_dir().join(format!("baren-mail-{}", uuid::Uuid::new_v4()));
        let queue =
            MailQueue::start(&config(1), Arc::new(FileTransport::new(&dir).unwrap())).unwrap();
        assert!(!queue.delivers());
        queue.send(code_email());
        queue.flush(Duration::from_secs(5)).await;
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(names[0].ends_with("-verification_code.eml"));
        assert!(names[1].ends_with("-verification_code.json"));
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(&names[1])).unwrap()).unwrap();
        assert_eq!(json["code"], "482713");
        assert_eq!(json["to"], "ceyhun@example.com");
        assert!(json["html"].as_str().unwrap().contains("482"));
        let eml = std::fs::read_to_string(dir.join(&names[0])).unwrap();
        assert!(eml.contains("multipart/alternative"), "{eml}");
        assert!(
            eml.contains("To: \"ceyhun cakir\" <ceyhun@example.com>"),
            "{eml}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn smtp_urls_with_tls_build() {
        // These need lettre's TLS features; a build without them rejects the schemes.
        for url in [
            "smtps://user:pass@smtp.example.com:465",
            "smtp://user:pass@smtp.example.com:587?tls=required",
            "smtp://localhost:2525",
        ] {
            assert!(SmtpTransport::new(url).is_ok(), "{url}");
        }
        let err = SmtpTransport::new("smtp://u:hunter2@smtp.example.com?tls=sometimes")
            .err()
            .unwrap()
            .to_string();
        assert!(!err.contains("hunter2"), "{err}");
    }
}
