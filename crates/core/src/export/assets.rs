//! Asset references inside style values (mirror of `packages/schema/src/assets.ts`).
//!
//! Image fills are stored as `backgroundImage: url("baren-asset://<blake3 hex>")`
//! (possibly inside a larger value such as a `-webkit-cross-fade(...)` used for fill
//! opacity). Exporters find those tokens and replace the whole `url(...)` token.

use crate::util::is_blake3_hex;

/// `baren-asset://` — the scheme the Electron main process serves.
pub const ASSET_URL_PREFIX: &str = "baren-asset://";

/// One `url(baren-asset://<hash>)` token: byte range of the whole token and the hash.
struct Token<'a> {
    start: usize,
    end: usize,
    hash: &'a str,
}

/// Every well-formed asset URL token in `value`, in order.
fn tokens(value: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut from = 0;
    while let Some(rel) = value[from..].find(ASSET_URL_PREFIX) {
        let at = from + rel;
        from = at + ASSET_URL_PREFIX.len();
        let hash_end = from + 64;
        let Some(hash) = value.get(from..hash_end).filter(|h| is_blake3_hex(h)) else {
            continue;
        };
        // Backwards: optional quote, optional whitespace, then `url(`.
        let mut s = at;
        let quote = match s.checked_sub(1).map(|i| bytes[i]) {
            Some(q @ (b'"' | b'\'')) => {
                s -= 1;
                Some(q)
            }
            _ => None,
        };
        while s > 0 && bytes[s - 1].is_ascii_whitespace() {
            s -= 1;
        }
        if s < 4 || !value[..s].to_ascii_lowercase().ends_with("url(") {
            continue;
        }
        let start = s - 4;
        // Forwards: the matching quote, optional whitespace, then `)`.
        let mut e = hash_end;
        if let Some(q) = quote {
            if bytes.get(e) != Some(&q) {
                continue;
            }
            e += 1;
        }
        while e < bytes.len() && bytes[e].is_ascii_whitespace() {
            e += 1;
        }
        if bytes.get(e) != Some(&b')') {
            continue;
        }
        out.push(Token {
            start,
            end: e + 1,
            hash,
        });
        from = e + 1;
    }
    out
}

/// Distinct asset hashes referenced by `url(baren-asset://…)` tokens in `value`.
pub fn asset_refs(value: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    if !value.contains(ASSET_URL_PREFIX) {
        return out;
    }
    for t in tokens(value) {
        if !out.contains(&t.hash) {
            out.push(t.hash);
        }
    }
    out
}

/// `value` with every asset URL token replaced by `map(hash)` (a whole CSS image).
pub fn rewrite_asset_urls(value: &str, mut map: impl FnMut(&str) -> String) -> String {
    if !value.contains(ASSET_URL_PREFIX) {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len());
    let mut last = 0;
    for t in tokens(value) {
        out.push_str(&value[last..t.start]);
        out.push_str(&map(t.hash));
        last = t.end;
    }
    out.push_str(&value[last..]);
    out
}

/// Style keys whose values can carry image fills.
pub fn is_image_property(key: &str) -> bool {
    matches!(key, "backgroundImage" | "background")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(c: char) -> String {
        c.to_string().repeat(64)
    }

    #[test]
    fn finds_tokens_with_any_quoting() {
        let (a, b) = (h('a'), h('b'));
        let v = format!(
            r#"url("baren-asset://{a}"), url( 'baren-asset://{b}' ), url(baren-asset://{a})"#
        );
        assert_eq!(asset_refs(&v), [a.as_str(), b.as_str()]);
        assert!(asset_refs("url(https://x/y.png)").is_empty());
        assert!(
            asset_refs(&format!("baren-asset://{a}")).is_empty(),
            "needs url()"
        );
        assert!(
            asset_refs(&format!(r#"url("baren-asset://{a}')"#)).is_empty(),
            "quotes must match"
        );
        assert!(asset_refs(&format!("url(baren-asset://{})", "A".repeat(64))).is_empty());
    }

    #[test]
    fn rewrites_whole_tokens() {
        let a = h('a');
        let v = format!(
            r#"-webkit-cross-fade(url("baren-asset://{a}"), url("data:image/gif;base64,R0lG"), 0.25)"#
        );
        let out = rewrite_asset_urls(&v, |hash| {
            format!(r#"url("data:image/png;base64,{}")"#, &hash[..2])
        });
        assert_eq!(
            out,
            r#"-webkit-cross-fade(url("data:image/png;base64,aa"), url("data:image/gif;base64,R0lG"), 0.25)"#
        );
        assert_eq!(rewrite_asset_urls("red", |_| unreachable!()), "red");
    }
}
