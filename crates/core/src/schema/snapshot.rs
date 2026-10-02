//! `LoroDoc` → plain snapshot, mirroring `packages/schema/src/snapshot.ts`,
//! `decodeNode` (nodes.ts) and `decodeToken` (tokens.ts) rule for rule:
//! unknown node types decode as `frame`, non-scalar style values are dropped,
//! `text` is present only on text nodes, tokens without a string/number value
//! are skipped and a missing token type reads as `"other"`.

use loro::{LoroDoc, LoroValue, TreeID, TreeParentId};

use super::doc::{meta_map, nodes_tree, tokens_map};
use super::types::{
    ComponentEntry, ComponentRegistry, DesignNode, DocSnapshot, JsNum, NodeMap, NodeType,
    OverrideEntry, OverrideStyles, Overrides, StyleValue, Styles, SubtreeSnapshot, Token, TokenMap,
    VectorData, VectorPoint, VectorSubpath,
};
use crate::{container, node_key};

/// Materialise the whole document. One deep read of the tree (`get_value_with_meta`),
/// then an iterative depth-first walk, exactly like the JS `toSnapshot`.
pub fn to_snapshot(doc: &LoroDoc) -> DocSnapshot {
    let tree = nodes_tree(doc);
    let forest = tree.get_value_with_meta();
    let roots: &[LoroValue] = match &forest {
        LoroValue::List(list) => list,
        _ => &[],
    };
    let page_ids = roots
        .iter()
        .filter_map(raw_tree_node)
        .map(|raw| raw.id.to_owned())
        .collect();
    // Upper bound (includes deleted ids) — far cheaper than counting live nodes.
    let mut nodes = NodeMap::with_capacity(tree.nodes().len());
    collect_nodes(roots, None, &mut nodes);

    let name = match meta_map(doc).get_value() {
        LoroValue::Map(m) => match m.get("name") {
            Some(LoroValue::String(s)) => s.to_string(),
            _ => String::new(),
        },
        _ => String::new(),
    };

    DocSnapshot {
        name,
        page_ids,
        nodes,
        tokens: decode_tokens(&tokens_map(doc).get_deep_value()),
        components: decode_registry(&doc.get_map(container::COMPONENTS).get_deep_value()),
    }
}

/// The component registry (`components` root map); `None` when empty.
pub(crate) fn decode_registry(v: &LoroValue) -> Option<ComponentRegistry> {
    let LoroValue::Map(m) = v else { return None };
    let entries: Vec<(String, ComponentEntry)> = m
        .iter()
        .filter_map(|(key, value)| {
            let LoroValue::Map(entry) = value else {
                return None;
            };
            let main_id = string_of(entry.get("mainId"))?;
            Some((key.to_string(), ComponentEntry { main_id }))
        })
        .collect();
    (!entries.is_empty()).then_some(ComponentRegistry(entries))
}

/// Materialise one subtree (e.g. a single artboard), like `toSubtreeSnapshot`.
/// Returns `None` when `root_id` is not a live node.
pub fn to_subtree_snapshot(doc: &LoroDoc, root_id: &str) -> Option<SubtreeSnapshot> {
    let tree = nodes_tree(doc);
    let root = parse_node_id(root_id)?;
    if !is_live(&tree, root) {
        return None;
    }
    let mut nodes = NodeMap::default();
    let mut stack = vec![(root, parent_of(&tree, root))];
    while let Some((id, parent_id)) = stack.pop() {
        let children = tree.children(id).unwrap_or_default();
        let data = tree
            .get_meta(id)
            .map(|m| m.get_deep_value())
            .unwrap_or(LoroValue::Null);
        let id_str = id.to_string();
        let child_ids = children.iter().map(ToString::to_string).collect();
        nodes.insert(decode_node(id_str.clone(), parent_id, child_ids, &data));
        for child in children.into_iter().rev() {
            stack.push((child, Some(id_str.clone())));
        }
    }
    Some(SubtreeSnapshot {
        root_id: root_id.to_owned(),
        nodes,
    })
}

/// Read one live node (`getNode`).
pub fn get_node(doc: &LoroDoc, id: &str) -> Option<DesignNode> {
    let tree = nodes_tree(doc);
    let tid = parse_node_id(id)?;
    if !is_live(&tree, tid) {
        return None;
    }
    let children = tree
        .children(tid)
        .unwrap_or_default()
        .iter()
        .map(ToString::to_string)
        .collect();
    let data = tree.get_meta(tid).ok()?.get_deep_value();
    Some(decode_node(
        id.to_owned(),
        parent_of(&tree, tid),
        children,
        &data,
    ))
}

/// All tokens (`getTokens`).
pub fn get_tokens(doc: &LoroDoc) -> TokenMap {
    decode_tokens(&tokens_map(doc).get_deep_value())
}

/// Node ids are Loro `TreeID` strings, `"<counter>@<peer>"` (`isTreeId`).
pub fn parse_node_id(id: &str) -> Option<TreeID> {
    let (counter, peer) = id.split_once('@')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(counter) || !digits(peer) {
        return None;
    }
    TreeID::try_from(id).ok()
}

pub(crate) fn is_live(tree: &loro::LoroTree, id: TreeID) -> bool {
    tree.contains(id) && !tree.is_node_deleted(&id).unwrap_or(true)
}

pub(crate) fn parent_of(tree: &loro::LoroTree, id: TreeID) -> Option<String> {
    match tree.parent(id) {
        Some(TreeParentId::Node(p)) => Some(p.to_string()),
        _ => None,
    }
}

struct RawTreeNode<'a> {
    id: &'a str,
    meta: &'a LoroValue,
    children: &'a [LoroValue],
}

/// `isRawTreeNode`: an object with a string `id` and a `children` array.
fn raw_tree_node(v: &LoroValue) -> Option<RawTreeNode<'_>> {
    let LoroValue::Map(m) = v else { return None };
    let Some(LoroValue::String(id)) = m.get("id") else {
        return None;
    };
    let Some(LoroValue::List(children)) = m.get("children") else {
        return None;
    };
    Some(RawTreeNode {
        id: id.as_str(),
        meta: m.get("meta").unwrap_or(&LoroValue::Null),
        children,
    })
}

/// Iterative pre-order walk (documents can be deep; avoid recursion limits).
fn collect_nodes(roots: &[LoroValue], parent_id: Option<&str>, out: &mut NodeMap) {
    let mut stack: Vec<(RawTreeNode<'_>, Option<String>)> = roots
        .iter()
        .rev()
        .filter_map(raw_tree_node)
        .map(|raw| (raw, parent_id.map(str::to_owned)))
        .collect();
    while let Some((raw, parent)) = stack.pop() {
        let child_ids = raw
            .children
            .iter()
            .filter_map(raw_tree_node)
            .map(|c| c.id.to_owned())
            .collect();
        out.insert(decode_node(raw.id.to_owned(), parent, child_ids, raw.meta));
        for child in raw.children.iter().rev().filter_map(raw_tree_node) {
            stack.push((child, Some(raw.id.to_owned())));
        }
    }
}

fn style_value(v: &LoroValue) -> Option<StyleValue> {
    match v {
        LoroValue::String(s) => Some(StyleValue::Str(s.to_string())),
        LoroValue::Double(n) if n.is_finite() => Some(StyleValue::Num(*n)),
        // JS never writes I64 (BigInt is rejected by `set`), but a Rust writer
        // could; read it as the number it represents.
        LoroValue::I64(n) => Some(StyleValue::Num(*n as f64)),
        _ => None,
    }
}

fn string_of(v: Option<&LoroValue>) -> Option<String> {
    match v {
        Some(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn bool_of(v: Option<&LoroValue>) -> Option<bool> {
    match v {
        Some(LoroValue::Bool(b)) => Some(*b),
        _ => None,
    }
}

/// `decodeNode`: a node's data-map deep value → `DesignNode`.
pub(crate) fn decode_node(
    id: String,
    parent_id: Option<String>,
    children: Vec<String>,
    data: &LoroValue,
) -> DesignNode {
    let empty = Default::default();
    let d = match data {
        LoroValue::Map(m) => m,
        _ => &empty,
    };
    let node_type = match d.get(node_key::TYPE) {
        Some(LoroValue::String(s)) => NodeType::parse(s).unwrap_or(NodeType::Frame),
        _ => NodeType::Frame,
    };
    let styles = match d.get(node_key::STYLES) {
        Some(LoroValue::Map(raw)) => Styles(
            raw.iter()
                .filter_map(|(k, v)| style_value(v).map(|sv| (k.to_string(), sv)))
                .collect(),
        ),
        _ => Styles::default(),
    };
    let text =
        (node_type == NodeType::Text).then(|| string_of(d.get(node_key::TEXT)).unwrap_or_default());
    let is_instance = node_type == NodeType::Instance;
    DesignNode {
        id,
        node_type,
        name: string_of(d.get(node_key::NAME)).unwrap_or_default(),
        parent_id,
        children,
        styles,
        text,
        svg: string_of(d.get(node_key::SVG)),
        asset_id: string_of(d.get(node_key::ASSET_ID)),
        asset_name: string_of(d.get(node_key::ASSET_NAME)),
        locked: bool_of(d.get(node_key::LOCKED)),
        hidden: bool_of(d.get(node_key::HIDDEN)),
        background: string_of(d.get(node_key::BACKGROUND)),
        component_key: matches!(node_type, NodeType::Frame | NodeType::Instance)
            .then(|| string_of(d.get(node_key::COMPONENT_KEY)))
            .flatten(),
        node_key: string_of(d.get(node_key::NODE_KEY)),
        main_id: is_instance
            .then(|| string_of(d.get(node_key::MAIN_ID)))
            .flatten(),
        overrides: is_instance
            .then(|| decode_overrides(d.get(node_key::OVERRIDES)))
            .flatten(),
        vector: (node_type == NodeType::Vector)
            .then(|| decode_vector(d.get(node_key::VECTOR)))
            .flatten(),
    }
}

fn override_style_value(v: &LoroValue) -> Option<Option<StyleValue>> {
    match v {
        LoroValue::Null => Some(None),
        other => style_value(other).map(Some),
    }
}

/// `decodeOverrideEntry`: `None` when the entry carries no valid field.
pub(crate) fn decode_override_entry(v: &LoroValue) -> Option<OverrideEntry> {
    let LoroValue::Map(m) = v else { return None };
    let styles = match m.get("styles") {
        Some(LoroValue::Map(raw)) => {
            let entries: Vec<(String, Option<StyleValue>)> = raw
                .iter()
                .filter_map(|(k, v)| override_style_value(v).map(|sv| (k.to_string(), sv)))
                .collect();
            (!entries.is_empty()).then_some(OverrideStyles(entries))
        }
        _ => None,
    };
    let entry = OverrideEntry {
        styles,
        text: string_of(m.get("text")),
        hidden: bool_of(m.get("hidden")),
        asset_id: string_of(m.get("assetId")),
        asset_name: string_of(m.get("assetName")),
    };
    (!entry.is_empty()).then_some(entry)
}

/// `decodeOverrides`: `None` when empty.
pub(crate) fn decode_overrides(v: Option<&LoroValue>) -> Option<Overrides> {
    let Some(LoroValue::Map(m)) = v else {
        return None;
    };
    let entries: Vec<(String, OverrideEntry)> = m
        .iter()
        .filter_map(|(path, raw)| decode_override_entry(raw).map(|e| (path.to_string(), e)))
        .collect();
    (!entries.is_empty()).then_some(Overrides(entries))
}

fn finite_number(v: Option<&LoroValue>) -> Option<f64> {
    match v {
        Some(LoroValue::Double(n)) if n.is_finite() => Some(*n),
        Some(LoroValue::I64(n)) => Some(*n as f64),
        _ => None,
    }
}

fn decode_handle(v: Option<&LoroValue>) -> Option<[JsNum; 2]> {
    let Some(LoroValue::List(list)) = v else {
        return None;
    };
    if list.len() != 2 {
        return None;
    }
    Some([
        JsNum(finite_number(list.first())?),
        JsNum(finite_number(list.get(1))?),
    ])
}

/// `decodeVectorPoint`.
pub(crate) fn decode_vector_point(v: &LoroValue) -> Option<VectorPoint> {
    let LoroValue::Map(m) = v else { return None };
    Some(VectorPoint {
        x: JsNum(finite_number(m.get("x"))?),
        y: JsNum(finite_number(m.get("y"))?),
        handle_in: decode_handle(m.get("in")),
        handle_out: decode_handle(m.get("out")),
        mode: string_of(m.get("mode"))
            .filter(|mode| matches!(mode.as_str(), "corner" | "smooth" | "mirrored")),
    })
}

/// `decodeVector`: subpaths sorted by (order, id); empty subpaths skipped.
pub(crate) fn decode_vector(v: Option<&LoroValue>) -> Option<VectorData> {
    let Some(LoroValue::Map(m)) = v else {
        return None;
    };
    let fill_rule = match m.get("fillRule") {
        Some(LoroValue::String(s)) if s.as_str() == "evenodd" => "evenodd",
        _ => "nonzero",
    };
    let mut sorted: Vec<(f64, VectorSubpath)> = Vec::new();
    if let Some(LoroValue::Map(subpaths)) = m.get("subpaths") {
        for (id, raw) in subpaths.iter() {
            let LoroValue::Map(sp) = raw else { continue };
            let points: Vec<VectorPoint> = match sp.get("points") {
                Some(LoroValue::List(list)) => {
                    list.iter().filter_map(decode_vector_point).collect()
                }
                _ => Vec::new(),
            };
            if points.is_empty() {
                continue;
            }
            let order = finite_number(sp.get("order")).unwrap_or(0.0);
            sorted.push((
                order,
                VectorSubpath {
                    id: id.to_string(),
                    closed: bool_of(sp.get("closed")) == Some(true),
                    points,
                },
            ));
        }
    }
    sorted.sort_by(|(oa, a), (ob, b)| {
        oa.partial_cmp(ob)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.encode_utf16().cmp(b.id.encode_utf16()))
    });
    Some(VectorData {
        fill_rule: fill_rule.to_owned(),
        subpaths: sorted.into_iter().map(|(_, sp)| sp).collect(),
    })
}

/// `decodeToken`.
pub(crate) fn decode_token(v: &LoroValue) -> Option<Token> {
    let LoroValue::Map(m) = v else { return None };
    let value = match m.get("value") {
        Some(LoroValue::String(s)) => StyleValue::Str(s.to_string()),
        // JS `typeof v === 'number'` accepts any double, including non-finite.
        Some(LoroValue::Double(n)) => StyleValue::Num(*n),
        Some(LoroValue::I64(n)) => StyleValue::Num(*n as f64),
        _ => return None,
    };
    Some(Token {
        token_type: string_of(m.get("type")).unwrap_or_else(|| "other".to_owned()),
        value,
        description: string_of(m.get("description")),
    })
}

fn decode_tokens(v: &LoroValue) -> TokenMap {
    match v {
        LoroValue::Map(m) => TokenMap(
            m.iter()
                .filter_map(|(name, raw)| decode_token(raw).map(|t| (name.to_string(), t)))
                .collect(),
        ),
        _ => TokenMap::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::doc::create_empty_doc;

    #[test]
    fn parse_node_id_matches_js_regex() {
        assert!(parse_node_id("2@1").is_some());
        assert!(parse_node_id("0@18446744073709551615").is_some());
        assert!(parse_node_id("2@").is_none());
        assert!(parse_node_id("@1").is_none());
        assert!(parse_node_id("a@1").is_none());
        assert!(parse_node_id("-1@1").is_none());
        assert!(parse_node_id("1@2@3").is_none());
    }

    #[test]
    fn empty_doc_snapshot() {
        let doc = create_empty_doc("Empty").unwrap();
        let snap = to_snapshot(&doc);
        assert_eq!(snap.name, "Empty");
        assert_eq!(snap.page_ids.len(), 1);
        let page = snap.nodes.get(&snap.page_ids[0]).unwrap();
        assert_eq!(page.node_type, NodeType::Page);
        assert_eq!(page.name, "Page 1");
        assert_eq!(page.background.as_deref(), Some("#EEEEEE"));
        assert_eq!(page.parent_id, None);
        assert!(snap.tokens.is_empty());
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(
            json["nodes"][&snap.page_ids[0]]["styles"],
            serde_json::json!({})
        );
    }

    #[test]
    fn decode_node_tolerates_garbage() {
        let n = decode_node("1@1".into(), None, vec![], &LoroValue::Null);
        assert_eq!(n.node_type, NodeType::Frame);
        assert_eq!(n.name, "");
        assert!(n.styles.is_empty());
        assert_eq!(n.text, None);
    }

    #[test]
    fn decode_token_rules() {
        let doc = loro::LoroDoc::new();
        let m = doc.get_map("t");
        m.insert("value", 0.5).unwrap();
        let t = decode_token(&m.get_deep_value()).unwrap();
        assert_eq!(t.token_type, "other");
        assert_eq!(t.value, StyleValue::Num(0.5));
        m.insert("value", true).unwrap();
        assert!(decode_token(&m.get_deep_value()).is_none());
    }
}
