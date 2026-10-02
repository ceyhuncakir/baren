//! "Continue in browser": device-code flow and the `/device` page.

mod common;

use common::TestServer;
use serde_json::json;

fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&")
        .into_bytes()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn device_flow_signs_the_app_in() {
    let srv = TestServer::start().await;
    srv.sign_up("ceyhun cakir", "ceyhun@example.com").await;

    let (status, start) = srv.api("POST", "/api/auth/device/start", None, None).await;
    assert_eq!(status, 200, "{start}");
    let device_code = start["deviceCode"].as_str().unwrap().to_string();
    let user_code = start["userCode"].as_str().unwrap().to_string();
    assert_eq!(user_code.len(), 7);
    assert_eq!(&user_code[3..4], "-");
    assert_eq!(
        start["verifyUrl"],
        format!("http://{}/device?code={user_code}", srv.addr).as_str()
    );
    assert_eq!(start["interval"], 2);

    let poll = || {
        srv.api(
            "POST",
            "/api/auth/device/poll",
            None,
            Some(json!({ "deviceCode": device_code })),
        )
    };
    let (status, body) = poll().await;
    assert_eq!((status, body["status"].as_str()), (200, Some("pending")));

    // The browser page shows the code and a sign-in form.
    let page = srv
        .raw("GET", &format!("/device?code={user_code}"), &[], None)
        .await;
    assert_eq!(page.status, 200);
    let html = page.text();
    assert!(html.contains(&user_code));
    assert!(html.contains("Sign in and approve"));
    assert_eq!(page.header("referrer-policy"), Some("same-origin"));
    assert!(page
        .header("content-security-policy")
        .unwrap()
        .contains("default-src 'none'"));

    // Wrong password: stays pending.
    let host = srv.addr.to_string();
    let origin = format!("http://{host}");
    let headers = [
        ("content-type", "application/x-www-form-urlencoded"),
        ("origin", origin.as_str()),
    ];
    let res = srv
        .raw(
            "POST",
            "/device",
            &headers,
            Some(form(&[
                ("code", &user_code.to_lowercase()),
                ("action", "approve"),
                ("email", "ceyhun@example.com"),
                ("password", "nope nope"),
            ])),
        )
        .await;
    assert_eq!(res.status, 401);
    assert!(res.text().contains("Email or password is incorrect."));
    assert_eq!(poll().await.1["status"], "pending");

    // Cross-site posts are refused.
    let res = srv
        .raw(
            "POST",
            "/device",
            &[
                ("content-type", "application/x-www-form-urlencoded"),
                ("origin", "https://evil.example"),
            ],
            Some(form(&[("code", &user_code), ("action", "approve")])),
        )
        .await;
    assert_eq!(res.status, 403);

    // Correct credentials approve it and set the page's session cookie.
    let res = srv
        .raw(
            "POST",
            "/device",
            &headers,
            Some(form(&[
                ("code", &user_code),
                ("action", "approve"),
                ("email", "ceyhun@example.com"),
                ("password", "correct horse battery"),
            ])),
        )
        .await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(res.text().contains("baren://auth/"));
    let cookie = res.header("set-cookie").unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));

    // The app's next poll receives a working token, exactly once.
    let (status, body) = poll().await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], "ok", "{body}");
    assert_eq!(body["user"]["email"], "ceyhun@example.com");
    let token = body["token"].as_str().unwrap();
    let (status, _) = srv.api("GET", "/api/me", Some(token), None).await;
    assert_eq!(status, 200);
    assert_eq!(poll().await.1["status"], "expired");

    // A second request can be approved with just the cookie, and denied too.
    let (_, start2) = srv.api("POST", "/api/auth/device/start", None, None).await;
    let code2 = start2["userCode"].as_str().unwrap();
    let session = cookie.split(';').next().unwrap();
    let page = srv
        .raw(
            "GET",
            &format!("/device?code={code2}"),
            &[("cookie", session)],
            None,
        )
        .await;
    assert!(page.text().contains("Signed in as"));
    let res = srv
        .raw(
            "POST",
            "/device",
            &[
                ("content-type", "application/x-www-form-urlencoded"),
                ("cookie", session),
            ],
            Some(form(&[("code", code2), ("action", "deny")])),
        )
        .await;
    assert_eq!(res.status, 200);
    let (_, body) = srv
        .api(
            "POST",
            "/api/auth/device/poll",
            None,
            Some(json!({ "deviceCode": start2["deviceCode"] })),
        )
        .await;
    assert_eq!(body["status"], "denied");

    // Unknown codes.
    let page = srv.raw("GET", "/device?code=ZZZ-ZZZ", &[], None).await;
    assert_eq!(page.status, 400);
    let (status, _) = srv
        .api(
            "POST",
            "/api/auth/device/poll",
            None,
            Some(json!({ "deviceCode": "nope" })),
        )
        .await;
    assert_eq!(status, 404);
}
