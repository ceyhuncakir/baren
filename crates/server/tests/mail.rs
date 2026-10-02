//! Real mail transports end to end: `MAIL_TRANSPORT=file:<dir>` (register → verify → forgot →
//! reset → login, invites and re-sends) and SMTP against a scripted local SMTP server
//! (including a transient failure that must be retried).

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use baren_server::{mailer, MailConfig, MailTransport, MemoryMailer};
use common::TestServer;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Everything logged in this test binary (the mail worker logs from other threads).
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Capture {
        self.clone()
    }
}

fn captured_logs() -> Capture {
    static CAPTURE: OnceLock<Capture> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let capture = Capture::default();
            let _ = tracing_subscriber::fmt()
                .with_writer(capture.clone())
                .with_ansi(false)
                .without_time()
                .with_max_level(tracing::Level::INFO)
                .try_init();
            capture
        })
        .clone()
}

/// Wait for the `n`-th (1-based) `.json` sidecar of `kind` in `dir`.
async fn wait_for_mail(dir: &Path, kind: &str, n: usize) -> Value {
    let deadline = tokio::time::Instant::now() + common::TIMEOUT;
    loop {
        let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|d| {
                d.filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| {
                        p.extension().is_some_and(|x| x == "json")
                            && p.file_name().is_some_and(|f| {
                                f.to_string_lossy().ends_with(&format!("-{kind}.json"))
                            })
                    })
                    .collect()
            })
            .unwrap_or_default();
        found.sort();
        if found.len() >= n {
            let json: Value =
                serde_json::from_slice(&std::fs::read(&found[n - 1]).unwrap()).unwrap();
            let eml = found[n - 1].with_extension("eml");
            assert!(eml.exists(), "the .eml is written before the .json");
            return json;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no {kind} mail #{n} in {}",
            dir.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn file_transport_register_verify_forgot_reset_login() {
    let dir = std::env::temp_dir().join(format!("baren-mails-{}", uuid::Uuid::new_v4()));
    let config = MailConfig {
        transport: MailTransport::File(dir.clone()),
        ..MailConfig::default()
    };
    let delivering = mailer::from_config(&config).unwrap();
    assert!(!delivering.delivers());
    let srv = TestServer::start_with_mailer(|_| {}, MemoryMailer::new(), delivering).await;
    let email = "ceyhun@example.com";

    let (status, _) = srv
        .api(
            "POST",
            "/api/auth/register",
            None,
            Some(json!({ "name": "ceyhun cakir", "email": email, "password": "first password" })),
        )
        .await;
    assert_eq!(status, 200);
    let mail = wait_for_mail(&dir, "verification_code", 1).await;
    assert_eq!(mail["to"], email);
    let code = mail["code"].as_str().unwrap().to_string();
    assert!(mail["subject"].as_str().unwrap().contains(&code));
    assert!(mail["text"].as_str().unwrap().contains(&code));
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/verify",
            None,
            Some(json!({ "email": email, "code": code })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let token = body["token"].as_str().unwrap().to_string();

    let (status, _) = srv
        .api(
            "POST",
            "/api/auth/password/forgot",
            None,
            Some(json!({ "email": email })),
        )
        .await;
    assert_eq!(status, 204);
    let mail = wait_for_mail(&dir, "password_reset", 1).await;
    let reset_code = mail["code"].as_str().unwrap().to_string();
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/password/reset",
            None,
            Some(json!({ "email": email, "code": reset_code, "password": "second password" })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(srv.api("GET", "/api/me", Some(&token), None).await.0, 401);
    let (status, _) = srv
        .api(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({ "email": email, "password": "second password" })),
        )
        .await;
    assert_eq!(status, 200);
    let token = body["token"].as_str().unwrap().to_string();

    // Email invites are mailed; re-sending rotates the link.
    let team = srv.first_team(&token).await;
    let (status, invite) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&token),
            Some(json!({ "role": "editor", "email": "Defne@Example.COM" })),
        )
        .await;
    assert_eq!(status, 200, "{invite}");
    let mail = wait_for_mail(&dir, "team_invite", 1).await;
    assert_eq!(mail["to"], "defne@example.com");
    assert_eq!(mail["url"], invite["url"]);
    assert_eq!(
        mail["subject"],
        "ceyhun cakir invited you to ceyhun's Team on Baren"
    );

    let id = invite["id"].as_str().unwrap();
    let (status, resent) = srv
        .api(
            "POST",
            &format!("/api/invites/{id}/resend"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, 200, "{resent}");
    assert_ne!(resent["token"], invite["token"]);
    let mail = wait_for_mail(&dir, "team_invite", 2).await;
    assert_eq!(mail["url"], resent["url"]);
    let old = invite["token"].as_str().unwrap();
    assert_eq!(
        srv.api("GET", &format!("/api/invites/{old}"), None, None)
            .await
            .0,
        404
    );
    let new = resent["token"].as_str().unwrap();
    assert_eq!(
        srv.api("GET", &format!("/api/invites/{new}"), None, None)
            .await
            .0,
        200
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A scripted SMTP server: accepts every message, except that the first `fail_first` DATA
/// commands get `451` (a transient failure).
struct FakeSmtp {
    url: String,
    messages: Arc<Mutex<Vec<String>>>,
    rejected: Arc<Mutex<usize>>,
}

impl FakeSmtp {
    async fn start(fail_first: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("smtp://{}", listener.local_addr().unwrap());
        let messages = Arc::new(Mutex::new(Vec::new()));
        let rejected = Arc::new(Mutex::new(0usize));
        let (m, r) = (messages.clone(), rejected.clone());
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let (m, r) = (m.clone(), r.clone());
                tokio::spawn(async move {
                    let (read, mut write) = socket.into_split();
                    let mut lines = BufReader::new(read).lines();
                    write.write_all(b"220 fake ESMTP\r\n").await.unwrap();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let verb = line
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .to_ascii_uppercase();
                        let reply: &[u8] = match verb.as_str() {
                            "EHLO" | "HELO" => b"250-fake\r\n250 8BITMIME\r\n",
                            "MAIL" | "RCPT" | "RSET" | "NOOP" => b"250 OK\r\n",
                            "DATA" => {
                                write.write_all(b"354 go ahead\r\n").await.unwrap();
                                let mut data = String::new();
                                while let Ok(Some(l)) = lines.next_line().await {
                                    if l == "." {
                                        break;
                                    }
                                    data.push_str(&l);
                                    data.push('\n');
                                }
                                let mut rejected = r.lock().unwrap();
                                if *rejected < fail_first {
                                    *rejected += 1;
                                    b"451 4.3.0 try again later\r\n"
                                } else {
                                    m.lock().unwrap().push(data);
                                    b"250 2.0.0 queued\r\n"
                                }
                            }
                            "QUIT" => {
                                let _ = write.write_all(b"221 bye\r\n").await;
                                break;
                            }
                            _ => b"502 unknown\r\n",
                        };
                        if write.write_all(reply).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        Self {
            url,
            messages,
            rejected,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn smtp_transport_retries_and_delivers_without_logging_codes() {
    let logs = captured_logs();
    let smtp = FakeSmtp::start(1).await;
    let config = MailConfig {
        transport: MailTransport::Smtp(smtp.url.clone()),
        from: "Baren <no-reply@example.com>".into(),
        max_attempts: 3,
        retry_base: Duration::from_millis(50),
    };
    let delivering = mailer::from_config(&config).unwrap();
    assert!(delivering.delivers());
    let srv = TestServer::start_with_mailer(|_| {}, MemoryMailer::new(), delivering).await;
    let (status, body) = srv.api("GET", "/api/auth/providers", None, None).await;
    assert_eq!((status, body), (200, json!({ "email": true })));

    let (status, _) = srv
        .api(
            "POST",
            "/api/auth/register",
            None,
            Some(json!({ "name": "ceyhun cakir", "email": "ceyhun@example.com", "password": "first password" })),
        )
        .await;
    assert_eq!(status, 200);

    let deadline = tokio::time::Instant::now() + common::TIMEOUT;
    while smtp.messages.lock().unwrap().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "no message reached the SMTP server"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        *smtp.rejected.lock().unwrap(),
        1,
        "the first attempt was refused with 451"
    );
    let message = smtp.messages.lock().unwrap()[0].clone();
    assert!(
        message.contains("From: Baren <no-reply@example.com>"),
        "{message}"
    );
    assert!(
        message.contains("To: \"ceyhun cakir\" <ceyhun@example.com>"),
        "{message}"
    );
    assert!(message.contains("multipart/alternative"), "{message}");
    assert!(message.contains("text/html"), "{message}");

    // The log says what happened, but never shows the code or the full address.
    let code = message
        .lines()
        .find_map(|l| l.strip_prefix("Subject: "))
        .and_then(|s| s.split_whitespace().next())
        .unwrap()
        .to_string();
    assert_eq!(code.len(), 6, "{message}");
    // Give the worker a moment to write its "delivered" line.
    let deadline = tokio::time::Instant::now() + common::TIMEOUT;
    loop {
        let text = String::from_utf8_lossy(&logs.0.lock().unwrap()).into_owned();
        if text.contains("email delivered") {
            assert!(text.contains("email delivery failed; retrying"), "{text}");
            assert!(text.contains("c***@example.com"), "{text}");
            assert!(
                !text.contains(&code),
                "the code leaked into the log:\n{text}"
            );
            assert!(!text.contains("ceyhun@example.com"), "{text}");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no delivery log line:\n{text}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
