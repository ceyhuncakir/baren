//! Teams, members, invites and file permissions.

mod common;

use common::TestServer;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn invite_accept_and_members() {
    let srv = TestServer::start().await;
    let (alice, alice_id) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let (bob, bob_id) = srv.sign_up("Defne Aydın", "defne@example.com").await;
    let team = srv.first_team(&alice).await;

    // Admin creates a single-use editor invite.
    let (status, invite) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&alice),
            Some(json!({ "role": "editor", "maxUses": 1, "expiresInDays": 7, "email": "defne@example.com" })),
        )
        .await;
    assert_eq!(status, 200, "{invite}");
    let token = invite["token"].as_str().unwrap().to_string();
    assert_eq!(
        invite["url"],
        format!("http://{}/i/{token}", srv.addr).as_str()
    );
    assert_eq!(invite["role"], "editor");

    // Pending invites are listed for the team (without tokens).
    let (status, list) = srv
        .api(
            "GET",
            &format!("/api/teams/{team}/invites"),
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["email"], "defne@example.com");
    assert_eq!(list[0]["invitedBy"], "ceyhun cakir");
    assert!(list[0].get("token").is_none());

    // Preview works without signing in.
    let (status, preview) = srv
        .api("GET", &format!("/api/invites/{token}"), None, None)
        .await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["teamName"], "ceyhun's Team");
    assert_eq!(preview["inviterName"], "ceyhun cakir");
    assert_eq!(preview["role"], "editor");
    assert_eq!(preview["memberCount"], 1);

    // The landing page links into the desktop app.
    let page = srv.raw("GET", &format!("/i/{token}"), &[], None).await;
    assert_eq!(page.status, 200);
    let html = page.text();
    assert!(html.contains(&format!("baren://invite/{token}")));
    assert!(html.contains("Open in Baren"));
    assert!(html.contains("ceyhun&#39;s Team"));

    // Accept.
    let (status, accepted) = srv
        .api(
            "POST",
            &format!("/api/invites/{token}/accept"),
            Some(&bob),
            None,
        )
        .await;
    assert_eq!(status, 200, "{accepted}");
    assert_eq!(accepted["alreadyMember"], false);
    assert_eq!(accepted["team"]["id"], team.as_str());
    assert_eq!(accepted["team"]["role"], "editor");
    assert_eq!(accepted["team"]["memberCount"], 2);

    // Accepting again is idempotent and does not consume a use.
    let (status, again) = srv
        .api(
            "POST",
            &format!("/api/invites/{token}/accept"),
            Some(&bob),
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(again["alreadyMember"], true);

    // Both see both members.
    for viewer in [&alice, &bob] {
        let (status, members) = srv
            .api(
                "GET",
                &format!("/api/teams/{team}/members"),
                Some(viewer),
                None,
            )
            .await;
        assert_eq!(status, 200, "{members}");
        let members = members.as_array().unwrap();
        assert_eq!(members.len(), 2);
        let roles: Vec<(&str, &str)> = members
            .iter()
            .map(|m| (m["userId"].as_str().unwrap(), m["role"].as_str().unwrap()))
            .collect();
        assert!(roles.contains(&(alice_id.as_str(), "admin")));
        assert!(roles.contains(&(bob_id.as_str(), "editor")));
        assert!(members.iter().all(|m| m["lastSeenAt"].is_i64()));
    }
    let (_, bob_teams) = srv.api("GET", "/api/teams", Some(&bob), None).await;
    assert_eq!(
        bob_teams.as_array().unwrap().len(),
        2,
        "own team + joined team"
    );

    // The single use is gone for a third person.
    let (carol, _) = srv.sign_up("Mert", "mert@example.com").await;
    let (status, body) = srv
        .api(
            "POST",
            &format!("/api/invites/{token}/accept"),
            Some(&carol),
            None,
        )
        .await;
    assert_eq!(status, 410);
    assert_eq!(body["error"]["code"], "invite_used_up");
}

#[tokio::test(flavor = "multi_thread")]
async fn invite_revoke_and_role_rules() {
    let srv = TestServer::start().await;
    let (admin, admin_id) = srv.sign_up("Admin", "admin@example.com").await;
    let (viewer, viewer_id) = srv.sign_up("Viewer", "viewer@example.com").await;
    let team = srv.first_team(&admin).await;

    let (_, invite) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&admin),
            Some(json!({ "role": "viewer" })),
        )
        .await;
    let token = invite["token"].as_str().unwrap().to_string();
    srv.api(
        "POST",
        &format!("/api/invites/{token}/accept"),
        Some(&viewer),
        None,
    )
    .await;

    // Viewers cannot invite, rename the team or create files.
    let (status, _) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&viewer),
            Some(json!({ "role": "viewer" })),
        )
        .await;
    assert_eq!(status, 403);
    let (status, _) = srv
        .api(
            "PATCH",
            &format!("/api/teams/{team}"),
            Some(&viewer),
            Some(json!({ "name": "Mine now" })),
        )
        .await;
    assert_eq!(status, 403);
    let (status, _) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/files"),
            Some(&viewer),
            Some(json!({ "name": "Nope" })),
        )
        .await;
    assert_eq!(status, 403);

    // Admin renames the team and changes file access.
    let (status, renamed) = srv
        .api(
            "PATCH",
            &format!("/api/teams/{team}"),
            Some(&admin),
            Some(json!({ "name": "baren", "fileAccess": "link" })),
        )
        .await;
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(renamed["name"], "baren");
    assert_eq!(renamed["fileAccess"], "link");

    // The last admin cannot be demoted or removed.
    let (status, body) = srv
        .api(
            "PATCH",
            &format!("/api/teams/{team}/members/{admin_id}"),
            Some(&admin),
            Some(json!({ "role": "editor" })),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(body["error"]["code"], "last_admin");

    // Promote the viewer, then the original admin may step down.
    let (status, _) = srv
        .api(
            "PATCH",
            &format!("/api/teams/{team}/members/{viewer_id}"),
            Some(&admin),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(status, 200);
    let (status, _) = srv
        .api(
            "DELETE",
            &format!("/api/teams/{team}/members/{admin_id}"),
            Some(&admin),
            None,
        )
        .await;
    assert_eq!(status, 200, "leaving the team");
    let (status, _) = srv
        .api(
            "GET",
            &format!("/api/teams/{team}/members"),
            Some(&admin),
            None,
        )
        .await;
    assert_eq!(status, 404, "no longer a member");

    // New admin revokes a fresh invite; preview and accept then fail with 410.
    let (_, invite) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&viewer),
            Some(json!({ "role": "editor" })),
        )
        .await;
    let token = invite["token"].as_str().unwrap().to_string();
    let id = invite["id"].as_str().unwrap().to_string();
    let (status, _) = srv
        .api("DELETE", &format!("/api/invites/{id}"), Some(&viewer), None)
        .await;
    assert_eq!(status, 200);
    let (status, body) = srv
        .api("GET", &format!("/api/invites/{token}"), None, None)
        .await;
    assert_eq!(status, 410);
    assert_eq!(body["error"]["code"], "invite_revoked");
    let (status, _) = srv
        .api(
            "POST",
            &format!("/api/invites/{token}/accept"),
            Some(&admin),
            None,
        )
        .await;
    assert_eq!(status, 410);
    let page = srv.raw("GET", &format!("/i/{token}"), &[], None).await;
    assert_eq!(page.status, 410);
    assert!(page.text().contains("revoked"));

    // Unknown tokens are 404.
    let (status, body) = srv.api("GET", "/api/invites/nope", None, None).await;
    assert_eq!(status, 404);
    assert_eq!(body["error"]["code"], "invite_not_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn files_are_scoped_to_teams() {
    let srv = TestServer::start().await;
    let (alice, _) = srv.sign_up("Alice", "alice@example.com").await;
    let (eve, _) = srv.sign_up("Eve", "eve@example.com").await;
    let team = srv.first_team(&alice).await;

    let file = srv.create_file(&alice, &team, "Cloud posture").await;
    let (status, files) = srv
        .api(
            "GET",
            &format!("/api/teams/{team}/files"),
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(files[0]["id"], file.as_str());
    assert_eq!(files[0]["name"], "Cloud posture");
    assert_eq!(files[0]["archived"], false);

    // An outsider sees neither the list nor the file.
    let (status, _) = srv
        .api("GET", &format!("/api/teams/{team}/files"), Some(&eve), None)
        .await;
    assert_eq!(status, 404);
    let (status, _) = srv
        .api(
            "GET",
            &format!("/api/files/{file}/snapshot"),
            Some(&eve),
            None,
        )
        .await;
    assert_eq!(status, 403);
    let (status, _) = srv
        .api(
            "GET",
            "/api/files/does-not-exist/snapshot",
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(status, 404);

    // A new file's snapshot is a valid (empty) Loro document.
    let res = srv
        .raw(
            "GET",
            &format!("/api/files/{file}/snapshot"),
            &[("authorization", &format!("Bearer {alice}"))],
            None,
        )
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("application/octet-stream"));
    let doc = loro::LoroDoc::new();
    doc.import(&res.body).expect("valid snapshot");

    // Creating with an initial snapshot; invalid bytes are rejected.
    let seed = loro::LoroDoc::new();
    seed.get_map("meta").insert("name", "Seeded").unwrap();
    seed.commit();
    let snapshot = seed.export(loro::ExportMode::Snapshot).unwrap();
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&snapshot);
    let (status, created) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/files"),
            Some(&alice),
            Some(json!({ "name": "Seeded", "snapshot": b64 })),
        )
        .await;
    assert_eq!(status, 200, "{created}");
    let (status, body) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/files"),
            Some(&alice),
            Some(json!({ "name": "Broken", "snapshot": "aGVsbG8=" })),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "invalid_snapshot");

    // Archive + rename.
    let (status, updated) = srv
        .api(
            "PATCH",
            &format!("/api/files/{file}"),
            Some(&alice),
            Some(json!({ "archived": true, "name": "Old posture" })),
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["archived"], true);
    assert_eq!(updated["name"], "Old posture");

    // With "anyone with the link", outsiders can view but not edit.
    srv.api(
        "PATCH",
        &format!("/api/teams/{team}"),
        Some(&alice),
        Some(json!({ "fileAccess": "link" })),
    )
    .await;
    let (status, _) = srv
        .api(
            "GET",
            &format!("/api/files/{file}/snapshot"),
            Some(&eve),
            None,
        )
        .await;
    assert_eq!(status, 200);
    let (status, _) = srv
        .api(
            "PATCH",
            &format!("/api/files/{file}"),
            Some(&eve),
            Some(json!({ "name": "pwned" })),
        )
        .await;
    assert_eq!(status, 403);

    // Delete.
    let (status, _) = srv
        .api("DELETE", &format!("/api/files/{file}"), Some(&alice), None)
        .await;
    assert_eq!(status, 200);
    let (status, _) = srv
        .api(
            "GET",
            &format!("/api/files/{file}/snapshot"),
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(status, 404);
}
