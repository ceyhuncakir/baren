//! Instance resolution, mirroring `packages/schema/src/resolve.ts` (contract §2.7.4, §3.2):
//! instances are tree leaves whose content is expanded from their main component at render
//! time; expanded nodes get virtual ids `"<instanceId>/<path>"`. `to_render_subtree` prints the
//! same JSON as the TS `toRenderSubtree` (checked by the parity fixtures).
//!
//! The `loro` crate reads the retained data and children of deleted tree nodes (verified, also
//! after a snapshot round trip), so instances of a deleted main render from it, as in JS.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use loro::{LoroDoc, LoroTree, LoroValue, TreeID, ValueOrContainer};
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

use super::doc::nodes_tree;
use super::snapshot::{decode_node, is_live, parse_node_id, to_subtree_snapshot};
use super::types::{DesignNode, NodeType, OverrideEntry, Overrides, StyleValue, Styles};
use crate::{container, node_key};

/// Deepest nesting of instances inside instances (`MAX_INSTANCE_DEPTH`).
pub const MAX_INSTANCE_DEPTH: usize = 16;
/// Placeholder fill of unresolved instances (`MISSING_FILL_COLOR`).
pub const MISSING_FILL_COLOR: &str = "#E3E3E3";
/// Style keys an instance always owns (`PLACEMENT_KEYS`).
pub const PLACEMENT_KEYS: [&str; 28] = [
    "left",
    "top",
    "right",
    "bottom",
    "inset",
    "position",
    "rotate",
    "transform",
    "margin",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "alignSelf",
    "justifySelf",
    "flex",
    "flexGrow",
    "flexShrink",
    "flexBasis",
    "order",
    "zIndex",
    "gridArea",
    "gridColumn",
    "gridColumnStart",
    "gridColumnEnd",
    "gridRow",
    "gridRowStart",
    "gridRowEnd",
];
/// Size keys an instance may own (`SIZE_KEYS`).
pub const SIZE_KEYS: [&str; 7] = [
    "width",
    "height",
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
    "aspectRatio",
];
const MAX_TREE_DEPTH: usize = 256;

/// `InstanceStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstanceStatus {
    Ok,
    Cycle,
    Depth,
    Unresolved,
}

/// `ResolvedNode.source`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSource {
    pub instance_id: String,
    pub path: String,
    pub main_node_id: String,
    pub component_key: String,
}

/// `ResolvedNode.overridden` (style keys sorted).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overridden {
    pub styles: Vec<String>,
    pub text: bool,
    pub hidden: bool,
    pub asset_id: bool,
}

/// `ResolvedNode`: a `DesignNode` (real or virtual id) plus resolution details.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedNode {
    #[serde(flatten)]
    pub node: DesignNode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ResolvedSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overridden: Option<Overridden>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<InstanceStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_deleted: Option<bool>,
}

impl ResolvedNode {
    fn plain(node: DesignNode) -> Self {
        ResolvedNode {
            node,
            source: None,
            overridden: None,
            status: None,
            main_deleted: None,
        }
    }
}

/// `toRenderSubtree` result: nodes in pre-order (instances expanded in place).
#[derive(Clone, Debug, PartialEq)]
pub struct RenderSubtree {
    pub root_id: String,
    pub nodes: Vec<ResolvedNode>,
}

impl RenderSubtree {
    pub fn get(&self, id: &str) -> Option<&ResolvedNode> {
        self.nodes.iter().find(|n| n.node.id == id)
    }
}

impl Serialize for RenderSubtree {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        struct Nodes<'a>(&'a [ResolvedNode]);
        impl Serialize for Nodes<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let mut map = s.serialize_map(Some(self.0.len()))?;
                for n in self.0 {
                    map.serialize_entry(&n.node.id, n)?;
                }
                map.end()
            }
        }
        let mut map = s.serialize_map(Some(2))?;
        map.serialize_entry("rootId", &self.root_id)?;
        map.serialize_entry("nodes", &Nodes(&self.nodes))?;
        map.end()
    }
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/// `normalizeDeg`: (−180, 180].
pub fn normalize_deg(deg: f64) -> f64 {
    if !deg.is_finite() {
        return 0.0;
    }
    let mut r = deg % 360.0;
    if r <= -180.0 {
        r += 360.0;
    } else if r > 180.0 {
        r -= 360.0;
    }
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

/// `parseAngle`: degrees from `"15deg"`, `"0.25turn"`, `"1rad"`, `"10grad"` or `"15"`.
pub fn parse_angle(value: &str) -> Option<f64> {
    let lower = value.trim().to_ascii_lowercase();
    let units = ["deg", "turn", "grad", "rad"];
    let (num, unit) = units
        .iter()
        .find_map(|u| lower.strip_suffix(u).map(|n| (n, *u)))
        .unwrap_or((lower.as_str(), "deg"));
    // `[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?` — the same grammar as the TS regex.
    let body = num.strip_prefix(['+', '-']).unwrap_or(num);
    let (mantissa, exponent) = match body.split_once('e') {
        Some((m, e)) => (m, Some(e)),
        None => (body, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((int, frac)) => {
            (digits(int) && (frac.is_empty() || digits(frac))) || (int.is_empty() && digits(frac))
        }
        None => digits(mantissa),
    };
    let exponent_ok = exponent.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)));
    if !mantissa_ok || !exponent_ok {
        return None;
    }
    let n: f64 = num.parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    Some(match unit {
        "turn" => n * 360.0,
        "rad" => (n * 180.0) / std::f64::consts::PI,
        "grad" => n * 0.9,
        _ => n,
    })
}

/// `rotateOnlyTransform`: the summed angles of a transform made only of rotate()/rotateZ().
pub fn rotate_only_transform(value: Option<&StyleValue>) -> Option<f64> {
    let Some(StyleValue::Str(t)) = value else {
        return None;
    };
    let t = t.trim();
    if t.is_empty() || t == "none" {
        return None;
    }
    let mut total = 0.0;
    let mut rest = t;
    let mut any = false;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let open = rest.find('(')?;
        let close = rest.find(')')?;
        if close < open {
            return None;
        }
        let name = rest[..open].to_ascii_lowercase();
        if name != "rotate" && name != "rotatez" {
            return None;
        }
        total += parse_angle(&rest[open + 1..close])?;
        any = true;
        rest = &rest[close + 1..];
    }
    any.then_some(total)
}

/// `readRotation`: a node's own rotation in degrees, normalised to (−180, 180].
pub fn read_rotation(styles: &Styles) -> f64 {
    let mut deg = match styles.get("rotate") {
        Some(StyleValue::Num(n)) if n.is_finite() => *n,
        Some(StyleValue::Str(s)) if s.trim() != "none" => parse_angle(s).unwrap_or(0.0),
        _ => 0.0,
    };
    deg += rotate_only_transform(styles.get("transform")).unwrap_or(0.0);
    normalize_deg(deg)
}

// ---------------------------------------------------------------------------
// Main lookup (§2.7.4)
// ---------------------------------------------------------------------------

/// `findMainComponent` result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoundMain {
    pub main_id: String,
    pub deleted: bool,
}

fn meta_str(tree: &LoroTree, id: TreeID, key: &str) -> Option<String> {
    match tree.get_meta(id).ok()?.get(key)? {
        ValueOrContainer::Value(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

/// The node's `componentKey` when it decodes as a frame (a main).
fn main_key_of(tree: &LoroTree, id: TreeID) -> Option<String> {
    let key = meta_str(tree, id, node_key::COMPONENT_KEY)?;
    let frame_like = match meta_str(tree, id, node_key::TYPE) {
        Some(t) => NodeType::parse(&t).is_none_or(|t| t == NodeType::Frame),
        None => true,
    };
    frame_like.then_some(key)
}

fn registry_main_id(doc: &LoroDoc, key: &str) -> Option<String> {
    let entry = match doc.get_map(container::COMPONENTS).get(key)? {
        ValueOrContainer::Container(loro::Container::Map(m)) => m,
        _ => return None,
    };
    match entry.get("mainId")? {
        ValueOrContainer::Value(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn smallest_live_main(tree: &LoroTree, key: &str) -> Option<TreeID> {
    tree.nodes()
        .into_iter()
        .filter(|id| is_live(tree, *id) && main_key_of(tree, *id).as_deref() == Some(key))
        .min_by_key(|id| (id.peer, id.counter))
}

/// `findMainComponent(doc, key, hint)`: registry → smallest live TreeID → retained data of a
/// deleted main (registry id, then `hint`) → `None`.
pub fn find_main_component(doc: &LoroDoc, key: &str, hint: Option<&str>) -> Option<FoundMain> {
    let tree = nodes_tree(doc);
    let registered = registry_main_id(doc, key);
    if let Some(tid) = registered.as_deref().and_then(parse_node_id) {
        if is_live(&tree, tid) && main_key_of(&tree, tid).as_deref() == Some(key) {
            return Some(FoundMain {
                main_id: tid.to_string(),
                deleted: false,
            });
        }
    }
    if let Some(tid) = smallest_live_main(&tree, key) {
        return Some(FoundMain {
            main_id: tid.to_string(),
            deleted: false,
        });
    }
    for candidate in [registered.as_deref(), hint].into_iter().flatten() {
        let Some(tid) = parse_node_id(candidate) else {
            continue;
        };
        if tree.contains(tid)
            && tree.is_node_deleted(&tid).unwrap_or(false)
            && main_key_of(&tree, tid).as_deref() == Some(key)
        {
            return Some(FoundMain {
                main_id: candidate.to_owned(),
                deleted: true,
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Resolution (§3.2)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct TNode {
    path: String,
    parent_path: Option<String>,
    child_paths: Vec<String>,
    /// Fields of the resolved node (id/parent/children are assigned per instance).
    node: DesignNode,
    status: Option<InstanceStatus>,
    main_deleted: bool,
    main_node_id: String,
    source_key: String,
}

#[derive(Debug)]
struct Template {
    ok: bool,
    main_deleted: bool,
    name: String,
    nodes: Vec<TNode>,
    deps: HashSet<String>,
    max_depth: usize,
    truncated: bool,
}

struct TExpansion {
    nodes: Vec<TNode>,
    main_name: String,
    deps: HashSet<String>,
    max_depth: usize,
    truncated: bool,
}

struct RawNode {
    id: TreeID,
    meta: LoroValue,
    children: Vec<RawNode>,
}

fn raw_subtree(tree: &LoroTree, id: TreeID, depth: usize) -> RawNode {
    let meta = tree
        .get_meta(id)
        .map(|m| m.get_deep_value())
        .unwrap_or(LoroValue::Null);
    let children = if depth < MAX_TREE_DEPTH {
        tree.children(id)
            .unwrap_or_default()
            .into_iter()
            .map(|c| raw_subtree(tree, c, depth + 1))
            .collect()
    } else {
        Vec::new()
    };
    RawNode { id, meta, children }
}

fn is_node_key(s: &str) -> bool {
    s.len() == 10
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

fn is_placement_key(k: &str) -> bool {
    PLACEMENT_KEYS.contains(&k)
}

fn set_style(styles: &mut Styles, key: &str, value: StyleValue) {
    match styles.0.iter_mut().find(|(k, _)| k == key) {
        Some((_, v)) => *v = value,
        None => styles.0.push((key.to_owned(), value)),
    }
}

fn remove_style(styles: &mut Styles, key: &str) {
    styles.0.retain(|(k, _)| k != key);
}

fn apply_override_styles(styles: &mut Styles, entry: Option<&OverrideEntry>) {
    let Some(o) = entry.and_then(|e| e.styles.as_ref()) else {
        return;
    };
    for (key, value) in &o.0 {
        match value {
            None => remove_style(styles, key),
            Some(v) => set_style(styles, key, v.clone()),
        }
    }
}

fn apply_entry(node: &mut DesignNode, entry: Option<&OverrideEntry>) {
    let Some(e) = entry else { return };
    apply_override_styles(&mut node.styles, Some(e));
    if let Some(t) = &e.text {
        if node.node_type == NodeType::Text {
            node.text = Some(t.clone());
        }
    }
    if let Some(h) = e.hidden {
        node.hidden = Some(h);
    }
    if let Some(a) = &e.asset_id {
        node.asset_id = Some(a.clone());
    }
    if let Some(a) = &e.asset_name {
        node.asset_name = Some(a.clone());
    }
}

fn without_placement(styles: &Styles) -> Styles {
    Styles(
        styles
            .0
            .iter()
            .filter(|(k, _)| !is_placement_key(k))
            .cloned()
            .collect(),
    )
}

/// Base, then `overrides['']`, then the instance's own styles (all keys).
fn root_styles(base: &Styles, inst: &DesignNode) -> Styles {
    let mut styles = base.clone();
    apply_override_styles(&mut styles, inst.overrides.as_ref().and_then(|o| o.get("")));
    for (k, v) in inst.styles.iter() {
        set_style(&mut styles, k, v.clone());
    }
    styles
}

fn placeholder_styles(inst: &DesignNode) -> Styles {
    let mut styles = root_styles(&Styles::default(), inst);
    if styles.get("width").is_none() {
        styles.0.push(("width".into(), StyleValue::Num(100.0)));
    }
    if styles.get("height").is_none() {
        styles.0.push(("height".into(), StyleValue::Num(100.0)));
    }
    if styles.get("backgroundColor").is_none() && styles.get("background").is_none() {
        styles
            .0
            .push(("backgroundColor".into(), MISSING_FILL_COLOR.into()));
    }
    styles
}

fn placeholder_node(inst: &DesignNode, status: InstanceStatus) -> TNode {
    TNode {
        path: String::new(),
        parent_path: None,
        child_paths: Vec::new(),
        node: DesignNode {
            node_type: NodeType::Instance,
            name: inst.name.clone(),
            styles: placeholder_styles(inst),
            locked: inst.locked,
            hidden: inst.hidden,
            component_key: inst.component_key.clone(),
            node_key: inst.node_key.clone(),
            main_id: inst.main_id.clone(),
            ..Default::default()
        },
        status: Some(status),
        main_deleted: false,
        main_node_id: String::new(),
        source_key: inst.component_key.clone().unwrap_or_default(),
    }
}

fn overridden_of(entry: Option<&OverrideEntry>, extra: &[String]) -> Option<Overridden> {
    let mut styles: Vec<String> = entry
        .and_then(|e| e.styles.as_ref())
        .map(|s| s.0.iter().map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    styles.extend(extra.iter().cloned());
    // JS sorts by UTF-16 code units; style keys are ASCII, so byte order is the same.
    styles.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    styles.dedup();
    let text = entry.is_some_and(|e| e.text.is_some());
    let hidden = entry.is_some_and(|e| e.hidden.is_some());
    let asset_id = entry.is_some_and(|e| e.asset_id.is_some());
    (!styles.is_empty() || text || hidden || asset_id).then_some(Overridden {
        styles,
        text,
        hidden,
        asset_id,
    })
}

fn own_size_keys(styles: &Styles) -> Vec<String> {
    styles
        .0
        .iter()
        .filter(|(k, _)| SIZE_KEYS.contains(&k.as_str()))
        .map(|(k, _)| k.clone())
        .collect()
}

fn virtual_id(instance: &str, path: &str) -> String {
    if path.is_empty() {
        instance.to_owned()
    } else {
        format!("{instance}/{path}")
    }
}

/// One resolution pass over a document (templates cached for the pass).
pub struct Resolver<'a> {
    doc: &'a LoroDoc,
    tree: LoroTree,
    templates: HashMap<String, Rc<Template>>,
}

impl<'a> Resolver<'a> {
    pub fn new(doc: &'a LoroDoc) -> Self {
        Resolver {
            doc,
            tree: nodes_tree(doc),
            templates: HashMap::new(),
        }
    }

    fn valid_in(t: &Template, stack: &[String]) -> bool {
        stack.is_empty()
            || (stack.len() + t.max_depth < MAX_INSTANCE_DEPTH
                && !stack.iter().any(|k| t.deps.contains(k)))
    }

    fn template(&mut self, key: &str, stack: &[String], hint: Option<&str>) -> Rc<Template> {
        if let Some(t) = self.templates.get(key) {
            if Self::valid_in(t, stack) && (t.ok || hint.is_none()) {
                return t.clone();
            }
        }
        let hint_key = hint.map(|h| format!("{key}|{h}"));
        if let Some(t) = hint_key.as_ref().and_then(|k| self.templates.get(k)) {
            if Self::valid_in(t, stack) {
                return t.clone();
            }
        }
        let (t, main_id) = self.build_template(key, stack, hint);
        let t = Rc::new(t);
        if !t.truncated && !stack.iter().any(|k| t.deps.contains(k)) {
            let via_hint = hint.is_some()
                && (!t.ok
                    || (t.main_deleted
                        && main_id.as_deref() == hint
                        && registry_main_id(self.doc, key).as_deref() != hint));
            let cache_key = if via_hint {
                hint_key.unwrap_or_else(|| key.to_owned())
            } else {
                key.to_owned()
            };
            self.templates.insert(cache_key, t.clone());
        }
        t
    }

    fn build_template(
        &mut self,
        key: &str,
        stack: &[String],
        hint: Option<&str>,
    ) -> (Template, Option<String>) {
        let unresolved = || Template {
            ok: false,
            main_deleted: false,
            name: String::new(),
            nodes: Vec::new(),
            deps: HashSet::new(),
            max_depth: 0,
            truncated: false,
        };
        let Some(found) = find_main_component(self.doc, key, hint) else {
            return (unresolved(), None);
        };
        let Some(root_id) = parse_node_id(&found.main_id).filter(|id| self.tree.contains(*id))
        else {
            return (unresolved(), None);
        };
        let raw = raw_subtree(&self.tree, root_id, 0);
        let main = decode_node(raw.id.to_string(), None, Vec::new(), &raw.meta);
        let mut t = Template {
            ok: true,
            main_deleted: found.deleted,
            name: main.name.clone(),
            nodes: vec![TNode {
                path: String::new(),
                parent_path: None,
                child_paths: Vec::new(),
                node: DesignNode {
                    node_type: NodeType::Instance,
                    name: main.name.clone(),
                    styles: without_placement(&main.styles),
                    ..Default::default()
                },
                status: None,
                main_deleted: false,
                main_node_id: raw.id.to_string(),
                source_key: key.to_owned(),
            }],
            deps: HashSet::new(),
            max_depth: 0,
            truncated: false,
        };
        let mut used: HashSet<String> = HashSet::new();
        let mut inner: Vec<String> = stack.to_vec();
        inner.push(key.to_owned());
        for child in &raw.children {
            self.visit(&mut t, child, 0, &inner, &mut used, key, 1);
        }
        (t, Some(found.main_id))
    }

    #[allow(clippy::too_many_arguments)]
    fn visit(
        &mut self,
        t: &mut Template,
        raw: &RawNode,
        parent_index: usize,
        inner: &[String],
        used: &mut HashSet<String>,
        key: &str,
        depth: usize,
    ) {
        let d = decode_node(raw.id.to_string(), None, Vec::new(), &raw.meta);
        let segment = match d.node_key.as_deref() {
            Some(k) if is_node_key(k) && !used.contains(k) => k.to_owned(),
            _ => format!("~{}", raw.id),
        };
        used.insert(segment.clone());
        t.nodes[parent_index].child_paths.push(segment.clone());
        let parent_path = t.nodes[parent_index].path.clone();
        if d.node_type == NodeType::Instance {
            let nested = self.expand_nested(&d, inner);
            if let Some(k) = &d.component_key {
                t.deps.insert(k.clone());
            }
            t.deps.extend(nested.deps.iter().cloned());
            t.max_depth = t.max_depth.max(1 + nested.max_depth);
            t.truncated |= nested.truncated;
            let prefix = |p: &str| {
                if p.is_empty() {
                    segment.clone()
                } else {
                    format!("{segment}/{p}")
                }
            };
            for nn in nested.nodes {
                let is_root = nn.path.is_empty();
                let mut node = TNode {
                    path: prefix(&nn.path),
                    parent_path: Some(match &nn.parent_path {
                        None => parent_path.clone(),
                        Some(p) => prefix(p),
                    }),
                    child_paths: nn.child_paths.iter().map(|p| prefix(p)).collect(),
                    ..nn
                };
                if is_root {
                    node.main_node_id = raw.id.to_string();
                    node.source_key = key.to_owned();
                    if d.node_key.is_some() {
                        node.node.node_key = d.node_key.clone();
                    }
                    node.node.name = if d.name.is_empty() {
                        nested.main_name.clone()
                    } else {
                        d.name.clone()
                    };
                }
                t.nodes.push(node);
            }
            return;
        }
        let node = TNode {
            path: segment,
            parent_path: Some(parent_path),
            child_paths: Vec::new(),
            node: DesignNode {
                node_type: d.node_type,
                name: d.name,
                styles: d.styles,
                text: d.text,
                svg: d.svg,
                asset_id: d.asset_id,
                asset_name: d.asset_name,
                locked: d.locked,
                hidden: d.hidden,
                node_key: d.node_key,
                vector: d.vector,
                ..Default::default()
            },
            status: None,
            main_deleted: false,
            main_node_id: raw.id.to_string(),
            source_key: key.to_owned(),
        };
        t.nodes.push(node);
        let index = t.nodes.len() - 1;
        if depth < MAX_TREE_DEPTH {
            for child in &raw.children {
                self.visit(t, child, index, inner, used, key, depth + 1);
            }
        }
    }

    fn expand_nested(&mut self, inst: &DesignNode, stack: &[String]) -> TExpansion {
        let status = match &inst.component_key {
            None => Some(InstanceStatus::Unresolved),
            Some(k) if stack.contains(k) => Some(InstanceStatus::Cycle),
            Some(_) if stack.len() >= MAX_INSTANCE_DEPTH => Some(InstanceStatus::Depth),
            Some(_) => None,
        };
        let t = match (status, &inst.component_key) {
            (None, Some(k)) => Some(self.template(k, stack, inst.main_id.as_deref())),
            _ => None,
        };
        let t = match t {
            Some(t) if t.ok => t,
            _ => {
                let s = status.unwrap_or(InstanceStatus::Unresolved);
                return TExpansion {
                    nodes: vec![placeholder_node(inst, s)],
                    main_name: String::new(),
                    deps: HashSet::new(),
                    max_depth: 0,
                    truncated: s == InstanceStatus::Depth,
                };
            }
        };
        let empty = Overrides::default();
        let overrides = inst.overrides.as_ref().unwrap_or(&empty);
        let key = inst.component_key.clone().unwrap_or_default();
        let nodes = t
            .nodes
            .iter()
            .map(|tn| {
                let mut n = tn.clone();
                if tn.path.is_empty() {
                    n.node.styles = root_styles(&tn.node.styles, inst);
                    n.node.node_type = NodeType::Instance;
                    n.node.name = if inst.name.is_empty() {
                        t.name.clone()
                    } else {
                        inst.name.clone()
                    };
                    n.node.hidden = inst.hidden;
                    n.node.locked = inst.locked;
                    n.node.component_key = Some(key.clone());
                    if inst.main_id.is_some() {
                        n.node.main_id = inst.main_id.clone();
                    }
                    n.status = Some(InstanceStatus::Ok);
                    n.main_deleted = t.main_deleted;
                } else {
                    apply_entry(&mut n.node, overrides.get(&tn.path));
                }
                n
            })
            .collect();
        TExpansion {
            nodes,
            main_name: t.name.clone(),
            deps: t.deps.clone(),
            max_depth: t.max_depth,
            truncated: t.truncated,
        }
    }

    fn to_resolved(
        tn: TNode,
        id: String,
        parent_id: Option<String>,
        children: Vec<String>,
        source: Option<ResolvedSource>,
        overridden: Option<Overridden>,
    ) -> ResolvedNode {
        let mut node = tn.node;
        node.id = id;
        node.parent_id = parent_id;
        node.children = children;
        ResolvedNode {
            node,
            source,
            overridden,
            status: tn.status,
            main_deleted: tn.main_deleted.then_some(true),
        }
    }

    /// The expansion of a live instance: its root (TreeID) and every virtual node, pre-order.
    pub fn expand_instance(&mut self, inst: &DesignNode) -> Vec<ResolvedNode> {
        let id = inst.id.clone();
        let key = inst.component_key.clone().unwrap_or_default();
        let t = inst
            .component_key
            .as_ref()
            .map(|k| self.template(k, &[], inst.main_id.as_deref()));
        let t = match t {
            Some(t) if t.ok => t,
            _ => {
                let n = placeholder_node(inst, InstanceStatus::Unresolved);
                let overridden = overridden_of(
                    inst.overrides.as_ref().and_then(|o| o.get("")),
                    &own_size_keys(&inst.styles),
                );
                return vec![Self::to_resolved(
                    n,
                    id,
                    inst.parent_id.clone(),
                    Vec::new(),
                    None,
                    overridden,
                )];
            }
        };
        let empty = Overrides::default();
        let overrides = inst.overrides.as_ref().unwrap_or(&empty);
        let mut out = Vec::with_capacity(t.nodes.len());
        for tn in &t.nodes {
            let vid = virtual_id(&id, &tn.path);
            let children = tn.child_paths.iter().map(|p| virtual_id(&id, p)).collect();
            if tn.path.is_empty() {
                let mut n = tn.clone();
                n.node.styles = root_styles(&tn.node.styles, inst);
                n.node.name = if inst.name.is_empty() {
                    t.name.clone()
                } else {
                    inst.name.clone()
                };
                n.node.component_key = Some(key.clone());
                n.status = Some(InstanceStatus::Ok);
                n.node.locked = inst.locked;
                n.node.hidden = inst.hidden;
                n.node.node_key = inst.node_key.clone();
                n.node.main_id = inst.main_id.clone();
                n.main_deleted = t.main_deleted;
                let source = ResolvedSource {
                    instance_id: id.clone(),
                    path: String::new(),
                    main_node_id: tn.main_node_id.clone(),
                    component_key: key.clone(),
                };
                let overridden = overridden_of(overrides.get(""), &own_size_keys(&inst.styles));
                out.push(Self::to_resolved(
                    n,
                    vid,
                    inst.parent_id.clone(),
                    children,
                    Some(source),
                    overridden,
                ));
                continue;
            }
            let entry = overrides.get(&tn.path);
            let mut n = tn.clone();
            apply_entry(&mut n.node, entry);
            let source = ResolvedSource {
                instance_id: id.clone(),
                path: tn.path.clone(),
                main_node_id: tn.main_node_id.clone(),
                component_key: tn.source_key.clone(),
            };
            let parent = virtual_id(&id, tn.parent_path.as_deref().unwrap_or(""));
            out.push(Self::to_resolved(
                n,
                vid,
                Some(parent),
                children,
                Some(source),
                overridden_of(entry, &[]),
            ));
        }
        out
    }
}

/// Split `"<instanceTreeId>/<path>"`; `None` for TreeIDs and malformed ids.
pub fn parse_virtual_id(id: &str) -> Option<(&str, &str)> {
    let (instance, path) = id.split_once('/')?;
    parse_node_id(instance)?;
    if path.is_empty() {
        return None;
    }
    let ok = path.split('/').all(|seg| match seg.strip_prefix('~') {
        Some(tid) => parse_node_id(tid).is_some(),
        None => is_node_key(seg),
    });
    ok.then_some((instance, path))
}

fn collect_preorder(nodes: &[ResolvedNode], root: &str, out: &mut Vec<ResolvedNode>) {
    let index: HashMap<&str, &ResolvedNode> =
        nodes.iter().map(|n| (n.node.id.as_str(), n)).collect();
    let mut stack = vec![root.to_owned()];
    while let Some(id) = stack.pop() {
        let Some(n) = index.get(id.as_str()) else {
            continue;
        };
        out.push((*n).clone());
        for c in n.node.children.iter().rev() {
            stack.push(c.clone());
        }
    }
}

/// `toRenderSubtree`: the subtree of `root_ref` (real or virtual) with every instance expanded.
pub fn to_render_subtree(doc: &LoroDoc, root_ref: &str) -> Option<RenderSubtree> {
    let mut resolver = Resolver::new(doc);
    to_render_subtree_with(&mut resolver, doc, root_ref)
}

/// [`to_render_subtree`] sharing a resolver's template cache.
pub fn to_render_subtree_with(
    resolver: &mut Resolver<'_>,
    doc: &LoroDoc,
    root_ref: &str,
) -> Option<RenderSubtree> {
    if let Some((instance_id, _)) = parse_virtual_id(root_ref) {
        let inst = super::snapshot::get_node(doc, instance_id)?;
        if inst.node_type != NodeType::Instance {
            return None;
        }
        let expanded = resolver.expand_instance(&inst);
        if !expanded.iter().any(|n| n.node.id == root_ref) {
            return None;
        }
        let mut nodes = Vec::new();
        collect_preorder(&expanded, root_ref, &mut nodes);
        return Some(RenderSubtree {
            root_id: root_ref.to_owned(),
            nodes,
        });
    }
    let sub = to_subtree_snapshot(doc, root_ref)?;
    let mut nodes = Vec::with_capacity(sub.nodes.len());
    let mut stack = vec![root_ref.to_owned()];
    while let Some(id) = stack.pop() {
        let Some(n) = sub.nodes.get(&id) else {
            continue;
        };
        if n.node_type == NodeType::Instance {
            let expanded = resolver.expand_instance(n);
            collect_preorder(&expanded, &id, &mut nodes);
            continue;
        }
        nodes.push(ResolvedNode::plain(n.clone()));
        for c in n.children.iter().rev() {
            stack.push(c.clone());
        }
    }
    Some(RenderSubtree {
        root_id: root_ref.to_owned(),
        nodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_forms() {
        let s = |pairs: &[(&str, StyleValue)]| {
            Styles(
                pairs
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), v.clone()))
                    .collect(),
            )
        };
        assert_eq!(read_rotation(&s(&[])), 0.0);
        assert_eq!(read_rotation(&s(&[("rotate", "15deg".into())])), 15.0);
        assert_eq!(read_rotation(&s(&[("rotate", "0.25turn".into())])), 90.0);
        assert!((read_rotation(&s(&[("rotate", "100grad".into())])) - 90.0).abs() < 1e-9);
        assert_eq!(read_rotation(&s(&[("rotate", 30.into())])), 30.0);
        assert_eq!(read_rotation(&s(&[("rotate", "270deg".into())])), -90.0);
        assert_eq!(
            read_rotation(&s(&[("transform", "rotate(10deg) rotateZ(5deg)".into())])),
            15.0
        );
        assert_eq!(
            read_rotation(&s(&[("transform", "translateX(4px) rotate(30deg)".into())])),
            0.0
        );
        assert_eq!(
            read_rotation(&s(&[
                ("rotate", "10deg".into()),
                ("transform", "rotate(20deg)".into())
            ])),
            30.0
        );
        assert_eq!(normalize_deg(-180.0), 180.0);
        assert_eq!(normalize_deg(190.0), -170.0);
    }

    #[test]
    fn virtual_ids() {
        assert_eq!(
            parse_virtual_id("12@3/abcdefghij/klmnopqrst"),
            Some(("12@3", "abcdefghij/klmnopqrst"))
        );
        assert_eq!(parse_virtual_id("12@3/~4@5"), Some(("12@3", "~4@5")));
        assert_eq!(parse_virtual_id("12@3"), None);
        assert_eq!(parse_virtual_id("12@3/short"), None);
        assert_eq!(parse_virtual_id("x/abcdefghij"), None);
    }
}
