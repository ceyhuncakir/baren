//! A small fixed-window rate limiter for credential endpoints (keyed by purpose + email).
//! In-memory and per process, which is enough for a single small VPS.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct RateLimiter {
    limit: u32,
    window: Duration,
    hits: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimiter {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Record one attempt for `key`; false when the key is over its limit for this window.
    pub fn check(&self, key: &str) -> bool {
        self.check_at(key, Instant::now())
    }

    fn check_at(&self, key: &str, now: Instant) -> bool {
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() > 10_000 {
            let window = self.window;
            hits.retain(|_, (_, start)| now.duration_since(*start) < window);
        }
        let entry = hits.entry(key.to_string()).or_insert((0, now));
        if now.duration_since(entry.1) >= self.window {
            *entry = (0, now);
        }
        entry.0 += 1;
        entry.0 <= self.limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_key_and_resets_after_window() {
        let rl = RateLimiter::new(2, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(rl.check_at("a", t0));
        assert!(rl.check_at("a", t0));
        assert!(!rl.check_at("a", t0));
        assert!(rl.check_at("b", t0));
        assert!(rl.check_at("a", t0 + Duration::from_secs(61)));
    }
}
