//! Runtime configuration, read from the environment by the binary and built directly by tests.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context};

pub const DEFAULT_BIND: &str = "127.0.0.1:8787";
pub const DEFAULT_DATABASE_URL: &str = "sqlite://baren.db";

/// Origins allowed by default: the packaged Electron renderer (`app://renderer`) and the Vite
/// dev servers used by `electron-vite dev`, `build:web` and Playwright.
pub const DEFAULT_CORS_ORIGINS: &[&str] = &[
    "app://renderer",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:5199",
    "http://127.0.0.1:5199",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CorsOrigins {
    Any,
    List(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Config {
    /// `BIND`: socket address to listen on. Port 0 picks a free port.
    pub bind: String,
    /// `DATABASE_URL`: `sqlite://path/to/file.db` (created if missing).
    pub database_url: String,
    /// `PUBLIC_URL`: externally visible base URL, used in invite links.
    /// When unset it is derived from the bound address.
    pub public_url: Option<String>,
    /// `CORS_ORIGINS`: comma-separated origins, or `*`.
    pub cors_origins: CorsOrigins,
    /// `SESSION_TTL_DAYS`: sliding session lifetime.
    pub session_ttl: Duration,
    /// `ROOM_IDLE_SECS`: unload a room this long after its last client left.
    pub room_idle: Duration,
    /// `COMPACT_EVERY_UPDATES`: compact a room's snapshot after this many appended updates.
    pub compact_every_updates: usize,
    /// `COMPACT_INTERVAL_SECS`: compact a room with pending updates at least this often.
    pub compact_interval: Duration,
    /// `MAX_MESSAGE_BYTES`: largest WebSocket message (and snapshot upload) accepted.
    pub max_message_bytes: usize,
    /// Capacity of each client's outbound queue; a client that falls this far behind is
    /// disconnected and resyncs on reconnect.
    pub client_queue: usize,
    /// Capacity of each room's inbound command queue.
    pub room_queue: usize,
    /// Interval between server pings; a client silent for 3× this is dropped.
    pub ping_interval: Duration,
    /// Outgoing email (`MAIL_TRANSPORT`, `SMTP_URL`, `MAIL_FROM`).
    pub mail: MailConfig,
    /// `ASSETS_DIR`: where uploaded image bytes are stored (content-addressed). When unset it
    /// is `<database file stem>-assets` next to the SQLite file.
    pub assets_dir: Option<PathBuf>,
    /// `UPDATES_DIR`: directory served at `/updates/*` (the desktop auto-update feed). The
    /// feed answers 404 when unset.
    pub updates_dir: Option<PathBuf>,
}

/// How outgoing email is delivered.
#[derive(Clone, PartialEq, Eq)]
pub enum MailTransport {
    /// Write codes and links to the server log (development; nothing is sent).
    Log,
    /// Write every message to `<dir>` as `.eml` (MIME) plus a `.json` sidecar (tests, previews).
    File(PathBuf),
    /// Deliver through an SMTP relay. The URL carries the credentials:
    /// `smtps://user:pass@host:465` (implicit TLS), `smtp://user:pass@host:587?tls=required`
    /// (STARTTLS), `smtp://host:25` (plain, local relays only).
    Smtp(String),
}

impl fmt::Debug for MailTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MailTransport::Log => f.write_str("Log"),
            MailTransport::File(dir) => f.debug_tuple("File").field(dir).finish(),
            MailTransport::Smtp(url) => f.debug_tuple("Smtp").field(&redact_url(url)).finish(),
        }
    }
}

impl MailTransport {
    /// Whether this transport actually delivers email to people (`GET /api/auth/providers`).
    pub fn delivers(&self) -> bool {
        matches!(self, MailTransport::Smtp(_))
    }

    pub fn name(&self) -> &'static str {
        match self {
            MailTransport::Log => "log",
            MailTransport::File(_) => "file",
            MailTransport::Smtp(_) => "smtp",
        }
    }
}

#[derive(Debug, Clone)]
pub struct MailConfig {
    pub transport: MailTransport,
    /// `MAIL_FROM`: the sender mailbox, e.g. `Baren <no-reply@example.com>`.
    /// Required with SMTP; defaults to [`DEFAULT_MAIL_FROM`] otherwise.
    pub from: String,
    /// `MAIL_MAX_ATTEMPTS`: delivery attempts per message before giving up.
    pub max_attempts: u32,
    /// `MAIL_RETRY_BASE_MS`: first retry delay; it doubles on every further attempt.
    pub retry_base: Duration,
}

pub const DEFAULT_MAIL_FROM: &str = "Baren <no-reply@baren.localhost>";

impl Default for MailConfig {
    fn default() -> Self {
        Self {
            transport: MailTransport::Log,
            from: DEFAULT_MAIL_FROM.into(),
            max_attempts: 5,
            retry_base: Duration::from_secs(2),
        }
    }
}

/// `scheme://user:***@host:port/...` — never print SMTP passwords.
pub fn redact_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut parsed) => {
            if parsed.password().is_some() {
                let _ = parsed.set_password(Some("***"));
            }
            parsed.to_string()
        }
        Err(_) => "<invalid url>".into(),
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: DEFAULT_BIND.into(),
            database_url: DEFAULT_DATABASE_URL.into(),
            public_url: None,
            cors_origins: CorsOrigins::List(
                DEFAULT_CORS_ORIGINS.iter().map(|s| s.to_string()).collect(),
            ),
            session_ttl: Duration::from_secs(30 * 24 * 3600),
            room_idle: Duration::from_secs(30),
            compact_every_updates: 500,
            compact_interval: Duration::from_secs(120),
            max_message_bytes: 32 * 1024 * 1024,
            client_queue: 512,
            room_queue: 1024,
            ping_interval: Duration::from_secs(25),
            mail: MailConfig::default(),
            assets_dir: None,
            updates_dir: None,
        }
    }
}

impl Config {
    /// Read the configuration from environment variables (see the field docs).
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let mut c = Config::default();
        // BAREN_ADDR was the foundation skeleton's name for BIND.
        if let Some(bind) = get("BIND").or_else(|| get("BAREN_ADDR")) {
            c.bind = bind;
        }
        if let Some(url) = get("DATABASE_URL") {
            c.database_url = url;
        }
        if let Some(url) = get("PUBLIC_URL").filter(|s| !s.trim().is_empty()) {
            let url = url.trim().trim_end_matches('/').to_string();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                bail!("PUBLIC_URL must start with http:// or https:// (got {url})");
            }
            c.public_url = Some(url);
        }
        if let Some(origins) = get("CORS_ORIGINS") {
            c.cors_origins = parse_cors(&origins);
        }
        if let Some(v) = get("SESSION_TTL_DAYS") {
            c.session_ttl = Duration::from_secs(parse_num::<u64>("SESSION_TTL_DAYS", &v)? * 86_400);
        }
        if let Some(v) = get("ROOM_IDLE_SECS") {
            c.room_idle = Duration::from_secs(parse_num("ROOM_IDLE_SECS", &v)?);
        }
        if let Some(v) = get("COMPACT_EVERY_UPDATES") {
            c.compact_every_updates = parse_num("COMPACT_EVERY_UPDATES", &v)?;
        }
        if let Some(v) = get("COMPACT_INTERVAL_SECS") {
            c.compact_interval = Duration::from_secs(parse_num("COMPACT_INTERVAL_SECS", &v)?);
        }
        if let Some(v) = get("MAX_MESSAGE_BYTES") {
            c.max_message_bytes = parse_num("MAX_MESSAGE_BYTES", &v)?;
        }
        c.mail = parse_mail(&get)?;
        if let Some(dir) = non_empty(get("ASSETS_DIR")) {
            c.assets_dir = Some(PathBuf::from(dir));
        }
        if let Some(dir) = non_empty(get("UPDATES_DIR")) {
            c.updates_dir = Some(PathBuf::from(dir));
        }
        Ok(c)
    }

    /// The directory holding uploaded assets: `ASSETS_DIR`, or `<db stem>-assets` next to the
    /// database file (`sqlite:///var/lib/baren/baren.db` → `/var/lib/baren/baren-assets`).
    /// In-memory databases get a per-process directory under the system temp dir.
    pub fn resolved_assets_dir(&self) -> PathBuf {
        if let Some(dir) = &self.assets_dir {
            return dir.clone();
        }
        match sqlite_path(&self.database_url) {
            Some(db) => {
                let stem = db
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "baren".into());
                db.parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(format!("{stem}-assets"))
            }
            None => std::env::temp_dir().join(format!("baren-assets-{}", std::process::id())),
        }
    }

    /// The public base URL without a trailing slash.
    pub fn public_url_for(&self, bound: std::net::SocketAddr) -> String {
        self.public_url
            .clone()
            .unwrap_or_else(|| format!("http://{bound}"))
    }
}

fn parse_num<T: std::str::FromStr>(key: &str, value: &str) -> anyhow::Result<T>
where
    T::Err: std::error::Error + Send + Sync + 'static,
{
    value
        .trim()
        .parse()
        .with_context(|| format!("{key} must be a number (got {value:?})"))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// `MAIL_TRANSPORT = log | file:<dir> | smtp` (default `smtp` when `SMTP_URL` is set, else
/// `log`), `SMTP_URL`, `MAIL_FROM`, `MAIL_MAX_ATTEMPTS`, `MAIL_RETRY_BASE_MS`.
fn parse_mail(get: &impl Fn(&str) -> Option<String>) -> anyhow::Result<MailConfig> {
    let mut mail = MailConfig::default();
    let smtp_url = non_empty(get("SMTP_URL"));
    let transport = non_empty(get("MAIL_TRANSPORT"));
    mail.transport = match (transport.as_deref(), smtp_url) {
        (None, None) | (Some("log"), _) => MailTransport::Log,
        (None, Some(url)) | (Some("smtp"), Some(url)) => {
            validate_smtp_url(&url)?;
            MailTransport::Smtp(url)
        }
        (Some("smtp"), None) => bail!("MAIL_TRANSPORT=smtp needs SMTP_URL"),
        (Some(other), _) => match other.strip_prefix("file:") {
            Some(dir) if !dir.trim().is_empty() => MailTransport::File(PathBuf::from(dir.trim())),
            _ => bail!("MAIL_TRANSPORT must be log, file:<dir> or smtp (got {other:?})"),
        },
    };
    match non_empty(get("MAIL_FROM")) {
        Some(from) => {
            from.parse::<lettre::message::Mailbox>()
                .with_context(|| format!("MAIL_FROM is not a valid mailbox (got {from:?})"))?;
            mail.from = from;
        }
        None if mail.transport.delivers() => {
            bail!("MAIL_FROM is required with SMTP, e.g. \"Baren <no-reply@example.com>\"")
        }
        None => {}
    }
    if let Some(v) = get("MAIL_MAX_ATTEMPTS") {
        mail.max_attempts = parse_num::<u32>("MAIL_MAX_ATTEMPTS", &v)?.max(1);
    }
    if let Some(v) = get("MAIL_RETRY_BASE_MS") {
        mail.retry_base = Duration::from_millis(parse_num("MAIL_RETRY_BASE_MS", &v)?);
    }
    Ok(mail)
}

fn validate_smtp_url(raw: &str) -> anyhow::Result<()> {
    let parsed =
        url::Url::parse(raw).map_err(|e| anyhow::anyhow!("SMTP_URL is not a valid URL: {e}"))?;
    if !matches!(parsed.scheme(), "smtp" | "smtps") {
        bail!(
            "SMTP_URL must start with smtps:// (implicit TLS) or smtp:// (got {})",
            redact_url(raw)
        );
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        bail!("SMTP_URL has no host ({})", redact_url(raw));
    }
    Ok(())
}

/// The file path of a `sqlite:` URL, or `None` for in-memory databases.
fn sqlite_path(url: &str) -> Option<PathBuf> {
    let rest = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))?;
    let path = rest.split('?').next().unwrap_or(rest);
    if path.is_empty() || path == ":memory:" || path.starts_with(":memory:") {
        return None;
    }
    Some(PathBuf::from(path))
}

fn parse_cors(value: &str) -> CorsOrigins {
    let items: Vec<String> = value
        .split(',')
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if items.iter().any(|s| s == "*") {
        CorsOrigins::Any
    } else {
        CorsOrigins::List(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> anyhow::Result<Config> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn defaults() {
        let c = cfg(&[]).unwrap();
        assert_eq!(c.bind, DEFAULT_BIND);
        assert!(
            matches!(c.cors_origins, CorsOrigins::List(ref l) if l.contains(&"app://renderer".to_string()))
        );
        assert_eq!(
            c.public_url_for("127.0.0.1:9000".parse().unwrap()),
            "http://127.0.0.1:9000"
        );
    }

    #[test]
    fn env_overrides() {
        let c = cfg(&[
            ("BIND", "0.0.0.0:9999"),
            ("PUBLIC_URL", "https://sync.example.com/"),
            ("CORS_ORIGINS", "app://renderer, https://a.example"),
            ("ROOM_IDLE_SECS", "5"),
        ])
        .unwrap();
        assert_eq!(c.bind, "0.0.0.0:9999");
        assert_eq!(c.public_url.as_deref(), Some("https://sync.example.com"));
        assert_eq!(
            c.cors_origins,
            CorsOrigins::List(vec!["app://renderer".into(), "https://a.example".into()])
        );
        assert_eq!(c.room_idle, Duration::from_secs(5));
        assert_eq!(
            cfg(&[("CORS_ORIGINS", "*")]).unwrap().cors_origins,
            CorsOrigins::Any
        );
    }

    #[test]
    fn rejects_bad_values() {
        assert!(cfg(&[("PUBLIC_URL", "example.com")]).is_err());
        assert!(cfg(&[("ROOM_IDLE_SECS", "soon")]).is_err());
    }

    #[test]
    fn mail_transport_defaults_to_log_and_follows_smtp_url() {
        let c = cfg(&[]).unwrap();
        assert_eq!(c.mail.transport, MailTransport::Log);
        assert!(!c.mail.transport.delivers());

        let c = cfg(&[
            ("SMTP_URL", "smtps://user:secret@smtp.example.com:465"),
            ("MAIL_FROM", "Baren <no-reply@example.com>"),
        ])
        .unwrap();
        assert_eq!(
            c.mail.transport,
            MailTransport::Smtp("smtps://user:secret@smtp.example.com:465".into())
        );
        assert!(c.mail.transport.delivers());
        // Debug output (e.g. a config dump) never shows the password.
        let debug = format!("{:?}", c.mail);
        assert!(!debug.contains("secret"), "{debug}");
        assert!(debug.contains("***"), "{debug}");

        // MAIL_TRANSPORT=log wins over a configured SMTP_URL.
        let c = cfg(&[
            ("MAIL_TRANSPORT", "log"),
            ("SMTP_URL", "smtp://localhost:25"),
        ])
        .unwrap();
        assert_eq!(c.mail.transport, MailTransport::Log);

        let c = cfg(&[("MAIL_TRANSPORT", "file:/tmp/mails")]).unwrap();
        assert_eq!(c.mail.transport, MailTransport::File("/tmp/mails".into()));
        assert_eq!(c.mail.from, DEFAULT_MAIL_FROM);
    }

    #[test]
    fn mail_config_errors() {
        // SMTP without a sender, without a URL, or with a bad URL.
        assert!(cfg(&[("SMTP_URL", "smtp://localhost:25")]).is_err());
        assert!(cfg(&[("MAIL_TRANSPORT", "smtp"), ("MAIL_FROM", "a@b.co")]).is_err());
        assert!(cfg(&[("SMTP_URL", "http://x.example"), ("MAIL_FROM", "a@b.co")]).is_err());
        assert!(cfg(&[("MAIL_TRANSPORT", "pigeon")]).is_err());
        assert!(cfg(&[("MAIL_TRANSPORT", "file:")]).is_err());
        assert!(cfg(&[("MAIL_FROM", "not a mailbox")]).is_err());
        let err = cfg(&[("SMTP_URL", "ftp://u:hunter2@x"), ("MAIL_FROM", "a@b.co")])
            .unwrap_err()
            .to_string();
        assert!(!err.contains("hunter2"), "{err}");
    }

    #[test]
    fn assets_and_updates_dirs() {
        let c = cfg(&[("DATABASE_URL", "sqlite:///var/lib/baren/baren.db")]).unwrap();
        assert_eq!(
            c.resolved_assets_dir(),
            PathBuf::from("/var/lib/baren/baren-assets")
        );
        assert_eq!(c.updates_dir, None);
        let c = cfg(&[
            ("ASSETS_DIR", "/srv/assets"),
            ("UPDATES_DIR", "/srv/updates"),
        ])
        .unwrap();
        assert_eq!(c.resolved_assets_dir(), PathBuf::from("/srv/assets"));
        assert_eq!(c.updates_dir, Some(PathBuf::from("/srv/updates")));
        let c = cfg(&[("DATABASE_URL", "sqlite::memory:")]).unwrap();
        assert!(c.resolved_assets_dir().starts_with(std::env::temp_dir()));
    }
}
