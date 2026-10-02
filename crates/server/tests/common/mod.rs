//! Test harness: a real server on a random port (temp SQLite file), a minimal HTTP/1.1 client
//! and a Loro-backed WebSocket peer that speaks the sync protocol.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use baren_server::{Config, Mailer, MemoryMailer, Server};
use futures_util::{SinkExt, StreamExt};
use loro::{ExportMode, LoroDoc, VersionVector};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub const TIMEOUT: Duration = Duration::from_secs(10);

pub struct TestServer {
    pub server: Option<Server>,
    pub addr: SocketAddr,
    pub mailer: MemoryMailer,
    db_path: PathBuf,
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with(|_| {}).await
    }

    pub async fn start_with(tweak: impl FnOnce(&mut Config)) -> Self {
        let mailer = MemoryMailer::new();
        Self::start_with_mailer(tweak, mailer.clone(), Arc::new(mailer)).await
    }

    /// Start with a specific mailer (`memory` stays empty unless it is that mailer).
    pub async fn start_with_mailer(
        tweak: impl FnOnce(&mut Config),
        memory: MemoryMailer,
        mailer: Arc<dyn Mailer>,
    ) -> Self {
        let db_path = std::env::temp_dir().join(format!(
            "baren-server-test-{}.db",
            uuid::Uuid::new_v4().simple()
        ));
        let mut config = Config {
            bind: "127.0.0.1:0".into(),
            database_url: format!("sqlite://{}", db_path.display()),
            ..Config::default()
        };
        tweak(&mut config);
        let server = baren_server::start(config, mailer)
            .await
            .expect("server starts");
        Self {
            addr: server.addr(),
            server: Some(server),
            mailer: memory,
            db_path,
        }
    }

    /// A second connection to the server's database (for tests that age rows).
    pub async fn db(&self) -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect(&format!("sqlite://{}", self.db_path.display()))
            .await
            .expect("open test db")
    }

    /// Where this server keeps asset bytes.
    pub fn assets_dir(&self) -> PathBuf {
        self.db_path.with_file_name(format!(
            "{}-assets",
            self.db_path.file_stem().unwrap().to_string_lossy()
        ))
    }

    pub fn ws_url(&self, file_id: &str, token: Option<&str>) -> String {
        match token {
            Some(t) => format!("ws://{}/ws/files/{file_id}?token={t}", self.addr),
            None => format!("ws://{}/ws/files/{file_id}", self.addr),
        }
    }

    pub fn open_rooms(&self) -> usize {
        self.server.as_ref().map_or(0, |s| s.open_rooms())
    }

    pub async fn stop(&mut self) {
        if let Some(server) = self.server.take() {
            server.shutdown().await.expect("clean shutdown");
        }
    }

    // ------------------------------------------------------------------------------------------
    // HTTP

    pub async fn api(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut headers = vec![("accept".to_string(), "application/json".to_string())];
        if let Some(t) = token {
            headers.push(("authorization".into(), format!("Bearer {t}")));
        }
        let body = body.map(|b| {
            headers.push(("content-type".into(), "application/json".into()));
            serde_json::to_vec(&b).unwrap()
        });
        let res = http(self.addr, method, path, &headers, body).await;
        let value = if res.body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&res.body)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&res.body).into_owned()))
        };
        (res.status, value)
    }

    pub async fn raw(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> HttpResponse {
        let headers: Vec<(String, String)> = headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        http(self.addr, method, path, &headers, body).await
    }

    /// Register + verify; returns `(token, user_id)`.
    pub async fn sign_up(&self, name: &str, email: &str) -> (String, String) {
        let (status, body) = self
            .api(
                "POST",
                "/api/auth/register",
                None,
                Some(json!({ "name": name, "email": email, "password": "correct horse battery" })),
            )
            .await;
        assert_eq!(status, 200, "register: {body}");
        let code = self.mailer.last_code_for(email).expect("code was mailed");
        let (status, body) = self
            .api(
                "POST",
                "/api/auth/verify",
                None,
                Some(json!({ "email": email, "code": code })),
            )
            .await;
        assert_eq!(status, 200, "verify: {body}");
        (
            body["token"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
    }

    /// The caller's first team id.
    pub async fn first_team(&self, token: &str) -> String {
        let (status, me) = self.api("GET", "/api/me", Some(token), None).await;
        assert_eq!(status, 200, "{me}");
        me["teams"][0]["id"].as_str().unwrap().to_string()
    }

    pub async fn create_file(&self, token: &str, team_id: &str, name: &str) -> String {
        let (status, file) = self
            .api(
                "POST",
                &format!("/api/teams/{team_id}/files"),
                Some(token),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(status, 200, "create file: {file}");
        file["id"].as_str().unwrap().to_string()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.db_path.display()));
        }
        let _ = std::fs::remove_dir_all(self.assets_dir());
    }
}

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// One HTTP/1.1 request over a fresh connection (`Connection: close`).
pub async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
) -> HttpResponse {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let body = body.unwrap_or_default();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nhost: {addr}\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    stream.write_all(&body).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(TIMEOUT, stream.read_to_end(&mut raw))
        .await
        .expect("http response in time")
        .unwrap();
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> HttpResponse {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("header terminator");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .expect("status line");
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    let chunked = headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v.contains("chunked"));
    if chunked {
        body = dechunk(&body);
    }
    HttpResponse {
        status,
        headers,
        body,
    }
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_str = String::from_utf8_lossy(&data[..line_end]);
        let size = usize::from_str_radix(size_str.split(';').next().unwrap().trim(), 16).unwrap();
        data = &data[line_end + 2..];
        if size == 0 {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
    out
}

// ---------------------------------------------------------------------------------------------
// WebSocket peer

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A sync-protocol client backed by its own `LoroDoc`.
pub struct Peer {
    ws: Ws,
    pub doc: LoroDoc,
    sent_vv: VersionVector,
    pub presence: Vec<Value>,
    pub welcome: Option<Value>,
    pub errors: Vec<Value>,
    pub synced: bool,
}

pub enum Outcome {
    Open(Box<Peer>),
    /// The server closed the socket with this code before anything else.
    Closed(u16),
}

impl Peer {
    pub async fn connect(url: &str, doc: LoroDoc) -> Outcome {
        // Like browsers, disable Nagle so small frames are not delayed.
        let (mut ws, _) = tokio_tungstenite::connect_async_with_config(url, None, true)
            .await
            .expect("websocket upgrade");
        // Start the handshake: tell the server what we have.
        ws.send(Message::Binary(
            frame(0x02, &doc.oplog_vv().encode()).into(),
        ))
        .await
        .unwrap();
        let mut peer = Peer {
            ws,
            sent_vv: doc.oplog_vv(),
            doc,
            presence: Vec::new(),
            welcome: None,
            errors: Vec::new(),
            synced: false,
        };
        // Pump until the server answered our sync request (or closed on us).
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while !peer.synced {
            match tokio::time::timeout_at(deadline, peer.ws.next()).await {
                Ok(Some(Ok(Message::Close(frame)))) => {
                    return Outcome::Closed(frame.map_or(1005, |f| u16::from(f.code)));
                }
                Ok(Some(Ok(msg))) => peer.on_message(msg).await,
                Ok(Some(Err(e))) => panic!("websocket error during handshake: {e}"),
                Ok(None) => return Outcome::Closed(1006),
                Err(_) => panic!("handshake timed out"),
            }
        }
        Outcome::Open(Box::new(peer))
    }

    pub async fn connect_ok(url: &str, doc: LoroDoc) -> Peer {
        match Self::connect(url, doc).await {
            Outcome::Open(p) => *p,
            Outcome::Closed(code) => panic!("expected open connection, closed with {code}"),
        }
    }

    async fn on_message(&mut self, msg: Message) {
        match msg {
            Message::Binary(bytes) => {
                let (kind, payload) = bytes.split_first().expect("non-empty frame");
                match kind {
                    0x01 => {
                        self.doc.import(payload).expect("import update");
                    }
                    0x03 => {
                        if !payload.is_empty() {
                            self.doc.import(payload).expect("import sync response");
                        }
                        self.synced = true;
                    }
                    0x02 => {
                        // Server asks for what it is missing.
                        let theirs = VersionVector::decode(payload).unwrap();
                        let ours = self.doc.oplog_vv();
                        if !matches!(
                            ours.partial_cmp(&theirs),
                            Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
                        ) {
                            let update = self.doc.export(ExportMode::updates(&theirs)).unwrap();
                            self.send_binary(frame(0x01, &update)).await;
                        }
                    }
                    other => panic!("unexpected frame type {other}"),
                }
            }
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                match value["type"].as_str() {
                    Some("welcome") => self.welcome = Some(value),
                    Some("error") => self.errors.push(value),
                    _ => self.presence.push(value),
                }
            }
            _ => {}
        }
    }

    pub async fn send_binary(&mut self, bytes: Vec<u8>) {
        self.ws.send(Message::Binary(bytes.into())).await.unwrap();
    }

    pub async fn send_text(&mut self, text: String) {
        self.ws.send(Message::Text(text.into())).await.unwrap();
    }

    /// Commit local edits and push them as one `0x01` update.
    pub async fn push(&mut self) {
        self.doc.commit();
        let update = self.doc.export(ExportMode::updates(&self.sent_vv)).unwrap();
        self.sent_vv = self.doc.oplog_vv();
        self.send_binary(frame(0x01, &update)).await;
    }

    /// Process incoming frames for `dur`.
    pub async fn pump(&mut self, dur: Duration) {
        let deadline = tokio::time::Instant::now() + dur;
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            self.on_message(msg).await;
        }
    }

    /// Pump until `cond` holds (panics after [`TIMEOUT`]).
    pub async fn pump_until(&mut self, mut cond: impl FnMut(&Peer) -> bool) {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while !cond(self) {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(msg))) => self.on_message(msg).await,
                Ok(other) => panic!("connection ended while waiting: {other:?}"),
                Err(_) => panic!("timed out waiting for condition"),
            }
        }
    }

    /// Wait for the server to close the socket; returns the close code.
    pub async fn closed(&mut self) -> u16 {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Close(frame)))) => {
                    return frame.map_or(1005, |f| u16::from(f.code));
                }
                Ok(Some(Ok(msg))) => self.on_message(msg).await,
                Ok(_) => return 1006,
                Err(_) => panic!("socket was not closed"),
            }
        }
    }

    pub async fn close(mut self) {
        let _ = self
            .ws
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: CloseCode::Normal,
                reason: "bye".into(),
            }))
            .await;
        // Drain until the server acknowledges.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(Ok(_)) = self.ws.next().await {}
        })
        .await;
    }

    /// Ask the server for anything we are missing and wait for the answer.
    pub async fn resync(&mut self) {
        self.synced = false;
        let vv = self.doc.oplog_vv().encode();
        self.send_binary(frame(0x02, &vv)).await;
        self.pump_until(|p| p.synced).await;
    }
}

pub fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(kind);
    out.extend_from_slice(payload);
    out
}
