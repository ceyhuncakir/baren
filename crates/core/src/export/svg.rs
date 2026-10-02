//! SVG sanitizer for HTML export.
//!
//! The markup is tokenised and **re-serialised** from an allowlist: only known
//! presentational SVG elements and attributes survive, entities are decoded
//! and re-escaped, comments/PIs/doctypes are dropped, and disallowed elements
//! (`script`, `style`, `foreignObject`, `a`, animation elements, …) are removed
//! with their whole subtree. References must be local (`#id`), except raster
//! `data:` images on `<image>`. Nothing from the input reaches the output
//! verbatim, so malformed markup cannot smuggle anything through.

use super::css::is_safe_value;
use super::escape::{attr as escape_attr, decode_entities, text as escape_text};

/// Sanitise `markup` and return a single `<svg>` element. `root_style` is
/// appended to the root element's `style` (node styles win over the markup's).
pub(crate) fn sanitize(markup: &str, root_style: Option<&str>) -> String {
    let mut out = String::with_capacity(markup.len());
    let mut open: Vec<&'static str> = Vec::new();
    // While Some(depth), we are inside a dropped subtree.
    let mut skip: Option<usize> = None;
    let mut root_closed = false;

    for token in Tokenizer::new(markup) {
        if root_closed {
            break;
        }
        if let Some(depth) = skip.as_mut() {
            match token {
                Token::Start {
                    self_closing: false,
                    ..
                } => *depth += 1,
                Token::End { .. } => {
                    *depth -= 1;
                    if *depth == 0 {
                        skip = None;
                    }
                }
                _ => {}
            }
            continue;
        }
        match token {
            Token::Start {
                name,
                attrs,
                self_closing,
            } => {
                let canonical = element(name).filter(|&e| !open.is_empty() || e == "svg");
                let Some(el) = canonical else {
                    if !self_closing {
                        skip = Some(1);
                    }
                    continue;
                };
                let is_root = open.is_empty();
                write_start(
                    &mut out,
                    el,
                    &attrs,
                    is_root.then_some(root_style).flatten(),
                );
                if self_closing {
                    out.push_str("/>");
                    root_closed = is_root;
                } else {
                    out.push('>');
                    open.push(el);
                }
            }
            Token::End { name } => {
                let Some(el) = element(name) else { continue };
                if let Some(pos) = open.iter().rposition(|&o| o == el) {
                    while open.len() > pos {
                        let top = open.pop().expect("non-empty");
                        out.push_str("</");
                        out.push_str(top);
                        out.push('>');
                    }
                    root_closed = open.is_empty();
                }
            }
            Token::Text(t) => {
                if !open.is_empty() {
                    out.push_str(&escape_text(&decode_entities(t)));
                }
            }
            Token::Cdata(t) => {
                if !open.is_empty() {
                    out.push_str(&escape_text(t));
                }
            }
        }
    }
    while let Some(top) = open.pop() {
        out.push_str("</");
        out.push_str(top);
        out.push('>');
    }
    if out.is_empty() {
        write_start(&mut out, "svg", &[], root_style);
        out.push_str("></svg>");
    }
    out
}

fn write_start(
    out: &mut String,
    el: &'static str,
    attrs: &[(&str, &str)],
    extra_style: Option<&str>,
) {
    out.push('<');
    out.push_str(el);
    let mut style: Option<String> = None;
    for &(raw_name, raw_value) in attrs {
        let Some(name) = attribute(raw_name) else {
            continue;
        };
        let value = decode_entities(raw_value);
        if !attribute_value_ok(el, name, &value) {
            continue;
        }
        if name == "style" {
            style = Some(value.into_owned());
            continue;
        }
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        out.push_str(&escape_attr(&value));
        out.push('"');
    }
    let style = match (style, extra_style.filter(|s| !s.is_empty())) {
        (Some(a), Some(b)) => Some(format!("{}; {b}", a.trim_end_matches([';', ' ']))),
        (a, b) => a.or_else(|| b.map(str::to_owned)),
    };
    if let Some(style) = style {
        out.push_str(" style=\"");
        out.push_str(&escape_attr(&style));
        out.push('"');
    }
}

fn attribute_value_ok(el: &str, name: &str, value: &str) -> bool {
    let squashed: String = value
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .flat_map(char::to_lowercase)
        .collect();
    if matches!(name, "href" | "xlink:href") {
        let raster = ["png", "jpeg", "jpg", "gif", "webp", "avif"]
            .iter()
            .any(|t| squashed.starts_with(&format!("data:image/{t};base64,")));
        return squashed.starts_with('#') || (el == "image" && raster);
    }
    if squashed.contains("javascript:")
        || squashed.contains("vbscript:")
        || squashed.contains("data:")
    {
        return false;
    }
    // Paint servers, clip paths, masks, filters and markers: local refs only.
    let mut rest = squashed.as_str();
    while let Some(i) = rest.find("url(") {
        rest = &rest[i + 4..];
        if !rest.trim_start_matches(['"', '\'']).starts_with('#') {
            return false;
        }
    }
    name != "style" || is_safe_value(value)
}

/// Canonical name of an allowed element (SVG is case-sensitive, but accept
/// any casing of the known names).
fn element(name: &str) -> Option<&'static str> {
    const ELEMENTS: &[&str] = &[
        "svg",
        "g",
        "defs",
        "symbol",
        "use",
        "title",
        "desc",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "text",
        "tspan",
        "textPath",
        "linearGradient",
        "radialGradient",
        "stop",
        "clipPath",
        "mask",
        "pattern",
        "marker",
        "image",
        "filter",
        "feBlend",
        "feColorMatrix",
        "feComponentTransfer",
        "feComposite",
        "feConvolveMatrix",
        "feDiffuseLighting",
        "feDisplacementMap",
        "feDistantLight",
        "feDropShadow",
        "feFlood",
        "feFuncA",
        "feFuncB",
        "feFuncG",
        "feFuncR",
        "feGaussianBlur",
        "feMerge",
        "feMergeNode",
        "feMorphology",
        "feOffset",
        "fePointLight",
        "feSpecularLighting",
        "feSpotLight",
        "feTile",
        "feTurbulence",
    ];
    ELEMENTS
        .iter()
        .copied()
        .find(|e| e.eq_ignore_ascii_case(name))
}

/// Canonical name of an allowed attribute. Event handlers (`on*`), `xmlns:*`
/// other than xlink, and anything unknown are dropped.
fn attribute(name: &str) -> Option<&'static str> {
    const ATTRIBUTES: &[&str] = &[
        "id",
        "class",
        "style",
        "transform",
        "d",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "fx",
        "fy",
        "fr",
        "dx",
        "dy",
        "width",
        "height",
        "viewBox",
        "preserveAspectRatio",
        "points",
        "pathLength",
        "fill",
        "fill-opacity",
        "fill-rule",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-miterlimit",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-opacity",
        "opacity",
        "clip-path",
        "clip-rule",
        "mask",
        "filter",
        "color",
        "display",
        "visibility",
        "overflow",
        "offset",
        "stop-color",
        "stop-opacity",
        "gradientUnits",
        "gradientTransform",
        "spreadMethod",
        "patternUnits",
        "patternContentUnits",
        "patternTransform",
        "clipPathUnits",
        "maskUnits",
        "maskContentUnits",
        "filterUnits",
        "primitiveUnits",
        "markerWidth",
        "markerHeight",
        "markerUnits",
        "refX",
        "refY",
        "orient",
        "marker-start",
        "marker-mid",
        "marker-end",
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "text-anchor",
        "dominant-baseline",
        "alignment-baseline",
        "baseline-shift",
        "letter-spacing",
        "word-spacing",
        "text-decoration",
        "rotate",
        "textLength",
        "lengthAdjust",
        "startOffset",
        "xmlns",
        "xmlns:xlink",
        "version",
        "href",
        "xlink:href",
        "in",
        "in2",
        "result",
        "stdDeviation",
        "mode",
        "operator",
        "k1",
        "k2",
        "k3",
        "k4",
        "values",
        "type",
        "tableValues",
        "slope",
        "intercept",
        "amplitude",
        "exponent",
        "kernelMatrix",
        "order",
        "divisor",
        "bias",
        "targetX",
        "targetY",
        "edgeMode",
        "kernelUnitLength",
        "preserveAlpha",
        "surfaceScale",
        "diffuseConstant",
        "specularConstant",
        "specularExponent",
        "lighting-color",
        "flood-color",
        "flood-opacity",
        "baseFrequency",
        "numOctaves",
        "seed",
        "stitchTiles",
        "scale",
        "xChannelSelector",
        "yChannelSelector",
        "radius",
        "azimuth",
        "elevation",
        "pointsAtX",
        "pointsAtY",
        "pointsAtZ",
        "limitingConeAngle",
        "shape-rendering",
        "color-interpolation",
        "color-interpolation-filters",
        "vector-effect",
        "paint-order",
        "mix-blend-mode",
        "isolation",
        "role",
        "aria-hidden",
        "aria-label",
        "focusable",
    ];
    ATTRIBUTES
        .iter()
        .copied()
        .find(|a| a.eq_ignore_ascii_case(name))
}

enum Token<'a> {
    Start {
        name: &'a str,
        attrs: Vec<(&'a str, &'a str)>,
        self_closing: bool,
    },
    End {
        name: &'a str,
    },
    Text(&'a str),
    Cdata(&'a str),
}

struct Tokenizer<'a> {
    src: &'a str,
    pos: usize,
}

impl<'a> Tokenizer<'a> {
    fn new(src: &'a str) -> Self {
        Tokenizer { src, pos: 0 }
    }

    fn rest(&self) -> &'a str {
        &self.src[self.pos..]
    }

    /// Skip past `pat` (or to the end).
    fn skip_past(&mut self, pat: &str) {
        self.pos = match self.rest().find(pat) {
            Some(i) => self.pos + i + pat.len(),
            None => self.src.len(),
        };
    }

    fn name_len(s: &str) -> usize {
        s.bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.'))
            .count()
    }

    fn skip_ws(&mut self) {
        let ws = self
            .rest()
            .bytes()
            .take_while(u8::is_ascii_whitespace)
            .count();
        self.pos += ws;
    }

    /// Parse a start tag at `<name`; `None` if it is never terminated.
    fn start_tag(&mut self) -> Option<Token<'a>> {
        self.pos += 1; // '<'
        let len = Self::name_len(self.rest());
        let name = &self.rest()[..len];
        self.pos += len;
        let mut attrs = Vec::new();
        loop {
            self.skip_ws();
            let rest = self.rest();
            if rest.is_empty() {
                return None;
            }
            if let Some(after) = rest.strip_prefix("/>") {
                self.pos = self.src.len() - after.len();
                return Some(Token::Start {
                    name,
                    attrs,
                    self_closing: true,
                });
            }
            if rest.starts_with('>') {
                self.pos += 1;
                return Some(Token::Start {
                    name,
                    attrs,
                    self_closing: false,
                });
            }
            let len = rest
                .bytes()
                .take_while(|b| !b.is_ascii_whitespace() && !matches!(b, b'=' | b'>' | b'/'))
                .count();
            if len == 0 {
                self.pos += 1; // stray '/' or '='
                continue;
            }
            let attr_name = &rest[..len];
            self.pos += len;
            self.skip_ws();
            let mut value = "";
            if self.rest().starts_with('=') {
                self.pos += 1;
                self.skip_ws();
                let rest = self.rest();
                match rest.chars().next() {
                    Some(q @ ('"' | '\'')) => {
                        let body = &rest[1..];
                        let end = body.find(q).unwrap_or(body.len());
                        value = &body[..end];
                        self.pos += 1 + end + usize::from(end < body.len());
                    }
                    _ => {
                        let end = rest
                            .bytes()
                            .take_while(|b| !b.is_ascii_whitespace() && *b != b'>')
                            .count();
                        value = &rest[..end];
                        self.pos += end;
                    }
                }
            }
            attrs.push((attr_name, value));
        }
    }
}

impl<'a> Iterator for Tokenizer<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Token<'a>> {
        loop {
            let rest = self.rest();
            if rest.is_empty() {
                return None;
            }
            if !rest.starts_with('<') {
                let end = rest.find('<').unwrap_or(rest.len());
                self.pos += end;
                return Some(Token::Text(&rest[..end]));
            }
            if rest.starts_with("<!--") {
                self.skip_past("-->");
                continue;
            }
            if let Some(body) = rest.strip_prefix("<![CDATA[") {
                let end = body.find("]]>").unwrap_or(body.len());
                self.skip_past("]]>");
                return Some(Token::Cdata(&body[..end]));
            }
            if rest.starts_with("<!") || rest.starts_with("<?") {
                self.skip_past(">");
                continue;
            }
            if let Some(body) = rest.strip_prefix("</") {
                let len = Self::name_len(body);
                let name = &body[..len];
                self.skip_past(">");
                return Some(Token::End { name });
            }
            if rest[1..].starts_with(|c: char| c.is_ascii_alphabetic()) {
                // An unterminated tag drops it and everything after it.
                let token = self.start_tag();
                if token.is_none() {
                    self.pos = self.src.len();
                }
                return token;
            }
            // A lone '<' is text.
            self.pos += 1;
            return Some(Token::Text("<"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn keeps_clean_markup() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="url(#g)"/></svg>"#;
        assert_eq!(sanitize(svg, None), svg);
    }

    #[test]
    fn strips_scripts_handlers_and_foreign_content() {
        let svg = r#"<?xml version="1.0"?><!DOCTYPE svg><svg onload="alert(1)"><script>alert(2)</script><g><foreignObject><div onclick="x">hi</div></foreignObject><path d="M0 0" onmouseover="alert(3)"/></g><style>@import url(evil.css);</style><!-- c --></svg>"#;
        assert_eq!(sanitize(svg, None), r#"<svg><g><path d="M0 0"/></g></svg>"#);
    }

    #[test]
    fn blocks_script_and_remote_urls() {
        let svg = r##"<svg><a href="javascript:alert(1)"><text>x</text></a><use href="#icon"/><use xlink:href="https://evil/x.svg#a"/><image href="data:image/png;base64,AAAA"/><image href="data:image/svg+xml;base64,PHN2Zz4="/><rect fill="url(https://evil/x)" style="fill: url(#ok)"/><rect style="background: url(javas&#99;ript:alert(1))"/></svg>"##;
        assert_eq!(
            sanitize(svg, None),
            r##"<svg><use href="#icon"/><use/><image href="data:image/png;base64,AAAA"/><image/><rect style="fill: url(#ok)"/><rect/></svg>"##
        );
    }

    #[test]
    fn re_escapes_entities_and_text() {
        let svg = r#"<svg><text x="1" font-family="&quot;Inter&quot;">a &lt; b &amp; <![CDATA[<c>]]></text></svg>"#;
        assert_eq!(
            sanitize(svg, None),
            r#"<svg><text x="1" font-family="&quot;Inter&quot;">a &lt; b &amp; &lt;c&gt;</text></svg>"#
        );
    }

    #[test]
    fn closes_unbalanced_markup_and_ignores_trailing_content() {
        assert_eq!(
            sanitize("<svg><g><path d='M1 1'>", None),
            r#"<svg><g><path d="M1 1"></path></g></svg>"#
        );
        assert_eq!(
            sanitize("<svg></svg><script>x</script><svg/>", None),
            "<svg></svg>"
        );
        assert_eq!(sanitize("<svg><g></svg>", None), "<svg><g></g></svg>");
        assert_eq!(sanitize("<svg><rect width=\"1\"", None), "<svg></svg>");
    }

    #[test]
    fn root_must_be_svg_and_gets_node_style() {
        assert_eq!(
            sanitize("<div>hi</div>", Some("width: 16px")),
            r#"<svg style="width: 16px"></svg>"#
        );
        assert_eq!(sanitize("", None), "<svg></svg>");
        assert_eq!(
            sanitize(
                r#"<svg style="color: red;"><g/></svg>"#,
                Some("width: 16px")
            ),
            r#"<svg style="color: red; width: 16px"><g/></svg>"#
        );
        assert_eq!(
            sanitize("<SVG VIEWBOX='0 0 1 1'></SVG>", None),
            r#"<svg viewBox="0 0 1 1"></svg>"#
        );
    }

    #[test]
    fn lone_angle_brackets_are_text() {
        assert_eq!(
            sanitize("<svg><text>1 < 2</text></svg>", None),
            "<svg><text>1 &lt; 2</text></svg>"
        );
    }
}
