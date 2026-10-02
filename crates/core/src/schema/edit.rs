//! Mutation helpers mirroring `packages/schema/src/nodes.ts` and `tokens.ts`.
//!
//! The same validation and container layout as JS (mergeable `styles` /
//! `text` / token maps, tree rules, unchanged values write no op), but
//! nothing here commits — group ops and call `doc.commit()` yourself.

use loro::{LoroDoc, LoroMap, LoroText, LoroValue, TreeID, TreeParentId, ValueOrContainer};

use super::doc::{nodes_tree, tokens_map};
use super::snapshot::{is_live, parse_node_id};
use super::types::{NodeType, StyleValue, Token};
use crate::error::{CoreError, Result};
use crate::node_key;

/// Optional initial content for [`create_node`] (`CreateNodeInput` minus the
/// structural fields).
#[derive(Clone, Debug, Default)]
pub struct NodeInit {
    pub name: Option<String>,
    pub styles: Vec<(String, StyleValue)>,
    /// Text nodes only.
    pub text: Option<String>,
    pub svg: Option<String>,
    pub asset_id: Option<String>,
    pub asset_name: Option<String>,
    pub locked: Option<bool>,
    pub hidden: Option<bool>,
    pub background: Option<String>,
    /// Frames (mains) and instances.
    pub component_key: Option<String>,
    /// Nodes inside a main component.
    pub node_key: Option<String>,
    /// Instances: TreeID hint of the main.
    pub main_id: Option<String>,
}

fn require_node(doc: &LoroDoc, id: &str) -> Result<TreeID> {
    let tree = nodes_tree(doc);
    parse_node_id(id)
        .filter(|&tid| is_live(&tree, tid))
        .ok_or_else(|| CoreError::NodeNotFound(id.to_owned()))
}

fn node_type_of(doc: &LoroDoc, id: TreeID) -> NodeType {
    let Ok(data) = nodes_tree(doc).get_meta(id) else {
        return NodeType::Frame;
    };
    match data.get(node_key::TYPE) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => {
            NodeType::parse(&s).unwrap_or(NodeType::Frame)
        }
        _ => NodeType::Frame,
    }
}

/// `getNodeType`.
pub fn get_node_type(doc: &LoroDoc, id: &str) -> Result<NodeType> {
    Ok(node_type_of(doc, require_node(doc, id)?))
}

fn assert_parent_allowed(doc: &LoroDoc, node_type: NodeType, parent: Option<&str>) -> Result<()> {
    match (node_type, parent) {
        (NodeType::Page, None) => Ok(()),
        (NodeType::Page, Some(_)) => Err(CoreError::invalid("Pages must be root nodes")),
        (t, None) => Err(CoreError::invalid(format!(
            "A {} node needs a parent page or frame",
            t.as_str()
        ))),
        (_, Some(parent)) => {
            let parent_type = node_type_of(doc, require_node(doc, parent)?);
            if parent_type.is_container() {
                Ok(())
            } else {
                Err(CoreError::invalid(format!(
                    "A {} node cannot contain children",
                    parent_type.as_str()
                )))
            }
        }
    }
}

fn parent_id(parent: Option<&str>) -> Result<TreeParentId> {
    match parent {
        None => Ok(TreeParentId::Root),
        Some(p) => parse_node_id(p)
            .map(TreeParentId::Node)
            .ok_or_else(|| CoreError::NodeNotFound(p.to_owned())),
    }
}

fn child_count(doc: &LoroDoc, parent: Option<&str>) -> Result<usize> {
    Ok(nodes_tree(doc)
        .children_num(parent_id(parent)?)
        .unwrap_or(0))
}

/// Create a node and return its id. `index` is clamped; `None` appends.
pub fn create_node(
    doc: &LoroDoc,
    node_type: NodeType,
    parent: Option<&str>,
    index: Option<usize>,
    init: &NodeInit,
) -> Result<String> {
    if init.text.is_some() && node_type != NodeType::Text {
        return Err(CoreError::invalid(format!(
            "Only text nodes have text content (got {})",
            node_type.as_str()
        )));
    }
    if let Some((key, _)) = init
        .styles
        .iter()
        .find(|(_, v)| matches!(v, StyleValue::Num(n) if !n.is_finite()))
    {
        return Err(CoreError::invalid(format!(
            "Style {key} must be a string or finite number"
        )));
    }
    if node_type == NodeType::Instance && init.component_key.is_none() {
        return Err(CoreError::invalid("An instance needs a componentKey"));
    }
    if init.component_key.is_some() && !matches!(node_type, NodeType::Frame | NodeType::Instance) {
        return Err(CoreError::invalid(
            "Only frames and instances have a componentKey",
        ));
    }
    assert_parent_allowed(doc, node_type, parent)?;
    let count = child_count(doc, parent)?;
    let at = index.unwrap_or(count).min(count);
    let tree = nodes_tree(doc);
    let id = tree.create_at(parent_id(parent)?, at)?;
    write_node_data(&tree.get_meta(id)?, node_type, init)?;
    Ok(id.to_string())
}

/// `writeNodeData`: fast path without validation (also used by the bench generator).
pub fn write_node_data(data: &LoroMap, node_type: NodeType, init: &NodeInit) -> Result<()> {
    data.insert(node_key::TYPE, node_type.as_str())?;
    data.insert(
        node_key::NAME,
        init.name.as_deref().unwrap_or(node_type.default_name()),
    )?;
    let styles = data.ensure_mergeable_map(node_key::STYLES)?;
    for (k, v) in &init.styles {
        styles.insert(k, v.to_loro())?;
    }
    if node_type == NodeType::Text {
        let text = data.ensure_mergeable_text(node_key::TEXT)?;
        if let Some(t) = init.text.as_deref().filter(|t| !t.is_empty()) {
            text.insert(0, t)?;
        }
    }
    if let Some(v) = &init.svg {
        data.insert(node_key::SVG, v.as_str())?;
    }
    if let Some(v) = &init.asset_id {
        data.insert(node_key::ASSET_ID, v.as_str())?;
    }
    if let Some(v) = &init.asset_name {
        data.insert(node_key::ASSET_NAME, v.as_str())?;
    }
    if let Some(v) = init.locked {
        data.insert(node_key::LOCKED, v)?;
    }
    if let Some(v) = init.hidden {
        data.insert(node_key::HIDDEN, v)?;
    }
    if let Some(v) = &init.background {
        data.insert(node_key::BACKGROUND, v.as_str())?;
    }
    if let Some(v) = &init.component_key {
        data.insert(node_key::COMPONENT_KEY, v.as_str())?;
    }
    if let Some(v) = &init.node_key {
        data.insert(node_key::NODE_KEY, v.as_str())?;
    }
    if let Some(v) = &init.main_id {
        data.insert(node_key::MAIN_ID, v.as_str())?;
    }
    // Same layout as JS `writeNodeData`: every instance gets its (mergeable) overrides map and
    // every vector its vector map at creation.
    match node_type {
        NodeType::Instance => {
            data.ensure_mergeable_map(node_key::OVERRIDES)?;
        }
        NodeType::Vector => {
            data.ensure_mergeable_map(node_key::VECTOR)?
                .ensure_mergeable_map("subpaths")?;
        }
        _ => {}
    }
    Ok(())
}

/// `moveNode`: `index` is the final position among the new siblings (clamped);
/// `None` appends. Moving a node into its own subtree fails.
pub fn move_node(
    doc: &LoroDoc,
    id: &str,
    parent: Option<&str>,
    index: Option<usize>,
) -> Result<()> {
    let tid = require_node(doc, id)?;
    assert_parent_allowed(doc, node_type_of(doc, tid), parent)?;
    let tree = nodes_tree(doc);
    let target_parent = parent_id(parent)?;
    let same_parent = tree.parent(tid) == Some(target_parent);
    let max = child_count(doc, parent)? - usize::from(same_parent);
    let to = index.unwrap_or(max).min(max);
    if same_parent {
        let siblings = tree.children(target_parent).unwrap_or_default();
        if siblings.iter().position(|c| *c == tid) == Some(to) {
            return Ok(());
        }
    }
    tree.mov_to(tid, target_parent, to)
        .map_err(|e| CoreError::invalid(format!("Cannot move {id}: {e}")))
}

/// `deleteNode`: deletes the node and its subtree.
pub fn delete_node(doc: &LoroDoc, id: &str) -> Result<()> {
    let tid = require_node(doc, id)?;
    nodes_tree(doc).delete(tid)?;
    Ok(())
}

fn styles_map(doc: &LoroDoc, tid: TreeID) -> Result<LoroMap> {
    let data = nodes_tree(doc).get_meta(tid)?;
    match data.get(node_key::STYLES) {
        Some(ValueOrContainer::Container(loro::Container::Map(m))) => Ok(m),
        _ => Ok(data.ensure_mergeable_map(node_key::STYLES)?),
    }
}

fn current_value(map: &LoroMap, key: &str) -> Option<LoroValue> {
    match map.get(key)? {
        ValueOrContainer::Value(v) => Some(v),
        ValueOrContainer::Container(_) => None,
    }
}

/// `setStyles`: patch style properties; `None` removes. Unchanged values write no op.
pub fn set_styles(doc: &LoroDoc, id: &str, patch: &[(&str, Option<StyleValue>)]) -> Result<()> {
    let styles = styles_map(doc, require_node(doc, id)?)?;
    for (key, value) in patch {
        match value {
            None => {
                if styles.get(key).is_some() {
                    styles.delete(key)?;
                }
            }
            Some(StyleValue::Num(n)) if !n.is_finite() => {
                return Err(CoreError::invalid(format!(
                    "Style {key} must be a string or finite number"
                )));
            }
            Some(v) => {
                let next = v.to_loro();
                if current_value(&styles, key).as_ref() != Some(&next) {
                    styles.insert(key, next)?;
                }
            }
        }
    }
    Ok(())
}

/// `setText`: replace a text node's content as a minimal diff.
pub fn set_text(doc: &LoroDoc, id: &str, text: &str) -> Result<()> {
    let tid = require_node(doc, id)?;
    let node_type = node_type_of(doc, tid);
    if node_type != NodeType::Text {
        return Err(CoreError::invalid(format!(
            "Node {id} is a {}, not text",
            node_type.as_str()
        )));
    }
    let data = nodes_tree(doc).get_meta(tid)?;
    let container: LoroText = match data.get(node_key::TEXT) {
        Some(ValueOrContainer::Container(loro::Container::Text(t))) => t,
        _ => data.ensure_mergeable_text(node_key::TEXT)?,
    };
    if container.to_string() != text {
        container
            .update(text, Default::default())
            .map_err(|e| CoreError::Loro(format!("text update timed out: {e:?}")))?;
    }
    Ok(())
}

/// `isTokenName`: `^--[A-Za-z0-9_-]+$`.
pub fn is_token_name(name: &str) -> bool {
    name.len() > 2
        && name.starts_with("--")
        && name[2..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `setTokens` (merge mode): upsert tokens; `None` deletes.
pub fn set_tokens(doc: &LoroDoc, tokens: &[(&str, Option<Token>)]) -> Result<()> {
    if let Some((name, _)) = tokens.iter().find(|(n, _)| !is_token_name(n)) {
        return Err(CoreError::invalid(format!(
            "Token names must be CSS custom properties: {name}"
        )));
    }
    let map = tokens_map(doc);
    for (name, token) in tokens {
        let Some(token) = token else {
            if map.get(name).is_some() {
                map.delete(name)?;
            }
            continue;
        };
        let entry = match map.get(name) {
            Some(ValueOrContainer::Container(loro::Container::Map(m))) => m,
            _ => map.ensure_mergeable_map(name)?,
        };
        let set = |key: &str, v: LoroValue| -> Result<()> {
            if current_value(&entry, key).as_ref() != Some(&v) {
                entry.insert(key, v)?;
            }
            Ok(())
        };
        set("type", LoroValue::from(token.token_type.as_str()))?;
        set("value", token.value.to_loro())?;
        match &token.description {
            Some(d) => set("description", LoroValue::from(d.as_str()))?,
            None => {
                if entry.get("description").is_some() {
                    entry.delete("description")?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::doc::create_empty_doc;
    use crate::schema::snapshot::{get_node, to_snapshot};

    fn page(doc: &LoroDoc) -> String {
        to_snapshot(doc).page_ids[0].clone()
    }

    #[test]
    fn create_validates_tree_rules() {
        let doc = create_empty_doc("T").unwrap();
        let page = page(&doc);
        let none = NodeInit::default();
        assert!(create_node(&doc, NodeType::Page, Some(&page), None, &none).is_err());
        assert!(create_node(&doc, NodeType::Frame, None, None, &none).is_err());
        let text = create_node(&doc, NodeType::Text, Some(&page), None, &none).unwrap();
        let err = create_node(&doc, NodeType::Rect, Some(&text), None, &none).unwrap_err();
        assert_eq!(err.code(), "invalid-input");
        let with_text = NodeInit {
            text: Some("x".into()),
            ..Default::default()
        };
        assert!(create_node(&doc, NodeType::Rect, Some(&page), None, &with_text).is_err());
        assert_eq!(
            create_node(&doc, NodeType::Rect, Some("9@9"), None, &none)
                .unwrap_err()
                .code(),
            "not-found"
        );
    }

    #[test]
    fn create_move_delete_keep_order() {
        let doc = create_empty_doc("T").unwrap();
        let page = page(&doc);
        let mk = |name: &str, idx: Option<usize>| {
            let init = NodeInit {
                name: Some(name.into()),
                ..Default::default()
            };
            create_node(&doc, NodeType::Frame, Some(&page), idx, &init).unwrap()
        };
        let a = mk("A", None);
        let b = mk("B", None);
        let c = mk("C", Some(0));
        let order = |doc: &LoroDoc| {
            let snap = to_snapshot(doc);
            snap.nodes.get(&page).unwrap().children.clone()
        };
        assert_eq!(order(&doc), [c.clone(), a.clone(), b.clone()]);
        move_node(&doc, &c, Some(&page), Some(99)).unwrap();
        assert_eq!(order(&doc), [a.clone(), b.clone(), c.clone()]);
        move_node(&doc, &b, Some(&a), None).unwrap();
        assert_eq!(order(&doc), [a.clone(), c.clone()]);
        assert!(
            move_node(&doc, &a, Some(&b), None).is_err(),
            "cycle rejected"
        );
        delete_node(&doc, &a).unwrap();
        doc.commit();
        let snap = to_snapshot(&doc);
        assert!(!snap.nodes.contains(&a));
        assert!(!snap.nodes.contains(&b), "descendants go with their parent");
        assert_eq!(snap.nodes.len(), 2);
    }

    #[test]
    fn styles_text_and_tokens() {
        let doc = create_empty_doc("T").unwrap();
        let page = page(&doc);
        let t = create_node(
            &doc,
            NodeType::Text,
            Some(&page),
            None,
            &NodeInit {
                text: Some("Hello".into()),
                styles: vec![("fontSize".into(), "12px".into())],
                ..Default::default()
            },
        )
        .unwrap();
        set_styles(
            &doc,
            &t,
            &[
                ("fontSize", None),
                ("left", Some(10.into())),
                ("color", Some("red".into())),
            ],
        )
        .unwrap();
        set_text(&doc, &t, "Hello, world").unwrap();
        assert!(set_text(&doc, &page, "nope").is_err());
        set_tokens(
            &doc,
            &[(
                "--color-primary",
                Some(Token {
                    token_type: "color".into(),
                    value: "#141414".into(),
                    description: None,
                }),
            )],
        )
        .unwrap();
        assert!(set_tokens(&doc, &[("color", None)]).is_err());
        doc.commit();
        let node = get_node(&doc, &t).unwrap();
        assert_eq!(node.text.as_deref(), Some("Hello, world"));
        assert_eq!(node.styles.get("left"), Some(&StyleValue::Num(10.0)));
        assert_eq!(node.styles.get("fontSize"), None);
        assert_eq!(
            to_snapshot(&doc)
                .tokens
                .get("--color-primary")
                .unwrap()
                .value,
            "#141414".into()
        );
    }

    #[test]
    fn unchanged_writes_produce_no_ops() {
        let doc = create_empty_doc("T").unwrap();
        let page = page(&doc);
        let r = create_node(
            &doc,
            NodeType::Rect,
            Some(&page),
            None,
            &NodeInit::default(),
        )
        .unwrap();
        set_styles(&doc, &r, &[("width", Some(10.into()))]).unwrap();
        doc.commit();
        let before = doc.oplog_vv();
        set_styles(&doc, &r, &[("width", Some(10.into())), ("height", None)]).unwrap();
        move_node(&doc, &r, Some(&page), Some(0)).unwrap();
        doc.commit();
        assert_eq!(doc.oplog_vv(), before);
    }

    #[test]
    fn token_names() {
        assert!(is_token_name("--color-primary"));
        assert!(is_token_name("--a_b-9"));
        assert!(!is_token_name("--"));
        assert!(!is_token_name("-a"));
        assert!(!is_token_name("--a b"));
    }
}
