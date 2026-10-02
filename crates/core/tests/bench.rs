//! Store benchmarks on a ~50k-node document. Ignored by default; run with
//!
//!   cargo test -p baren-core --release --test bench -- --ignored --nocapture
//!
//! Timings include SQLite I/O against a real file (WAL, synchronous=NORMAL).

mod common;

use std::time::{Duration, Instant};

use baren_core::schema::bench::{bench_doc_node_count, generate_bench_doc, BenchOptions};
use baren_core::schema::{export_snapshot, set_styles, set_text, to_snapshot, NodeType};
use baren_core::{HtmlOptions, Store};
use common::{Client, TempDir};

fn ms(d: Duration) -> String {
    format!("{:>9.2} ms", d.as_secs_f64() * 1e3)
}

fn time<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let out = f();
    println!("{label:<52}{}", ms(start.elapsed()));
    out
}

#[test]
#[ignore = "benchmark: run with --release -- --ignored --nocapture"]
fn bench_50k_nodes_1k_updates() {
    let options = BenchOptions {
        artboards: 100,
        nodes_per_artboard: 499,
        peer_id: Some(1),
        ..Default::default()
    };
    let nodes = bench_doc_node_count(&options);
    println!("\n== baren-core store bench: {nodes} nodes, 1000 updates ==");

    let doc = time("generate bench doc (Rust)", || {
        generate_bench_doc(&options).unwrap()
    });
    let snapshot = time("export snapshot", || export_snapshot(&doc).unwrap());
    println!(
        "{:<52}{:>9.2} MB",
        "snapshot size",
        snapshot.len() as f64 / 1e6
    );

    let dir = TempDir::new("bench");
    let path = dir.path().join("core.db");
    let id = {
        let store = Store::open(&path).unwrap();
        let meta = time("import_file (validate + insert)", || {
            store.import_file(&snapshot, None).unwrap()
        });
        meta.id
    };

    // Cold process: nothing cached.
    let store = time("Store::open (existing db, migrations checked)", || {
        Store::open(&path).unwrap()
    });
    let bytes = time("open_file, cold (stored snapshot, no doc load)", || {
        store.open_file(&id).unwrap()
    });
    assert_eq!(bytes.len(), snapshot.len());
    time("list_files", || store.list_files().unwrap());

    // The "renderer": a client doc on the same snapshot producing small updates.
    let mut client = Client::load(&bytes);
    let snap = to_snapshot(&client.doc);
    let targets: Vec<(String, NodeType)> = snap
        .nodes
        .iter()
        .filter(|n| matches!(n.node_type, NodeType::Text | NodeType::Rect))
        .map(|n| (n.id.clone(), n.node_type))
        .collect();
    assert!(targets.len() > 40_000);

    let mut latencies = Vec::with_capacity(1000);
    let mut total_bytes = 0;
    for i in 0..1000usize {
        let (node, kind) = &targets[(i * 7919) % targets.len()];
        if *kind == NodeType::Text && i % 3 == 0 {
            set_text(&client.doc, node, &format!("Edited {i}")).unwrap();
        } else {
            set_styles(
                &client.doc,
                node,
                &[
                    ("left", Some((i as f64).into())),
                    ("top", Some(((i * 2) as f64).into())),
                ],
            )
            .unwrap();
        }
        let update = client.take_update();
        total_bytes += update.len();
        let start = Instant::now();
        store.apply_update(&id, &update).unwrap();
        latencies.push(start.elapsed());
    }
    let first = latencies[0];
    let mut steady = latencies[1..].to_vec();
    steady.sort();
    let pct = |p: f64| steady[((steady.len() - 1) as f64 * p).round() as usize];
    let total: Duration = latencies.iter().sum();
    println!(
        "{:<52}{}",
        "apply_update #1 (loads + caches the 50k doc)",
        ms(first)
    );
    println!("{:<52}{}", "apply_update x1000 total", ms(total));
    println!("{:<52}{}", "  steady-state mean", ms((total - first) / 999));
    println!("{:<52}{}", "  p50", ms(pct(0.50)));
    println!("{:<52}{}", "  p95", ms(pct(0.95)));
    println!(
        "{:<52}{}",
        "  p99 (includes compactions every 500)",
        ms(pct(0.99))
    );
    println!("{:<52}{}", "  max", ms(*steady.last().unwrap()));
    println!(
        "{:<52}{:>9.1} B",
        "  mean update size",
        total_bytes as f64 / 1000.0
    );

    let full = time("  to_snapshot (50k nodes, cached doc)", || {
        store.snapshot(&id).unwrap()
    });
    time("  serialise to JSON (pretty)", || {
        baren_core::export::json::to_string_pretty(&full).unwrap()
    });
    let json = time("export_json (to_snapshot + serialise, 50k nodes)", || {
        store.export_json(&id).unwrap()
    });
    println!("{:<52}{:>9.2} MB", "  json size", json.len() as f64 / 1e6);
    let artboard = snap.nodes.get(&snap.page_ids[0]).unwrap().children[0].clone();
    let html = time("export_html (one 500-node artboard)", || {
        store
            .export_html(&id, &artboard, &HtmlOptions::default())
            .unwrap()
    });
    println!("{:<52}{:>9.1} KB", "  html size", html.len() as f64 / 1e3);

    // A few pending updates, then open: replays + compacts.
    for (node, _) in &targets[..10] {
        set_styles(&client.doc, node, &[("width", Some(10.into()))]).unwrap();
        store.apply_update(&id, &client.take_update()).unwrap();
    }
    let reopened = time("open_file with 10 pending (export + compact)", || {
        store.open_file(&id).unwrap()
    });
    time("open_file again (clean, from disk)", || {
        store.open_file(&id).unwrap()
    });
    time("flush (vacuum free pages + WAL checkpoint)", || {
        store.flush().unwrap()
    });
    drop(store);

    let store = Store::open(&path).unwrap();
    let doc = baren_core::schema::load_doc(&store.open_file(&id).unwrap()).unwrap();
    assert_eq!(to_snapshot(&doc), to_snapshot(&client.doc), "nothing lost");
    assert_eq!(reopened.len(), store.open_file(&id).unwrap().len());
    let db_size = std::fs::metadata(&path).unwrap().len();
    println!(
        "{:<52}{:>9.2} MB",
        "database file size",
        db_size as f64 / 1e6
    );
}

/// Phase 3 budget (contract §9): HTML export of a 500-node artboard that also holds 50
/// instances of a 12-node main stays within 2 × the plain artboard's export time.
#[test]
#[ignore = "benchmark: run with --release -- --ignored --nocapture"]
fn bench_html_export_with_50_instances() {
    use baren_core::schema::{create_node, NodeInit};
    let options = BenchOptions {
        artboards: 1,
        nodes_per_artboard: 500,
        peer_id: Some(1),
        ..Default::default()
    };
    let doc = generate_bench_doc(&options).unwrap();
    let snap = to_snapshot(&doc);
    let page = snap.page_ids[0].clone();
    let artboard = snap.nodes.get(&page).unwrap().children[0].clone();
    let init = |name: &str, styles: Vec<(&str, baren_core::StyleValue)>| NodeInit {
        name: Some(name.into()),
        styles: styles.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
        ..Default::default()
    };
    // A 12-node main on its own page.
    let comp_page = create_node(
        &doc,
        NodeType::Page,
        None,
        None,
        &init("Components", vec![]),
    )
    .unwrap();
    let key = "benchmaincard0001";
    let main = create_node(
        &doc,
        NodeType::Frame,
        Some(&comp_page),
        None,
        &NodeInit {
            component_key: Some(key.into()),
            ..init(
                "Card",
                vec![
                    ("left", 0.into()),
                    ("top", 0.into()),
                    ("width", 200.into()),
                    ("height", 120.into()),
                    ("display", "flex".into()),
                    ("backgroundColor", "#FFFFFF".into()),
                ],
            )
        },
    )
    .unwrap();
    for i in 0..11 {
        let (t, text) = if i % 2 == 0 {
            (NodeType::Text, Some(format!("Line {i}")))
        } else {
            (NodeType::Rect, None)
        };
        create_node(
            &doc,
            t,
            Some(&main),
            None,
            &NodeInit {
                text,
                node_key: Some(format!("benchkey{i:02}")),
                ..init("Part", vec![("width", 16.into()), ("height", 16.into())])
            },
        )
        .unwrap();
    }
    doc.get_map(baren_core::container::COMPONENTS)
        .ensure_mergeable_map(key)
        .unwrap()
        .insert("mainId", main.as_str())
        .unwrap();
    for i in 0..50 {
        create_node(
            &doc,
            NodeType::Instance,
            Some(&artboard),
            None,
            &NodeInit {
                component_key: Some(key.into()),
                main_id: Some(main.clone()),
                ..init(&format!("Card {i}"), vec![])
            },
        )
        .unwrap();
    }
    doc.commit();
    let dir = TempDir::new("bench-html3");
    let store = Store::open(dir.path().join("core.db")).unwrap();
    let id = store
        .import_file(&export_snapshot(&doc).unwrap(), None)
        .unwrap()
        .id;
    let plain_doc = generate_bench_doc(&options).unwrap();
    let plain_id = store
        .import_file(&export_snapshot(&plain_doc).unwrap(), None)
        .unwrap()
        .id;
    let plain_board = to_snapshot(&plain_doc)
        .nodes
        .get(&to_snapshot(&plain_doc).page_ids[0])
        .unwrap()
        .children[0]
        .clone();
    // Warm both documents (first export loads and caches them).
    store
        .export_html(&plain_id, &plain_board, &HtmlOptions::default())
        .unwrap();
    store
        .export_html(&id, &artboard, &HtmlOptions::default())
        .unwrap();
    let median = |f: &dyn Fn() -> String| {
        let mut runs: Vec<Duration> = (0..21)
            .map(|_| {
                let start = Instant::now();
                std::hint::black_box(f());
                start.elapsed()
            })
            .collect();
        runs.sort();
        runs[10]
    };
    let plain = median(&|| {
        store
            .export_html(&plain_id, &plain_board, &HtmlOptions::default())
            .unwrap()
    });
    let with = median(&|| {
        store
            .export_html(&id, &artboard, &HtmlOptions::default())
            .unwrap()
    });
    let html = store
        .export_html(&id, &artboard, &HtmlOptions::default())
        .unwrap();
    assert_eq!(
        html.matches("Line 0").count(),
        50,
        "every instance is expanded"
    );
    println!("\n== Phase 3 HTML export bench ==");
    println!(
        "{:<52}{}",
        "export_html (500-node artboard), median",
        ms(plain)
    );
    println!(
        "{:<52}{}",
        "export_html (500 nodes + 50 instances), median",
        ms(with)
    );
    println!(
        "{:<52}{:>9.2} x",
        "ratio (budget 2x)",
        with.as_secs_f64() / plain.as_secs_f64()
    );
}
