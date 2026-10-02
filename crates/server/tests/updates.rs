//! `GET`/`HEAD /updates/*`: the auto-update feed served from `UPDATES_DIR`.

mod common;

use std::path::PathBuf;

use common::TestServer;

struct Feed {
    dir: PathBuf,
    blob: Vec<u8>,
}

impl Feed {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("baren-feed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("latest-linux.yml"),
            "version: 0.2.0\npath: baren-0.2.0.AppImage\n",
        )
        .unwrap();
        let blob: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("baren-0.2.0.AppImage"), &blob).unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        Self { dir, blob }
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn feed_is_404_without_updates_dir() {
    let srv = TestServer::start().await;
    let res = srv.raw("GET", "/updates/latest-linux.yml", &[], None).await;
    assert_eq!(res.status, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_files_with_validators() {
    let feed = Feed::new();
    let dir = feed.dir.clone();
    let srv = TestServer::start_with(|c| c.updates_dir = Some(dir)).await;

    let res = srv
        .raw("GET", "/updates/latest-linux.yml?noCache=1abc", &[], None)
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.text(), "version: 0.2.0\npath: baren-0.2.0.AppImage\n");
    assert_eq!(res.header("content-type"), Some("text/yaml; charset=utf-8"));
    assert_eq!(res.header("cache-control"), Some("no-cache"));
    assert_eq!(res.header("accept-ranges"), Some("bytes"));
    let etag = res.header("etag").unwrap().to_string();
    let modified = res.header("last-modified").unwrap().to_string();
    assert!(modified.ends_with(" GMT"), "{modified}");

    let res = srv
        .raw(
            "GET",
            "/updates/latest-linux.yml",
            &[("if-none-match", &etag)],
            None,
        )
        .await;
    assert_eq!(res.status, 304);
    let res = srv
        .raw(
            "GET",
            "/updates/latest-linux.yml",
            &[("if-modified-since", &modified)],
            None,
        )
        .await;
    assert_eq!(res.status, 304);

    let res = srv
        .raw("HEAD", "/updates/baren-0.2.0.AppImage", &[], None)
        .await;
    assert_eq!(res.status, 200);
    assert!(res.body.is_empty());
    assert_eq!(res.header("content-length"), Some("200000"));
    assert_eq!(res.header("content-type"), Some("application/octet-stream"));

    let res = srv
        .raw("GET", "/updates/baren-0.2.0.AppImage", &[], None)
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, feed.blob);

    for bad in [
        "/updates/.env",
        "/updates/../Cargo.toml",
        "/updates/%2e%2e/Cargo.toml",
        "/updates/missing.yml",
        "/updates/",
    ] {
        assert_eq!(srv.raw("GET", bad, &[], None).await.status, 404, "{bad}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn single_and_multiple_ranges() {
    let feed = Feed::new();
    let dir = feed.dir.clone();
    let srv = TestServer::start_with(|c| c.updates_dir = Some(dir)).await;
    let path = "/updates/baren-0.2.0.AppImage";

    let res = srv
        .raw("GET", path, &[("range", "bytes=100-199")], None)
        .await;
    assert_eq!(res.status, 206);
    assert_eq!(res.header("content-range"), Some("bytes 100-199/200000"));
    assert_eq!(res.header("content-length"), Some("100"));
    assert_eq!(res.body, feed.blob[100..200]);

    let res = srv.raw("GET", path, &[("range", "bytes=-10")], None).await;
    assert_eq!(res.status, 206);
    assert_eq!(res.body, feed.blob[199_990..]);

    let res = srv
        .raw("GET", path, &[("range", "bytes=300000-")], None)
        .await;
    assert_eq!(res.status, 416);
    assert_eq!(res.header("content-range"), Some("bytes */200000"));

    // A stale If-Range sends the whole file.
    let res = srv
        .raw(
            "GET",
            path,
            &[("range", "bytes=0-9"), ("if-range", "\"stale\"")],
            None,
        )
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body.len(), 200_000);

    // electron-updater's differential download: many ranges, parts in request order.
    let ranges = [(150_000u64, 150_009u64), (0, 4), (70_000, 135_535)];
    let spec = ranges
        .iter()
        .map(|(a, b)| format!("{a}-{b}"))
        .collect::<Vec<_>>()
        .join(", ");
    let res = srv
        .raw("GET", path, &[("range", &format!("bytes={spec}"))], None)
        .await;
    assert_eq!(res.status, 206);
    let ctype = res.header("content-type").unwrap().to_string();
    let boundary = ctype
        .strip_prefix("multipart/byteranges; boundary=")
        .expect(&ctype)
        .to_string();
    assert_eq!(
        res.header("content-length").unwrap(),
        res.body.len().to_string()
    );
    // Parse it the way electron-updater's DataSplitter does: skip `--boundary`, skip to the
    // end of the part headers, take exactly the requested length, skip `\r\n--boundary`, ...
    let body = &res.body;
    let mut pos = boundary.len() + 2;
    for (start, end) in ranges {
        let headers_end = find(body, b"\r\n\r\n", pos).expect("part headers") + 4;
        let headers = String::from_utf8_lossy(&body[pos..headers_end]).into_owned();
        assert!(
            headers.contains(&format!("Content-Range: bytes {start}-{end}/200000")),
            "{headers}"
        );
        let len = (end - start + 1) as usize;
        assert_eq!(
            &body[headers_end..headers_end + len],
            &feed.blob[start as usize..=end as usize]
        );
        pos = headers_end + len;
        assert_eq!(
            &body[pos..pos + 4 + boundary.len()],
            format!("\r\n--{boundary}").as_bytes()
        );
        pos += 4 + boundary.len();
    }
    assert_eq!(&body[pos..], b"--\r\n");
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}
