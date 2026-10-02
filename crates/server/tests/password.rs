//! Password reset (`/api/auth/password/forgot` + `/reset`), change, and `/api/auth/providers`.

mod common;

use std::sync::Arc;

use baren_server::MemoryMailer;
use common::{Peer, TestServer};
use loro::LoroDoc;
use serde_json::json;

const PASSWORD: &str = "correct horse battery";

async fn forgot(srv: &TestServer, email: &str) -> (u16, serde_json::Value) {
    srv.api(
        "POST",
        "/api/auth/password/forgot",
        None,
        Some(json!({ "email": email })),
    )
    .await
}

async fn reset(
    srv: &TestServer,
    email: &str,
    code: &str,
    password: &str,
) -> (u16, serde_json::Value) {
    srv.api(
        "POST",
        "/api/auth/password/reset",
        None,
        Some(json!({ "email": email, "code": code, "password": password })),
    )
    .await
}

async fn login(srv: &TestServer, email: &str, password: &str) -> (u16, serde_json::Value) {
    srv.api(
        "POST",
        "/api/auth/login",
        None,
        Some(json!({ "email": email, "password": password })),
    )
    .await
}

fn wrong_code(code: &str) -> &'static str {
    if code == "000000" {
        "111111"
    } else {
        "000000"
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn providers_reports_real_email_delivery() {
    let srv = TestServer::start().await;
    let (status, body) = srv.api("GET", "/api/auth/providers", None, None).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "email": false }));

    let delivering = MemoryMailer::delivering();
    let srv = TestServer::start_with_mailer(|_| {}, delivering.clone(), Arc::new(delivering)).await;
    let (_, body) = srv.api("GET", "/api/auth/providers", None, None).await;
    assert_eq!(body, json!({ "email": true }));
}

#[tokio::test(flavor = "multi_thread")]
async fn forgot_answers_204_and_only_mails_existing_accounts() {
    let srv = TestServer::start().await;
    let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;

    let (status, body) = forgot(&srv, "nobody@example.com").await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(body, serde_json::Value::Null);
    assert_eq!(srv.mailer.count("nobody@example.com", "password_reset"), 0);

    let (status, _) = forgot(&srv, "  Ceyhun@Example.COM ").await;
    assert_eq!(status, 204);
    let code = srv
        .mailer
        .last_reset_code_for("ceyhun@example.com")
        .expect("reset code mailed");
    assert_eq!(code.len(), 6);
    assert!(code.bytes().all(|b| b.is_ascii_digit()));

    // Within the 30 s cooldown: still 204, no second email, the first code stays valid.
    let (status, _) = forgot(&srv, "ceyhun@example.com").await;
    assert_eq!(status, 204);
    assert_eq!(srv.mailer.count("ceyhun@example.com", "password_reset"), 1);

    // Requesting a reset does not touch the account: the old password and session still work.
    assert_eq!(login(&srv, "ceyhun@example.com", PASSWORD).await.0, 200);
    assert_eq!(srv.api("GET", "/api/me", Some(&token), None).await.0, 200);

    // Garbage is a 400, not a 204.
    let (status, body) = forgot(&srv, "not-an-email").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_email");
}

#[tokio::test(flavor = "multi_thread")]
async fn forgot_is_rate_limited_per_address() {
    let srv = TestServer::start().await;
    for _ in 0..5 {
        assert_eq!(forgot(&srv, "spam@example.com").await.0, 204);
    }
    let (status, body) = forgot(&srv, "spam@example.com").await;
    assert_eq!(status, 429);
    assert_eq!(body["error"]["code"], "rate_limited");
    // Other addresses are unaffected.
    assert_eq!(forgot(&srv, "other@example.com").await.0, 204);
}

#[tokio::test(flavor = "multi_thread")]
async fn reset_sets_the_password_and_revokes_every_session() {
    let srv = TestServer::start().await;
    let email = "ceyhun@example.com";
    let (old_token, user_id) = srv.sign_up("ceyhun cakir", email).await;
    let (status, second) = login(&srv, email, PASSWORD).await;
    assert_eq!(status, 200);
    let second_token = second["token"].as_str().unwrap().to_string();

    // A live connection with the old session, to see it closed.
    let team = srv.first_team(&old_token).await;
    let file = srv.create_file(&old_token, &team, "Doc").await;
    let mut peer = Peer::connect_ok(&srv.ws_url(&file, Some(&old_token)), LoroDoc::new()).await;

    assert_eq!(forgot(&srv, email).await.0, 204);
    let code = srv.mailer.last_reset_code_for(email).unwrap();

    // Validation before the code is checked.
    let (status, body) = reset(&srv, email, &code, "short").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "weak_password");
    let (status, body) = reset(&srv, email, "12", "new password 1").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_code");
    // Unknown accounts look exactly like wrong codes.
    let (status, body) = reset(&srv, "nobody@example.com", &code, "new password 1").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_code");

    let (status, body) = reset(&srv, email, wrong_code(&code), "new password 1").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_code");

    // The right code, formatted like the UI shows it.
    let shown = format!("{} {}", &code[..3], &code[3..]);
    let (status, body) = reset(&srv, email, &shown, "new password 1").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["user"]["id"], user_id.as_str());
    assert_eq!(body["user"]["email"], email);
    let new_token = body["token"].as_str().unwrap().to_string();

    // Every earlier session is gone, and its socket was closed with 4401.
    for token in [&old_token, &second_token] {
        let (status, body) = srv.api("GET", "/api/me", Some(token), None).await;
        assert_eq!(status, 401, "{body}");
    }
    assert_eq!(peer.closed().await, 4401);
    assert_eq!(
        srv.api("GET", "/api/me", Some(&new_token), None).await.0,
        200
    );

    // The new password works, the old one does not, and the code is single-use.
    assert_eq!(login(&srv, email, PASSWORD).await.0, 401);
    assert_eq!(login(&srv, email, "new password 1").await.0, 200);
    let (status, body) = reset(&srv, email, &code, "another password").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_code");
}

#[tokio::test(flavor = "multi_thread")]
async fn reset_verifies_an_unverified_email() {
    let srv = TestServer::start().await;
    let email = "pending@example.com";
    let (status, _) = srv
        .api(
            "POST",
            "/api/auth/register",
            None,
            Some(json!({ "name": "Pending Person", "email": email, "password": PASSWORD })),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        login(&srv, email, PASSWORD).await.1["error"]["code"],
        "email_not_verified"
    );

    assert_eq!(forgot(&srv, email).await.0, 204);
    let code = srv.mailer.last_reset_code_for(email).unwrap();
    let (status, body) = reset(&srv, email, &code, "brand new password").await;
    assert_eq!(status, 200, "{body}");
    // The emailed code proved the address: login works without the verification step.
    assert_eq!(login(&srv, email, "brand new password").await.0, 200);
    // And the pending verification code is gone.
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/verify",
            None,
            Some(json!({ "email": email, "code": srv.mailer.last_code_for(email).unwrap() })),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "already_verified");
}

#[tokio::test(flavor = "multi_thread")]
async fn reset_codes_allow_five_attempts_and_expire() {
    let srv = TestServer::start().await;
    let email = "ceyhun@example.com";
    srv.sign_up("ceyhun cakir", email).await;
    assert_eq!(forgot(&srv, email).await.0, 204);
    let code = srv.mailer.last_reset_code_for(email).unwrap();
    for _ in 0..5 {
        let (status, body) = reset(&srv, email, wrong_code(&code), "new password 1").await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (400, Some("invalid_code"))
        );
    }
    // Even the right code is refused now: a new one is needed.
    let (status, body) = reset(&srv, email, &code, "new password 1").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "too_many_attempts");

    // A new code (after the cooldown) resets the counter; an expired one is refused.
    let db = srv.db().await;
    sqlx::query("UPDATE password_resets SET created_at = created_at - 60000")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(forgot(&srv, email).await.0, 204);
    assert_eq!(srv.mailer.count(email, "password_reset"), 2);
    let code = srv.mailer.last_reset_code_for(email).unwrap();
    sqlx::query("UPDATE password_resets SET expires_at = 1")
        .execute(&db)
        .await
        .unwrap();
    let (status, body) = reset(&srv, email, &code, "new password 1").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "code_expired");
    assert_eq!(login(&srv, email, PASSWORD).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn change_password_needs_the_current_one_and_keeps_this_session() {
    let srv = TestServer::start().await;
    let email = "ceyhun@example.com";
    let (token, _) = srv.sign_up("ceyhun cakir", email).await;
    let other = login(&srv, email, PASSWORD).await.1["token"]
        .as_str()
        .unwrap()
        .to_string();
    let change = |body: serde_json::Value| {
        let token = token.clone();
        let srv = &srv;
        async move {
            srv.api(
                "POST",
                "/api/auth/password/change",
                Some(&token),
                Some(body),
            )
            .await
        }
    };

    let (status, _) = srv
        .api(
            "POST",
            "/api/auth/password/change",
            None,
            Some(json!({ "currentPassword": PASSWORD, "newPassword": "new password 1" })),
        )
        .await;
    assert_eq!(status, 401);

    let (status, body) = change(json!({ "newPassword": "new password 1" })).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "current_password_required");

    // A wrong current password is a 400 (not 401: the session itself is fine).
    let (status, body) =
        change(json!({ "currentPassword": "wrong password", "newPassword": "new password 1" }))
            .await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_credentials");

    let (status, body) =
        change(json!({ "currentPassword": PASSWORD, "newPassword": "short" })).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "weak_password");

    let (status, body) =
        change(json!({ "currentPassword": PASSWORD, "newPassword": "new password 1" })).await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(srv.api("GET", "/api/me", Some(&token), None).await.0, 200);
    assert_eq!(srv.api("GET", "/api/me", Some(&other), None).await.0, 401);
    assert_eq!(login(&srv, email, PASSWORD).await.0, 401);
    assert_eq!(login(&srv, email, "new password 1").await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_out_closes_only_that_sessions_sockets() {
    let srv = TestServer::start().await;
    let email = "ceyhun@example.com";
    let (token, _) = srv.sign_up("ceyhun cakir", email).await;
    let other = login(&srv, email, PASSWORD).await.1["token"]
        .as_str()
        .unwrap()
        .to_string();
    let team = srv.first_team(&token).await;
    let file = srv.create_file(&token, &team, "Doc").await;
    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await;
    let mut b = Peer::connect_ok(&srv.ws_url(&file, Some(&other)), LoroDoc::new()).await;

    assert_eq!(
        srv.api("POST", "/api/auth/logout", Some(&token), None)
            .await
            .0,
        200
    );
    assert_eq!(a.closed().await, 4401);
    // The other session's socket is still in sync.
    b.resync().await;
    b.close().await;
}
