//! Large deterministic documents for performance tests — the same layout as
//! `generateBenchDoc` in `packages/schema/src/bench.ts` (one page, a grid of
//! artboards, each filled with flex "section" frames holding text and rects).

use loro::{LoroDoc, TreeID};

use super::doc::{create_empty_doc_with, nodes_tree, EmptyDocOptions};
use super::edit::{write_node_data, NodeInit};
use super::types::{NodeType, StyleValue};
use crate::error::Result;

#[derive(Clone, Debug)]
pub struct BenchOptions {
    pub artboards: usize,
    /// Layers inside each artboard (not counting the artboard itself).
    pub nodes_per_artboard: usize,
    pub seed: u32,
    pub artboard_width: f64,
    pub artboard_height: f64,
    /// Fixed peer id so node ids are reproducible.
    pub peer_id: Option<u64>,
}

impl Default for BenchOptions {
    fn default() -> Self {
        BenchOptions {
            artboards: 40,
            nodes_per_artboard: 500,
            seed: 1,
            artboard_width: 1440.0,
            artboard_height: 900.0,
            peer_id: None,
        }
    }
}

/// `benchDocNodeCount`: page + artboards + layers.
pub fn bench_doc_node_count(o: &BenchOptions) -> usize {
    1 + o.artboards * (1 + o.nodes_per_artboard)
}

const ARTBOARD_GAP: f64 = 160.0;
const SECTION_SIZE: usize = 8;
const PALETTE: [&str; 6] = [
    "#141414", "#2F80FF", "#F04E1E", "#E5E5E5", "#F7F7F7", "#666666",
];
const WORDS: [&str; 8] = [
    "Design", "Layers", "Canvas", "Tokens", "Export", "Invite", "Frames", "Recent",
];

/// mulberry32, bit-for-bit the JS implementation.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        let i = (self.next() * items.len() as f64) as usize % items.len();
        items[i]
    }

    fn step(&mut self, n: u32) -> f64 {
        (self.next() * f64::from(n)).floor()
    }
}

/// Build the bench document in a single commit.
pub fn generate_bench_doc(o: &BenchOptions) -> Result<LoroDoc> {
    let doc = create_empty_doc_with(
        "Bench",
        &EmptyDocOptions {
            page_name: Some("Bench".to_owned()),
            peer_id: o.peer_id,
            ..Default::default()
        },
    )?;
    let tree = nodes_tree(&doc);
    let page = tree.roots()[0];
    let columns = ((o.artboards.max(1) as f64).sqrt().ceil() as usize).max(1);
    let mut rand = Mulberry32(o.seed);

    for a in 0..o.artboards {
        let artboard = tree.create(page)?;
        let init = NodeInit {
            name: Some(format!("Artboard {}", a + 1)),
            styles: vec![
                (
                    "left".into(),
                    ((a % columns) as f64 * (o.artboard_width + ARTBOARD_GAP)).into(),
                ),
                (
                    "top".into(),
                    ((a / columns) as f64 * (o.artboard_height + ARTBOARD_GAP)).into(),
                ),
                ("width".into(), o.artboard_width.into()),
                ("height".into(), o.artboard_height.into()),
                ("display".into(), "flex".into()),
                ("flexDirection".into(), "column".into()),
                ("gap".into(), "24px".into()),
                ("padding".into(), "48px".into()),
                ("backgroundColor".into(), "#FFFFFF".into()),
                ("overflow".into(), "hidden".into()),
            ],
            ..Default::default()
        };
        write_node_data(&tree.get_meta(artboard)?, NodeType::Frame, &init)?;
        fill_artboard(&doc, artboard, o.nodes_per_artboard, &mut rand)?;
    }
    doc.commit();
    Ok(doc)
}

fn fill_artboard(
    doc: &LoroDoc,
    artboard: TreeID,
    count: usize,
    rand: &mut Mulberry32,
) -> Result<()> {
    let tree = nodes_tree(doc);
    let mut section: Option<TreeID> = None;
    let mut in_section = 0;
    for i in 0..count {
        let current = match section {
            Some(s) if in_section < SECTION_SIZE => s,
            _ => {
                let s = tree.create(artboard)?;
                let direction = if rand.next() < 0.5 { "row" } else { "column" };
                let init = NodeInit {
                    name: Some(format!("Section {i}")),
                    styles: vec![
                        ("display".into(), "flex".into()),
                        ("flexDirection".into(), direction.into()),
                        (
                            "gap".into(),
                            format!("{}px", 4.0 + rand.step(4) * 4.0).into(),
                        ),
                        ("padding".into(), "16px".into()),
                        ("borderRadius".into(), "8px".into()),
                        ("backgroundColor".into(), rand.pick(&PALETTE).into()),
                    ],
                    ..Default::default()
                };
                write_node_data(&tree.get_meta(s)?, NodeType::Frame, &init)?;
                section = Some(s);
                in_section = 0;
                continue;
            }
        };
        let node = tree.create(current)?;
        let is_text = rand.next() < 0.6;
        let init = if is_text {
            NodeInit {
                name: Some(format!("Text {i}")),
                styles: vec![
                    ("fontFamily".into(), "Inter".into()),
                    (
                        "fontSize".into(),
                        format!("{}px", 12.0 + rand.step(4) * 2.0).into(),
                    ),
                    ("lineHeight".into(), "20px".into()),
                    ("color".into(), StyleValue::from(rand.pick(&PALETTE))),
                ],
                text: Some(format!("{} {i}", rand.pick(&WORDS))),
                ..Default::default()
            }
        } else {
            NodeInit {
                name: Some(format!("Rectangle {i}")),
                styles: vec![
                    (
                        "width".into(),
                        format!("{}px", 24.0 + rand.step(8) * 16.0).into(),
                    ),
                    (
                        "height".into(),
                        format!("{}px", 16.0 + rand.step(4) * 8.0).into(),
                    ),
                    ("borderRadius".into(), "4px".into()),
                    ("backgroundColor".into(), rand.pick(&PALETTE).into()),
                ],
                ..Default::default()
            }
        };
        let node_type = if is_text {
            NodeType::Text
        } else {
            NodeType::Rect
        };
        write_node_data(&tree.get_meta(node)?, node_type, &init)?;
        in_section += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::snapshot::to_snapshot;

    #[test]
    fn mulberry32_matches_js() {
        // First outputs of `prng(1)` in packages/schema/src/bench.ts.
        let mut r = Mulberry32(1);
        let got: Vec<u32> = (0..3)
            .map(|_| (r.next() * 4_294_967_296.0) as u32)
            .collect();
        assert_eq!(got, [2_693_262_067, 11_749_833, 2_265_367_787]);
    }

    #[test]
    fn node_count_matches_formula() {
        let o = BenchOptions {
            artboards: 3,
            nodes_per_artboard: 20,
            peer_id: Some(7),
            ..Default::default()
        };
        let doc = generate_bench_doc(&o).unwrap();
        let snap = to_snapshot(&doc);
        assert_eq!(snap.nodes.len(), bench_doc_node_count(&o));
        assert_eq!(snap.page_ids.len(), 1);
        // Deterministic content (and node ids) with a fixed peer id.
        let again = generate_bench_doc(&o).unwrap();
        assert_eq!(to_snapshot(&again), snap);
    }
}
