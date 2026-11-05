//! Turns that were running when Atlas last stopped — quit, crashed, or
//! restarted to update — so the next launch can continue them
//! (`restart_continuation`).
//!
//! A turn is written in when it starts and out when it ends, by the thread it
//! belongs to. What is still in the file at launch is exactly the turns that
//! never ended. Nothing else on disk can say so: the transcript is flushed at
//! a turn's end, and the history store's writes are batched with no flush at
//! exit.
//!
//! The file is tiny (one entry per running session) and written whole, to a
//! temporary file then renamed, so a crash mid-write leaves the previous
//! version. Writes go to the blocking pool; each one writes the record as it
//! is when it runs, under a lock, so a late write never puts back an entry a
//! newer one removed.
//!
//! The exit sweep (`AgentHost::shutdown`) tears the connections down without
//! ending their turns, but the turn tasks still see their sends fail on the
//! way out. [`OpenTurns::freeze`] stops them writing those turns out: a turn
//! the quit cut short is exactly what this file is for.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use atlas_thread_metadata::ThreadId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::lock;

/// One turn that was running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTurn {
    pub started_at: DateTime<Utc>,
    /// How many restarts in a row this turn has been continued across: 0 for
    /// a turn the user (or a pull request watch) started. Bounds a turn that
    /// keeps taking Atlas down with it.
    pub continuations: u32,
}

#[derive(Debug, Default)]
pub(crate) struct OpenTurns {
    path: Option<PathBuf>,
    entries: Arc<Mutex<HashMap<ThreadId, OpenTurn>>>,
    write: Arc<Mutex<()>>,
    frozen: AtomicBool,
    /// Continuations the launch sweep is about to start, by thread: the turn
    /// they open is written in with this count rather than 0.
    pending: Mutex<HashMap<ThreadId, u32>>,
}

impl OpenTurns {
    /// The record at `path`, as the last run left it. A missing or unreadable
    /// file is an empty record.
    pub(crate) fn load(path: PathBuf) -> Self {
        let entries = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<HashMap<ThreadId, OpenTurn>>(&bytes).ok())
            .unwrap_or_default();
        Self {
            path: Some(path),
            entries: Arc::new(Mutex::new(entries)),
            ..Self::default()
        }
    }

    /// Every turn the last run left open, emptied from the record: each is
    /// either continued now (and written back in when its turn starts) or
    /// let go.
    pub(crate) fn take_left_open(&self) -> Vec<(ThreadId, OpenTurn)> {
        let taken = std::mem::take(&mut *lock(&self.entries));
        if !taken.is_empty() {
            self.persist();
        }
        taken.into_iter().collect()
    }

    /// The next turn in `thread` is a continuation, the `count`th in a row.
    pub(crate) fn expect_continuation(&self, thread: ThreadId, count: u32) {
        lock(&self.pending).insert(thread, count);
    }

    /// A turn started in `thread`.
    pub(crate) fn begin(&self, thread: ThreadId) {
        if self.frozen.load(Ordering::SeqCst) {
            return;
        }
        let continuations = lock(&self.pending).remove(&thread).unwrap_or(0);
        lock(&self.entries).insert(
            thread,
            OpenTurn {
                started_at: Utc::now(),
                continuations,
            },
        );
        self.persist();
    }

    /// The turn in `thread` ended, however it ended.
    pub(crate) fn end(&self, thread: ThreadId) {
        if self.frozen.load(Ordering::SeqCst) {
            return;
        }
        if lock(&self.entries).remove(&thread).is_some() {
            self.persist();
        }
    }

    /// Atlas is going away: what is open stays open on disk.
    pub(crate) fn freeze(&self) {
        self.frozen.store(true, Ordering::SeqCst);
    }

    fn persist(&self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        let entries = self.entries.clone();
        let write = self.write.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _held = lock(&write);
            let bytes = match serde_json::to_vec(&*lock(&entries)) {
                Ok(bytes) => bytes,
                Err(e) => {
                    tracing::warn!(error = %e, "could not encode the open turns");
                    return;
                }
            };
            let tmp = path.with_extension("json.tmp");
            let written = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, &path));
            if let Err(e) = written {
                tracing::warn!(error = %e, path = %path.display(), "could not record the open turns");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The record on disk, once `done` holds for it.
    fn wait_until(
        path: &std::path::Path,
        done: impl Fn(&HashMap<ThreadId, OpenTurn>) -> bool,
    ) -> HashMap<ThreadId, OpenTurn> {
        for _ in 0..200 {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(map) = serde_json::from_slice::<HashMap<ThreadId, OpenTurn>>(&bytes) {
                    if done(&map) {
                        return map;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("the record on disk never got there");
    }

    fn wait_for(path: &std::path::Path, want: usize) -> HashMap<ThreadId, OpenTurn> {
        wait_until(path, |map| map.len() == want)
    }

    #[test]
    fn a_turn_the_quit_cut_short_survives_to_the_next_launch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("open-turns.json");
        let (a, b) = (ThreadId::new(), ThreadId::new());

        let turns = OpenTurns::load(path.clone());
        turns.begin(a);
        turns.begin(b);
        wait_for(&path, 2);
        turns.end(b);
        wait_for(&path, 1);
        // The exit sweep fails the running turn's send on the way out.
        turns.freeze();
        turns.end(a);

        let next = OpenTurns::load(path.clone());
        let left = next.take_left_open();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].0, a);
        assert_eq!(left[0].1.continuations, 0);
        // Taken means emptied: a launch that continues nothing leaves nothing.
        wait_for(&path, 0);
    }

    #[test]
    fn a_continuation_is_written_in_with_its_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("open-turns.json");
        let thread = ThreadId::new();
        let turns = OpenTurns::load(path.clone());
        turns.expect_continuation(thread, 2);
        turns.begin(thread);
        assert_eq!(wait_for(&path, 1)[&thread].continuations, 2);
        // The next turn there is the user's own again.
        turns.end(thread);
        turns.begin(thread);
        wait_until(&path, |map| {
            map.get(&thread).is_some_and(|t| t.continuations == 0)
        });
    }
}
