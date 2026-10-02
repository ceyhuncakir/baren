//! Plain snapshot types, mirroring `packages/schema/src/types.ts`.
//!
//! Serialization reproduces what `JSON.stringify(toSnapshot(doc))` prints in
//! JS: camelCase keys, optional fields omitted, `parentId: null` for pages,
//! integral numbers without a fraction, and map entries in document order.

use std::collections::HashMap;

use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

use crate::util::js_integer;

/// `NodeType` in `@baren/schema`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    Page,
    /// Unknown types decode as frames.
    #[default]
    Frame,
    Text,
    Rect,
    Svg,
    Image,
    /// Phase 3: a box whose children are absolutely positioned inside it.
    Group,
    /// Phase 3: structured path geometry (`vector`).
    Vector,
    /// Phase 3: a tree leaf resolved from its main component at render time.
    Instance,
}

impl NodeType {
    pub const ALL: [NodeType; 9] = [
        NodeType::Page,
        NodeType::Frame,
        NodeType::Text,
        NodeType::Rect,
        NodeType::Svg,
        NodeType::Image,
        NodeType::Group,
        NodeType::Vector,
        NodeType::Instance,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            NodeType::Page => "page",
            NodeType::Frame => "frame",
            NodeType::Text => "text",
            NodeType::Rect => "rect",
            NodeType::Svg => "svg",
            NodeType::Image => "image",
            NodeType::Group => "group",
            NodeType::Vector => "vector",
            NodeType::Instance => "instance",
        }
    }

    pub fn parse(s: &str) -> Option<NodeType> {
        NodeType::ALL.into_iter().find(|t| t.as_str() == s)
    }

    /// `CONTAINER_NODE_TYPES`: pages, frames and groups may have children.
    pub fn is_container(self) -> bool {
        matches!(self, NodeType::Page | NodeType::Frame | NodeType::Group)
    }

    /// `DEFAULT_NODE_NAMES` (an instance with an empty name shows its main's name).
    pub fn default_name(self) -> &'static str {
        match self {
            NodeType::Page => "Page",
            NodeType::Frame => "Frame",
            NodeType::Text => "Text",
            NodeType::Rect => "Rectangle",
            NodeType::Svg => "Vector",
            NodeType::Image => "Image",
            NodeType::Group => "Group",
            NodeType::Vector => "Vector",
            NodeType::Instance => "",
        }
    }
}

/// `StyleValue` (and token values): a string or a finite number.
#[derive(Clone, Debug, PartialEq)]
pub enum StyleValue {
    Str(String),
    Num(f64),
}

impl StyleValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            StyleValue::Str(s) => Some(s),
            StyleValue::Num(_) => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            StyleValue::Num(n) => Some(*n),
            StyleValue::Str(_) => None,
        }
    }

    pub(crate) fn to_loro(&self) -> loro::LoroValue {
        match self {
            StyleValue::Str(s) => loro::LoroValue::from(s.as_str()),
            // JS numbers are stored as doubles; match that so both sides
            // read back the same value type.
            StyleValue::Num(n) => loro::LoroValue::Double(*n),
        }
    }
}

impl From<&str> for StyleValue {
    fn from(s: &str) -> Self {
        StyleValue::Str(s.to_owned())
    }
}

impl From<String> for StyleValue {
    fn from(s: String) -> Self {
        StyleValue::Str(s)
    }
}

impl From<f64> for StyleValue {
    fn from(n: f64) -> Self {
        StyleValue::Num(n)
    }
}

impl From<i32> for StyleValue {
    fn from(n: i32) -> Self {
        StyleValue::Num(f64::from(n))
    }
}

impl Serialize for StyleValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            StyleValue::Str(v) => s.serialize_str(v),
            StyleValue::Num(n) => serialize_js_number(*n, s),
        }
    }
}

/// Serialize like `JSON.stringify` does for a finite JS number.
pub(crate) fn serialize_js_number<S: Serializer>(n: f64, s: S) -> Result<S::Ok, S::Error> {
    match js_integer(n) {
        Some(i) => s.serialize_i64(i),
        None => s.serialize_f64(n),
    }
}

/// camelCase CSS property → value, in document order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Styles(pub Vec<(String, StyleValue)>);

impl Styles {
    pub fn get(&self, key: &str) -> Option<&StyleValue> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &StyleValue)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for Styles {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// Override styles (`OverrideStyles`): `None` = "property removed in this instance".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OverrideStyles(pub Vec<(String, Option<StyleValue>)>);

impl OverrideStyles {
    pub fn get(&self, key: &str) -> Option<&Option<StyleValue>> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for OverrideStyles {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// `OverrideEntry` (absent field = not overridden).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<OverrideStyles>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_name: Option<String>,
}

impl OverrideEntry {
    pub fn is_empty(&self) -> bool {
        self.styles.is_none()
            && self.text.is_none()
            && self.hidden.is_none()
            && self.asset_id.is_none()
            && self.asset_name.is_none()
    }
}

/// An instance's overrides by path (`''` = root, `k1/k2` = nested), in document order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Overrides(pub Vec<(String, OverrideEntry)>);

impl Overrides {
    pub fn get(&self, path: &str) -> Option<&OverrideEntry> {
        self.0.iter().find(|(k, _)| k == path).map(|(_, v)| v)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &OverrideEntry)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }
}

impl Serialize for Overrides {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// A finite number printed like JS (`serialize_js_number`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JsNum(pub f64);

impl Serialize for JsNum {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        serialize_js_number(self.0, s)
    }
}

/// `VectorPoint`: an anchor in node-local px; handles relative to it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VectorPoint {
    pub x: JsNum,
    pub y: JsNum,
    #[serde(rename = "in", skip_serializing_if = "Option::is_none")]
    pub handle_in: Option<[JsNum; 2]>,
    #[serde(rename = "out", skip_serializing_if = "Option::is_none")]
    pub handle_out: Option<[JsNum; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// `VectorSubpath`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VectorSubpath {
    pub id: String,
    pub closed: bool,
    pub points: Vec<VectorPoint>,
}

/// `VectorData` (subpaths sorted by (order, id)).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorData {
    pub fill_rule: String,
    pub subpaths: Vec<VectorSubpath>,
}

/// `DesignNode` in `@baren/schema`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub name: String,
    pub parent_id: Option<String>,
    pub children: Vec<String>,
    pub styles: Styles,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub svg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// Original file name of the node's image (layer source or fill), for display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    /// Frame: main component key. Instance: the component it shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_key: Option<String>,
    /// Address of the node inside a main component.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_key: Option<String>,
    /// Instance: TreeID hint of its main.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Overrides>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector: Option<VectorData>,
}

impl DesignNode {
    pub fn is_hidden(&self) -> bool {
        self.hidden == Some(true)
    }
}

/// `Token` in `@baren/schema`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Token {
    #[serde(rename = "type")]
    pub token_type: String,
    pub value: StyleValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Nodes keyed by id, kept in depth-first document order (the same order JS
/// `toSnapshot` inserts them, so serialized output lines up with JS).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NodeMap {
    nodes: Vec<DesignNode>,
    index: HashMap<String, usize>,
}

impl NodeMap {
    pub fn with_capacity(n: usize) -> Self {
        NodeMap {
            nodes: Vec::with_capacity(n),
            index: HashMap::with_capacity(n),
        }
    }

    /// Insert or replace a node (replacement keeps the original position).
    pub fn insert(&mut self, node: DesignNode) {
        match self.index.get(&node.id) {
            Some(&i) => self.nodes[i] = node,
            None => {
                self.index.insert(node.id.clone(), self.nodes.len());
                self.nodes.push(node);
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<&DesignNode> {
        self.index.get(id).map(|&i| &self.nodes[i])
    }

    pub fn contains(&self, id: &str) -> bool {
        self.index.contains_key(id)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Nodes in depth-first document order.
    pub fn iter(&self) -> impl Iterator<Item = &DesignNode> {
        self.nodes.iter()
    }
}

impl Serialize for NodeMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.nodes.len()))?;
        for node in &self.nodes {
            map.serialize_entry(&node.id, node)?;
        }
        map.end()
    }
}

/// Tokens keyed by CSS variable name, in document order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TokenMap(pub Vec<(String, Token)>);

impl TokenMap {
    pub fn get(&self, name: &str) -> Option<&Token> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Token)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for TokenMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// One component registry entry.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEntry {
    pub main_id: String,
}

/// The component registry (`componentKey → { mainId }`), in document order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ComponentRegistry(pub Vec<(String, ComponentEntry)>);

impl ComponentRegistry {
    pub fn get(&self, key: &str) -> Option<&ComponentEntry> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

impl Serialize for ComponentRegistry {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// `DocSnapshot` in `@baren/schema`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSnapshot {
    pub name: String,
    pub page_ids: Vec<String>,
    pub nodes: NodeMap,
    pub tokens: TokenMap,
    /// Omitted when the registry is empty (Phase 2 snapshots are unchanged).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<ComponentRegistry>,
}

/// One materialised subtree (`toSubtreeSnapshot`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtreeSnapshot {
    pub root_id: String,
    pub nodes: NodeMap,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str) -> DesignNode {
        DesignNode {
            id: id.into(),
            node_type: NodeType::Frame,
            name: "F".into(),
            styles: Styles(vec![
                ("left".into(), 0.0.into()),
                ("gap".into(), "8px".into()),
            ]),
            locked: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn node_json_matches_js_shape() {
        let json = serde_json::to_string(&node("1@2")).unwrap();
        assert_eq!(
            json,
            r#"{"id":"1@2","type":"frame","name":"F","parentId":null,"children":[],"styles":{"left":0,"gap":"8px"},"locked":true}"#
        );
    }

    #[test]
    fn phase3_fields_serialize_in_js_order() {
        let mut n = node("2@1");
        n.node_type = NodeType::Instance;
        n.locked = None;
        n.component_key = Some("k".repeat(16));
        n.node_key = Some("n".repeat(10));
        n.main_id = Some("1@1".into());
        n.overrides = Some(Overrides(vec![(
            String::new(),
            OverrideEntry {
                styles: Some(OverrideStyles(vec![
                    ("color".into(), Some("red".into())),
                    ("gap".into(), None),
                ])),
                hidden: Some(false),
                ..Default::default()
            },
        )]));
        let json = serde_json::to_string(&n).unwrap();
        assert_eq!(
            json,
            r#"{"id":"2@1","type":"instance","name":"F","parentId":null,"children":[],"styles":{"left":0,"gap":"8px"},"componentKey":"kkkkkkkkkkkkkkkk","nodeKey":"nnnnnnnnnn","mainId":"1@1","overrides":{"":{"styles":{"color":"red","gap":null},"hidden":false}}}"#
        );
        let v = VectorData {
            fill_rule: "nonzero".into(),
            subpaths: vec![VectorSubpath {
                id: "a".into(),
                closed: true,
                points: vec![VectorPoint {
                    x: JsNum(1.0),
                    y: JsNum(0.5),
                    handle_in: Some([JsNum(-0.0), JsNum(2.0)]),
                    handle_out: None,
                    mode: Some("smooth".into()),
                }],
            }],
        };
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"fillRule":"nonzero","subpaths":[{"id":"a","closed":true,"points":[{"x":1,"y":0.5,"in":[0,2],"mode":"smooth"}]}]}"#
        );
    }

    #[test]
    fn numbers_serialize_like_js() {
        let v = |n: f64| serde_json::to_string(&StyleValue::Num(n)).unwrap();
        assert_eq!(v(1440.0), "1440");
        assert_eq!(v(-0.0), "0");
        assert_eq!(v(0.6), "0.6");
        assert_eq!(v(0.1 + 0.2), "0.30000000000000004");
    }

    #[test]
    fn node_map_keeps_order_and_replaces_in_place() {
        let mut m = NodeMap::default();
        m.insert(node("2@1"));
        m.insert(node("1@1"));
        let mut replaced = node("2@1");
        replaced.name = "G".into();
        m.insert(replaced);
        let ids: Vec<_> = m.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["2@1", "1@1"]);
        assert_eq!(m.get("2@1").unwrap().name, "G");
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn node_type_round_trip() {
        for t in NodeType::ALL {
            assert_eq!(NodeType::parse(t.as_str()), Some(t));
        }
        assert_eq!(NodeType::parse("group"), Some(NodeType::Group));
        assert_eq!(NodeType::parse("widget"), None);
        assert!(NodeType::Frame.is_container());
        assert!(NodeType::Group.is_container());
        assert!(!NodeType::Text.is_container());
        assert!(!NodeType::Instance.is_container());
    }
}
