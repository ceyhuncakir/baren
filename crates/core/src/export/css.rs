//! Style map → CSS declarations.
//!
//! Numbers follow React's convention (the canvas renders style maps the same
//! way): unitless properties stay bare, everything else gets `px`. Values that
//! could escape their context (`<`, `{`, `}`, control characters, script
//! URLs, `expression(`) are dropped rather than emitted.

use crate::schema::StyleValue;
use crate::util::format_number;

/// camelCase → kebab-case (`backgroundColor` → `background-color`,
/// `WebkitLineClamp` → `-webkit-line-clamp`, `msTransform` → `-ms-transform`).
/// Custom properties (`--x`) pass through. `None` for anything that is not a
/// plausible property name.
pub(crate) fn property_name(key: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix("--") {
        let ok = !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        return ok.then(|| key.to_owned());
    }
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    if !key.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let mut out = String::with_capacity(key.len() + 4);
    // `ms` is the one lowercase vendor prefix; `Webkit…`/`Moz…` get their
    // leading dash from the uppercase rule below.
    if key.starts_with("ms") && key.as_bytes().get(2).is_some_and(u8::is_ascii_uppercase) {
        out.push('-');
    }
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// React's `isUnitlessNumber` set (camelCase, vendor prefix stripped), plus
/// custom properties, whose numbers are emitted bare.
fn is_unitless(key: &str) -> bool {
    let bare = ["Webkit", "Moz", "ms", "O"]
        .iter()
        .find_map(|p| {
            key.strip_prefix(p)
                .filter(|r| r.starts_with(|c: char| c.is_ascii_uppercase()))
        })
        .map(|r| {
            let mut s = r.to_owned();
            s[..1].make_ascii_lowercase();
            s
        });
    let key = bare.as_deref().unwrap_or(key);
    matches!(
        key,
        "animationIterationCount"
            | "aspectRatio"
            | "borderImageOutset"
            | "borderImageSlice"
            | "borderImageWidth"
            | "boxFlex"
            | "boxFlexGroup"
            | "boxOrdinalGroup"
            | "columnCount"
            | "columns"
            | "flex"
            | "flexGrow"
            | "flexPositive"
            | "flexShrink"
            | "flexNegative"
            | "flexOrder"
            | "gridArea"
            | "gridRow"
            | "gridRowEnd"
            | "gridRowSpan"
            | "gridRowStart"
            | "gridColumn"
            | "gridColumnEnd"
            | "gridColumnSpan"
            | "gridColumnStart"
            | "fontWeight"
            | "lineClamp"
            | "lineHeight"
            | "opacity"
            | "order"
            | "orphans"
            | "scale"
            | "tabSize"
            | "widows"
            | "zIndex"
            | "zoom"
            | "fillOpacity"
            | "floodOpacity"
            | "stopOpacity"
            | "strokeDasharray"
            | "strokeDashoffset"
            | "strokeMiterlimit"
            | "strokeOpacity"
            | "strokeWidth"
    ) || key.starts_with("--")
}

/// True when `value` is safe to place inside a `style` attribute or a
/// `<style>` block (after HTML escaping).
pub(crate) fn is_safe_value(value: &str) -> bool {
    if value
        .chars()
        .any(|c| matches!(c, '<' | '>' | '{' | '}') || c.is_control())
    {
        return false;
    }
    let squashed: String = value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\\')
        .flat_map(char::to_lowercase)
        .collect();
    ![
        "javascript:",
        "vbscript:",
        "expression(",
        "@import",
        "behavior:",
        "-moz-binding",
    ]
    .iter()
    .any(|bad| squashed.contains(bad))
}

/// Render one style value for property `key`, or `None` to drop it.
pub(crate) fn value(key: &str, v: &StyleValue) -> Option<String> {
    match v {
        StyleValue::Num(n) if !n.is_finite() => None,
        // Rotation is stored as "<n>deg"; a bare number means degrees (contract §2.3).
        StyleValue::Num(n) if key == "rotate" => Some(format!("{}deg", format_number(*n))),
        StyleValue::Num(n) if is_unitless(key) => Some(format_number(*n)),
        StyleValue::Num(n) => Some(format!("{}px", format_number(*n))),
        StyleValue::Str(s) => {
            let s = s.trim();
            (!s.is_empty() && is_safe_value(s)).then(|| s.to_owned())
        }
    }
}

/// `property: value` for a style entry, or `None` if either part is unsafe.
pub(crate) fn declaration(key: &str, v: &StyleValue) -> Option<String> {
    Some(format!("{}: {}", property_name(key)?, value(key, v)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn property_names() {
        assert_eq!(
            property_name("backgroundColor").unwrap(),
            "background-color"
        );
        assert_eq!(
            property_name("WebkitLineClamp").unwrap(),
            "-webkit-line-clamp"
        );
        assert_eq!(property_name("msTransform").unwrap(), "-ms-transform");
        assert_eq!(property_name("gap").unwrap(), "gap");
        assert_eq!(property_name("--brand-1").unwrap(), "--brand-1");
        assert_eq!(property_name("color;x"), None);
        assert_eq!(property_name("1abc"), None);
        assert_eq!(property_name(""), None);
        assert_eq!(property_name("--"), None);
    }

    #[test]
    fn numbers_get_px_unless_unitless() {
        assert_eq!(value("width", &1440.into()).unwrap(), "1440px");
        assert_eq!(value("left", &0.into()).unwrap(), "0px");
        assert_eq!(value("opacity", &0.5.into()).unwrap(), "0.5");
        assert_eq!(value("lineHeight", &1.25.into()).unwrap(), "1.25");
        assert_eq!(value("fontWeight", &600.into()).unwrap(), "600");
        assert_eq!(value("WebkitLineClamp", &2.into()).unwrap(), "2");
        assert_eq!(value("zIndex", &(-1).into()).unwrap(), "-1");
        assert_eq!(value("width", &f64::NAN.into()), None);
        assert_eq!(value("rotate", &15.into()).unwrap(), "15deg");
        assert_eq!(value("rotate", &"-22.5deg".into()).unwrap(), "-22.5deg");
    }

    #[test]
    fn unsafe_values_are_dropped() {
        assert_eq!(value("color", &"red".into()).unwrap(), "red");
        assert_eq!(
            value("backgroundImage", &"url(data:image/png;base64,AAA)".into()).unwrap(),
            "url(data:image/png;base64,AAA)"
        );
        for bad in [
            "red</style><script>",
            "x}body{color:red",
            "url(JavaScript:alert(1))",
            "url(java\\script:alert(1))",
            "expression(alert(1))",
            "a\nb",
            "",
        ] {
            assert_eq!(value("color", &bad.into()), None, "{bad}");
        }
    }

    #[test]
    fn declarations() {
        assert_eq!(
            declaration("fontSize", &"22px".into()).unwrap(),
            "font-size: 22px"
        );
        assert_eq!(declaration("bad key", &"1".into()), None);
    }
}
