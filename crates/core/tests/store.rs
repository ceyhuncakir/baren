//! Store behaviour end to end, against real SQLite files.

mod common;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use baren_core::loro::LoroDoc;
use baren_core::schema::{
    self, create_node, set_styles, set_text, to_snapshot, NodeInit, NodeType,
};
use baren_core::{CoreError, HtmlOptions, Store, StoreOptions};
use common::{Client, TempDir};

fn open(dir: &TempDir) -> Store {
    Store::open(dir.path().join("core.db")).unwrap()
}

fn open_with(dir: &TempDir, options: StoreOptions) -> Store {
    Store::open_with(dir.path().join("core.db"), options).unwrap()
}

/// Rows in `file_updates` for a file, read straight from the database.
fn update_rows(db: &Path, id: &str) -> i64 {
    let c = rusqlite::Connection::open(db).unwrap();
    c.query_row(
        "SELECT COUNT(*) FROM file_updates WHERE file_id = ?1",
        [id],
        |r| r.get(0),
    )
    .unwrap()
}

fn frame(client: &mut Client, name: &str) -> String {
    let page = client.page();
    let init = NodeInit {
        name: Some(name.into()),
        ..Default::default()
    };
    create_node(&client.doc, NodeType::Frame, Some(&page), None, &init).unwrap()
}

fn doc_of(store: &Store, id: &str) -> LoroDoc {
    schema::load_doc(&store.open_file(id).unwrap()).unwrap()
}

#[test]
fn file_lifecycle() {
    let dir = TempDir::new("lifecycle");
    let store = open(&dir);
    assert!(store.list_files().unwrap().is_empty());

    let a = store.create_file("Alpha").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(3));
    let b = store.create_file("Beta").unwrap();
    assert_eq!(a.name, "Alpha");
    assert!(!a.archived);
    assert_eq!((a.team_id.as_deref(), a.remote_id.as_deref()), (None, None));
    assert_eq!(a.created_at, a.updated_at);
    assert_ne!(a.id, b.id);

    let names = |s: &Store| {
        s.list_files()
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&store),
        ["Beta", "Alpha"],
        "most recently updated first"
    );

    std::thread::sleep(std::time::Duration::from_millis(3));
    store.rename_file(&a.id, "Alpha 2").unwrap();
    assert_eq!(names(&store), ["Alpha 2", "Beta"]);
    store.archive_file(&b.id, true).unwrap();
    let b2 = store.get_file(&b.id).unwrap();
    assert!(b2.archived);
    assert!(b2.updated_at >= b.updated_at);
    store
        .set_file_remote(&b.id, Some("team-1"), Some("remote-9"))
        .unwrap();
    let b3 = store.get_file(&b.id).unwrap();
    assert_eq!(b3.team_id.as_deref(), Some("team-1"));
    assert_eq!(b3.remote_id.as_deref(), Some("remote-9"));

    store.remove_file(&a.id).unwrap();
    assert_eq!(names(&store), ["Beta"]);
    for result in [
        store.open_file(&a.id).map(|_| ()),
        store.rename_file(&a.id, "x"),
        store.archive_file(&a.id, false),
        store.remove_file(&a.id),
        store.get_thumbnail(&a.id).map(|_| ()),
    ] {
        assert!(
            matches!(result, Err(CoreError::FileNotFound(_))),
            "{result:?}"
        );
    }

    // Everything survives a restart.
    drop(store);
    let store = open(&dir);
    assert_eq!(store.list_files().unwrap(), vec![b3]);
}

#[test]
fn new_file_has_the_schema_layout() {
    let dir = TempDir::new("layout");
    let store = open(&dir);
    let meta = store.create_file("Layout").unwrap();
    let snap = to_snapshot(&doc_of(&store, &meta.id));
    assert_eq!(snap.name, "Layout");
    assert_eq!(snap.page_ids.len(), 1);
    let page = snap.nodes.get(&snap.page_ids[0]).unwrap();
    assert_eq!(
        (page.name.as_str(), page.background.as_deref()),
        ("Page 1", Some("#EEEEEE"))
    );
    assert!(snap.tokens.is_empty());
    let json: serde_json::Value =
        serde_json::from_str(&store.export_json(&meta.id).unwrap()).unwrap();
    assert_eq!(json["name"], "Layout");
    assert_eq!(json["pageIds"].as_array().unwrap().len(), 1);
}

#[test]
fn updates_are_validated_persisted_and_replayed() {
    let dir = TempDir::new("updates");
    let db = dir.path().join("core.db");
    let store = open(&dir);
    let meta = store.create_file("Doc").unwrap();
    let mut client = Client::load(&store.open_file(&meta.id).unwrap());

    let board = frame(&mut client, "Board");
    let u1 = client.take_update();
    set_styles(&client.doc, &board, &[("width", Some(1440.into()))]).unwrap();
    let u2 = client.take_update();
    store.apply_update(&meta.id, &u1).unwrap();
    store.apply_update(&meta.id, &u2).unwrap();
    assert_eq!(update_rows(&db, &meta.id), 2);

    // Re-sending known ops is accepted and not stored again.
    store.apply_update(&meta.id, &u1).unwrap();
    assert_eq!(update_rows(&db, &meta.id), 2);

    // Garbage, truncation and corruption are rejected without side effects.
    let mut corrupt = u2.clone();
    let mid = corrupt.len() / 2;
    corrupt[mid] ^= 0x5a;
    for bad in [
        b"".to_vec(),
        b"hello".to_vec(),
        u2[..u2.len() / 2].to_vec(),
        corrupt,
    ] {
        let err = store.apply_update(&meta.id, &bad).unwrap_err();
        assert_eq!(err.code(), "invalid-update", "{err}");
    }
    assert_eq!(update_rows(&db, &meta.id), 2);
    assert!(matches!(
        store.apply_update("nope", &u1),
        Err(CoreError::FileNotFound(_))
    ));

    // A fresh process replays snapshot + log and compacts on open.
    drop(store);
    let store = open(&dir);
    let doc = doc_of(&store, &meta.id);
    assert_eq!(to_snapshot(&doc), to_snapshot(&client.doc));
    assert_eq!(update_rows(&db, &meta.id), 0, "open_file compacted the log");
    assert!(store.get_file(&meta.id).unwrap().updated_at >= meta.updated_at);
}

#[test]
fn out_of_order_updates_survive_compaction() {
    let dir = TempDir::new("ooo");
    let db = dir.path().join("core.db");
    let store = open(&dir);
    let meta = store.create_file("Doc").unwrap();
    let mut client = Client::load(&store.open_file(&meta.id).unwrap());
    let board = frame(&mut client, "Board");
    let u1 = client.take_update();
    set_styles(&client.doc, &board, &[("height", Some(900.into()))]).unwrap();
    let u2 = client.take_update();

    // u2 depends on u1 but arrives first: accepted and persisted as pending.
    store.apply_update(&meta.id, &u2).unwrap();
    store.compact(&meta.id).unwrap();
    assert_eq!(
        update_rows(&db, &meta.id),
        1,
        "pending update kept through compaction"
    );
    assert!(!to_snapshot(&doc_of(&store, &meta.id))
        .nodes
        .contains(&board));

    // Survives a restart while still pending.
    drop(store);
    let store = open(&dir);
    store.apply_update(&meta.id, &u1).unwrap();
    store.compact(&meta.id).unwrap();
    assert_eq!(update_rows(&db, &meta.id), 0, "resolved: everything folded");
    assert_eq!(
        to_snapshot(&doc_of(&store, &meta.id)),
        to_snapshot(&client.doc)
    );
}

#[test]
fn compaction_triggers_by_count() {
    let dir = TempDir::new("compact");
    let db = dir.path().join("core.db");
    let store = open_with(
        &dir,
        StoreOptions {
            compact_every: 10,
            ..Default::default()
        },
    );
    let meta = store.create_file("Doc").unwrap();
    let mut client = Client::load(&store.open_file(&meta.id).unwrap());
    let board = frame(&mut client, "Board");
    store.apply_update(&meta.id, &client.take_update()).unwrap();
    for i in 0..24 {
        set_styles(&client.doc, &board, &[("left", Some(f64::from(i).into()))]).unwrap();
        store.apply_update(&meta.id, &client.take_update()).unwrap();
        assert!(update_rows(&db, &meta.id) < 10);
    }
    assert_eq!(update_rows(&db, &meta.id), 25 % 10);
    store.flush().unwrap();
    assert_eq!(update_rows(&db, &meta.id), 0);
    drop(store);
    assert_eq!(
        to_snapshot(&doc_of(&open(&dir), &meta.id)),
        to_snapshot(&client.doc)
    );
}

#[test]
fn eviction_compacts_and_reloads() {
    let dir = TempDir::new("evict");
    let db = dir.path().join("core.db");
    let store = open_with(
        &dir,
        StoreOptions {
            cache_capacity: 1,
            ..Default::default()
        },
    );
    let files: Vec<_> = (0..3)
        .map(|i| store.create_file(&format!("F{i}")).unwrap())
        .collect();
    let mut clients: Vec<_> = files
        .iter()
        .map(|f| Client::load(&store.open_file(&f.id).unwrap()))
        .collect();
    for round in 0..3 {
        for (f, c) in files.iter().zip(clients.iter_mut()) {
            frame(c, &format!("R{round}"));
            store.apply_update(&f.id, &c.take_update()).unwrap();
        }
    }
    // Only the most recently used file stays loaded; the others were
    // compacted when evicted.
    assert_eq!(update_rows(&db, &files[0].id), 0);
    assert_eq!(update_rows(&db, &files[1].id), 0);
    assert_eq!(update_rows(&db, &files[2].id), 1);
    for (f, c) in files.iter().zip(&clients) {
        assert_eq!(to_snapshot(&doc_of(&store, &f.id)), to_snapshot(&c.doc));
    }
}

#[test]
fn concurrent_updates_from_many_threads() {
    let dir = TempDir::new("concurrent");
    let store = Arc::new(open_with(
        &dir,
        StoreOptions {
            compact_every: 16,
            cache_capacity: 2,
            ..Default::default()
        },
    ));
    let files: Vec<_> = (0..4)
        .map(|i| store.create_file(&format!("F{i}")).unwrap())
        .collect();
    let mut expected = HashMap::new();
    let mut work: Vec<(String, Vec<u8>)> = Vec::new();
    for f in &files {
        let mut client = Client::load(&store.open_file(&f.id).unwrap());
        let board = frame(&mut client, "Board");
        work.push((f.id.clone(), client.take_update()));
        for i in 0..40 {
            set_styles(&client.doc, &board, &[("top", Some(f64::from(i).into()))]).unwrap();
            work.push((f.id.clone(), client.take_update()));
        }
        expected.insert(f.id.clone(), to_snapshot(&client.doc));
    }
    // Deal updates round-robin to 8 threads: same-file updates run
    // concurrently and out of order, like libuv pool tasks.
    let mut buckets: Vec<Vec<(String, Vec<u8>)>> = vec![Vec::new(); 8];
    for (i, item) in work.into_iter().enumerate() {
        buckets[i % 8].push(item);
    }
    std::thread::scope(|s| {
        for bucket in buckets {
            let store = Arc::clone(&store);
            s.spawn(move || {
                for (id, update) in bucket.into_iter().rev() {
                    store.apply_update(&id, &update).unwrap();
                }
            });
        }
        s.spawn(|| {
            for _ in 0..50 {
                store.list_files().unwrap();
            }
        });
    });
    store.flush().unwrap();
    for f in &files {
        assert_eq!(
            &to_snapshot(&doc_of(&store, &f.id)),
            expected.get(&f.id).unwrap()
        );
    }
}

#[test]
fn assets_are_content_addressed() {
    let dir = TempDir::new("assets");
    let store = open(&dir);
    let png = b"\x89PNG\r\n\x1a\nfake image".to_vec();
    let hash = store.put_asset(&png, "Image/PNG").unwrap();
    assert_eq!(hash, blake3::hash(&png).to_hex().as_str());
    assert_eq!(
        store.put_asset(&png, "image/png").unwrap(),
        hash,
        "deduplicated"
    );
    let asset = store.get_asset(&hash).unwrap().unwrap();
    assert_eq!((asset.bytes, asset.mime.as_str()), (png, "image/png"));
    assert_eq!(store.get_asset(&"0".repeat(64)).unwrap(), None);
    assert_eq!(store.get_asset("../etc/passwd").unwrap(), None);
    assert_eq!(
        store.put_asset(b"", "image/png").unwrap_err().code(),
        "invalid-input"
    );
    assert_eq!(
        store.put_asset(b"x", "nonsense").unwrap_err().code(),
        "invalid-input"
    );
}

#[test]
fn thumbnails() {
    let dir = TempDir::new("thumbs");
    let store = open(&dir);
    let meta = store.create_file("Doc").unwrap();
    assert_eq!(store.get_thumbnail(&meta.id).unwrap(), None);
    let png = b"\x89PNG\r\n\x1a\n1".to_vec();
    store.set_thumbnail(&meta.id, &png).unwrap();
    assert_eq!(store.get_thumbnail(&meta.id).unwrap(), Some(png));
    let png2 = b"\x89PNG\r\n\x1a\n2".to_vec();
    store.set_thumbnail(&meta.id, &png2).unwrap();
    assert_eq!(store.get_thumbnail(&meta.id).unwrap(), Some(png2));
    assert_eq!(
        store.set_thumbnail(&meta.id, b"GIF89a").unwrap_err().code(),
        "invalid-input"
    );
    assert!(matches!(
        store.set_thumbnail("missing", b"\x89PNG\r\n\x1a\n"),
        Err(CoreError::FileNotFound(_))
    ));
    // Thumbnail does not bump updated_at (it would reorder Recents).
    assert_eq!(
        store.get_file(&meta.id).unwrap().updated_at,
        meta.updated_at
    );
    store.remove_file(&meta.id).unwrap();
    let db = rusqlite::Connection::open(dir.path().join("core.db")).unwrap();
    let left: i64 = db
        .query_row("SELECT COUNT(*) FROM thumbnails", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0, "cascade delete");
}

#[test]
fn rename_and_doc_name_stay_in_sync() {
    let dir = TempDir::new("rename");
    let store = open(&dir);
    let meta = store.create_file("Before").unwrap();
    let mut client = Client::load(&store.open_file(&meta.id).unwrap());

    store.rename_file(&meta.id, "Renamed").unwrap();
    assert_eq!(to_snapshot(&doc_of(&store, &meta.id)).name, "Renamed");
    assert!(store
        .export_json(&meta.id)
        .unwrap()
        .contains("\"name\": \"Renamed\""));

    // A renderer renaming through the document updates the file list too
    // (its concurrent edit wins or loses by Loro's last-writer rule).
    client
        .doc
        .import(&store.open_file(&meta.id).unwrap())
        .unwrap();
    schema::set_doc_name(&client.doc, "From editor").unwrap();
    store.apply_update(&meta.id, &client.take_update()).unwrap();
    assert_eq!(store.get_file(&meta.id).unwrap().name, "From editor");
    assert!(store.rename_file(&meta.id, "a\0b").is_err());
}

#[test]
fn import_file_validates_and_overrides_name() {
    let dir = TempDir::new("import");
    let store = open(&dir);
    let doc = schema::create_empty_doc("Remote").unwrap();
    let bytes = schema::export_snapshot(&doc).unwrap();
    let a = store.import_file(&bytes, None).unwrap();
    assert_eq!(a.name, "Remote");
    let b = store.import_file(&bytes, Some("Local copy")).unwrap();
    assert_eq!(to_snapshot(&doc_of(&store, &b.id)).name, "Local copy");
    assert_eq!(
        store.import_file(b"junk", None).unwrap_err().code(),
        "invalid-update"
    );
}

#[test]
fn a_database_has_exactly_one_owner() {
    let dir = TempDir::new("owner");
    let path = dir.path().join("core.db");
    let first = Store::open(&path).unwrap();
    let meta = first.create_file("Mine").unwrap();
    let err = Store::open(&path).err().expect("second owner refused");
    assert_eq!(err.code(), "locked", "{err}");
    drop(first);
    let second = Store::open(&path).expect("lock released on drop");
    assert_eq!(second.get_file(&meta.id).unwrap().name, "Mine");
}

#[test]
fn opening_a_directory_uses_baren_sqlite_inside_it() {
    let dir = TempDir::new("datadir");
    let store = Store::open(dir.path()).unwrap();
    let meta = store.create_file("In dir").unwrap();
    assert!(dir.path().join(baren_core::store::DB_FILE_NAME).is_file());
    drop(store);
    let by_file = Store::open(dir.path().join("baren.sqlite")).unwrap();
    assert_eq!(by_file.get_file(&meta.id).unwrap().name, "In dir");
    assert_eq!(
        Store::open(dir.path()).err().unwrap().code(),
        "locked",
        "same database"
    );
}

#[test]
fn rejects_databases_from_the_future() {
    let dir = TempDir::new("future");
    let path = dir.path().join("core.db");
    drop(Store::open(&path).unwrap());
    drop(Store::open(&path).unwrap()); // reopening an up-to-date db is a no-op
    rusqlite::Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    let err = Store::open(&path).err().unwrap();
    assert_eq!(err.code(), "database-too-new", "{err}");
}

#[test]
fn asset_info_and_mime_sniffing() {
    let dir = TempDir::new("asset-info");
    let store = open(&dir);
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    png.extend_from_slice(&2400u32.to_be_bytes());
    png.extend_from_slice(&1200u32.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]);
    // A generic type from a drag and drop is replaced by the sniffed one.
    let hash = store.put_asset(&png, "application/octet-stream").unwrap();
    let info = store.asset_info(&hash).unwrap().unwrap();
    assert_eq!(info.mime, "image/png");
    assert_eq!(
        (info.width, info.height, info.size),
        (Some(2400), Some(1200), png.len())
    );
    // Non-images keep their type and have no pixel size.
    let text = store.put_asset(b"hello", "text/plain").unwrap();
    let info = store.asset_info(&text).unwrap().unwrap();
    assert_eq!((info.mime.as_str(), info.width), ("text/plain", None));
    assert_eq!(store.asset_info(&"0".repeat(64)).unwrap(), None);
}

#[test]
fn json_export_can_embed_referenced_assets() {
    let dir = TempDir::new("json-assets");
    let store = open(&dir);
    let meta = store.create_file("Doc").unwrap();
    let a = store.put_asset(b"\x89PNG\r\n\x1a\nA", "image/png").unwrap();
    let b = store.put_asset(b"GIF89aB", "image/gif").unwrap();
    let mut client = Client::load(&store.open_file(&meta.id).unwrap());
    let board = frame(&mut client, "Board");
    let fill = format!(r#"url("baren-asset://{b}")"#);
    set_styles(
        &client.doc,
        &board,
        &[("backgroundImage", Some(fill.as_str().into()))],
    )
    .unwrap();
    let image = NodeInit {
        asset_id: Some(a.clone()),
        asset_name: Some("photo.png".into()),
        ..Default::default()
    };
    create_node(&client.doc, NodeType::Image, Some(&board), None, &image).unwrap();
    store.apply_update(&meta.id, &client.take_update()).unwrap();

    let plain = store.export_json(&meta.id).unwrap();
    assert!(!plain.contains("\"assets\""));
    assert!(plain.contains("\"assetName\": \"photo.png\""), "{plain}");
    let full = store
        .export_json_with(&meta.id, &baren_core::JsonOptions { embed_assets: true })
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&full).unwrap();
    assert_eq!(v["assets"][&a], "data:image/png;base64,iVBORw0KGgpB");
    assert_eq!(v["assets"][&b], "data:image/gif;base64,R0lGODlhQg==");
    assert_eq!(v["name"], "Doc");
}

#[test]
fn html_export_embeds_assets() {
    let dir = TempDir::new("html");
    let store = open(&dir);
    let meta = store.create_file("Doc").unwrap();
    let hash = store.put_asset(b"\x89PNG\r\n\x1a\n", "image/png").unwrap();
    let mut client = Client::load(&store.open_file(&meta.id).unwrap());
    let board = frame(&mut client, "Board");
    let title = create_node(
        &client.doc,
        NodeType::Text,
        Some(&board),
        None,
        &NodeInit::default(),
    )
    .unwrap();
    set_text(&client.doc, &title, "Hi <there>").unwrap();
    let image = NodeInit {
        asset_id: Some(hash),
        ..Default::default()
    };
    create_node(&client.doc, NodeType::Image, Some(&board), None, &image).unwrap();
    store.apply_update(&meta.id, &client.take_update()).unwrap();

    let html = store
        .export_html(&meta.id, &board, &HtmlOptions::default())
        .unwrap();
    assert_eq!(
        html,
        "<section style=\"position: relative\">\n  <p style=\"margin: 0\">Hi &lt;there&gt;</p>\n  <img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"Image\">\n</section>\n"
    );
    let err = store
        .export_html(&meta.id, "123@456", &HtmlOptions::default())
        .unwrap_err();
    assert!(matches!(err, CoreError::NodeNotFound(_)));
}
