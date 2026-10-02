//! Live rooms over WebSocket: handshake, concurrent edits, presence, permissions,
//! persistence across room unloads and server restarts.

mod common;

use std::time::Duration;

use common::{frame, Outcome, Peer, TestServer};
use loro::LoroDoc;
use serde_json::json;

async fn setup() -> (TestServer, String, String, String) {
    let srv = TestServer::start_with(|c| {
        c.room_idle = Duration::from_millis(300);
    })
    .await;
    let (alice, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let (bob, _) = srv.sign_up("Defne Aydın", "defne@example.com").await;
    let team = srv.first_team(&alice).await;
    let (_, invite) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&alice),
            Some(json!({ "role": "editor" })),
        )
        .await;
    let token = invite["token"].as_str().unwrap();
    srv.api(
        "POST",
        &format!("/api/invites/{token}/accept"),
        Some(&bob),
        None,
    )
    .await;
    let file = srv.create_file(&alice, &team, "Shared").await;
    (srv, alice, bob, file)
}

fn deep(doc: &LoroDoc) -> serde_json::Value {
    serde_json::to_value(doc.get_deep_value()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn two_clients_edit_concurrently_and_converge() {
    let (srv, alice, bob, file) = setup().await;

    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), LoroDoc::new()).await;
    let mut b = Peer::connect_ok(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await;
    assert_eq!(a.welcome.as_ref().unwrap()["role"], "admin");
    assert_eq!(b.welcome.as_ref().unwrap()["role"], "editor");

    // Concurrent edits on both sides: disjoint keys, the same text, and the same tree.
    a.doc.get_map("meta").insert("name", "Shared").unwrap();
    a.doc.get_text("notes").insert(0, "hello").unwrap();
    let tree_a = a.doc.get_tree("nodes");
    tree_a.create(None).unwrap();
    b.doc
        .get_map("tokens")
        .insert("--color-primary", "#141414")
        .unwrap();
    b.doc.get_text("notes").insert(0, "world ").unwrap();
    let tree_b = b.doc.get_tree("nodes");
    tree_b.create(None).unwrap();
    a.push().await;
    b.push().await;

    let a_target = |p: &Peer| p.doc.get_map("tokens").get("--color-primary").is_some();
    let b_target = |p: &Peer| p.doc.get_map("meta").get("name").is_some();
    a.pump_until(a_target).await;
    b.pump_until(b_target).await;
    a.pump(Duration::from_millis(100)).await;
    b.pump(Duration::from_millis(100)).await;

    assert_eq!(deep(&a.doc), deep(&b.doc), "documents converge");
    assert_eq!(a.doc.get_tree("nodes").roots().len(), 2);
    let notes = a.doc.get_text("notes").to_string();
    assert!(
        notes.contains("hello") && notes.contains("world"),
        "{notes}"
    );

    // A third client joining late receives everything in the handshake.
    let c = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), LoroDoc::new()).await;
    assert_eq!(deep(&c.doc), deep(&a.doc));

    // The snapshot endpoint serves the live room's state.
    let res = srv
        .raw(
            "GET",
            &format!("/api/files/{file}/snapshot"),
            &[("authorization", &format!("Bearer {bob}"))],
            None,
        )
        .await;
    assert_eq!(res.status, 200);
    let snap = LoroDoc::new();
    snap.import(&res.body).unwrap();
    assert_eq!(deep(&snap), deep(&a.doc));

    // The file list mirrors the document's meta.name.
    let team = srv.first_team(&alice).await;
    let (_, files) = srv
        .api(
            "GET",
            &format!("/api/teams/{team}/files"),
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(files[0]["name"], "Shared");
}

#[tokio::test(flavor = "multi_thread")]
async fn offline_edits_upload_on_reconnect_and_survive_unload() {
    let (srv, alice, bob, file) = setup().await;

    // Alice edits while "offline" (before connecting); the server asks for them on join.
    let offline = LoroDoc::new();
    offline
        .get_map("meta")
        .insert("name", "Offline draft")
        .unwrap();
    offline.get_list("log").insert(0, "edit 1").unwrap();
    offline.commit();
    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), offline).await;
    a.pump(Duration::from_millis(200)).await;
    a.close().await;

    // Wait for the idle room to compact and unload.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while srv.open_rooms() > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "room did not unload"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // A new room loads the compacted document from SQLite.
    let b = Peer::connect_ok(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await;
    assert_eq!(
        b.doc
            .get_map("meta")
            .get("name")
            .unwrap()
            .into_value()
            .unwrap(),
        "Offline draft".into()
    );
    assert_eq!(b.doc.get_list("log").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn documents_survive_a_server_restart() {
    let db = std::env::temp_dir().join(format!(
        "baren-restart-{}.db",
        uuid::Uuid::new_v4().simple()
    ));
    let url = format!("sqlite://{}", db.display());
    let (token, file) = {
        let url = url.clone();
        let mut srv = TestServer::start_with(move |c| c.database_url = url).await;
        let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
        let team = srv.first_team(&token).await;
        let file = srv.create_file(&token, &team, "Durable").await;
        let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await;
        for i in 0..20 {
            a.doc.get_list("items").push(i).unwrap();
            a.push().await;
        }
        // Make sure the room processed everything, then shut down while connected.
        a.resync().await;
        srv.stop().await;
        assert!(matches!(a.closed().await, 1012 | 1006));
        (token, file)
    };
    let srv = TestServer::start_with(move |c| c.database_url = url).await;
    let b = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await;
    assert_eq!(b.doc.get_list("items").len(), 20);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn presence_relays_mcp_agents_and_drops_oversized_agent_frames() {
    let (srv, alice, bob, file) = setup().await;
    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), LoroDoc::new()).await;
    let mut b = Peer::connect_ok(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await;

    // A client without agents (an old client): the field is absent from its fan-out.
    b.send_text(json!({ "pageId": "p1", "cursor": null, "selection": [] }).to_string())
        .await;
    a.pump_until(|p| p.presence.iter().any(|m| m["type"] == "presence"))
        .await;
    let from_b = a.presence.iter().find(|m| m["type"] == "presence").unwrap();
    assert!(
        from_b.get("agents").is_none(),
        "no agents field without agents"
    );

    // Agents are relayed unchanged, next to the server-assigned identity.
    a.send_text(
        json!({ "pageId": "p1", "cursor": null, "selection": [],
                "agents": [{ "id": "k3v9q2m1x8z0", "name": "baren-e2e", "working": ["12@34", "56@34"] }] })
        .to_string(),
    )
    .await;
    b.pump_until(|p| p.presence.iter().any(|m| m.get("agents").is_some()))
        .await;
    let relayed = b
        .presence
        .iter()
        .find(|m| m.get("agents").is_some())
        .unwrap();
    assert_eq!(relayed["name"], "ceyhun cakir");
    assert_eq!(relayed["agents"][0]["id"], "k3v9q2m1x8z0");
    assert_eq!(relayed["agents"][0]["name"], "baren-e2e");
    assert_eq!(relayed["agents"][0]["working"][1], "56@34");

    // Released working sets: an empty list is omitted.
    a.send_text(
        json!({ "pageId": "released", "cursor": null, "selection": [], "agents": [] }).to_string(),
    )
    .await;
    b.pump_until(|p| p.presence.iter().any(|m| m["pageId"] == "released"))
        .await;
    let released = b
        .presence
        .iter()
        .find(|m| m["pageId"] == "released")
        .unwrap();
    assert!(released.get("agents").is_none());

    // Frames over the agent limits are dropped; the next valid frame still arrives.
    let seen = b.presence.len();
    let nine: Vec<_> = (0..9)
        .map(|i| json!({ "id": format!("a{i}"), "name": "x", "working": [] }))
        .collect();
    a.send_text(json!({ "pageId": "too-many", "selection": [], "agents": nine }).to_string())
        .await;
    a.send_text(
        json!({ "pageId": "long-name", "selection": [],
                "agents": [{ "id": "a", "name": "n".repeat(65), "working": [] }] })
        .to_string(),
    )
    .await;
    a.send_text(json!({ "pageId": "marker", "selection": [] }).to_string())
        .await;
    b.pump_until(|p| p.presence.iter().any(|m| m["pageId"] == "marker"))
        .await;
    assert!(b.presence[seen..]
        .iter()
        .all(|m| m["pageId"] != "too-many" && m["pageId"] != "long-name"));
}

#[tokio::test(flavor = "multi_thread")]
async fn presence_fans_out_with_server_assigned_identity() {
    let (srv, alice, bob, file) = setup().await;
    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), LoroDoc::new()).await;
    let mut b = Peer::connect_ok(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await;
    let a_color = a.welcome.as_ref().unwrap()["color"]
        .as_str()
        .unwrap()
        .to_string();
    let b_color = b.welcome.as_ref().unwrap()["color"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(a_color, b_color, "different users get different colours");

    // Spoofed identity fields are ignored; the server fills them in.
    a.send_text(
        json!({ "userId": "spoof", "name": "Mallory", "color": "#000000", "pageId": "p1",
                "cursor": { "x": 10.5, "y": 20.0 }, "selection": ["n1"] })
        .to_string(),
    )
    .await;
    b.pump_until(|p| p.presence.iter().any(|m| m["type"] == "presence"))
        .await;
    let p = b.presence.iter().find(|m| m["type"] == "presence").unwrap();
    assert_eq!(p["name"], "ceyhun cakir");
    assert_eq!(p["color"], a_color.as_str());
    assert_ne!(p["userId"], "spoof");
    assert_eq!(p["pageId"], "p1");
    assert_eq!(p["cursor"]["x"], 10.5);
    assert_eq!(p["selection"][0], "n1");
    assert!(p["clientId"].is_string());
    assert!(p.get("transient").is_none(), "no gesture in progress");

    // An in-progress gesture (canvas `transient`) is relayed unchanged.
    a.send_text(
        json!({ "pageId": "p1", "cursor": null, "selection": ["n1"],
                "transient": { "kind": "resize",
                               "nodes": [{ "id": "n1", "rect": { "x": 1, "y": 2, "width": 30, "height": 40 } }] } })
        .to_string(),
    )
    .await;
    b.pump_until(|p| p.presence.iter().any(|m| m.get("transient").is_some()))
        .await;
    let t = &b
        .presence
        .iter()
        .find(|m| m.get("transient").is_some())
        .unwrap()["transient"];
    assert_eq!(t["kind"], "resize");
    assert_eq!(t["nodes"][0]["id"], "n1");
    assert_eq!(t["nodes"][0]["rect"]["height"], 40.0);

    // A late joiner gets the current presence right away.
    let c = Peer::connect_ok(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await;
    assert!(c
        .presence
        .iter()
        .any(|m| m["type"] == "presence" && m["name"] == "ceyhun cakir"));
    assert_eq!(
        c.welcome.as_ref().unwrap()["color"].as_str().unwrap(),
        b_color,
        "same user keeps the same colour"
    );

    // Leaving is announced.
    a.close().await;
    b.pump_until(|p| p.presence.iter().any(|m| m["type"] == "leave"))
        .await;

    // Presence is never persisted: the snapshot has no trace of it.
    let res = srv
        .raw(
            "GET",
            &format!("/api/files/{file}/snapshot"),
            &[("authorization", &format!("Bearer {bob}"))],
            None,
        )
        .await;
    assert!(!String::from_utf8_lossy(&res.body).contains("spoof"));
}

#[tokio::test(flavor = "multi_thread")]
async fn unauthorized_connections_are_closed_with_app_codes() {
    let (srv, alice, _bob, file) = setup().await;
    let (eve, _) = srv.sign_up("Eve", "eve@example.com").await;

    let cases = [
        (srv.ws_url(&file, None), 4401),
        (srv.ws_url(&file, Some("bogus")), 4401),
        (srv.ws_url(&file, Some(&eve)), 4403),
        (srv.ws_url("no-such-file", Some(&alice)), 4404),
    ];
    for (url, expected) in cases {
        match Peer::connect(&url, LoroDoc::new()).await {
            Outcome::Closed(code) => assert_eq!(code, expected, "{url}"),
            Outcome::Open(_) => panic!("{url} should have been rejected"),
        }
    }
    assert_eq!(srv.open_rooms(), 0, "rejected clients never open a room");
}

#[tokio::test(flavor = "multi_thread")]
async fn viewers_are_read_only_and_bad_frames_disconnect() {
    let (srv, alice, _bob, file) = setup().await;
    let (viewer, _) = srv.sign_up("Viewer", "viewer@example.com").await;
    let team = srv.first_team(&alice).await;
    let (_, invite) = srv
        .api(
            "POST",
            &format!("/api/teams/{team}/invites"),
            Some(&alice),
            Some(json!({ "role": "viewer" })),
        )
        .await;
    let token = invite["token"].as_str().unwrap();
    srv.api(
        "POST",
        &format!("/api/invites/{token}/accept"),
        Some(&viewer),
        None,
    )
    .await;

    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), LoroDoc::new()).await;
    let mut v = Peer::connect_ok(&srv.ws_url(&file, Some(&viewer)), LoroDoc::new()).await;
    assert_eq!(v.welcome.as_ref().unwrap()["role"], "viewer");

    // The viewer's edit is refused (with a one-time error) and never reaches others.
    v.doc.get_map("meta").insert("name", "vandalised").unwrap();
    v.push().await;
    v.pump_until(|p| !p.errors.is_empty()).await;
    assert_eq!(v.errors[0]["code"], "read_only");
    // The editor's edit still reaches the viewer.
    a.doc.get_map("meta").insert("title", "real").unwrap();
    a.push().await;
    v.pump_until(|p| p.doc.get_map("meta").get("title").is_some())
        .await;
    a.resync().await;
    assert!(a.doc.get_map("meta").get("name").is_none());

    // Garbage update bytes get the sender disconnected with 4400.
    a.send_binary(frame(0x01, b"definitely not loro")).await;
    assert_eq!(a.closed().await, 4400);
    // Unknown frame types too.
    let mut a2 = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), LoroDoc::new()).await;
    a2.send_binary(vec![0x7f, 1, 2, 3]).await;
    assert_eq!(a2.closed().await, 4400);

    // Removing a member kicks their live connection with 4403.
    let (_, members) = srv
        .api(
            "GET",
            &format!("/api/teams/{team}/members"),
            Some(&alice),
            None,
        )
        .await;
    let viewer_id = members
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "viewer")
        .unwrap()["userId"]
        .as_str()
        .unwrap()
        .to_string();
    srv.api(
        "DELETE",
        &format!("/api/teams/{team}/members/{viewer_id}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(v.closed().await, 4403);
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_file_closes_its_room() {
    let (srv, alice, bob, file) = setup().await;
    let mut b = Peer::connect_ok(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await;
    let (status, _) = srv
        .api("DELETE", &format!("/api/files/{file}"), Some(&alice), None)
        .await;
    assert_eq!(status, 200);
    assert_eq!(b.closed().await, 4404);
    match Peer::connect(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await {
        Outcome::Closed(code) => assert_eq!(code, 4404),
        Outcome::Open(_) => panic!("deleted file should not open"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn many_updates_compact_into_the_snapshot() {
    let srv = TestServer::start_with(|c| {
        c.compact_every_updates = 10;
    })
    .await;
    let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&token).await;
    let file = srv.create_file(&token, &team, "Busy").await;
    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await;
    for i in 0..60 {
        a.doc.get_text("t").insert(0, &i.to_string()).unwrap();
        a.push().await;
    }
    a.resync().await;
    // Give the maintenance tick time to compact.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let mut b = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await;
    b.pump(Duration::from_millis(100)).await;
    assert_eq!(
        b.doc.get_text("t").to_string(),
        a.doc.get_text("t").to_string()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_peers_editing_at_once_converge_quickly() {
    const PEERS: usize = 8;
    const EDITS: usize = 25;
    let srv = TestServer::start().await;
    let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&token).await;
    let file = srv.create_file(&token, &team, "Busy room").await;

    let mut peers = Vec::new();
    for _ in 0..PEERS {
        peers.push(Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await);
    }
    let started = std::time::Instant::now();
    // Every peer edits concurrently; each pumps its socket between edits.
    let tasks: Vec<_> = peers
        .into_iter()
        .enumerate()
        .map(|(i, mut peer)| {
            tokio::spawn(async move {
                for n in 0..EDITS {
                    peer.doc
                        .get_map("cells")
                        .insert(&format!("{i}:{n}"), n as i64)
                        .unwrap();
                    peer.push().await;
                    peer.pump(Duration::from_millis(1)).await;
                }
                peer.pump_until(|p| p.doc.get_map("cells").len() == PEERS * EDITS)
                    .await;
                peer
            })
        })
        .collect();
    let mut done = Vec::new();
    for t in tasks {
        done.push(t.await.unwrap());
    }
    let elapsed = started.elapsed();
    let first = deep(&done[0].doc);
    for p in &done[1..] {
        assert_eq!(deep(&p.doc), first);
    }
    eprintln!(
        "{PEERS} peers x {EDITS} edits converged in {elapsed:?} ({:.2} ms per edit)",
        elapsed.as_secs_f64() * 1000.0 / (PEERS * EDITS) as f64
    );
    assert!(elapsed < Duration::from_secs(10));
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_edit_round_trip_latency() {
    let (srv, alice, bob, file) = setup().await;
    let mut a = Peer::connect_ok(&srv.ws_url(&file, Some(&alice)), LoroDoc::new()).await;
    let mut b = Peer::connect_ok(&srv.ws_url(&file, Some(&bob)), LoroDoc::new()).await;
    let mut samples = Vec::new();
    for i in 0..50i64 {
        let t = std::time::Instant::now();
        a.doc.get_map("m").insert("v", i).unwrap();
        a.push().await;
        b.pump_until(|p| {
            p.doc
                .get_map("m")
                .get("v")
                .and_then(|v| v.into_value().ok())
                .is_some_and(|v| v == i.into())
        })
        .await;
        samples.push(t.elapsed());
    }
    samples.sort();
    let p50 = samples[samples.len() / 2];
    let p99 = samples[samples.len() * 99 / 100];
    eprintln!("A -> server -> B latency over loopback: p50 {p50:?}, p99 {p99:?}");
    assert!(p99 < Duration::from_millis(100), "p99 {p99:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_peer_that_stops_reading_is_dropped_and_can_resync() {
    let srv = TestServer::start_with(|c| c.client_queue = 4).await;
    let (token, _) = srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;
    let team = srv.first_team(&token).await;
    let file = srv.create_file(&token, &team, "Firehose").await;
    let mut writer = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await;
    // The reader joins and then stops reading its socket.
    let mut reader = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), LoroDoc::new()).await;

    // ~16 MB of updates: far more than socket buffers plus a 4-message queue can hold.
    let chunk = "x".repeat(64 * 1024);
    for _ in 0..256 {
        writer.doc.get_text("blob").insert(0, &chunk).unwrap();
        writer.push().await;
    }
    writer.resync().await;

    // The room did not stall on the reader: the writer is fully synced, and the reader is
    // told it was too slow once it looks at its socket again.
    assert_eq!(reader.closed().await, 4429);

    // Reconnecting catches up through the handshake.
    let fresh = Peer::connect_ok(&srv.ws_url(&file, Some(&token)), reader.doc.fork()).await;
    assert_eq!(
        fresh.doc.get_text("blob").len_unicode(),
        writer.doc.get_text("blob").len_unicode()
    );
}
