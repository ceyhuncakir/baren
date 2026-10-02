//! Email templates (`crates/server/templates/`), embedded at compile time.
//!
//! Each message has an HTML body and a plain-text body (`<kind>.txt`). The HTML is
//! `layout.html` (brand row, white card, footer) filled from `<kind>.html`: the part before
//! `<!-- footer -->` goes into the card, the part after it is the footer line. They reproduce
//! the artboards 26–28 ("Email — Verification code / Password reset / Team invite") in
//! email-safe markup: nested tables, inline styles, 600 px wide, no external images, scripts or
//! web fonts (Inter and JetBrains Mono are named first and fall back to system fonts).
//! Placeholders are `{{name}}` (HTML-escaped in HTML templates) and `{{{name}}}` (inserted as
//! is; only the layout's `content` and `footer` slots).

use baren_proto::dto::Role;

use super::Email;
use crate::dates::long_date;
use crate::html::escape;

const LAYOUT_HTML: &str = include_str!("../../templates/layout.html");
const VERIFICATION_HTML: &str = include_str!("../../templates/verification_code.html");
const VERIFICATION_TXT: &str = include_str!("../../templates/verification_code.txt");
const RESET_HTML: &str = include_str!("../../templates/password_reset.html");
const RESET_TXT: &str = include_str!("../../templates/password_reset.txt");
const INVITE_HTML: &str = include_str!("../../templates/team_invite.html");
const INVITE_TXT: &str = include_str!("../../templates/team_invite.txt");

/// How long emailed codes stay valid (keep in sync with `routes::auth`).
pub const CODE_TTL_MINUTES: u32 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub subject: String,
    /// The inbox preview line (hidden text at the top of the HTML).
    pub preheader: String,
    pub text: String,
    pub html: String,
}

/// Render one message.
pub fn render(email: &Email) -> Rendered {
    let minutes = CODE_TTL_MINUTES.to_string();
    let to = email.to().to_string();
    let (subject, preheader, vars, html, txt): (String, String, Vec<(&str, String)>, &str, &str) =
        match email {
            Email::VerificationCode { name, code, .. } => (
                format!("{code} is your Baren verification code"),
                format!("Enter {code} to verify your email. It expires in {minutes} minutes."),
                vec![
                    ("to", to),
                    ("first_name", first_name(name)),
                    ("code", code.clone()),
                    ("code_display", spaced_code(code)),
                    ("minutes", minutes),
                ],
                VERIFICATION_HTML,
                VERIFICATION_TXT,
            ),
            Email::PasswordReset { code, .. } => (
                format!("{code} is your Baren password reset code"),
                format!("Enter {code} to choose a new password. It expires in {minutes} minutes."),
                vec![
                    ("to", to),
                    ("code", code.clone()),
                    ("code_display", spaced_code(code)),
                    ("minutes", minutes),
                ],
                RESET_HTML,
                RESET_TXT,
            ),
            Email::TeamInvite {
                inviter_name,
                inviter_email,
                team_name,
                member_count,
                role,
                url,
                expires_at,
                ..
            } => {
                let expiry = match expires_at {
                    Some(at) => format!("This invite expires on {}.", long_date(*at)),
                    None => "This invite does not expire.".to_string(),
                };
                let members = match member_count {
                    1 => "1 member".to_string(),
                    n => format!("{n} members"),
                };
                let (role_title, access) = match role {
                    Role::Admin => ("an Admin", "can open every file shared with the team"),
                    Role::Editor => ("an Editor", "can open every file shared with the team"),
                    Role::Viewer => ("a Viewer", "can view every file shared with the team"),
                };
                (
                    format!("{inviter_name} invited you to {team_name} on Baren"),
                    format!(
                        "Join {team_name} as {} and design together.",
                        role_title.to_lowercase()
                    ),
                    vec![
                        ("to", to),
                        ("inviter_name", inviter_name.clone()),
                        ("inviter_email", inviter_email.clone()),
                        ("team_name", team_name.clone()),
                        ("team_initial", initial(team_name)),
                        ("members", members),
                        ("role", role_title.to_string()),
                        ("access", access.to_string()),
                        ("url", url.clone()),
                        ("expiry", expiry),
                    ],
                    INVITE_HTML,
                    INVITE_TXT,
                )
            }
        };
    // Each body template is `<card content><!-- footer --><footer line>`.
    let (content, footer) = html.split_once(FOOTER_MARKER).unwrap_or((html, ""));
    let mut layout_vars = vars.clone();
    layout_vars.push(("subject", subject.clone()));
    layout_vars.push(("preheader", preheader.clone()));
    layout_vars.push(("content", fill(content.trim(), &vars, true)));
    layout_vars.push(("footer", fill(footer.trim(), &vars, true)));
    Rendered {
        html: fill(LAYOUT_HTML, &layout_vars, true),
        text: fill(txt, &vars, false),
        subject,
        preheader,
    }
}

/// Separates a body template's card content from its footer line.
const FOOTER_MARKER: &str = "<!-- footer -->";

/// "ceyhun cakir" → "ceyhun".
fn first_name(name: &str) -> String {
    name.split_whitespace().next().unwrap_or(name).to_string()
}

/// "482719" → "482 719" (the designs' grouping; pasting it back still works).
fn spaced_code(code: &str) -> String {
    if code.len() == 6 && code.is_ascii() {
        format!("{} {}", &code[..3], &code[3..])
    } else {
        code.to_string()
    }
}

/// The team avatar letter: "ceyhun's Team" → "C".
fn initial(name: &str) -> String {
    name.chars()
        .find(|c| c.is_alphanumeric())
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_else(|| "#".into())
}

/// Replace `{{name}}` (escaped when `html`) and `{{{name}}}` (raw). Unknown names render as
/// nothing (the template tests make sure there are none).
pub fn fill(template: &str, vars: &[(&str, String)], html: bool) -> String {
    let lookup = |key: &str| {
        vars.iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    };
    let mut out = String::with_capacity(template.len() + 256);
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let (raw, open, close) = if after.starts_with("{{{") {
            (true, 3, "}}}")
        } else {
            (false, 2, "}}")
        };
        let Some(end) = after[open..].find(close) else {
            out.push_str(after);
            return out;
        };
        let key = after[open..open + end].trim();
        let value = lookup(key).unwrap_or("");
        if raw || !html {
            out.push_str(value);
        } else {
            out.push_str(&escape(value));
        }
        rest = &after[open + end + close.len()..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The data shown in the artboards 26–28.
    pub(crate) fn samples() -> Vec<Email> {
        vec![
            Email::VerificationCode {
                to: "ceyhun@example.com".into(),
                name: "ceyhun cakir".into(),
                code: "482719".into(),
            },
            Email::PasswordReset {
                to: "ceyhun@example.com".into(),
                name: "ceyhun cakir".into(),
                code: "530216".into(),
            },
            Email::TeamInvite {
                to: "defne@example.com".into(),
                inviter_name: "ceyhun cakir".into(),
                inviter_email: "ceyhun@example.com".into(),
                team_name: "ceyhun's Team".into(),
                member_count: 3,
                role: Role::Editor,
                url: "https://baren.dev/i/7Kq2xM9vRb4tPzW8".into(),
                // 2026-10-16T09:00:00Z
                expires_at: Some(1_792_141_200_000),
            },
        ]
    }

    #[test]
    fn fills_and_escapes() {
        let vars = [("a", "<b>&".to_string()), ("c", "<i>".to_string())];
        assert_eq!(
            fill("x{{a}}y{{{c}}}z{{ a }}", &vars, true),
            "x&lt;b&gt;&amp;y<i>z&lt;b&gt;&amp;"
        );
        assert_eq!(fill("{{a}} {{missing}}!", &vars, false), "<b>& !");
        assert_eq!(fill("unterminated {{a", &vars, true), "unterminated {{a");
    }

    #[test]
    fn every_template_renders_completely() {
        for email in samples() {
            let r = render(&email);
            for (part, body) in [("text", &r.text), ("html", &r.html)] {
                assert!(
                    !body.contains("{{"),
                    "{} {part} has a placeholder left",
                    email.kind()
                );
                assert!(
                    !body.contains("}}"),
                    "{} {part} has a placeholder left",
                    email.kind()
                );
            }
            assert!(r.html.starts_with("<!DOCTYPE html"), "{}", email.kind());
            assert!(r.html.contains(&escape(&r.preheader)));
            assert!(!r.subject.contains('\n'));
            if let Some(code) = email.code() {
                assert!(r.subject.contains(code));
                assert!(r.text.contains(code));
                assert!(r.html.contains(&spaced_code(code)));
            }
            assert!(!r.html.contains(FOOTER_MARKER));
            assert!(r.html.contains("Local-first design, together."));
            assert!(r.text.contains(email.to()));
            if let Some(url) = email.url() {
                assert!(r.text.contains(url));
                assert!(r.html.contains(&format!("href=\"{url}\"")));
            }
        }
    }

    #[test]
    fn copy_matches_the_designs() {
        let [verify, reset, invite] = samples().try_into().unwrap();
        let r = render(&verify);
        assert!(r
            .html
            .contains("Hi ceyhun, enter this code in Baren to finish setting up your account."));
        assert!(r.html.contains(">482 719<"));
        assert!(r
            .html
            .contains("someone signed up for Baren with ceyhun@example.com."));
        let r = render(&reset);
        assert!(r
            .html
            .contains("reset the password for ceyhun@example.com. Enter this code"));
        let r = render(&invite);
        assert_eq!(
            r.subject,
            "ceyhun cakir invited you to ceyhun's Team on Baren"
        );
        assert!(r.html.contains("Join ceyhun&#39;s Team on Baren"));
        assert!(r.html.contains(
            "You&#39;ll join as an Editor and can open every file shared with the team."
        ));
        assert!(r
            .html
            .contains("Invited by ceyhun cakir &middot; 3 members"));
        assert!(r.html.contains(">C<"));
        assert!(r.html.contains("This invite expires on October 16, 2026."));
        assert!(r
            .html
            .contains("ceyhun cakir (ceyhun@example.com) invited defne@example.com"));
    }

    #[test]
    fn user_data_is_escaped() {
        let r = render(&Email::TeamInvite {
            to: "x@y.io".into(),
            inviter_name: "<script>alert(1)</script>".into(),
            inviter_email: "a@b.io".into(),
            team_name: "Tom & Jerry".into(),
            member_count: 1,
            role: Role::Viewer,
            url: "https://x.example/i/a\"b".into(),
            expires_at: None,
        });
        assert!(!r.html.contains("<script>"));
        assert!(r.html.contains("Tom &amp; Jerry"));
        assert!(r.html.contains("https://x.example/i/a&quot;b"));
        assert!(r.html.contains("1 member<"));
        assert!(r.html.contains("as a Viewer and can view every file"));
        assert!(r.text.contains("This invite does not expire."));
        // The plain-text part is not HTML: no escaping there.
        assert!(r.text.contains("Tom & Jerry"));
    }

    /// `BAREN_EMAIL_PREVIEW_DIR=<dir> cargo test -p baren-server write_previews` writes
    /// each rendered HTML email to `<dir>/<kind>.html` (used for the screenshot comparison).
    #[test]
    fn write_previews() {
        let Some(dir) = std::env::var_os("BAREN_EMAIL_PREVIEW_DIR") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        for email in samples() {
            let r = render(&email);
            std::fs::write(dir.join(format!("{}.html", email.kind())), &r.html).unwrap();
            std::fs::write(dir.join(format!("{}.txt", email.kind())), &r.text).unwrap();
        }
    }
}
