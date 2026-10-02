//! HTML escaping and entity decoding.

use std::borrow::Cow;

/// Escape text content (`&`, `<`, `>`).
pub(crate) fn text(s: &str) -> Cow<'_, str> {
    escape(s, false)
}

/// Escape an attribute value for use inside double quotes.
pub(crate) fn attr(s: &str) -> Cow<'_, str> {
    escape(s, true)
}

fn escape(s: &str, attribute: bool) -> Cow<'_, str> {
    let needs = |c: char| matches!(c, '&' | '<' | '>') || (attribute && matches!(c, '"' | '\''));
    if !s.contains(needs) {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            '\'' if attribute => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

/// Decode the XML predefined entities, `&nbsp;` and numeric references.
/// Anything else is left as-is (and will be re-escaped on output).
pub(crate) fn decode_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest
            .find(';')
            .filter(|&end| end <= 12)
            .and_then(|end| decode_one(&rest[1..end]).map(|c| (c, end)));
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn decode_one(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{a0}'),
        _ => {
            let num = name.strip_prefix('#')?;
            let code = match num.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => num.parse().ok()?,
            };
            // NUL and invalid scalars decode to U+FFFD, like browsers do.
            Some(
                char::from_u32(code)
                    .filter(|&c| c != '\0')
                    .unwrap_or('\u{fffd}'),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes() {
        assert_eq!(text("a < b & c > d \"q\""), "a &lt; b &amp; c &gt; d \"q\"");
        assert_eq!(attr("x\"'<"), "x&quot;&#39;&lt;");
        assert!(matches!(text("plain"), Cow::Borrowed(_)));
    }

    #[test]
    fn decodes() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt;"), "a & b <c>");
        assert_eq!(decode_entities("&#106;&#x61;&#X76;"), "jav");
        assert_eq!(decode_entities("&unknown; & &#0;"), "&unknown; & \u{fffd}");
        assert_eq!(decode_entities("&#xFFFFFFFF;"), "\u{fffd}");
        assert_eq!(decode_entities("tail &"), "tail &");
    }
}
