//! The change feed into the code index.
//!
//! - `fileindex.rs`'s debounced watcher hands over every batch. Content edits
//!   (`ModifyKind::Data`) count here even though the Cmd+P file list ignores
//!   them, and a path-less rescan (watcher overflow) becomes a reconcile.
//! - `git_watcher.rs` reports HEAD / index / ref moves, which become a
//!   reconcile: a checkout rewrites files faster than per-file events say.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use notify::event::ModifyKind;
use notify::EventKind;
use notify_debouncer_full::DebouncedEvent;

use super::registry::CodeIndexRegistry;

/// What one debounced batch asks of the code index.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Feed {
    pub paths: Vec<PathBuf>,
    pub rescan: bool,
}

pub fn feed_from(events: &[DebouncedEvent]) -> Feed {
    let mut paths: BTreeSet<PathBuf> = BTreeSet::new();
    let mut rescan = false;
    for e in events {
        if e.event.need_rescan() {
            rescan = true;
            continue;
        }
        match e.event.kind {
            EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(
                ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any | ModifyKind::Other,
            )
            | EventKind::Any
            | EventKind::Other => {
                if e.event.paths.is_empty() {
                    rescan = true;
                }
                paths.extend(e.event.paths.iter().cloned());
            }
            // Permission/timestamp changes and reads change no symbols.
            EventKind::Modify(ModifyKind::Metadata(_)) | EventKind::Access(_) => {}
        }
    }
    Feed {
        paths: paths.into_iter().collect(),
        rescan,
    }
}

impl CodeIndexRegistry {
    /// Route one batch for the project at `root` (no-op unless it is open).
    pub fn apply_feed(&self, root: &Path, feed: Feed) {
        if feed.rescan {
            self.note_rescan(root);
        } else if !feed.paths.is_empty() {
            self.note_paths(root, feed.paths);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use notify::event::{
        AccessKind, CreateKind, DataChange, Flag, MetadataKind, RemoveKind, RenameMode,
    };
    use notify::Event;

    use super::*;

    fn ev(kind: EventKind, paths: &[&str]) -> DebouncedEvent {
        let mut e = Event::new(kind);
        for p in paths {
            e = e.add_path(PathBuf::from(p));
        }
        DebouncedEvent::new(e, Instant::now())
    }

    #[test]
    fn content_edits_creates_removes_and_renames_feed_paths() {
        let feed = feed_from(&[
            ev(
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                &["/p/a.rs"],
            ),
            ev(EventKind::Create(CreateKind::File), &["/p/b.rs"]),
            ev(EventKind::Remove(RemoveKind::File), &["/p/c.rs"]),
            ev(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &["/p/d.rs", "/p/e.rs"],
            ),
            ev(
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                &["/p/a.rs"],
            ),
        ]);
        assert!(!feed.rescan);
        let want: Vec<PathBuf> = ["/p/a.rs", "/p/b.rs", "/p/c.rs", "/p/d.rs", "/p/e.rs"]
            .iter()
            .map(PathBuf::from)
            .collect();
        assert_eq!(feed.paths, want);
    }

    #[test]
    fn metadata_and_access_are_ignored() {
        let feed = feed_from(&[
            ev(
                EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions)),
                &["/p/a.rs"],
            ),
            ev(EventKind::Access(AccessKind::Read), &["/p/a.rs"]),
        ]);
        assert_eq!(feed, Feed::default());
    }

    #[test]
    fn overflow_and_pathless_events_rescan() {
        let mut overflow = Event::new(EventKind::Other);
        overflow = overflow.set_flag(Flag::Rescan);
        assert!(feed_from(&[DebouncedEvent::new(overflow, Instant::now())]).rescan);
        assert!(feed_from(&[ev(EventKind::Modify(ModifyKind::Any), &[])]).rescan);
    }
}
