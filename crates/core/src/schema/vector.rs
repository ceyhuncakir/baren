//! Vector path data, mirroring `vectorToPathD` in `packages/schema/src/vector.ts`
//! byte for byte (contract §2.6): subpaths in order, empty ones skipped; `M x0 y0`, then
//! `L x y` per straight segment or `C x1 y1 x2 y2 x y` per curved one; a closed subpath with
//! at least two points emits its closing segment as a `C` only when it has a handle, then `Z`.
//! Every number is `String(Math.round(n * 1000) / 1000)` with −0 printed as `0`.

use super::types::{JsNum, VectorData, VectorPoint};
use crate::export::json::js_number;

/// ECMAScript `Math.round`: the nearest integer, ties toward +∞.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `formatPathNumber`.
pub fn format_path_number(n: f64) -> String {
    let r = js_round(n * 1000.0) / 1000.0;
    if r == 0.0 {
        "0".to_owned()
    } else {
        js_number(r)
    }
}

fn with_handle(p: &VectorPoint, h: Option<[JsNum; 2]>) -> (f64, f64) {
    match h {
        Some([dx, dy]) => (p.x.0 + dx.0, p.y.0 + dy.0),
        None => (p.x.0, p.y.0),
    }
}

/// `vectorToPathD`.
pub fn vector_to_path_d(v: &VectorData) -> String {
    let mut out: Vec<String> = Vec::new();
    let push = |out: &mut Vec<String>, parts: &[f64], op: &str| {
        out.push(op.to_owned());
        out.extend(parts.iter().map(|n| format_path_number(*n)));
    };
    for sp in &v.subpaths {
        let pts = &sp.points;
        let Some(first) = pts.first() else { continue };
        push(&mut out, &[first.x.0, first.y.0], "M");
        for pair in pts.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if a.handle_out.is_none() && b.handle_in.is_none() {
                push(&mut out, &[b.x.0, b.y.0], "L");
            } else {
                let c1 = with_handle(a, a.handle_out);
                let c2 = with_handle(b, b.handle_in);
                push(&mut out, &[c1.0, c1.1, c2.0, c2.1, b.x.0, b.y.0], "C");
            }
        }
        if sp.closed && pts.len() >= 2 {
            let last = &pts[pts.len() - 1];
            if last.handle_out.is_some() || first.handle_in.is_some() {
                let c1 = with_handle(last, last.handle_out);
                let c2 = with_handle(first, first.handle_in);
                push(
                    &mut out,
                    &[c1.0, c1.1, c2.0, c2.1, first.x.0, first.y.0],
                    "C",
                );
            }
            out.push("Z".to_owned());
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::types::VectorSubpath;

    fn p(x: f64, y: f64) -> VectorPoint {
        VectorPoint {
            x: JsNum(x),
            y: JsNum(y),
            handle_in: None,
            handle_out: None,
            mode: None,
        }
    }

    #[test]
    fn rounds_like_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(format_path_number(-0.0001), "0");
        assert_eq!(format_path_number(1.0 / 3.0), "0.333");
        assert_eq!(format_path_number(0.12345), "0.123");
        assert_eq!(format_path_number(1e21), "1e+21");
    }

    #[test]
    fn golden_strings_match_the_ts_generator() {
        let square = VectorSubpath {
            id: "sq".into(),
            closed: true,
            points: vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)],
        };
        let mut a = p(0.0, 0.0);
        a.handle_out = Some([JsNum(10.0), JsNum(-20.0)]);
        let mut b = p(30.0, 0.0);
        b.handle_in = Some([JsNum(-10.0), JsNum(-20.0)]);
        let curve = VectorSubpath {
            id: "cv".into(),
            closed: false,
            points: vec![a, b, p(60.0, 0.12345)],
        };
        let mut c0 = p(0.0, 0.0);
        c0.handle_in = Some([JsNum(0.0), JsNum(5.0)]);
        let closed_curve = VectorSubpath {
            id: "cc".into(),
            closed: true,
            points: vec![c0, p(10.0, 0.0)],
        };
        let data = |subpaths: Vec<VectorSubpath>| VectorData {
            fill_rule: "nonzero".into(),
            subpaths,
        };
        assert_eq!(
            vector_to_path_d(&data(vec![square.clone()])),
            "M 0 0 L 10 0 L 10 10 L 0 10 Z"
        );
        assert_eq!(
            vector_to_path_d(&data(vec![curve.clone()])),
            "M 0 0 C 10 -20 20 -20 30 0 L 60 0.123"
        );
        assert_eq!(
            vector_to_path_d(&data(vec![closed_curve])),
            "M 0 0 L 10 0 C 10 0 0 5 0 0 Z"
        );
        let empty = VectorSubpath {
            id: "e".into(),
            closed: false,
            points: vec![],
        };
        assert_eq!(
            vector_to_path_d(&data(vec![square, empty, curve])),
            "M 0 0 L 10 0 L 10 10 L 0 10 Z M 0 0 C 10 -20 20 -20 30 0 L 60 0.123"
        );
        assert_eq!(vector_to_path_d(&data(vec![])), "");
    }
}
