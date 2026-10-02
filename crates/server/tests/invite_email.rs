//! Invite emails: `POST /api/teams/:id/invites` with an `email`, and
//! `POST /api/invites/:id/resend`.

mod common;

use baren_proto::dto::Role;
use baren_server::Email;
use common::TestServer;
use serde_json::{json, Value};

async fn invite(srv: &TestServer, token: &str, team: &str, body: Value) -> (u16, Value) {
    srv.api(
        "POST",
        &format!("/api/teams/{team}/invites"),
        Some(token),
        Some(body),
    )
    .await
}

async fn join(srv: &TestServer, admin: &str, team: &str, who: &str, role: &str) {
    let (status, created) = invite(srv, admin, team, json!({ "role": role })).await;
    assert_eq!(status, 200, "{created}");
    let token = created["token"].as_str().unwrap();
    let (status, body) = srv
        .api(
            "POST",
            &format!("/api/invites/{token}/accept"),
            Some(who),
            None,
        )
        .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn email_invites_are_mailed_with_team_details() {
    let srv = TestServer::start().await;
    let (alice, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&alice).await;

    // A link-only invite sends nothing.
    let (status, _) = invite(&srv, &alice, &team, json!({ "role": "viewer" })).await;
    assert_eq!(status, 200);
    assert!(srv.mailer.sent().iter().all(|e| e.kind() != "team_invite"));

    let (status, created) = invite(
        &srv,
        &alice,
        &team,
        json!({ "role": "editor", "email": " Defne@Example.COM ", "expiresInDays": 14 }),
    )
    .await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["email"], "defne@example.com");
    let Some(Email::TeamInvite {
        to,
        inviter_name,
        inviter_email,
        team_name,
        member_count,
        role,
        url,
        expires_at,
    }) = srv.mailer.last_invite_for("defne@example.com")
    else {
        panic!("no invite email");
    };
    assert_eq!(to, "defne@example.com");
    assert_eq!(inviter_name, "ceyhun cakir");
    assert_eq!(inviter_email, "ceyhun@example.com");
    assert_eq!(team_name, "ceyhun's Team");
    assert_eq!(member_count, 1);
    assert_eq!(role, Role::Editor);
    assert_eq!(url, created["url"].as_str().unwrap());
    assert_eq!(expires_at, created["expiresAt"].as_i64());
}

#[tokio::test(flavor = "multi_thread")]
async fn resend_rotates_the_link_and_checks_permissions() {
    let srv = TestServer::start().await;
    let (alice, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let (bob, _) = srv.sign_up("Bob Editor", "bob@example.com").await;
    let (vera, _) = srv.sign_up("Vera Viewer", "vera@example.com").await;
    let (outsider, _) = srv.sign_up("Out Sider", "out@example.com").await;
    let team = srv.first_team(&alice).await;
    join(&srv, &alice, &team, &bob, "editor").await;
    join(&srv, &alice, &team, &vera, "viewer").await;

    let (_, by_alice) = invite(
        &srv,
        &alice,
        &team,
        json!({ "role": "viewer", "email": "x@example.com" }),
    )
    .await;
    let id = by_alice["id"].as_str().unwrap().to_string();
    let resend = |token: String, id: String| {
        let srv = &srv;
        async move {
            srv.api(
                "POST",
                &format!("/api/invites/{id}/resend"),
                Some(&token),
                None,
            )
            .await
        }
    };

    // Non-members do not see it; viewers and editors who did not create it may not resend.
    assert_eq!(resend(outsider.clone(), id.clone()).await.0, 404);
    assert_eq!(resend(vera.clone(), id.clone()).await.0, 403);
    assert_eq!(resend(bob.clone(), id.clone()).await.0, 403);
    assert_eq!(resend(alice.clone(), "nope".into()).await.0, 404);
    assert_eq!(
        srv.api("POST", &format!("/api/invites/{id}/resend"), None, None)
            .await
            .0,
        401
    );

    let (status, resent) = resend(alice.clone(), id.clone()).await;
    assert_eq!(status, 200, "{resent}");
    assert_eq!(resent["id"], id.as_str());
    assert_eq!(resent["email"], "x@example.com");
    assert_eq!(resent["expiresAt"], by_alice["expiresAt"]);
    assert_ne!(resent["token"], by_alice["token"]);
    assert_eq!(srv.mailer.count("x@example.com", "team_invite"), 2);
    assert_eq!(
        srv.mailer.last_invite_for("x@example.com").unwrap().url(),
        resent["url"].as_str()
    );
    // The old link is dead, the new one works.
    let old = by_alice["token"].as_str().unwrap();
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

    // One re-send per minute.
    let (status, body) = resend(alice.clone(), id.clone()).await;
    assert_eq!(status, 429, "{body}");

    // An editor may resend their own invite.
    let (_, by_bob) = invite(
        &srv,
        &bob,
        &team,
        json!({ "role": "viewer", "email": "y@example.com" }),
    )
    .await;
    let bob_invite = by_bob["id"].as_str().unwrap().to_string();
    assert_eq!(resend(bob.clone(), bob_invite).await.0, 200);

    // Link-only, revoked and used-up invites cannot be re-sent.
    let (_, link) = invite(&srv, &alice, &team, json!({ "role": "viewer" })).await;
    let (status, body) = resend(alice.clone(), link["id"].as_str().unwrap().into()).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invite_has_no_email");

    let (_, revoked) = invite(
        &srv,
        &alice,
        &team,
        json!({ "role": "viewer", "email": "z@example.com" }),
    )
    .await;
    let revoked_id = revoked["id"].as_str().unwrap().to_string();
    assert_eq!(
        srv.api(
            "DELETE",
            &format!("/api/invites/{revoked_id}"),
            Some(&alice),
            None
        )
        .await
        .0,
        200
    );
    let (status, body) = resend(alice.clone(), revoked_id).await;
    assert_eq!(status, 410);
    assert_eq!(body["error"]["code"], "invite_revoked");

    let (_, single) = invite(
        &srv,
        &alice,
        &team,
        json!({ "role": "viewer", "email": "out@example.com", "maxUses": 1 }),
    )
    .await;
    let token = single["token"].as_str().unwrap();
    assert_eq!(
        srv.api(
            "POST",
            &format!("/api/invites/{token}/accept"),
            Some(&outsider),
            None
        )
        .await
        .0,
        200
    );
    let (status, body) = resend(alice.clone(), single["id"].as_str().unwrap().into()).await;
    assert_eq!(status, 410);
    assert_eq!(body["error"]["code"], "invite_used_up");
}

#[tokio::test(flavor = "multi_thread")]
async fn invite_emails_are_rate_limited_per_sender() {
    let srv = TestServer::start().await;
    let (alice, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&alice).await;
    for i in 0..30 {
        let (status, body) = invite(
            &srv,
            &alice,
            &team,
            json!({ "role": "viewer", "email": format!("guest{i}@example.com") }),
        )
        .await;
        assert_eq!(status, 200, "{body}");
    }
    let (status, body) = invite(
        &srv,
        &alice,
        &team,
        json!({ "role": "viewer", "email": "one-more@example.com" }),
    )
    .await;
    assert_eq!(status, 429, "{body}");
    // Link invites (no email) are not limited by this.
    let (status, _) = invite(&srv, &alice, &team, json!({ "role": "viewer" })).await;
    assert_eq!(status, 200);
}
