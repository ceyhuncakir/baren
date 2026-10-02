//! Small helpers shared by the store and exporters.

use std::sync::{Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch (JS `Date.now()` scale).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// A new file id: a time-ordered UUIDv7 string.
pub(crate) fn new_file_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Lock a mutex, recovering the guard if a previous holder panicked. Every
/// structure we guard stays valid across a panic (SQLite rolls back open
/// transactions; doc slots are reset by their owner on error).
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn try_lock<T>(m: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match m.try_lock() {
        Ok(g) => Some(g),
        Err(TryLockError::Poisoned(p)) => Some(p.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

/// JS `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// If `v` is an integer that JS prints without a fraction, that integer.
pub(crate) fn js_integer(v: f64) -> Option<i64> {
    // `-0.0` folds to 0, matching `JSON.stringify(-0) === "0"`.
    (v.is_finite() && v.fract() == 0.0 && v.abs() <= MAX_SAFE_INTEGER).then_some(v as i64)
}

/// Format a finite number the way it should appear in CSS/HTML output:
/// integers without a fraction, everything else in shortest round-trip form.
pub(crate) fn format_number(v: f64) -> String {
    match js_integer(v) {
        Some(i) => i.to_string(),
        None => v.to_string(),
    }
}

/// Lowercase hex check for blake3 digests.
pub(crate) fn is_blake3_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_integer_matches_json_stringify() {
        assert_eq!(js_integer(0.0), Some(0));
        assert_eq!(js_integer(-0.0), Some(0));
        assert_eq!(js_integer(1440.0), Some(1440));
        assert_eq!(js_integer(-12.0), Some(-12));
        assert_eq!(js_integer(0.5), None);
        assert_eq!(js_integer(f64::NAN), None);
        assert_eq!(js_integer(f64::INFINITY), None);
        assert_eq!(js_integer(2f64.powi(60)), None);
    }

    #[test]
    fn format_number_is_compact() {
        assert_eq!(format_number(12.0), "12");
        assert_eq!(format_number(0.6), "0.6");
        assert_eq!(format_number(-1.25), "-1.25");
    }

    #[test]
    fn file_ids_are_unique_and_sortable() {
        let a = new_file_id();
        let b = new_file_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert!(a <= b, "UUIDv7 strings sort by creation time");
    }

    #[test]
    fn blake3_hex_check() {
        assert!(is_blake3_hex(&blake3::hash(b"x").to_hex()));
        assert!(!is_blake3_hex("ABC"));
        assert!(!is_blake3_hex(&"G".repeat(64)));
    }
}
