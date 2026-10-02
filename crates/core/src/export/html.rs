//! Node subtree → semantic HTML with inline styles.
//!
//! Mapping: page → `<main>`, artboard (frame under a page) → `<section>`,
//! frame/rect/group/instance → `<div>`, text → `<h1>`/`<h2>`/`<h3>` by font size
//! (≥32/24/20px) or `<p>`, svg → sanitised inline `<svg>`, vector → `<svg>` + one
//! `<path>`, image → `<img>`. Instances arrive resolved (`to_render_subtree`); groups
//! get `position: relative` unless absolutely positioned (their children are). Hidden
//! descendants and hidden paints (`--hidden-*` style keys) are omitted. Tokens
//! become `:root` custom properties so `var(--token)` references in styles keep
//! working. Image layers and image fills (`url("baren-asset://<hash>")` in
//! background values) are inlined as `data:` URIs when embedding, otherwise
//! point at `asset_url_prefix + hash`. All text is escaped and style values
//! that could break out of their context are dropped.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use super::assets::{asset_refs, is_image_property, rewrite_asset_urls};
use super::{base64, css, escape, svg};
use crate::schema::{vector_to_path_d, DesignNode, NodeMap, NodeType, StyleValue, TokenMap};
use crate::store::Asset;
use crate::util::{format_number, is_blake3_hex};

/// Deeper trees are cut off (protects the stack; real designs are far shallower).
const MAX_DEPTH: usize = 256;

#[derive(Clone, Debug)]
pub struct HtmlOptions {
    /// Emit a complete `<!doctype html>` document instead of a fragment.
    pub document: bool,
    /// Inline images as `data:` URIs. Otherwise (or when the asset is
    /// missing) `src` is `asset_url_prefix + hash`.
    pub embed_assets: bool,
    /// Add `data-node-id` attributes (for mapping output back to layers).
    pub include_node_ids: bool,
    pub asset_url_prefix: String,
}

impl Default for HtmlOptions {
    fn default() -> Self {
        HtmlOptions {
            document: false,
            embed_assets: true,
            include_node_ids: false,
            asset_url_prefix: "baren-asset://".to_owned(),
        }
    }
}

pub struct HtmlInput<'a> {
    pub root_id: &'a str,
    /// At least the root's subtree.
    pub nodes: &'a NodeMap,
    pub tokens: &'a TokenMap,
    /// Document title (used in `document` mode).
    pub title: &'a str,
    /// The root is an artboard (its parent is a page): its canvas position
    /// (`left`/`top`) is dropped.
    pub root_is_artboard: bool,
    /// Embeddable assets by hash.
    pub assets: &'a HashMap<String, Asset>,
}

/// Style keys the exporter drops: hidden paints kept for the eye toggle.
fn is_hidden_paint(key: &str) -> bool {
    key.starts_with("--hidden-")
}

/// Asset hashes used by the visible nodes under `root_id`: image layers and
/// image fills (hidden paints are not exported, so they are not referenced).
pub fn referenced_assets<'a>(nodes: &'a NodeMap, root_id: &str) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut stack: Vec<(&DesignNode, usize)> =
        nodes.get(root_id).map(|n| (n, 0)).into_iter().collect();
    while let Some((node, depth)) = stack.pop() {
        if depth > 0 && node.is_hidden() {
            continue;
        }
        if let Some(hash) = node.asset_id.as_deref() {
            if node.node_type == NodeType::Image && is_blake3_hex(hash) && seen.insert(hash) {
                out.push(hash);
            }
        }
        for (key, value) in node.styles.iter() {
            if !is_image_property(key) {
                continue;
            }
            if let StyleValue::Str(s) = value {
                for hash in asset_refs(s) {
                    if seen.insert(hash) {
                        out.push(hash);
                    }
                }
            }
        }
        if depth < MAX_DEPTH {
            stack.extend(
                node.children
                    .iter()
                    .filter_map(|c| nodes.get(c))
                    .map(|c| (c, depth + 1)),
            );
        }
    }
    out
}

pub fn render(input: &HtmlInput<'_>, options: &HtmlOptions) -> String {
    let mut body = String::new();
    if let Some(root) = input.nodes.get(input.root_id) {
        let role = match root.node_type {
            NodeType::Page => Role::Page,
            _ if input.root_is_artboard => Role::RootArtboard,
            _ => Role::Layer,
        };
        let base_depth = usize::from(options.document);
        Writer {
            input,
            options,
            out: &mut body,
        }
        .node(root, role, base_depth, 0);
    }
    let root_vars = tokens_css(input.tokens);
    if options.document {
        let mut out = String::with_capacity(body.len() + 512);
        out.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
        out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
        let _ = writeln!(out, "<title>{}</title>", escape::text(input.title));
        out.push_str("<style>\n");
        out.push_str(&root_vars);
        out.push_str("body { margin: 0; }\n</style>\n</head>\n<body>\n");
        out.push_str(&body);
        out.push_str("</body>\n</html>\n");
        out
    } else if root_vars.is_empty() {
        body
    } else {
        format!("<style>\n{root_vars}</style>\n{body}")
    }
}

/// `:root { --name: value; }` for every token with a safe name and value.
fn tokens_css(tokens: &TokenMap) -> String {
    let mut decls = String::new();
    for (name, token) in tokens.iter() {
        if !crate::schema::is_token_name(name) {
            continue;
        }
        let value = match &token.value {
            StyleValue::Num(n) if n.is_finite() => format_number(*n),
            StyleValue::Num(_) => continue,
            StyleValue::Str(s) => {
                let s = s.trim();
                if s.is_empty() || s.contains(';') || !css::is_safe_value(s) {
                    continue;
                }
                s.to_owned()
            }
        };
        let _ = write!(decls, "  {name}: {value};");
        if let Some(d) = token.description.as_deref() {
            let d: String = d
                .replace("*/", "* /")
                .chars()
                .filter(|c| !c.is_control() && !matches!(c, '<' | '>'))
                .collect();
            let _ = write!(decls, " /* {} */", d.trim());
        }
        decls.push('\n');
    }
    if decls.is_empty() {
        decls
    } else {
        format!(":root {{\n{decls}}}\n")
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    /// A page exported as a whole: artboards are absolutely positioned inside.
    Page,
    /// An artboard positioned inside an exported page (offset by the page origin).
    PageArtboard {
        dx: f64,
        dy: f64,
    },
    /// The exported artboard itself: canvas position dropped.
    RootArtboard,
    Layer,
}

struct Writer<'a, 'o> {
    input: &'a HtmlInput<'a>,
    options: &'a HtmlOptions,
    out: &'o mut String,
}

impl Writer<'_, '_> {
    fn node(&mut self, node: &DesignNode, role: Role, indent: usize, depth: usize) {
        let pad = "  ".repeat(indent);
        let styles = self.declarations(node, role);
        match node.node_type {
            NodeType::Svg => {
                let markup = svg::sanitize(
                    node.svg.as_deref().unwrap_or(""),
                    (!styles.is_empty()).then_some(styles.as_str()),
                );
                let markup = match self.id_attr(node) {
                    Some(id) => markup.replacen("<svg", &format!("<svg{id}"), 1),
                    None => markup,
                };
                let _ = writeln!(self.out, "{pad}{markup}");
            }
            NodeType::Image => {
                let _ = writeln!(
                    self.out,
                    "{pad}<img{} src=\"{}\" alt=\"{}\"{}{}>",
                    self.id_attr(node).unwrap_or_default(),
                    escape::attr(&self.image_src(node)),
                    escape::attr(&node.name),
                    self.intrinsic_size_attrs(node),
                    style_attr(&styles),
                );
            }
            NodeType::Text => {
                let tag = text_tag(node);
                let text = node.text.as_deref().unwrap_or("");
                let content = escape::text(text).replace('\n', "<br>");
                let _ = writeln!(
                    self.out,
                    "{pad}<{tag}{}{}>{content}</{tag}>",
                    self.id_attr(node).unwrap_or_default(),
                    style_attr(&styles),
                );
            }
            NodeType::Vector => {
                let w = format_number(px(node.styles.get("width")).unwrap_or(0.0));
                let h = format_number(px(node.styles.get("height")).unwrap_or(0.0));
                let overflow = if node.styles.get("overflow").is_none() {
                    " overflow=\"visible\""
                } else {
                    ""
                };
                let (d, fill_rule) = match &node.vector {
                    Some(v) => (vector_to_path_d(v), v.fill_rule.as_str()),
                    None => (String::new(), "nonzero"),
                };
                let _ = writeln!(
                    self.out,
                    "{pad}<svg{} width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\"{overflow}{}><path d=\"{}\" fill-rule=\"{fill_rule}\"/></svg>",
                    self.id_attr(node).unwrap_or_default(),
                    style_attr(&styles),
                    escape::attr(&d),
                );
            }
            NodeType::Page
            | NodeType::Frame
            | NodeType::Rect
            | NodeType::Group
            | NodeType::Instance => {
                let tag = match role {
                    Role::Page => "main",
                    Role::PageArtboard { .. } | Role::RootArtboard => "section",
                    Role::Layer => "div",
                };
                let _ = write!(
                    self.out,
                    "{pad}<{tag}{}{}>",
                    self.id_attr(node).unwrap_or_default(),
                    style_attr(&styles),
                );
                let children: Vec<&DesignNode> = if depth < MAX_DEPTH {
                    node.children
                        .iter()
                        .filter_map(|c| self.input.nodes.get(c))
                        .filter(|c| !c.is_hidden())
                        .collect()
                } else {
                    Vec::new()
                };
                if children.is_empty() {
                    let _ = writeln!(self.out, "</{tag}>");
                    return;
                }
                self.out.push('\n');
                let origin = (role == Role::Page)
                    .then(|| page_bounds(&children))
                    .flatten();
                for child in children {
                    let child_role = match (role, origin) {
                        (Role::Page, Some(b)) => Role::PageArtboard {
                            dx: -b.min_x,
                            dy: -b.min_y,
                        },
                        (Role::Page, None) => Role::PageArtboard { dx: 0.0, dy: 0.0 },
                        _ => Role::Layer,
                    };
                    self.node(child, child_role, indent + 1, depth + 1);
                }
                let _ = writeln!(self.out, "{pad}</{tag}>");
            }
        }
    }

    fn id_attr(&self, node: &DesignNode) -> Option<String> {
        self.options
            .include_node_ids
            .then(|| format!(" data-node-id=\"{}\"", escape::attr(&node.id)))
    }

    fn image_src(&self, node: &DesignNode) -> String {
        let Some(hash) = node.asset_id.as_deref().filter(|h| is_blake3_hex(h)) else {
            return String::new();
        };
        self.asset_url(hash)
    }

    /// `width`/`height` attributes from the image header when the layer's size is
    /// not fully set in its styles (prevents layout shift while the image loads).
    fn intrinsic_size_attrs(&self, node: &DesignNode) -> String {
        if node.styles.get("width").is_some() && node.styles.get("height").is_some() {
            return String::new();
        }
        let size = node
            .asset_id
            .as_deref()
            .and_then(|h| self.input.assets.get(h))
            .and_then(|a| imagesize::blob_size(&a.bytes).ok());
        match size {
            Some(s) if s.width > 0 && s.height > 0 => {
                format!(" width=\"{}\" height=\"{}\"", s.width, s.height)
            }
            _ => String::new(),
        }
    }

    /// Where an asset is loaded from: a `data:` URI when embedding (and the bytes
    /// are an image), else `asset_url_prefix + hash`.
    fn asset_url(&self, hash: &str) -> String {
        match self.input.assets.get(hash) {
            Some(asset) if self.options.embed_assets && asset.mime.starts_with("image/") => {
                format!(
                    "data:{};base64,{}",
                    asset.mime,
                    base64::encode(&asset.bytes)
                )
            }
            _ => format!("{}{hash}", self.options.asset_url_prefix),
        }
    }

    /// Inline style for a node in its role, as `a: b; c: d`.
    fn declarations(&self, node: &DesignNode, role: Role) -> String {
        let mut decls: Vec<String> = Vec::with_capacity(node.styles.len() + 3);
        let has = |key: &str| node.styles.get(key).is_some();
        let positional =
            |key: &str| matches!(key, "left" | "top" | "right" | "bottom" | "position");
        match role {
            Role::Page => {
                decls.push("position: relative".into());
                if let Some(bg) = node.background.as_deref().filter(|b| css::is_safe_value(b)) {
                    decls.push(format!("background-color: {bg}"));
                }
                let children: Vec<&DesignNode> = node
                    .children
                    .iter()
                    .filter_map(|c| self.input.nodes.get(c))
                    .filter(|c| !c.is_hidden())
                    .collect();
                if let Some(b) = page_bounds(&children) {
                    decls.push(format!("width: {}px", format_number(b.max_x - b.min_x)));
                    decls.push(format!("height: {}px", format_number(b.max_y - b.min_y)));
                }
            }
            Role::PageArtboard { dx, dy } => {
                decls.push("position: absolute".into());
                let left = px(node.styles.get("left")).unwrap_or(0.0) + dx;
                let top = px(node.styles.get("top")).unwrap_or(0.0) + dy;
                decls.push(format!("left: {}px", format_number(left)));
                decls.push(format!("top: {}px", format_number(top)));
            }
            Role::RootArtboard => {
                if !has("position") {
                    decls.push("position: relative".into());
                }
            }
            Role::Layer => {
                // Groups always establish a containing block for their absolute children.
                if node.node_type == NodeType::Group && !has("position") {
                    decls.push("position: relative".into());
                }
            }
        }
        if node.node_type == NodeType::Text {
            let tag = text_tag(node);
            if !node.styles.iter().any(|(k, _)| k.starts_with("margin")) {
                decls.push("margin: 0".into());
            }
            if tag != "p" && !has("fontWeight") {
                decls.push("font-weight: inherit".into());
            }
        }
        let drop_positional = matches!(role, Role::RootArtboard | Role::PageArtboard { .. });
        for (key, value) in sorted_styles(node) {
            if drop_positional
                && positional(key)
                && !(role == Role::RootArtboard && key == "position")
            {
                continue;
            }
            if is_hidden_paint(key) {
                continue;
            }
            let rewritten;
            let value = match value {
                StyleValue::Str(s) if is_image_property(key) && !asset_refs(s).is_empty() => {
                    rewritten = StyleValue::Str(rewrite_asset_urls(s, |hash| {
                        format!("url(\"{}\")", self.asset_url(hash))
                    }));
                    &rewritten
                }
                _ => value,
            };
            if let Some(d) = css::declaration(key, value) {
                decls.push(d);
            }
        }
        decls.join("; ")
    }
}

/// Conventional declaration order for readable output: positioning, layout,
/// box, typography, visuals. Unlisted properties follow alphabetically.
const PROPERTY_ORDER: &[&str] = &[
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "inset",
    "zIndex",
    "display",
    "flexDirection",
    "flexWrap",
    "flex",
    "flexGrow",
    "flexShrink",
    "flexBasis",
    "justifyContent",
    "alignItems",
    "alignContent",
    "alignSelf",
    "gap",
    "rowGap",
    "columnGap",
    "gridTemplateColumns",
    "gridTemplateRows",
    "order",
    "boxSizing",
    "width",
    "minWidth",
    "maxWidth",
    "height",
    "minHeight",
    "maxHeight",
    "aspectRatio",
    "margin",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "padding",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "overflow",
    "overflowX",
    "overflowY",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "textDecoration",
    "textTransform",
    "whiteSpace",
    "color",
    "background",
    "backgroundColor",
    "backgroundImage",
    "backgroundSize",
    "backgroundPosition",
    "backgroundRepeat",
    "border",
    "borderWidth",
    "borderStyle",
    "borderColor",
    "borderTop",
    "borderRight",
    "borderBottom",
    "borderLeft",
    "borderRadius",
    "boxShadow",
    "opacity",
    "filter",
    "backdropFilter",
    "transform",
    "transformOrigin",
    "transition",
    "cursor",
    "pointerEvents",
];

/// A node's styles in [`PROPERTY_ORDER`] (the stored order is Loro's
/// internal map order, which is arbitrary).
fn sorted_styles(node: &DesignNode) -> Vec<(&str, &StyleValue)> {
    let rank = |k: &str| {
        PROPERTY_ORDER
            .iter()
            .position(|p| *p == k)
            .unwrap_or(PROPERTY_ORDER.len())
    };
    let mut styles: Vec<_> = node.styles.iter().collect();
    styles.sort_by(|(a, _), (b, _)| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
    styles
}

fn style_attr(styles: &str) -> String {
    if styles.is_empty() {
        String::new()
    } else {
        format!(" style=\"{}\"", escape::attr(styles))
    }
}

/// A length in px from a number or a `"12px"` / `"12"` string.
fn px(v: Option<&StyleValue>) -> Option<f64> {
    let n = match v? {
        StyleValue::Num(n) => *n,
        StyleValue::Str(s) => s.trim().trim_end_matches("px").trim().parse().ok()?,
    };
    n.is_finite().then_some(n)
}

fn text_tag(node: &DesignNode) -> &'static str {
    match px(node.styles.get("fontSize")) {
        Some(size) if size >= 32.0 => "h1",
        Some(size) if size >= 24.0 => "h2",
        Some(size) if size >= 20.0 => "h3",
        _ => "p",
    }
}

#[derive(Clone, Copy)]
struct Bounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

/// Bounding box of artboards that have numeric `left/top/width/height`.
fn page_bounds(artboards: &[&DesignNode]) -> Option<Bounds> {
    artboards
        .iter()
        .filter_map(|a| {
            let s = &a.styles;
            let (x, y) = (
                px(s.get("left")).unwrap_or(0.0),
                px(s.get("top")).unwrap_or(0.0),
            );
            Some(Bounds {
                min_x: x,
                min_y: y,
                max_x: x + px(s.get("width"))?,
                max_y: y + px(s.get("height"))?,
            })
        })
        .reduce(|a, b| Bounds {
            min_x: a.min_x.min(b.min_x),
            min_y: a.min_y.min(b.min_y),
            max_x: a.max_x.max(b.max_x),
            max_y: a.max_y.max(b.max_y),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Styles, Token};

    fn node(
        id: &str,
        t: NodeType,
        parent: Option<&str>,
        children: &[&str],
        styles: Vec<(&str, StyleValue)>,
    ) -> DesignNode {
        DesignNode {
            id: id.into(),
            node_type: t,
            name: format!("{t:?} {id}"),
            parent_id: parent.map(Into::into),
            children: children.iter().map(|c| (*c).to_owned()).collect(),
            styles: Styles(styles.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()),
            text: (t == NodeType::Text).then(String::new),
            ..Default::default()
        }
    }

    fn fixture() -> (NodeMap, TokenMap) {
        let mut nodes = NodeMap::default();
        let mut page = node("1@1", NodeType::Page, None, &["2@1", "9@1"], vec![]);
        page.background = Some("#EEEEEE".into());
        nodes.insert(page);
        nodes.insert(node(
            "2@1",
            NodeType::Frame,
            Some("1@1"),
            &["3@1", "4@1", "5@1", "6@1", "7@1"],
            vec![
                ("left", 100.into()),
                ("top", 50.into()),
                ("width", 1440.into()),
                ("height", 900.into()),
                ("display", "flex".into()),
                ("backgroundColor", "var(--color-background)".into()),
            ],
        ));
        let mut title = node(
            "3@1",
            NodeType::Text,
            Some("2@1"),
            &[],
            vec![("fontSize", "32px".into())],
        );
        title.text = Some("Hello <world> & \"friends\"\nline 2".into());
        nodes.insert(title);
        let mut body = node(
            "4@1",
            NodeType::Text,
            Some("2@1"),
            &[],
            vec![
                ("color", "red</style><script>".into()),
                ("lineHeight", 1.5.into()),
            ],
        );
        body.text = Some("<script>alert(1)</script>".into());
        nodes.insert(body);
        let mut icon = node(
            "5@1",
            NodeType::Svg,
            Some("2@1"),
            &[],
            vec![("width", 16.into())],
        );
        icon.svg = Some(r#"<svg viewBox="0 0 16 16" onload="x()"><script>y()</script><path d="M0 0h16"/></svg>"#.into());
        nodes.insert(icon);
        let mut img = node("6@1", NodeType::Image, Some("2@1"), &[], vec![]);
        img.asset_id = Some(blake3::hash(b"png").to_hex().to_string());
        nodes.insert(img);
        let mut hidden = node("7@1", NodeType::Rect, Some("2@1"), &[], vec![]);
        hidden.hidden = Some(true);
        nodes.insert(hidden);
        nodes.insert(node(
            "9@1",
            NodeType::Frame,
            Some("1@1"),
            &[],
            vec![
                ("left", 1640.into()),
                ("top", 50.into()),
                ("width", 100.into()),
                ("height", 100.into()),
            ],
        ));
        let tokens = TokenMap(vec![
            (
                "--color-background".into(),
                Token {
                    token_type: "color".into(),
                    value: "#FFFFFF".into(),
                    description: Some("Canvas */ </style>".into()),
                },
            ),
            (
                "--opacity".into(),
                Token {
                    token_type: "opacity".into(),
                    value: 0.6.into(),
                    description: None,
                },
            ),
            (
                "--evil".into(),
                Token {
                    token_type: "color".into(),
                    value: "red; } body { display:none".into(),
                    description: None,
                },
            ),
            (
                "bad name".into(),
                Token {
                    token_type: "color".into(),
                    value: "red".into(),
                    description: None,
                },
            ),
        ]);
        (nodes, tokens)
    }

    fn render_with(
        root: &str,
        artboard: bool,
        options: &HtmlOptions,
        assets: &HashMap<String, Asset>,
    ) -> String {
        let (nodes, tokens) = fixture();
        render(
            &HtmlInput {
                root_id: root,
                nodes: &nodes,
                tokens: &tokens,
                title: "Doc <1>",
                root_is_artboard: artboard,
                assets,
            },
            options,
        )
    }

    #[test]
    fn artboard_fragment() {
        let html = render_with("2@1", true, &HtmlOptions::default(), &HashMap::new());
        let expected = r#"<style>
:root {
  --color-background: #FFFFFF; /* Canvas * / /style */
  --opacity: 0.6;
}
</style>
<section style="position: relative; display: flex; width: 1440px; height: 900px; background-color: var(--color-background)">
  <h1 style="margin: 0; font-weight: inherit; font-size: 32px">Hello &lt;world&gt; &amp; "friends"<br>line 2</h1>
  <p style="margin: 0; line-height: 1.5">&lt;script&gt;alert(1)&lt;/script&gt;</p>
  <svg viewBox="0 0 16 16" style="width: 16px"><path d="M0 0h16"/></svg>
  <img src="baren-asset://HASH" alt="Image 6@1">
</section>
"#
        .replace("HASH", &blake3::hash(b"png").to_hex());
        assert_eq!(html, expected);
    }

    #[test]
    fn page_export_positions_artboards() {
        let html = render_with("1@1", false, &HtmlOptions::default(), &HashMap::new());
        assert!(html.contains(r#"<main style="position: relative; background-color: #EEEEEE; width: 1640px; height: 900px">"#), "{html}");
        assert!(html.contains(r#"<section style="position: absolute; left: 0px; top: 0px; display: flex; width: 1440px; height: 900px;"#), "{html}");
        assert!(html.contains(r#"<section style="position: absolute; left: 1540px; top: 0px; width: 100px; height: 100px"></section>"#), "{html}");
    }

    #[test]
    fn embeds_assets_and_node_ids_in_document_mode() {
        let hash = blake3::hash(b"png").to_hex().to_string();
        let assets = HashMap::from([(
            hash,
            Asset {
                bytes: b"png".to_vec(),
                mime: "image/png".into(),
            },
        )]);
        let options = HtmlOptions {
            document: true,
            include_node_ids: true,
            ..Default::default()
        };
        let html = render_with("6@1", false, &options, &assets);
        assert!(html.starts_with("<!doctype html>\n<html lang=\"en\">"));
        assert!(html.contains("<title>Doc &lt;1&gt;</title>"));
        assert!(
            html.contains(
                r#"  <img data-node-id="6@1" src="data:image/png;base64,cG5n" alt="Image 6@1">"#
            ),
            "{html}"
        );
        assert!(html.ends_with("</body>\n</html>\n"));
    }

    /// The 24-byte head of a PNG (signature + IHDR): enough for `imagesize`.
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend_from_slice(&width.to_be_bytes());
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn image_fills_are_embedded_or_linked_and_hidden_paints_dropped() {
        let (mut nodes, tokens) = fixture();
        let fill = blake3::hash(b"fill").to_hex().to_string();
        let hidden = blake3::hash(b"hidden").to_hex().to_string();
        nodes.insert(node(
            "9@1",
            NodeType::Frame,
            Some("1@1"),
            &[],
            vec![
                ("width", 100.into()),
                (
                    "backgroundImage",
                    format!(r#"url("baren-asset://{fill}")"#).as_str().into(),
                ),
                ("backgroundSize", "cover".into()),
                (
                    "--hidden-backgroundColor",
                    format!(r#"url("baren-asset://{hidden}")"#).as_str().into(),
                ),
            ],
        ));
        assert_eq!(referenced_assets(&nodes, "9@1"), [fill.as_str()]);
        let assets = HashMap::from([(
            fill.clone(),
            Asset {
                bytes: b"png".to_vec(),
                mime: "image/png".into(),
            },
        )]);
        let input = |assets| HtmlInput {
            root_id: "9@1",
            nodes: &nodes,
            tokens: &tokens,
            title: "",
            root_is_artboard: false,
            assets,
        };
        let embedded = render(&input(&assets), &HtmlOptions::default());
        assert!(
            embedded.contains(
                r#"<div style="width: 100px; background-image: url(&quot;data:image/png;base64,cG5n&quot;); background-size: cover"></div>"#
            ),
            "{embedded}"
        );
        assert!(!embedded.contains("hidden"), "{embedded}");
        let linked = render(
            &input(&assets),
            &HtmlOptions {
                embed_assets: false,
                asset_url_prefix: "assets/".into(),
                ..Default::default()
            },
        );
        assert!(
            linked.contains(&format!("background-image: url(&quot;assets/{fill}&quot;)")),
            "{linked}"
        );
    }

    #[test]
    fn images_without_a_set_size_get_intrinsic_attributes() {
        let (mut nodes, tokens) = fixture();
        let hash = blake3::hash(b"header").to_hex().to_string();
        let mut img = node(
            "8@1",
            NodeType::Image,
            Some("2@1"),
            &[],
            vec![("width", 50.into())],
        );
        img.asset_id = Some(hash.clone());
        nodes.insert(img);
        let assets = HashMap::from([(
            hash,
            Asset {
                bytes: png_header(2400, 1200),
                mime: "image/png".into(),
            },
        )]);
        let html = render(
            &HtmlInput {
                root_id: "8@1",
                nodes: &nodes,
                tokens: &tokens,
                title: "",
                root_is_artboard: false,
                assets: &assets,
            },
            &HtmlOptions::default(),
        );
        assert!(
            html.contains(r#" width="2400" height="1200" style="width: 50px">"#),
            "{html}"
        );
    }

    #[test]
    fn referenced_assets_skip_hidden_and_invalid() {
        let (mut nodes, _) = fixture();
        let mut bad = node("8@1", NodeType::Image, Some("2@1"), &[], vec![]);
        bad.asset_id = Some("not-a-hash".into());
        nodes.insert(bad);
        let hashes = referenced_assets(&nodes, "1@1");
        assert_eq!(hashes, [blake3::hash(b"png").to_hex().as_str()]);
    }
}
