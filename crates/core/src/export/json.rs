//! JSON printed the way `JSON.stringify(value, null, 2)` prints it: serde_json's
//! pretty printer (same layout and string escaping as JS) with numbers
//! formatted by ECMAScript `Number::toString`.

use std::io;

use serde::Serialize;
use serde_json::ser::{Formatter, PrettyFormatter};

use crate::error::Result;
use crate::export::assets::asset_refs;
use crate::schema::{NodeMap, NodeType, StyleValue};
use crate::util::is_blake3_hex;

/// Every asset hash a snapshot references (image layers, image fills and hidden
/// fills — JSON export keeps everything), in first-seen order.
pub fn snapshot_asset_refs(nodes: &NodeMap) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |h: &str| {
        if !out.iter().any(|o| o == h) {
            out.push(h.to_owned());
        }
    };
    for node in nodes.iter() {
        if node.node_type == NodeType::Image {
            if let Some(h) = node.asset_id.as_deref().filter(|h| is_blake3_hex(h)) {
                push(h);
            }
        }
        for (_, v) in node.styles.iter() {
            if let StyleValue::Str(s) = v {
                for h in asset_refs(s) {
                    push(h);
                }
            }
        }
        // Instance overrides reference assets too (contract §3.5).
        for (_, entry) in node.overrides.iter().flat_map(|o| o.iter()) {
            if let Some(h) = entry.asset_id.as_deref().filter(|h| is_blake3_hex(h)) {
                push(h);
            }
            for (_, v) in entry.styles.iter().flat_map(|s| s.0.iter()) {
                if let Some(StyleValue::Str(s)) = v {
                    for h in asset_refs(s) {
                        push(h);
                    }
                }
            }
        }
    }
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn to_string_pretty<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    let mut out = Vec::with_capacity(4096);
    let mut ser =
        serde_json::Serializer::with_formatter(&mut out, JsPretty(PrettyFormatter::new()));
    value.serialize(&mut ser)?;
    Ok(String::from_utf8(out).expect("serde_json writes UTF-8"))
}

/// ECMAScript `Number::toString(x)` for a finite double (`1e+21`, `1e-7`,
/// `0.000001`, `123.5`). Non-finite values are `null`, as in JSON.
pub fn js_number(x: f64) -> String {
    if !x.is_finite() {
        return "null".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    // Rust's `{:e}` prints the shortest digits that round-trip: "d.ddde±x".
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').expect("LowerExp has an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("integer exponent") + 1;
    let mut s = String::with_capacity(24);
    if x < 0.0 {
        s.push('-');
    }
    if k <= n && n <= 21 {
        s.push_str(&digits);
        s.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        s.push_str(&digits[..n as usize]);
        s.push('.');
        s.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        s.push_str("0.");
        s.extend(std::iter::repeat_n('0', (-n) as usize));
        s.push_str(&digits);
    } else {
        s.push_str(&digits[..1]);
        if k > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        s.push('e');
        s.push(if n > 0 { '+' } else { '-' });
        s.push_str(&(n - 1).abs().to_string());
    }
    s
}

struct JsPretty<'a>(PrettyFormatter<'a>);

impl Formatter for JsPretty<'_> {
    fn write_f64<W: ?Sized + io::Write>(&mut self, w: &mut W, value: f64) -> io::Result<()> {
        w.write_all(js_number(value).as_bytes())
    }

    fn begin_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_array(w)
    }

    fn end_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array(w)
    }

    fn begin_array_value<W: ?Sized + io::Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.0.begin_array_value(w, first)
    }

    fn end_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array_value(w)
    }

    fn begin_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object(w)
    }

    fn end_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object(w)
    }

    fn begin_object_key<W: ?Sized + io::Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.0.begin_object_key(w, first)
    }

    fn begin_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object_value(w)
    }

    fn end_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object_value(w)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{DesignNode, OverrideEntry, OverrideStyles, Overrides};

    #[test]
    fn asset_refs_include_overrides() {
        let h = |c: char| c.to_string().repeat(64);
        let mut nodes = NodeMap::default();
        nodes.insert(DesignNode {
            id: "1@1".into(),
            node_type: NodeType::Instance,
            overrides: Some(Overrides(vec![
                (
                    "abcdefghij".into(),
                    OverrideEntry {
                        asset_id: Some(h('a')),
                        ..Default::default()
                    },
                ),
                (
                    String::new(),
                    OverrideEntry {
                        styles: Some(OverrideStyles(vec![
                            (
                                "backgroundImage".into(),
                                Some(format!(r#"url("baren-asset://{}")"#, h('b')).into()),
                            ),
                            ("gone".into(), None),
                        ])),
                        ..Default::default()
                    },
                ),
            ])),
            ..Default::default()
        });
        assert_eq!(snapshot_asset_refs(&nodes), [h('a'), h('b')]);
    }

    #[test]
    fn numbers_match_ecmascript() {
        // Expected strings are what `String(x)` prints in Node 22.
        let cases: [(f64, &str); 14] = [
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123.5, "123.5"),
            (-0.6, "-0.6"),
            (2f64.powi(60), "1152921504606847000"),
            (1e20, "100000000000000000000"),
            (123_456_789.125, "123456789.125"),
            (-1.7976931348623157e308, "-1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (-0.0, "0"),
            (f64::NAN, "null"),
        ];
        for (x, expected) in cases {
            assert_eq!(js_number(x), expected, "{x:e}");
        }
    }

    #[test]
    fn pretty_layout_matches_json_stringify() {
        let v = serde_json::json!({ "a": [], "b": {}, "c": [1, "x"], "d": { "e": 0.5 } });
        assert_eq!(
            to_string_pretty(&v).unwrap(),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    \"x\"\n  ],\n  \"d\": {\n    \"e\": 0.5\n  }\n}"
        );
    }
}
