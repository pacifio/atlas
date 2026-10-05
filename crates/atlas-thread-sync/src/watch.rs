//! Turning saves in the replica worktree into thread paths.
//!
//! Any editor writes the file; the watcher reports it; the session decides
//! whether it was a real change or this replica's own write coming back (see
//! `replica.rs`) — or, for a path that is gone, a deletion or half a move.
//! Paths under `.git` and the atomic-write temporaries are dropped here.

use std::path::{Path, PathBuf};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::path;

/// Watch `root` recursively. Each changed file arrives once per event as its
/// thread path; keep the returned watcher alive for as long as events matter.
pub fn watch(root: &Path) -> notify::Result<(RecommendedWatcher, mpsc::UnboundedReceiver<String>)> {
    let (tx, rx) = mpsc::unbounded_channel();
    // Events name canonical paths on some platforms (macOS reports
    // `/private/var/…` for a root under `/var/…`), so match against both.
    let base: PathBuf = root.to_path_buf();
    let canonical: PathBuf = root.canonicalize().unwrap_or_else(|_| base.clone());
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // Removals too: a deletion, or half of a move (ATL-403).
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        for changed in event.paths {
            if changed.is_dir() {
                continue;
            }
            if let Some(rel) =
                path::relative(&base, &changed).or_else(|| path::relative(&canonical, &changed))
            {
                let _ = tx.send(rel);
            }
        }
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((watcher, rx))
}
