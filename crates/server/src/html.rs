//! Server-rendered pages (the `/i/:token` invite and `/f/:id` file link pages), styled with the
//! app's design tokens (design/tokens.css) and laid out like its auth screens (18–20, 22–23):
//! the form column on the left, the brand artwork in an inset, rounded shell on the right.

use std::sync::LazyLock;

use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_FRAME_OPTIONS};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// The Baren seal (104×104 PNG), shown at 26px in the brand row of pages and emails.
pub const MARK_PNG: &[u8] = include_bytes!("../assets/baren-mark.png");

/// The auth screens' artwork (apps/desktop/src/renderer/auth/assets), served at [`SHELL_PATH`].
pub const SHELL_WEBP: &[u8] = include_bytes!("../assets/shell-background.webp");
pub const SHELL_PATH: &str = "/static/shell-background.webp";

/// `GET /static/shell-background.webp`
pub async fn shell_background() -> Response {
    let mut response = SHELL_WEBP.into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    response
}

/// [`MARK_PNG`] as a `data:` URI (small enough to inline in every page).
static MARK_DATA_URI: LazyLock<String> =
    LazyLock::new(|| format!("data:image/png;base64,{}", STANDARD.encode(MARK_PNG)));

/// Escape text for HTML element and attribute content.
pub fn escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const STYLE: &str = r#"
:root {
  --color-background: #FFFFFF; --color-surface: #F7F7F7; --color-canvas: #EEEEEE;
  --color-muted: #EBEBEB; --color-input: #F3F3F3; --color-border: #E5E5E5;
  --color-foreground: #1A1A1A; --color-foreground-muted: #666666; --color-foreground-subtle: #999999;
  --color-primary: #141414; --color-primary-foreground: #FFFFFF; --color-selection: #2F80FF;
  --color-brand: #D0391E; --color-brand-foreground: #FFFFFF; --color-danger: #C0233C;
  --font-sans: "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --text-xs: 11px; --text-sm: 12px; --text-base: 13px; --text-md: 14px;
  --font-weight-regular: 400; --font-weight-medium: 500; --font-weight-semibold: 600;
  --tracking-tight: -0.01em;
  --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--color-background); color: var(--color-foreground);
  font-family: var(--font-sans); font-size: var(--text-sm); line-height: 16px;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; font-synthesis: none;
  display: flex; min-height: 100vh;
}
.panel { display: flex; flex-direction: column; flex-shrink: 0; width: 560px; padding: 40px 64px 32px; }
.artwork { display: flex; flex: 1 1 0; min-width: 0; padding: 12px; }
.shell { position: relative; flex: 1 1 0; min-width: 0; overflow: hidden; border-radius: var(--radius-xl); }
.shell img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: right top; }
.shell::after { content: ""; position: absolute; inset: 0; border-radius: inherit;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 6%, transparent); }
@media (max-width: 900px) { .artwork { display: none; } .panel { width: 100%; } }
@media (max-width: 560px) { .panel { padding: 32px 20px 24px; } }
.brand { display: flex; align-items: center; gap: 10px; }
.mark { display: block; width: 26px; height: 26px; }
.wordmark { font-size: var(--text-md); font-weight: var(--font-weight-semibold);
  letter-spacing: var(--tracking-tight); line-height: 18px; }
main { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.stack { width: 100%; max-width: 368px; display: flex; flex-direction: column; gap: 28px; }
.icon {
  width: 48px; height: 48px; border-radius: 12px; background: var(--color-surface);
  box-shadow: var(--color-border) 0 0 0 1px inset; display: flex; align-items: center; justify-content: center;
}
.icon svg { width: 22px; height: 22px; fill: none; stroke: var(--color-foreground); stroke-width: 1.6;
  stroke-linecap: round; stroke-linejoin: round; }
.heading { display: flex; flex-direction: column; gap: 8px; }
h1 { margin: 0; font-size: 28px; line-height: 34px; font-weight: var(--font-weight-medium); letter-spacing: -0.025em; }
p { margin: 0; color: var(--color-foreground-muted); font-size: var(--text-md); line-height: 22px; }
strong { color: var(--color-foreground); font-weight: var(--font-weight-medium); }
.button {
  height: 40px; border: 0; border-radius: var(--radius-lg); display: flex; align-items: center; justify-content: center;
  gap: 8px; font: var(--font-weight-medium) var(--text-base)/16px var(--font-sans); cursor: pointer; text-decoration: none;
  background: var(--color-brand); color: var(--color-brand-foreground); width: 100%;
}
footer { display: flex; align-items: center; justify-content: flex-end; }
footer code { color: var(--color-foreground-subtle); font: var(--text-xs)/14px var(--font-mono); }
"#;

/// Lucide-style icon paths used by the pages.
pub mod icons {
    pub const USERS: &str = r#"<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>"#;
    pub const FILE: &str = r#"<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>"#;
    pub const ALERT: &str =
        r#"<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>"#;
}

/// A full page: brand row, a centred 368px column with `body`, and the footer.
pub fn page(status: StatusCode, title: &str, icon: &str, body: &str) -> Response {
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{title} · Baren</title>
<style>{STYLE}</style>
</head>
<body>
<div class="panel">
<header class="brand"><img class="mark" src="{mark}" width="26" height="26" alt=""><div class="wordmark">Baren</div></header>
<main><div class="stack">
<div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">{icon}</svg></div>
{body}
</div></main>
<footer><code>v{version}</code></footer>
</div>
<div class="artwork" aria-hidden="true"><div class="shell"><img src="{shell}" alt=""></div></div>
</body>
</html>"#,
        title = escape(title),
        mark = MARK_DATA_URI.as_str(),
        shell = SHELL_PATH,
        version = env!("CARGO_PKG_VERSION"),
    );
    let mut response = (status, Html(html)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; form-action 'none'; \
             frame-ancestors 'none'; base-uri 'none'",
        ),
    );
    headers.insert(X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // The invite page's URL carries the invite token: never send it on in a `Referer`.
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}

/// `<div class="heading"><h1>…</h1><p>…</p></div>`; `paragraph_html` must already be escaped.
pub fn heading(title: &str, paragraph_html: &str) -> String {
    format!(
        r#"<div class="heading"><h1>{}</h1><p>{paragraph_html}</p></div>"#,
        escape(title)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup() {
        assert_eq!(
            escape(r#"<a href="x">'&'</a>"#),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }
}
