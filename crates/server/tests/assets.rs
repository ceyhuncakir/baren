//! `PUT`/`GET`/`HEAD /api/files/:id/assets/:hash`.

mod common;

use std::time::Duration;

use common::TestServer;
use serde_json::json;

/// A tiny but real PNG (1×1, transparent) plus some padding to make each sample unique.
fn png(seed: u8) -> Vec<u8> {
    let mut bytes = vec![
        0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
        0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
    ];
    bytes.extend(std::iter::repeat_n(seed, 100));
    bytes
}

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

async fn put(
    srv: &TestServer,
    token: &str,
    file: &str,
    hash: &str,
    bytes: Vec<u8>,
    mime: &str,
) -> common::HttpResponse {
    let auth = format!("Bearer {token}");
    srv.raw(
        "PUT",
        &format!("/api/files/{file}/assets/{hash}"),
        &[("authorization", &auth), ("content-type", mime)],
        Some(bytes),
    )
    .await
}

async fn get(
    srv: &TestServer,
    method: &str,
    token: &str,
    file: &str,
    hash: &str,
) -> common::HttpResponse {
    let auth = format!("Bearer {token}");
    srv.raw(
        method,
        &format!("/api/files/{file}/assets/{hash}"),
        &[("authorization", &auth)],
        None,
    )
    .await
}

/// Announce a 20 MB + 1 byte body and send none of it.
async fn oversized_put(srv: &TestServer, token: &str, file: &str, hash: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(srv.addr).await.unwrap();
    let req = format!(
        "PUT /api/files/{file}/assets/{hash} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\
         authorization: Bearer {token}\r\ncontent-type: image/png\r\ncontent-length: {}\r\n\r\n",
        20 * 1024 * 1024 + 1
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    // The server answers and closes without waiting for the body.
    let _ = tokio::time::timeout(common::TIMEOUT, stream.read_to_end(&mut buf))
        .await
        .expect("response in time");
    String::from_utf8_lossy(&buf).into_owned()
}

fn json_of(res: &common::HttpResponse) -> serde_json::Value {
    serde_json::from_slice(&res.body).unwrap_or(serde_json::Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn upload_download_and_head() {
    let srv = TestServer::start().await;
    let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&token).await;
    let file = srv.create_file(&token, &team, "Doc").await;
    let bytes = png(1);
    let h = hash(&bytes);

    // Unknown asset first.
    let res = get(&srv, "GET", &token, &file, &h).await;
    assert_eq!(res.status, 404);
    assert_eq!(json_of(&res)["error"]["code"], "asset_not_found");
    assert_eq!(get(&srv, "HEAD", &token, &file, &h).await.status, 404);

    // The declared type does not matter: the bytes are sniffed.
    let res = put(
        &srv,
        &token,
        &file,
        &h,
        bytes.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(res.status, 201, "{}", res.text());
    assert_eq!(
        json_of(&res),
        json!({ "hash": h, "mime": "image/png", "size": bytes.len() })
    );
    // Idempotent; upper-case ids are the same asset.
    let res = put(
        &srv,
        &token,
        &file,
        &h.to_uppercase(),
        bytes.clone(),
        "image/png",
    )
    .await;
    assert_eq!(res.status, 200, "{}", res.text());
    // Re-uploads are verified too.
    let mut tampered = bytes.clone();
    tampered[40] ^= 1;
    let res = put(&srv, &token, &file, &h, tampered, "image/png").await;
    assert_eq!(res.status, 400);
    assert_eq!(json_of(&res)["error"]["code"], "hash_mismatch");

    let res = get(&srv, "GET", &token, &file, &h).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, bytes);
    assert_eq!(res.header("content-type"), Some("image/png"));
    assert_eq!(
        res.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(res.header("etag"), Some(format!("\"{h}\"").as_str()));
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    let len = bytes.len().to_string();
    assert_eq!(res.header("content-length"), Some(len.as_str()));

    let res = get(&srv, "HEAD", &token, &file, &h).await;
    assert_eq!(res.status, 200);
    assert!(res.body.is_empty());
    assert_eq!(res.header("content-length"), Some(len.as_str()));
    assert_eq!(res.header("content-type"), Some("image/png"));

    // Revalidation.
    let auth = format!("Bearer {token}");
    let etag = format!("\"{h}\"");
    let res = srv
        .raw(
            "GET",
            &format!("/api/files/{file}/assets/{h}"),
            &[("authorization", &auth), ("if-none-match", &etag)],
            None,
        )
        .await;
    assert_eq!(res.status, 304);
    assert!(res.body.is_empty());

    // Stored once, content-addressed.
    let on_disk = srv.assets_dir().join(&h[..2]).join(&h);
    assert_eq!(std::fs::read(on_disk).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_bad_uploads() {
    let srv = TestServer::start().await;
    let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&token).await;
    let file = srv.create_file(&token, &team, "Doc").await;
    let bytes = png(2);

    let res = put(
        &srv,
        &token,
        &file,
        "not-a-hash",
        bytes.clone(),
        "image/png",
    )
    .await;
    assert_eq!(res.status, 400);
    assert_eq!(json_of(&res)["error"]["code"], "invalid_hash");

    let res = put(
        &srv,
        &token,
        &file,
        &hash(&png(3)),
        bytes.clone(),
        "image/png",
    )
    .await;
    assert_eq!(res.status, 400);
    assert_eq!(json_of(&res)["error"]["code"], "hash_mismatch");

    let html = b"<html><script>alert(1)</script></html>".to_vec();
    let res = put(&srv, &token, &file, &hash(&html), html, "image/png").await;
    assert_eq!(res.status, 415);
    assert_eq!(json_of(&res)["error"]["code"], "unsupported_media_type");

    // Over 20 MB: refused from Content-Length, before any of the body is read.
    let res = oversized_put(&srv, &token, &file, &hash(&bytes)).await;
    assert!(res.starts_with("HTTP/1.1 413"), "{res}");
    assert!(res.contains("asset_too_large"), "{res}");

    // Nothing was stored, and no temp files were left behind.
    let res = get(&srv, "GET", &token, &file, &hash(&bytes)).await;
    assert_eq!(res.status, 404);
    let tmp = srv.assets_dir().join("tmp");
    let leftovers = std::fs::read_dir(&tmp).map(|d| d.count()).unwrap_or(0);
    assert_eq!(leftovers, 0);

    // Unknown file / not signed in.
    let res = put(
        &srv,
        &token,
        "nope",
        &hash(&bytes),
        bytes.clone(),
        "image/png",
    )
    .await;
    assert_eq!(res.status, 404);
    let res = srv
        .raw(
            "PUT",
            &format!("/api/files/{file}/assets/{}", hash(&bytes)),
            &[],
            Some(bytes),
        )
        .await;
    assert_eq!(res.status, 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn permissions_follow_file_roles() {
    let srv = TestServer::start().await;
    let (alice, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let (bob, _) = srv.sign_up("Defne Aydın", "defne@example.com").await;
    let (carol, _) = srv.sign_up("Carol", "carol@example.com").await;
    let team = srv.first_team(&alice).await;
    let file = srv.create_file(&alice, &team, "Doc").await;
    let bytes = png(4);
    let h = hash(&bytes);
    assert_eq!(
        put(&srv, &alice, &file, &h, bytes.clone(), "image/png")
            .await
            .status,
        201
    );

    // Bob joins as a viewer: can read, cannot upload.
    let (status, invite) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&alice),
            Some(json!({ "role": "viewer" })),
        )
        .await;
    assert_eq!(status, 200);
    let token = invite["token"].as_str().unwrap();
    assert_eq!(
        srv.api(
            "POST",
            &format!("/api/invites/{token}/accept"),
            Some(&bob),
            None
        )
        .await
        .0,
        200
    );
    let res = get(&srv, "GET", &bob, &file, &h).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, bytes);
    let other = png(5);
    let res = put(&srv, &bob, &file, &hash(&other), other, "image/png").await;
    assert_eq!(res.status, 403);

    // Carol is not a member: no access, until the team allows link access (view only).
    assert_eq!(get(&srv, "GET", &carol, &file, &h).await.status, 403);
    let (status, _) = srv
        .api(
            "PATCH",
            &format!("/api/teams/{team}"),
            Some(&alice),
            Some(json!({ "fileAccess": "link" })),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(get(&srv, "GET", &carol, &file, &h).await.status, 200);
    assert_eq!(
        put(&srv, &carol, &file, &h, bytes.clone(), "image/png")
            .await
            .status,
        403
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hash_alone_never_grants_access() {
    let srv = TestServer::start().await;
    let (alice, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let (bob, _) = srv.sign_up("Defne Aydın", "defne@example.com").await;
    let alice_file = srv
        .create_file(&alice, &srv.first_team(&alice).await, "A")
        .await;
    let bob_file = srv
        .create_file(&bob, &srv.first_team(&bob).await, "B")
        .await;
    let secret = png(6);
    let h = hash(&secret);
    assert_eq!(
        put(&srv, &alice, &alice_file, &h, secret.clone(), "image/png")
            .await
            .status,
        201
    );

    // Bob knows the hash but not the bytes: his file has no such asset...
    let res = get(&srv, "GET", &bob, &bob_file, &h).await;
    assert_eq!(res.status, 404);
    // ...and claiming it without the bytes fails.
    let res = put(&srv, &bob, &bob_file, &h, png(7), "image/png").await;
    assert_eq!(res.status, 400);
    assert_eq!(json_of(&res)["error"]["code"], "hash_mismatch");
    // With the real bytes he may link them to his file (stored once on disk).
    assert_eq!(
        put(&srv, &bob, &bob_file, &h, secret.clone(), "image/png")
            .await
            .status,
        201
    );
    assert_eq!(get(&srv, "GET", &bob, &bob_file, &h).await.body, secret);
}

#[tokio::test(flavor = "multi_thread")]
async fn unreferenced_assets_are_swept() {
    let mut srv = TestServer::start().await;
    let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&token).await;
    let keep = srv.create_file(&token, &team, "Keep").await;
    let drop_me = srv.create_file(&token, &team, "Drop").await;
    let (a, b) = (png(8), png(9));
    assert_eq!(
        put(&srv, &token, &keep, &hash(&a), a.clone(), "image/png")
            .await
            .status,
        201
    );
    assert_eq!(
        put(&srv, &token, &drop_me, &hash(&b), b.clone(), "image/png")
            .await
            .status,
        201
    );
    assert_eq!(
        srv.api(
            "DELETE",
            &format!("/api/files/{drop_me}"),
            Some(&token),
            None
        )
        .await
        .0,
        200
    );
    let server = srv.server.as_ref().unwrap();
    // Within the grace period nothing goes.
    assert_eq!(
        server
            .sweep_unreferenced_assets(Duration::from_secs(3600))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        server
            .sweep_unreferenced_assets(Duration::ZERO)
            .await
            .unwrap(),
        1
    );
    let dir = srv.assets_dir();
    assert!(dir.join(&hash(&a)[..2]).join(hash(&a)).exists());
    assert!(!dir.join(&hash(&b)[..2]).join(hash(&b)).exists());
    assert_eq!(get(&srv, "GET", &token, &keep, &hash(&a)).await.body, a);
    srv.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cors_preflight_allows_put_and_head() {
    let srv = TestServer::start().await;
    let res = srv
        .raw(
            "OPTIONS",
            "/api/files/x/assets/y",
            &[
                ("origin", "app://renderer"),
                ("access-control-request-method", "PUT"),
                (
                    "access-control-request-headers",
                    "authorization, content-type",
                ),
            ],
            None,
        )
        .await;
    assert_eq!(res.status, 200);
    let methods = res
        .header("access-control-allow-methods")
        .unwrap_or_default();
    assert!(
        methods.contains("PUT") && methods.contains("HEAD"),
        "{methods}"
    );
}
