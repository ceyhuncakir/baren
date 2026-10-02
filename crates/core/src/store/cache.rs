//! LRU cache of open documents.
//!
//! Invariant: at most **one** `OpenDoc` exists per file id. Entries are only
//! removed from the map when nobody else holds them (`Arc::strong_count == 1`
//! under the map lock) and they are unloaded, so two in-memory copies of the
//! same file can never race each other's compactions.
//!
//! Lock order: the map lock is never held while waiting on a document lock
//! (only `try_lock`-free reads of atomics happen under it), and document locks
//! are never held while taking the map lock.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use loro::{LoroDoc, VersionRange, VersionVector};

use crate::util::lock;

/// A loaded document plus bookkeeping about what is on disk.
pub(crate) struct DocState {
    pub doc: LoroDoc,
    /// Highest `file_updates.seq` this state contains (0 = none).
    pub max_seq: i64,
    /// Updates appended since the stored snapshot was written.
    pub pending_updates: u32,
    pub pending_bytes: u64,
    /// Version ranges imported with missing dependencies. Their update rows
    /// must survive compaction until the dependencies arrive (Loro does not
    /// put pending changes into snapshots).
    pub unresolved: Vec<VersionRange>,
    /// Last `meta.name` mirrored into `files.name`.
    pub name: String,
    /// Set when the in-memory doc may differ from disk; the slot is dropped
    /// after the current operation and reloaded on next use.
    pub poisoned: bool,
    /// Consecutive failed compactions (stretches the compaction interval).
    pub compact_failures: u32,
}

impl DocState {
    /// True when the stored snapshot alone reproduces this state.
    pub fn is_clean(&self) -> bool {
        self.pending_updates == 0 && self.unresolved.is_empty()
    }

    /// Drop unresolved ranges whose ops have all arrived; true if none remain.
    pub fn settle_unresolved(&mut self) -> bool {
        if !self.unresolved.is_empty() {
            let vv = self.doc.oplog_vv();
            self.unresolved.retain(|r| !range_included(r, &vv));
        }
        self.unresolved.is_empty()
    }
}

fn range_included(range: &VersionRange, vv: &VersionVector) -> bool {
    range
        .iter()
        .all(|(peer, &(_, end))| vv.get(peer).copied().unwrap_or(0) >= end)
}

pub(crate) struct OpenDoc {
    pub id: String,
    last_used: AtomicU64,
    loaded: AtomicBool,
    slot: Mutex<Option<DocState>>,
}

impl OpenDoc {
    fn new(id: &str) -> Self {
        OpenDoc {
            id: id.to_owned(),
            last_used: AtomicU64::new(0),
            loaded: AtomicBool::new(false),
            slot: Mutex::new(None),
        }
    }

    pub fn lock(&self) -> SlotGuard<'_> {
        SlotGuard {
            owner: self,
            guard: lock(&self.slot),
        }
    }

    fn is_loaded(&self) -> bool {
        self.loaded.load(Ordering::Acquire)
    }
}

/// Exclusive access to one file's document slot. Keeps the `loaded` flag in
/// sync with the slot on every change.
pub(crate) struct SlotGuard<'a> {
    owner: &'a OpenDoc,
    guard: MutexGuard<'a, Option<DocState>>,
}

impl SlotGuard<'_> {
    pub fn state(&mut self) -> Option<&mut DocState> {
        self.guard.as_mut()
    }

    pub fn fill(&mut self, state: DocState) -> &mut DocState {
        self.owner.loaded.store(true, Ordering::Release);
        self.guard.insert(state)
    }

    pub fn clear(&mut self) -> Option<DocState> {
        self.owner.loaded.store(false, Ordering::Release);
        self.guard.take()
    }
}

pub(crate) struct DocCache {
    map: Mutex<CacheMap>,
    capacity: usize,
}

#[derive(Default)]
struct CacheMap {
    entries: HashMap<String, Arc<OpenDoc>>,
    clock: u64,
}

impl DocCache {
    pub fn new(capacity: usize) -> Self {
        DocCache {
            map: Mutex::new(CacheMap::default()),
            capacity: capacity.max(1),
        }
    }

    /// The single entry for `id` (created unloaded if absent), marked most
    /// recently used.
    pub fn acquire(&self, id: &str) -> Arc<OpenDoc> {
        let mut map = lock(&self.map);
        map.clock += 1;
        let now = map.clock;
        let entry = map
            .entries
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(OpenDoc::new(id)))
            .clone();
        entry.last_used.store(now, Ordering::Relaxed);
        entry
    }

    /// Loaded entries beyond capacity, least recently used first, never `keep`.
    pub fn eviction_candidates(&self, keep: &str) -> Vec<Arc<OpenDoc>> {
        let map = lock(&self.map);
        let mut loaded: Vec<_> = map
            .entries
            .values()
            .filter(|e| e.is_loaded())
            .cloned()
            .collect();
        if loaded.len() <= self.capacity {
            return Vec::new();
        }
        let excess = loaded.len() - self.capacity;
        loaded.sort_by_key(|e| e.last_used.load(Ordering::Relaxed));
        loaded
            .into_iter()
            .filter(|e| e.id != keep)
            .take(excess)
            .collect()
    }

    /// Every loaded entry (for flushing).
    pub fn loaded(&self) -> Vec<Arc<OpenDoc>> {
        lock(&self.map)
            .entries
            .values()
            .filter(|e| e.is_loaded())
            .cloned()
            .collect()
    }

    /// Forget unloaded entries nobody else references.
    pub fn prune(&self) {
        lock(&self.map)
            .entries
            .retain(|_, e| e.is_loaded() || Arc::strong_count(e) > 1);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        lock(&self.map).entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> DocState {
        DocState {
            doc: LoroDoc::new(),
            max_seq: 0,
            pending_updates: 0,
            pending_bytes: 0,
            unresolved: Vec::new(),
            name: String::new(),
            poisoned: false,
            compact_failures: 0,
        }
    }

    #[test]
    fn acquire_returns_the_same_entry() {
        let cache = DocCache::new(2);
        let a1 = cache.acquire("a");
        let a2 = cache.acquire("a");
        assert!(Arc::ptr_eq(&a1, &a2));
    }

    #[test]
    fn evicts_least_recently_used_loaded_entries() {
        let cache = DocCache::new(2);
        for id in ["a", "b", "c"] {
            cache.acquire(id).lock().fill(state());
        }
        cache.acquire("a"); // a is now most recent; b is the LRU
        let victims: Vec<_> = cache
            .eviction_candidates("c")
            .iter()
            .map(|e| e.id.clone())
            .collect();
        assert_eq!(victims, ["b"]);
        assert!(cache.eviction_candidates("x").len() == 1);
    }

    #[test]
    fn prune_keeps_loaded_or_referenced_entries() {
        let cache = DocCache::new(4);
        cache.acquire("loaded").lock().fill(state());
        let held = cache.acquire("held");
        drop(cache.acquire("idle"));
        cache.prune();
        assert_eq!(cache.len(), 2);
        drop(held);
        cache.prune();
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn unresolved_ranges_settle_once_ops_arrive() {
        let mut s = state();
        let mut range = VersionRange::new();
        range.insert(42, 0, 3);
        s.unresolved.push(range);
        assert!(!s.settle_unresolved());
        assert!(!s.is_clean());
        s.doc.set_peer_id(42).unwrap();
        s.doc.get_text("t").insert(0, "abc").unwrap();
        s.doc.commit();
        assert!(s.settle_unresolved());
        assert!(s.is_clean());
    }
}
