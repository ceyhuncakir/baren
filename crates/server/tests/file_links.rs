//! The page behind the app's "Copy link" (`/f/:id`).

mod common;

use common::TestServer;

const FILE: &str = "01a0fefe-0b75-71ce-b315-db36b3935047";

#[tokio::test(flavor = "multi_thread")]
async fn file_link_page_opens_the_app() {
    let srv = TestServer::start().await;

    let page = srv.raw("GET", &format!("/f/{FILE}"), &[], None).await;
    assert_eq!(page.status, 200);
    let html = page.text();
    assert!(
        html.contains(&format!(r#"href="baren://file/{FILE}""#)),
        "{html}"
    );
    assert!(html.contains("Open in Baren"));

    // A layer link keeps its node, percent-encoded for the app.
    let page = srv
        .raw("GET", &format!("/f/{FILE}?node=47@1076"), &[], None)
        .await;
    assert!(page
        .text()
        .contains(&format!(r#"href="baren://file/{FILE}?node=47%401076""#)));

    // Anything else in the node is dropped, not passed on.
    let page = srv
        .raw(
            "GET",
            &format!("/f/{FILE}?node=%22%3E%3Cscript%3E"),
            &[],
            None,
        )
        .await;
    let html = page.text();
    assert!(html.contains(&format!(r#"href="baren://file/{FILE}""#)));
    assert!(!html.contains("<script>"));

    let bad = srv.raw("GET", "/f/not%20an%20id", &[], None).await;
    assert_eq!(bad.status, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn pages_show_the_auth_artwork() {
    let srv = TestServer::start().await;
    let page = srv.raw("GET", &format!("/f/{FILE}"), &[], None).await;
    let html = page.text();
    assert!(html.contains(r#"<img src="/static/shell-background.webp""#));
    let csp = page.header("content-security-policy").unwrap_or_default();
    assert!(csp.contains("img-src data: 'self'"), "{csp}");

    let image = srv
        .raw("GET", "/static/shell-background.webp", &[], None)
        .await;
    assert_eq!(image.status, 200);
    assert_eq!(image.header("content-type"), Some("image/webp"));
    assert!(image.body.starts_with(b"RIFF"));
}
