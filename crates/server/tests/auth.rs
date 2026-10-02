//! Accounts: register → verify → login, session handling, error shapes.

mod common;

use common::TestServer;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn register_verify_login_logout() {
    let srv = TestServer::start().await;
    let email = "ceyhun@example.com";

    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/register",
            None,
            Some(json!({ "name": "ceyhun cakir", "email": "  Ceyhun@Example.COM ", "password": "correct horse battery" })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["needsVerification"], true);
    assert!(body["userId"].is_string());

    // Not verified yet: login is refused with a dedicated code.
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({ "email": email, "password": "correct horse battery" })),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["code"], "email_not_verified");

    // A wrong code is rejected and counted.
    let code = srv.mailer.last_code_for(email).unwrap();
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/verify",
            None,
            Some(json!({ "email": email, "code": wrong })),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_code");

    // The right code (formatted like the UI shows it) verifies and signs in.
    let shown = format!("{}-{}", &code[..3], &code[3..]);
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/verify",
            None,
            Some(json!({ "email": email, "code": shown })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let token = body["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 43);
    assert_eq!(body["user"]["email"], email);
    assert_eq!(body["user"]["name"], "ceyhun cakir");

    // /api/me returns the user and the team created at registration.
    let (status, me) = srv.api("GET", "/api/me", Some(&token), None).await;
    assert_eq!(status, 200);
    assert_eq!(me["user"]["email"], email);
    assert_eq!(me["teams"].as_array().unwrap().len(), 1);
    assert_eq!(me["teams"][0]["name"], "ceyhun's Team");
    assert_eq!(me["teams"][0]["role"], "admin");
    assert_eq!(me["teams"][0]["memberCount"], 1);
    assert_eq!(me["teams"][0]["fileAccess"], "members");

    // Password login.
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({ "email": email, "password": "wrong password" })),
        )
        .await;
    assert_eq!(status, 401);
    assert_eq!(body["error"]["code"], "invalid_credentials");
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({ "email": email, "password": "correct horse battery" })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let token2 = body["token"].as_str().unwrap().to_string();
    assert_ne!(token, token2);

    // Logging out revokes only that session.
    let (status, _) = srv
        .api("POST", "/api/auth/logout", Some(&token2), None)
        .await;
    assert_eq!(status, 200);
    let (status, body) = srv.api("GET", "/api/me", Some(&token2), None).await;
    assert_eq!(status, 401);
    assert_eq!(body["error"]["code"], "unauthorized");
    let (status, _) = srv.api("GET", "/api/me", Some(&token), None).await;
    assert_eq!(status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_and_invalid_registrations() {
    let srv = TestServer::start().await;
    srv.sign_up("Defne Aydın", "defne@example.com").await;

    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/register",
            None,
            Some(json!({ "name": "Someone", "email": "DEFNE@example.com", "password": "another password" })),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(body["error"]["code"], "email_taken");

    for (payload, code) in [
        (
            json!({ "name": "", "email": "a@b.co", "password": "long enough" }),
            "invalid_name",
        ),
        (
            json!({ "name": "A", "email": "nope", "password": "long enough" }),
            "invalid_email",
        ),
        (
            json!({ "name": "A", "email": "a@b.co", "password": "short" }),
            "weak_password",
        ),
    ] {
        let (status, body) = srv
            .api("POST", "/api/auth/register", None, Some(payload))
            .await;
        assert_eq!(status, 400);
        assert_eq!(body["error"]["code"], code);
    }

    // Malformed JSON uses the same error shape.
    let res = srv
        .raw(
            "POST",
            "/api/auth/login",
            &[("content-type", "application/json")],
            Some(b"{not json".to_vec()),
        )
        .await;
    assert_eq!(res.status, 400);
    assert!(res.text().contains("invalid_body"));
}

#[tokio::test(flavor = "multi_thread")]
async fn verification_code_attempts_are_limited() {
    let srv = TestServer::start().await;
    let email = "mert@example.com";
    srv.api(
        "POST",
        "/api/auth/register",
        None,
        Some(json!({ "name": "Mert", "email": email, "password": "long enough" })),
    )
    .await;
    let code = srv.mailer.last_code_for(email).unwrap();
    let wrong = if code == "999999" { "888888" } else { "999999" };
    for _ in 0..5 {
        let (status, _) = srv
            .api(
                "POST",
                "/api/auth/verify",
                None,
                Some(json!({ "email": email, "code": wrong })),
            )
            .await;
        assert_eq!(status, 400);
    }
    // Even the right code is refused once the attempts are used up.
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/verify",
            None,
            Some(json!({ "email": email, "code": code })),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "too_many_attempts");

    // Re-registering issues a fresh code that works.
    srv.api(
        "POST",
        "/api/auth/register",
        None,
        Some(json!({ "name": "Mert", "email": email, "password": "long enough" })),
    )
    .await;
    let fresh = srv.mailer.last_code_for(email).unwrap();
    let (status, body) = srv
        .api(
            "POST",
            "/api/auth/verify",
            None,
            Some(json!({ "email": email, "code": fresh })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn protected_endpoints_require_a_session() {
    let srv = TestServer::start().await;
    for (method, path) in [
        ("GET", "/api/me"),
        ("GET", "/api/teams"),
        ("POST", "/api/teams"),
        ("GET", "/api/teams/x/members"),
        ("GET", "/api/teams/x/files"),
        ("GET", "/api/files/x/snapshot"),
        ("POST", "/api/invites/x/accept"),
    ] {
        let (status, body) = srv.api(method, path, None, None).await;
        assert_eq!(status, 401, "{method} {path}: {body}");
        let (status, _) = srv.api(method, path, Some("not-a-real-token"), None).await;
        assert_eq!(status, 401, "{method} {path} with a bogus token");
    }
    let (status, body) = srv.api("GET", "/api/nope", None, None).await;
    assert_eq!(status, 404);
    assert_eq!(body["error"]["code"], "not_found");
    let res = srv.raw("GET", "/health", &[], None).await;
    assert_eq!((res.status, res.text().as_str()), (200, "ok"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cors_allows_the_electron_renderer() {
    let srv = TestServer::start().await;
    let res = srv
        .raw(
            "OPTIONS",
            "/api/me",
            &[
                ("origin", "app://renderer"),
                ("access-control-request-method", "GET"),
                ("access-control-request-headers", "authorization"),
            ],
            None,
        )
        .await;
    assert_eq!(
        res.header("access-control-allow-origin"),
        Some("app://renderer")
    );
    let res = srv
        .raw(
            "OPTIONS",
            "/api/me",
            &[
                ("origin", "https://evil.example"),
                ("access-control-request-method", "GET"),
            ],
            None,
        )
        .await;
    assert_eq!(res.header("access-control-allow-origin"), None);
}
